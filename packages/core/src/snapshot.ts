import fs from "node:fs/promises";
import path from "node:path";
import type { SnapshotArtifactRef, SnapshotManifest, SnapshotSignature } from "./types.js";
import { chunkGraphDigest, parseChunksNdjson } from "./chunks.js";
import { sha256Hex } from "./utils.js";

export type BuildSnapshotInput = {
  runId: string;
  target: string;
  sourceType: "web" | "walrus";
  namespace?: string;
  outputDir: string;
  chunkGraphDigest?: string;
  signingKey?: string;
};

/**
 * Content-addressed manifest over the finalized /context artifact set.
 * - artifactDigest: integrity root over the exact bytes of this package.
 * - chunkGraphDigest: deterministic, source-derived (same source => same value).
 * - signature: optional Ed25519 over artifactDigest when a signing key is set.
 */
export async function buildSnapshotManifest(input: BuildSnapshotInput): Promise<SnapshotManifest> {
  const { artifacts, artifactDigest, totalBytes } = await hashContextArtifacts(input.outputDir);
  const proof = artifacts.find((artifact) => artifact.path === "/context/proofs.json");
  const signature = await maybeSign(artifactDigest, input.signingKey ?? process.env.CONTEXTMEM_SIGNING_KEY);

  return {
    schemaVersion: 1,
    runId: input.runId,
    target: input.target,
    sourceType: input.sourceType,
    namespace: input.namespace,
    createdAt: new Date().toISOString(),
    artifactDigest,
    chunkGraphDigest: input.chunkGraphDigest,
    proofDigest: proof?.sha256,
    artifactCount: artifacts.length,
    totalBytes,
    artifacts,
    signature
  };
}

export type SnapshotVerification = {
  ok: boolean;
  runId?: string;
  artifactDigest: { expected: string; actual: string; ok: boolean };
  chunkGraphDigest: { expected?: string; actual?: string; ok: boolean };
  signature: { present: boolean; ok: boolean | null };
  artifacts: { total: number; mismatched: string[]; missing: string[]; extra: string[] };
};

/** Recompute a run's digests/signature and check them against its snapshot.json. */
export async function verifySnapshot(outputDir: string): Promise<SnapshotVerification> {
  const contextDir = path.join(outputDir, "context");
  const manifestRaw = await fs.readFile(path.join(contextDir, "snapshot.json"), "utf8").catch(() => null);
  if (!manifestRaw) throw new Error("No context/snapshot.json found; this run predates snapshot manifests or is incomplete.");
  const manifest = JSON.parse(manifestRaw) as SnapshotManifest;

  const { artifacts, artifactDigest } = await hashContextArtifacts(outputDir);
  const actualByPath = new Map(artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  const expectedByPath = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact.sha256]));
  const mismatched: string[] = [];
  const missing: string[] = [];
  for (const [artifactPath, expectedHash] of expectedByPath) {
    const actualHash = actualByPath.get(artifactPath);
    if (actualHash === undefined) missing.push(artifactPath);
    else if (actualHash !== expectedHash) mismatched.push(artifactPath);
  }
  const extra = [...actualByPath.keys()].filter((artifactPath) => !expectedByPath.has(artifactPath));

  const chunksText = await fs.readFile(path.join(contextDir, "chunks.ndjson"), "utf8").catch(() => "");
  const actualChunkDigest = chunksText.trim() ? chunkGraphDigest(parseChunksNdjson(chunksText)) : undefined;

  const signatureOk = manifest.signature ? await verifySignature(manifest.artifactDigest, manifest.signature) : null;
  const artifactDigestOk = artifactDigest === manifest.artifactDigest;
  const chunkOk = (manifest.chunkGraphDigest ?? undefined) === actualChunkDigest;

  return {
    ok: artifactDigestOk && chunkOk && mismatched.length === 0 && missing.length === 0 && extra.length === 0 && signatureOk !== false,
    runId: manifest.runId,
    artifactDigest: { expected: manifest.artifactDigest, actual: artifactDigest, ok: artifactDigestOk },
    chunkGraphDigest: { expected: manifest.chunkGraphDigest, actual: actualChunkDigest, ok: chunkOk },
    signature: { present: Boolean(manifest.signature), ok: signatureOk },
    artifacts: { total: manifest.artifacts.length, mismatched, missing, extra }
  };
}

async function hashContextArtifacts(outputDir: string): Promise<{ artifacts: SnapshotArtifactRef[]; artifactDigest: string; totalBytes: number }> {
  const contextDir = path.join(outputDir, "context");
  const relPaths = (await listFilesRecursive(contextDir, outputDir)).filter((rel) => routeOf(rel) !== "/context/snapshot.json").sort();
  const artifacts: SnapshotArtifactRef[] = [];
  let totalBytes = 0;
  for (const rel of relPaths) {
    const bytes = await fs.readFile(path.join(outputDir, rel));
    artifacts.push({ path: routeOf(rel), sha256: sha256Hex(bytes), bytes: bytes.byteLength });
    totalBytes += bytes.byteLength;
  }
  const artifactDigest = sha256Hex(artifacts.map((artifact) => `${artifact.path}:${artifact.sha256}`).join("\n"));
  return { artifacts, artifactDigest, totalBytes };
}

async function verifySignature(digestHex: string, signature: SnapshotSignature): Promise<boolean> {
  try {
    const { verifyPersonalMessageSignature } = (await import("@mysten/sui/verify")) as {
      verifyPersonalMessageSignature: (message: Uint8Array, signature: string) => Promise<{ toBase64(): string }>;
    };
    const publicKey = await verifyPersonalMessageSignature(new TextEncoder().encode(digestHex), signature.signature);
    return publicKey.toBase64() === signature.publicKey;
  } catch {
    return false;
  }
}

async function listFilesRecursive(dir: string, base: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

function routeOf(relPath: string): string {
  return `/${relPath.split(path.sep).join("/")}`;
}

async function maybeSign(digestHex: string, key?: string): Promise<SnapshotSignature | null> {
  if (!key) return null;
  try {
    const { Ed25519Keypair } = (await import("@mysten/sui/keypairs/ed25519")) as { Ed25519Keypair: KeypairCtor };
    const keypair = key.startsWith("suiprivkey") ? Ed25519Keypair.fromSecretKey(key) : Ed25519Keypair.fromSecretKey(Buffer.from(key, "base64"));
    const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(digestHex));
    return {
      scheme: "ed25519",
      publicKey: keypair.getPublicKey().toBase64(),
      signature,
      signedAt: new Date().toISOString()
    };
  } catch (error) {
    console.warn(`[contextmem] snapshot signing skipped: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

type Keypair = {
  signPersonalMessage(message: Uint8Array): Promise<{ signature: string; bytes: string }>;
  getPublicKey(): { toBase64(): string };
};

type KeypairCtor = {
  fromSecretKey(secret: string | Uint8Array): Keypair;
};
