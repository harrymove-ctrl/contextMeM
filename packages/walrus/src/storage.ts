import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { WalrusStorageReceipt } from "@contextmem/core";

// ContextMeM uploads its REAL proof artifacts — the tarred `context/` bundle
// (manifest.json, llms.txt, markdown chunks, proofs.json, screenshots) — to
// Walrus persistent storage through Tatum's REST gateway. Walrus *Storage*
// holds the bytes; Walrus *Memory* (MemWal) only remembers the semantic index
// (blobId, jobId, digest, what-changed) so an agent can recall + re-fetch it.
//
// Endpoint + auth follow Tatum's Walrus storage docs: a multipart POST returns
// a jobId + pre-computed blobId, then you poll the same path until the upload
// is CERTIFIED on the Walrus network. https://tatum.io/mcp + /v4/data/storage.

const DEFAULT_TATUM_STORAGE_URL = "https://api.tatum.io/v4/data/storage/upload";

export type TatumStorageConfig = {
  apiKey?: string;
  endpoint?: string;
};

export type WalrusStorageUploadInput = {
  fileName: string;
  data: Uint8Array;
  contentType?: string;
};

export type WalrusStorageUploadAccepted = {
  jobId: string;
  blobId?: string;
  status?: string;
  raw: unknown;
};

export type WalrusStorageJobState = {
  jobId: string;
  status: string;
  blobId?: string;
  certified: boolean;
  failed: boolean;
  downloadUrls?: string[];
  raw: unknown;
};

function resolveConfig(config: TatumStorageConfig = {}): { apiKey: string; endpoint: string } {
  const apiKey = config.apiKey ?? process.env.TATUM_API_KEY;
  const endpoint = config.endpoint ?? process.env.TATUM_STORAGE_URL ?? DEFAULT_TATUM_STORAGE_URL;
  if (!apiKey) {
    throw new Error(
      "TATUM_API_KEY is not configured. Set a Tatum mainnet API key (https://tatum.io) to upload proof bundles to Walrus storage."
    );
  }
  return { apiKey, endpoint: stripTrailingSlash(endpoint) };
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function pickString(value: unknown, keys: string[]): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const found = record[key];
    if (typeof found === "string" && found.length > 0) return found;
  }
  // Tatum sometimes nests the payload under `data`.
  const data = record.data;
  if (data && typeof data === "object") return pickString(data, keys);
  return undefined;
}

function pickUrls(value: unknown): string[] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["downloadUrls", "urls", "url", "downloadUrl"]) {
    const found = record[key];
    if (Array.isArray(found)) {
      const urls = found.filter((item): item is string => typeof item === "string");
      if (urls.length) return urls;
    }
    if (typeof found === "string" && found.length) return [found];
  }
  const data = record.data;
  if (data && typeof data === "object") return pickUrls(data);
  return undefined;
}

/** Async POST: returns immediately with a jobId + pre-computed blobId. */
export async function uploadToWalrusStorage(
  input: WalrusStorageUploadInput,
  config: TatumStorageConfig = {}
): Promise<WalrusStorageUploadAccepted> {
  const { apiKey, endpoint } = resolveConfig(config);
  const form = new FormData();
  const blob = new Blob([input.data as unknown as BlobPart], { type: input.contentType ?? "application/octet-stream" });
  form.append("file", blob, input.fileName);
  const response = await fetch(endpoint, { method: "POST", headers: { "x-api-key": apiKey }, body: form });
  const raw = await readBody(response);
  if (!response.ok) {
    throw new Error(`Tatum Walrus storage upload failed: ${response.status} ${response.statusText} — ${JSON.stringify(raw)}`);
  }
  const jobId = pickString(raw, ["jobId", "job_id", "id"]);
  if (!jobId) throw new Error(`Tatum Walrus storage upload returned no jobId: ${JSON.stringify(raw)}`);
  return {
    jobId,
    blobId: pickString(raw, ["blobId", "blob_id"]),
    status: pickString(raw, ["status"]),
    raw
  };
}

