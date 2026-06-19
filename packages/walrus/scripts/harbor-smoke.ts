/**
 * Live round-trip smoke test for the Harbor + Seal client.
 *
 * MANUAL ONLY — this is NOT a vitest test. It needs real Harbor credentials and
 * hits testnet, so CI (which has no creds) must never run it.
 *
 * Run:
 *   bun packages/walrus/scripts/harbor-smoke.ts
 *
 * Bun auto-loads the repo-root .env.local; if the env vars are not present we
 * parse .env.local manually as a fallback. Required keys:
 *   HARBOR_BASE_URL, HARBOR_API_KEY, HARBOR_SERVICE_PRIVATE_KEY, HARBOR_DEFAULT_SPACE_ID
 *
 * Flow: listSpaces → createPrivateBucket → putEncrypted → getDecrypted
 * (assert byte-exact) → cleanup (deleteBucketFile + deleteBucket). Prints
 * "SMOKE PASS" / "SMOKE FAIL: <reason>" and the on-chain finalize digest.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";

import { HarborStorage, harborConfigFromEnv } from "../src/harbor/index.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const ENV_FILE = path.join(REPO_ROOT, ".env.local");

const REQUIRED_KEYS = [
  "HARBOR_BASE_URL",
  "HARBOR_API_KEY",
  "HARBOR_SERVICE_PRIVATE_KEY",
  "HARBOR_DEFAULT_SPACE_ID",
] as const;

/** Minimal .env parser — only populates keys not already in process.env. */
function loadEnvFallback(): void {
  const missing = REQUIRED_KEYS.filter((k) => !process.env[k]);
  if (missing.length === 0) return;
  let raw: string;
  try {
    raw = readFileSync(ENV_FILE, "utf8");
  } catch {
    return; // nothing to backfill from; harborConfigFromEnv will report what's missing
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function main(): Promise<void> {
  loadEnvFallback();

  const config = harborConfigFromEnv();
  const storage = new HarborStorage(config);

  // 1. listSpaces — sanity check auth + assert a default space is configured.
  const spaces = await storage.client.listSpaces();
  console.log(`listSpaces: ${spaces.length} space(s) visible`);
  const spaceId = config.defaultSpaceId;
  if (!spaceId) {
    throw new Error("HARBOR_DEFAULT_SPACE_ID is not set");
  }
  console.log(`using spaceId: ${spaceId}`);

  // 2. createPrivateBucket — reserve → sign → finalize.
  const bucketName = `ctxm-smoke-${Date.now()}`;
  const created = await storage.createPrivateBucket(spaceId, bucketName);
  console.log(`createPrivateBucket: bucketId=${created.bucketId}`);
  console.log(`  sealPolicyId=${created.sealPolicyId}`);
  console.log(`  state=${created.state}`);
  console.log(`  finalize digest=${created.digest}`);
  if (!created.sealPolicyId) {
    throw new Error("finalize returned no sealPolicyId (bucket is not private?)");
  }

  let fileId: string | undefined;
  try {
    // 3. putEncrypted — encrypt + upload + poll to completed.
    const plaintext = new Uint8Array(Buffer.from(`contextMEM harbor smoke ${Date.now()}`));
    fileId = await storage.putEncrypted(
      created.bucketId,
      created.sealPolicyId,
      plaintext,
      "smoke.txt",
    );
    console.log(`putEncrypted: fileId=${fileId} (${plaintext.length} bytes plaintext)`);

    // 4. getDecrypted — download + decrypt, assert byte-exact round trip.
    const decrypted = await storage.getDecrypted(
      created.bucketId,
      created.sealPolicyId,
      fileId,
    );
    if (!bytesEqual(decrypted, plaintext)) {
      throw new Error(
        `decrypted bytes do not match original (got ${decrypted.length} bytes, expected ${plaintext.length})`,
      );
    }
    console.log("getDecrypted: byte-exact round trip OK");
  } finally {
    // 5. cleanup — this is throwaway test data; best-effort delete.
    try {
      if (fileId) {
        await storage.client.deleteBucketFile(created.bucketId, fileId);
        console.log(`cleanup: deleted file ${fileId}`);
      }
    } catch (err) {
      console.warn(`cleanup: deleteBucketFile failed: ${String(err)}`);
    }
    try {
      await storage.client.deleteBucket(created.bucketId);
      console.log(`cleanup: deleted bucket ${created.bucketId}`);
    } catch (err) {
      console.warn(`cleanup: deleteBucket failed: ${String(err)}`);
    }
  }

  console.log(`finalize digest: ${created.digest}`);
  console.log("SMOKE PASS");
}

main().catch((err) => {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`SMOKE FAIL: ${reason}`);
  if (err instanceof Error && err.stack) console.error(err.stack);
  process.exitCode = 1;
});
