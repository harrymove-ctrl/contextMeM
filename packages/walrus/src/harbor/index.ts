import { HarborClient } from "./client.js";
import { FileStatusError, HarborError, MirrorGrantMissingError } from "./errors.js";
import { SealCrypto } from "./seal.js";
import type {
  BucketId,
  FileId,
  FileUploadResponse,
  FinalizeBucketResponse,
  HarborConfig,
  SpaceId,
} from "./types.js";

// Re-exports — the harbor public surface.
export { HarborClient, contentTypeFromName } from "./client.js";
export { SealCrypto } from "./seal.js";
export * from "./constants.js";
export * from "./errors.js";
export * from "./types.js";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * After a bucket is finalized there is a ~3s window where the storage mirror has
 * not yet been granted, so uploads 403 with `mirror_missing_grant`. Detect it on
 * either the structured server code or the message text (the upload path may not
 * always surface a parseable code).
 */
function isMirrorMissingGrant(err: unknown): boolean {
  if (!(err instanceof HarborError)) return false;
  if (err.status !== 403) return false;
  return err.code === "mirror_missing_grant" || /mirror_missing_grant/i.test(err.message);
}

export interface CreatePrivateBucketResult {
  readonly bucketId: BucketId;
  readonly sealPolicyId: string | null;
  readonly state: string;
  /** On-chain digest of the sponsored finalize transaction (from the reserve step). */
  readonly digest: string;
}

export interface PutEncryptedOptions {
  /** Max upload attempts while tolerating the post-finalize mirror_missing_grant 403. */
  readonly uploadAttempts?: number;
  /** Backoff between upload retries (ms). */
  readonly uploadBackoffMs?: number;
  /** Max status polls before timing out. */
  readonly pollAttempts?: number;
  /** Delay between status polls (ms). */
  readonly pollIntervalMs?: number;
  /** Optional metadata stored alongside the file. */
  readonly metadata?: Record<string, unknown>;
}

/**
 * High-level Harbor + Seal operations: compose {@link HarborClient} and
 * {@link SealCrypto} into "ggdrive"-style private-bucket flows. All heavy
 * crypto + signing + retry logic lives here.
 *
 * Plain async/await port of the Effect `HarborStorageService`.
 */
export class HarborStorage {
  readonly client: HarborClient;
  readonly seal: SealCrypto;
  readonly defaultSpaceId?: string;

  constructor(config: HarborConfig) {
    this.client = new HarborClient(config);
    this.seal = new SealCrypto({ servicePrivateKey: config.servicePrivateKey });
    if (config.defaultSpaceId) this.defaultSpaceId = config.defaultSpaceId;
  }

  /**
   * Full create-bucket flow (private + Seal): reserve → sign bytes → finalize.
   * Done back-to-back because the sponsor signature expires fast.
   */
  async createPrivateBucket(spaceId: SpaceId, name: string): Promise<CreatePrivateBucketResult> {
    // 1. Reserve (sponsored tx bytes + digest)
    const reserve = await this.client.createBucket(spaceId, name);
    // 2. Sign locally
    const signature = await this.seal.signTransactionBytes(reserve.bytes);
    // 3. Finalize (immediately — the sponsor signature is short-lived)
    const finalized: FinalizeBucketResponse = await this.client.finalizeBucket(
      reserve.bucket_id,
      signature,
    );
    return {
      bucketId: finalized.bucket_id,
      sealPolicyId: finalized.seal_policy_id,
      state: finalized.state,
      digest: reserve.digest,
    };
  }

  /**
   * Encrypt bytes with Seal, upload (tolerating the post-finalize
   * `mirror_missing_grant` 403 via short backoff), then poll until the upload is
   * `completed`. Returns the new file id.
   */
  async putEncrypted(
    bucketId: BucketId,
    sealPolicyId: string,
    bytes: Uint8Array,
    fileName: string,
    options: PutEncryptedOptions = {},
  ): Promise<FileId> {
    const uploadAttempts = options.uploadAttempts ?? 12;
    const uploadBackoffMs = options.uploadBackoffMs ?? 3000;
    const pollAttempts = options.pollAttempts ?? 40;
    const pollIntervalMs = options.pollIntervalMs ?? 2000;

    const encrypted = await this.seal.encrypt(bytes, sealPolicyId);

    // Upload with a retry loop on the post-finalize mirror_missing_grant 403.
    let uploadResult: FileUploadResponse | undefined;
    for (let attempt = 0; attempt < uploadAttempts; attempt++) {
      try {
        uploadResult = await this.client.uploadBucketFile(
          bucketId,
          encrypted,
          fileName,
          options.metadata,
        );
        break;
      } catch (err) {
        if (isMirrorMissingGrant(err) && attempt < uploadAttempts - 1) {
          await sleep(uploadBackoffMs);
          continue;
        }
        throw err;
      }
    }
    if (!uploadResult) {
      throw new MirrorGrantMissingError({ bucketId, attempt: uploadAttempts });
    }

    const fileId = uploadResult.data.id;

    // Poll until completed or failed.
    let lastState = "queued";
    for (let i = 0; i < pollAttempts; i++) {
      const status = await this.client.getFileUploadStatus(bucketId, fileId);
      lastState = status.data.state;
      if (status.data.state === "completed") return fileId;
      if (status.data.state === "failed") {
        throw new FileStatusError({
          fileId,
          state: status.data.state,
          error: status.data.error ?? { code: "unknown", message: "Upload failed" },
        });
      }
      await sleep(pollIntervalMs);
    }

    throw new FileStatusError({
      fileId,
      state: lastState,
      error: { code: "timeout", message: "Upload did not complete in time" },
    });
  }

  /** Download a file and decrypt it with the bucket's sealPolicyId. */
  async getDecrypted(
    bucketId: BucketId,
    sealPolicyId: string,
    fileId: FileId,
  ): Promise<Uint8Array> {
    const ciphertext = await this.client.downloadBucketFile(bucketId, fileId);
    return this.seal.decrypt(ciphertext, sealPolicyId);
  }
}

/**
 * Build a {@link HarborConfig} from environment variables.
 *
 * Reads HARBOR_BASE_URL, HARBOR_API_KEY, HARBOR_SERVICE_PRIVATE_KEY, and
 * HARBOR_DEFAULT_SPACE_ID. Secrets live only in the gitignored env files and are
 * never hardcoded. Throws if the API key is missing.
 */
export function harborConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): HarborConfig {
  const apiKey = env.HARBOR_API_KEY;
  if (!apiKey) {
    throw new HarborError({
      message:
        "HARBOR_API_KEY is not set. Add it to .env.local / .dev.vars before using Harbor.",
    });
  }
  const baseUrl = env.HARBOR_BASE_URL ?? "https://api.testnet.harbor.walrus.xyz";
  const servicePrivateKey = env.HARBOR_SERVICE_PRIVATE_KEY ?? "";
  const defaultSpaceId = env.HARBOR_DEFAULT_SPACE_ID;
  return {
    baseUrl,
    apiKey,
    servicePrivateKey,
    ...(defaultSpaceId ? { defaultSpaceId } : {}),
  };
}
