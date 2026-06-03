#!/usr/bin/env bun
// Verifies a real round-trip against the PUBLIC MemWal relayer
// (https://relayer.memwal.ai) using the signed-request scheme documented in
// the relayer API reference:
//
//   signed_string = "{timestamp}.{method}.{path_and_query}.{body_sha256}.{nonce}.{account_id}"
//   x-public-key  = hex Ed25519 public key
//   x-signature   = hex Ed25519 signature over signed_string
//   x-timestamp   = unix seconds
//   x-nonce       = UUID v4
//   x-account-id  = MemWal account id
//
// Credentials are pulled from MEMWAL_ACCOUNT_ID + MEMWAL_PRIVATE_KEY env vars
// (no plaintext in this file). The private key is the raw 32-byte Ed25519
// seed as hex.

import { createHash, createPrivateKey, sign, randomUUID } from "node:crypto";

const accountId = process.env.MEMWAL_ACCOUNT_ID;
const privateKeyHex = process.env.MEMWAL_PRIVATE_KEY;
const relayerBase = process.env.MEMWAL_BASE_URL ?? "https://relayer.memwal.ai";

if (!accountId || !privateKeyHex) {
  console.error("Set MEMWAL_ACCOUNT_ID and MEMWAL_PRIVATE_KEY env vars first.");
  process.exit(1);
}
if (privateKeyHex.length !== 64) {
  console.error(`MEMWAL_PRIVATE_KEY should be 64 hex chars (32-byte Ed25519 seed); got ${privateKeyHex.length}.`);
  process.exit(1);
}

// Wrap raw 32-byte seed into PKCS#8 DER so node:crypto.createPrivateKey accepts it.
function rawSeedToPkcs8(seedHex: string): Buffer {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  // PKCS#8 prefix for Ed25519 OID (1.3.101.112) + OCTET STRING wrapper for the 32-byte seed.
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  return Buffer.concat([prefix, seed]);
}

const privateKey = createPrivateKey({ key: rawSeedToPkcs8(privateKeyHex), format: "der", type: "pkcs8" });

// Derive the matching public key for x-public-key.
import { createPublicKey } from "node:crypto";
const publicKeyObj = createPublicKey(privateKey);
const publicKeyDer = publicKeyObj.export({ format: "der", type: "spki" });
// The last 32 bytes of an Ed25519 SPKI DER are the raw public key.
const publicKeyRaw = publicKeyDer.subarray(publicKeyDer.length - 32);
const publicKeyHex = publicKeyRaw.toString("hex");

async function signedFetch(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const bodyText = JSON.stringify(body);
  const bodySha256 = createHash("sha256").update(bodyText).digest("hex");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomUUID();
  const method = "POST";
  const signedString = `${timestamp}.${method}.${path}.${bodySha256}.${nonce}.${accountId}`;
  const signature = sign(null, Buffer.from(signedString), privateKey).toString("hex");

  const headers = {
    "content-type": "application/json",
    "x-public-key": publicKeyHex,
    "x-signature": signature,
    "x-timestamp": timestamp,
    "x-nonce": nonce,
    "x-account-id": accountId!
  };

  const response = await fetch(`${relayerBase}${path}`, { method, headers, body: bodyText });
  return { status: response.status, text: await response.text() };
}

const namespace = `ctxm-verify-${randomUUID().slice(0, 8)}`;
const probeText = `ContextMeM verification probe at ${new Date().toISOString()}: dark mode preferred.`;

console.log("=== Identity ===");
console.log("relayer:    ", relayerBase);
console.log("accountId:  ", `${accountId.slice(0, 12)}...${accountId.slice(-8)}`);
console.log("publicKey:  ", `${publicKeyHex.slice(0, 12)}...${publicKeyHex.slice(-8)}`);
console.log("namespace:  ", namespace);
console.log();

console.log("=== POST /api/remember ===");
const remember = await signedFetch("/api/remember", { text: probeText, namespace });
console.log(`status: ${remember.status}`);
console.log(`body:   ${remember.text.slice(0, 600)}`);

if (remember.status >= 400) {
  console.error("\nRemember failed; not attempting recall.");
  process.exit(1);
}

console.log("\n=== Waiting 4s for indexing ===");
await new Promise((r) => setTimeout(r, 4000));

console.log("\n=== POST /api/recall ===");
const recall = await signedFetch("/api/recall", { query: "what did the user prefer about the UI?", namespace, limit: 5 });
console.log(`status: ${recall.status}`);
console.log(`body:   ${recall.text.slice(0, 800)}`);

console.log("\n=== Done ===");
