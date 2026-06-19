import { EncryptedObject, SealClient, SessionKey } from "@mysten/seal";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { SuiJsonRpcClient } from "@mysten/sui/jsonRpc";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, fromHex } from "@mysten/sui/utils";

import {
  HARBOR_LATEST_PACKAGE_ID,
  HARBOR_ORIGINAL_PACKAGE_ID,
  SEAL_KEY_SERVER_OBJECT_IDS,
  SealIdentity,
  type SealIdentityInput,
  SUI_TESTNET_FULLNODE,
} from "./constants.js";
import { SealCryptoError } from "./errors.js";

// The seal SDK types its `suiClient` as a structural `SealCompatibleClient`.
// `SuiJsonRpcClient` satisfies it at runtime (this is exactly the quickstart
// pairing) but the nominal generics don't always line up across @mysten releases,
// so we keep one narrow cast at the construction boundary.
type SealCompatibleClient = ConstructorParameters<typeof SealClient>[0]["suiClient"];

/**
 * SealCrypto — the heart of private (encrypted) Harbor operations.
 *
 * All client-side Seal encryption, decryption, and Sui signing happens here.
 * This **must** run locally (never on a remote server) because it holds the
 * user's service private key.
 *
 * Plain async/await port of the Effect `SealCryptoService`.
 */
export class SealCrypto {
  private readonly servicePrivateKey: string;
  private keypair: Ed25519Keypair | undefined;

  // SuiJsonRpcClient + SealClient are stateless config holders (no network I/O
  // until a call is made), so build them once. The keypair stays lazy so a
  // missing service key never fails construction.
  private readonly suiClient: SuiJsonRpcClient;
  private readonly sealClient: SealClient;

  constructor(config: { servicePrivateKey: string }) {
    this.servicePrivateKey = config.servicePrivateKey;
    this.suiClient = new SuiJsonRpcClient({
      url: SUI_TESTNET_FULLNODE,
      network: "testnet",
    });
    this.sealClient = new SealClient({
      suiClient: this.suiClient as unknown as SealCompatibleClient,
      serverConfigs: SEAL_KEY_SERVER_OBJECT_IDS.map((objectId) => ({
        objectId,
        weight: 1,
      })),
      verifyKeyServers: false, // testnet convenience (matches quickstart)
    });
  }

  /** Lazily decode the service private key into an Ed25519 keypair. */
  getKeypair(): Ed25519Keypair {
    if (this.keypair) return this.keypair;
    const raw = this.servicePrivateKey;
    if (!raw || raw.length < 20) {
      throw new SealCryptoError({
        message: "HARBOR_SERVICE_PRIVATE_KEY is missing or invalid",
        step: "load_keypair",
      });
    }
    try {
      const { secretKey } = decodeSuiPrivateKey(raw);
      this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
      return this.keypair;
    } catch (cause) {
      throw new SealCryptoError({
        message: "Failed to decode service private key",
        cause,
        step: "load_keypair",
      });
    }
  }

  /**
   * Encrypt plaintext for a private bucket.
   * Returns the full encrypted object bytes ready for multipart upload.
   */
  async encrypt(plaintext: Uint8Array, sealPolicyId: string): Promise<Uint8Array> {
    // Each file gets a fresh 32-byte nonce.
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(32)));

    const idInput: SealIdentityInput = { policyObjectId: sealPolicyId, nonce };
    const id = SealIdentity.serialize(idInput).toHex();

    try {
      const { encryptedObject } = await this.sealClient.encrypt({
        threshold: 2,
        packageId: HARBOR_ORIGINAL_PACKAGE_ID,
        id,
        data: plaintext,
      });
      return encryptedObject;
    } catch (cause) {
      throw new SealCryptoError({ message: "Seal encryption failed", cause, step: "encrypt" });
    }
  }

  /** Decrypt a downloaded ciphertext using the bucket's sealPolicyId. */
  async decrypt(ciphertext: Uint8Array, sealPolicyId: string): Promise<Uint8Array> {
    const keypair = this.getKeypair();

    let txBytes: Uint8Array;
    let sessionKey: SessionKey;
    try {
      const parsed = EncryptedObject.parse(ciphertext);
      const idHex = parsed.id.startsWith("0x") ? parsed.id : `0x${parsed.id}`;
      const idBytes = fromHex(idHex);

      // Build the access-check transaction kind (never broadcast).
      const tx = new Transaction();
      tx.moveCall({
        target: `${HARBOR_LATEST_PACKAGE_ID}::bucket_policy::seal_approve`,
        arguments: [tx.pure.vector("u8", Array.from(idBytes)), tx.object(sealPolicyId)],
      });
      try {
        txBytes = await tx.build({ client: this.suiClient, onlyTransactionKind: true });
      } catch (cause) {
        throw new SealCryptoError({
          message: "Failed to build seal_approve PTB",
          cause,
          step: "build_ptb",
        });
      }

      // SessionKey lets Seal key servers verify the caller.
      try {
        sessionKey = await SessionKey.create({
          address: keypair.toSuiAddress(),
          packageId: HARBOR_ORIGINAL_PACKAGE_ID,
          ttlMin: 10,
          suiClient: this.suiClient as unknown as SealCompatibleClient,
          signer: keypair,
        });
      } catch (cause) {
        throw new SealCryptoError({
          message: "Failed to create Seal SessionKey",
          cause,
          step: "session_key",
        });
      }
    } catch (cause) {
      if (cause instanceof SealCryptoError) throw cause;
      throw new SealCryptoError({
        message: "Decryption pipeline failed",
        cause,
        step: "decrypt",
      });
    }

    try {
      return await this.sealClient.decrypt({ data: ciphertext, sessionKey, txBytes });
    } catch (cause) {
      throw new SealCryptoError({ message: "Seal decryption failed", cause, step: "decrypt" });
    }
  }

  /**
   * Sign the base64-encoded sponsored transaction bytes returned by
   * POST /api/v1/spaces/{id}/buckets (reserve step).
   * Returns the signature in the format Harbor expects for /finalize.
   */
  async signTransactionBytes(bytesBase64: string): Promise<string> {
    const keypair = this.getKeypair();
    try {
      const { signature } = await keypair.signTransaction(fromBase64(bytesBase64));
      return signature; // base64 string ready for /finalize
    } catch (cause) {
      throw new SealCryptoError({
        message: "Failed to sign sponsored transaction bytes",
        cause,
        step: "sign",
      });
    }
  }
}