/** Poll a single upload job's certification progress. */
export async function getWalrusStorageJob(
  jobId: string,
  config: TatumStorageConfig = {}
): Promise<WalrusStorageJobState> {
  const { apiKey, endpoint } = resolveConfig(config);
  const response = await fetch(`${endpoint}/${encodeURIComponent(jobId)}`, {
    headers: { "x-api-key": apiKey }
  });
  const raw = await readBody(response);
  if (!response.ok) {
    throw new Error(`Tatum Walrus storage status failed: ${response.status} ${response.statusText} — ${JSON.stringify(raw)}`);
  }
  const status = pickString(raw, ["status"]) ?? "UNKNOWN";
  const normalized = status.toUpperCase();
  return {
    jobId,
    status,
    blobId: pickString(raw, ["blobId", "blob_id"]),
    certified: normalized === "CERTIFIED",
    failed: normalized === "FAILED" || normalized === "ERROR",
    downloadUrls: pickUrls(raw),
    raw
  };
}

export type WaitOptions = {
  pollIntervalMs?: number;
  timeoutMs?: number;
  onPoll?: (state: WalrusStorageJobState) => void;
};

/** Poll until the upload reaches CERTIFIED (or FAILED / timeout). */
export async function waitForWalrusStorageCertified(
  jobId: string,
  options: WaitOptions = {},
  config: TatumStorageConfig = {}
): Promise<WalrusStorageJobState> {
  const pollIntervalMs = options.pollIntervalMs ?? 3000;
  const timeoutMs = options.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;
  let last: WalrusStorageJobState | undefined;
  while (Date.now() < deadline) {
    last = await getWalrusStorageJob(jobId, config);
    options.onPoll?.(last);
    if (last.certified) return last;
    if (last.failed) throw new Error(`Tatum Walrus storage upload ${jobId} reported status=${last.status}`);
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Tatum Walrus storage upload ${jobId} did not certify within ${timeoutMs}ms (last status=${last?.status ?? "?"}).`);
}

/**
 * Upload a proof bundle and (optionally) wait for certification, returning a
 * portable receipt suitable for persisting to disk and indexing in MemWal.
 */
export async function uploadProofBundle(
  input: WalrusStorageUploadInput & { artifactDigest?: string; wait?: boolean } & WaitOptions,
  config: TatumStorageConfig = {}
): Promise<WalrusStorageReceipt> {
  const accepted = await uploadToWalrusStorage(input, config);
  const uploadedAt = new Date().toISOString();
  const endpoint = config.endpoint ?? process.env.TATUM_STORAGE_URL ?? DEFAULT_TATUM_STORAGE_URL;
  const base: WalrusStorageReceipt = {
    provider: "tatum",
    endpoint: stripTrailingSlash(endpoint),
    jobId: accepted.jobId,
    blobId: accepted.blobId,
    status: accepted.status ?? "PENDING",
    certified: false,
    fileName: input.fileName,
    byteLength: input.data.byteLength,
    artifactDigest: input.artifactDigest,
    uploadedAt
  };
  if (input.wait === false) return base;
  const final = await waitForWalrusStorageCertified(
    accepted.jobId,
    { pollIntervalMs: input.pollIntervalMs, timeoutMs: input.timeoutMs, onPoll: input.onPoll },
    config
  );
  return {
    ...base,
    blobId: final.blobId ?? base.blobId,
    status: final.status,
    certified: final.certified,
    downloadUrls: final.downloadUrls,
    certifiedAt: final.certified ? new Date().toISOString() : undefined
  };
}

export type ProofBundle = {
  filePath: string;
  fileName: string;
  data: Uint8Array;
  byteLength: number;
  artifactDigest: string;
};

/**
 * Tar+gzip a run's `context/` directory into a single proof bundle and compute
 * its sha256 digest. Used by the CLI/MCP before handing the bytes to Walrus
 * storage. Node/Bun only (shells out to `tar`); never runs in the CF worker.
 */
export async function packProofBundle(runDir: string, options: { outFile?: string } = {}): Promise<ProofBundle> {
  const contextDir = path.resolve(runDir, "context");
  await fs.access(contextDir).catch(() => {
    throw new Error(`No context/ directory found in ${runDir}. Run a walrus/web extract first.`);
  });
  const runId = path.basename(path.resolve(runDir));
  const fileName = `contextmem-proof-${runId}.tgz`;
  const outFile = options.outFile
    ? path.resolve(options.outFile)
    : path.join(await fs.mkdtemp(path.join(os.tmpdir(), "ctxm-proof-")), fileName);
  await tar(["-czf", outFile, "-C", contextDir, "."]);
  const data = await fs.readFile(outFile);
  const artifactDigest = `sha256:${createHash("sha256").update(data).digest("hex")}`;
  return { filePath: outFile, fileName, data: new Uint8Array(data), byteLength: data.byteLength, artifactDigest };
}

function tar(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited with code ${code}: ${stderr.trim()}`));
    });
  });
}
