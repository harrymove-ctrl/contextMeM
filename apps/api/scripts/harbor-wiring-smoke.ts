/**
 * Harbor wiring smoke test (fallback integration harness).
 *
 * Drives the WORKER's OWN code path:
 *   storeNamespaceImport()  (write)  ->  CloudflareNamespaceStore.readArtifact()  (read)
 * with in-memory fakes for D1 (bun:sqlite-backed, runs the REAL migration schema +
 * REAL SQL) and R2 (Map + put-counter), and the REAL Harbor creds from .env.local
 * (so the worker's own resolveHarborConfig(env) runs against real Harbor + Seal).
 *
 * Asserts:
 *  1. PRIVATE import -> ciphertext goes to Harbor; readArtifact decrypts to EXACT plaintext.
 *  2. R2 received ZERO puts for the private file (no plaintext leak).
 *  3. BACKWARD-COMPAT: a legacy artifact row (r2_key set, harbor_file_id NULL) still
 *     reads back from R2.
 *
 * Cleans up the real Harbor bucket it created.
 *
 * Run:  bun apps/api/scripts/harbor-wiring-smoke.ts   (from repo root)
 *
 * SAFETY: reads creds only from env files; never commits/pushes/deploys; never
 * writes secrets anywhere. Public-namespace / unconfigured behavior is untouched.
 */
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { harbor } from "@contextmem/walrus";
import { storeNamespaceImport, updateNamespaceArtifact, CloudflareNamespaceStore, type WorkerEnv } from "../src/worker.ts";

type ImportInput = Parameters<typeof storeNamespaceImport>[0];

const logs: string[] = [];
const log = (...parts: unknown[]) => {
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");
  logs.push(line);
  console.log(line);
};

function fail(msg: string): never {
  log("FAIL:", msg);
  console.error("\n----- LOGS -----\n" + logs.join("\n"));
  process.exit(1);
}

// ----- dotenv (read real creds; never hardcode) -----
function loadDotenv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  let txt: string;
  try {
    txt = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const raw of txt.split(/\r?\n/)) {
    const m = raw.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

// ----- in-memory D1 backed by a real SQLite engine (bun:sqlite) -----
function normParam(v: unknown): unknown {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v;
}

class FakeStmt {
  params: unknown[] = [];
  constructor(private readonly db: Database, public readonly sql: string) {}
  bind(...values: unknown[]): FakeStmt {
    this.params = values.map(normParam);
    return this;
  }
  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.query(this.sql).get(...(this.params as never[])) as T) ?? null;
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...(this.params as never[])) as T[] };
  }
  async run(): Promise<unknown> {
    return this.db.query(this.sql).run(...(this.params as never[]));
  }
}

class FakeD1 {
  constructor(public readonly db: Database) {}
  prepare(sql: string): FakeStmt {
    return new FakeStmt(this.db, sql);
  }
  async batch(statements: FakeStmt[]): Promise<unknown> {
    const tx = this.db.transaction((list: FakeStmt[]) => {
      for (const s of list) this.db.query(s.sql).run(...(s.params as never[]));
    });
    tx(statements);
    return [];
  }
}

// ----- in-memory R2 with a put-counter -----
class FakeR2 {
  store = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  putLog: string[] = [];
  async get(key: string) {
    const o = this.store.get(key);
    if (!o) return null;
    const ab = o.bytes.buffer.slice(o.bytes.byteOffset, o.bytes.byteOffset + o.bytes.byteLength);
    return {
      text: async () => new TextDecoder().decode(o.bytes),
      arrayBuffer: async () => ab,
    };
  }
  async put(key: string, value: string | ArrayBuffer | Uint8Array, opts?: { httpMetadata?: { contentType?: string } }) {
    this.putLog.push(key);
    let bytes: Uint8Array;
    if (typeof value === "string") bytes = new TextEncoder().encode(value);
    else if (value instanceof Uint8Array) bytes = value;
    else bytes = new Uint8Array(value);
    this.store.set(key, { bytes, contentType: opts?.httpMetadata?.contentType });
    return {};
  }
  seed(key: string, bytes: Uint8Array, contentType?: string) {
    this.store.set(key, { bytes, contentType });
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function main() {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const fileEnv = {
    ...loadDotenv(join(repoRoot, "apps/api/cloudflare/.dev.vars")),
    ...loadDotenv(join(repoRoot, ".env.local")),
  };
  // Prefer real creds from files; fall back to process.env if present.
  const get = (k: string) => fileEnv[k] ?? process.env[k];
  const HARBOR_API_KEY = get("HARBOR_API_KEY");
  const HARBOR_SERVICE_PRIVATE_KEY = get("HARBOR_SERVICE_PRIVATE_KEY");
  if (!HARBOR_API_KEY || !HARBOR_SERVICE_PRIVATE_KEY) {
    fail("Harbor creds missing (HARBOR_API_KEY / HARBOR_SERVICE_PRIVATE_KEY) in .env.local / .dev.vars — cannot run round-trip.");
  }

  // Build a real SQLite DB and apply the real migrations (0001..0007).
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  const migDir = join(repoRoot, "apps/api/migrations");
  const migFiles = readdirSync(migDir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of migFiles) {
    db.exec(readFileSync(join(migDir, f), "utf8"));
  }
  log("migrations applied:", migFiles.join(", "));

  const r2 = new FakeR2();
  const env: WorkerEnv = {
    CONTEXTMEM_DB: new FakeD1(db) as unknown as WorkerEnv["CONTEXTMEM_DB"],
    CONTEXTMEM_CONTEXT_BUCKET: r2 as unknown as WorkerEnv["CONTEXTMEM_CONTEXT_BUCKET"],
    CONTEXTMEM_WORKER_BASE_URL: "https://harbor-smoke.local",
    HARBOR_BASE_URL: get("HARBOR_BASE_URL"),
    HARBOR_API_KEY,
    HARBOR_SERVICE_PRIVATE_KEY,
    HARBOR_DEFAULT_SPACE_ID: get("HARBOR_DEFAULT_SPACE_ID"),
  };
  log("HARBOR_BASE_URL:", env.HARBOR_BASE_URL ?? "(default)");
  log("HARBOR_DEFAULT_SPACE_ID set:", Boolean(env.HARBOR_DEFAULT_SPACE_ID));

  // ============ 1) PRIVATE import round-trip ============
  // Use a /site/*.md artifact so the SAME private bucket also exercises the
  // inline edit path (updateNamespaceArtifact only edits /site/*.md).
  const namespace = `harbor-smoke-${Date.now()}`;
  const artifactPath = "/site/page.md";
  const PLAINTEXT = `harbor-smoke PRIVATE payload :: ${crypto.randomUUID()} :: unicode 🔐✓ :: ${new Date().toISOString()}`;
  const plaintextBytes = new TextEncoder().encode(PLAINTEXT);

  const input: ImportInput = {
    namespace,
    visibility: "private",
    ownerId: "anonymous",
    tags: [],
    sourceType: "import",
    directoryEnabled: false,
    target: "https://example.com/harbor-smoke",
    buildKind: "single",
    manifest: { schemaVersion: 1, generatedBy: "harbor-wiring-smoke" },
    files: [{ path: artifactPath, contentType: "text/plain; charset=utf-8", encoding: "utf8", content: PLAINTEXT }],
  } as ImportInput;

  const request = new Request("https://harbor-smoke.local/api/namespaces/import", { method: "POST" });

  log("\n[1] storeNamespaceImport (private)... encrypting + uploading to Harbor (may take ~10-60s for finalize+mirror-grant+poll)");
  let importResult: Awaited<ReturnType<typeof storeNamespaceImport>>;
  try {
    importResult = await storeNamespaceImport(input, request, env);
  } catch (err) {
    fail(`storeNamespaceImport threw: ${(err as Error).stack ?? String(err)}`);
  }
  log("import response versionId:", importResult.versionId, "visibility:", importResult.visibility);

  // Inspect persisted rows.
  const nsRow = db
    .query("SELECT harbor_space_id, harbor_bucket_id, harbor_seal_policy_id FROM contextmem_namespaces WHERE namespace = ?")
    .get(namespace) as { harbor_space_id: string | null; harbor_bucket_id: string | null; harbor_seal_policy_id: string | null } | null;
  const artRow = db
    .query("SELECT path, r2_key, harbor_file_id, harbor_bucket_id FROM contextmem_namespace_artifacts WHERE namespace = ?")
    .get(namespace) as { path: string; r2_key: string; harbor_file_id: string | null; harbor_bucket_id: string | null } | null;

  log("namespace row harbor:", nsRow);
  log("artifact row harbor:", artRow);

  const bucketId = nsRow?.harbor_bucket_id ?? null;
  const fileId = artRow?.harbor_file_id ?? null;
  const sealPolicyId = nsRow?.harbor_seal_policy_id ?? null;

  if (!bucketId) fail("namespace row has no harbor_bucket_id after private import");
  if (!sealPolicyId) fail("namespace row has no harbor_seal_policy_id after private import");
  if (!fileId) fail("artifact row has no harbor_file_id after private import");
  if (artRow!.r2_key !== `harbor:${fileId}`) fail(`artifact r2_key sentinel wrong: ${artRow!.r2_key} (expected harbor:${fileId})`);
  if (artRow!.harbor_bucket_id !== bucketId) fail("artifact harbor_bucket_id != namespace harbor_bucket_id");

  // No-plaintext-leak assertion.
  if (r2.putLog.length !== 0) fail(`R2 received ${r2.putLog.length} put(s) during private import (expected 0): ${r2.putLog.join(", ")}`);
  log("R2 put count during private import:", r2.putLog.length, "(expected 0) -> NO PLAINTEXT LEAK");

  // ============ 2) read back through worker code -> decrypt -> exact plaintext ============
  log("\n[2] CloudflareNamespaceStore.readArtifact (private)... downloading + Seal-decrypt");
  const store = new CloudflareNamespaceStore(env);
  let readBack: Awaited<ReturnType<CloudflareNamespaceStore["readArtifact"]>>;
  try {
    readBack = await store.readArtifact(namespace, artifactPath);
  } catch (err) {
    fail(`readArtifact threw: ${(err as Error).stack ?? String(err)}`);
  }
  if (!readBack) fail("readArtifact returned undefined for the private Harbor artifact");
  if (readBack.encoding !== "utf8") fail(`expected utf8 encoding, got ${readBack.encoding}`);
  const readBytes = new TextEncoder().encode(readBack.content);
  const exact = readBack.content === PLAINTEXT;
  const byteEq = bytesEqual(readBytes, plaintextBytes);
  log("readback content === sent:", exact, "| byte-equal:", byteEq, "| bytes:", plaintextBytes.byteLength);
  if (!exact || !byteEq) {
    log("SENT   :", JSON.stringify(PLAINTEXT));
    log("GOT    :", JSON.stringify(readBack.content));
    fail("round-trip byte mismatch");
  }

  // Crucial: R2 was NOT touched by the private read either.
  log("R2 put count after private read:", r2.putLog.length, "(still 0)");

  // ============ 2.5) PRIVATE inline edit (updateNamespaceArtifact) ============
  // The edit MUST re-encrypt to Harbor and produce ZERO R2 puts (no plaintext
  // leak), rotate harbor_file_id, and read back as the EDITED plaintext.
  log("\n[2.5] updateNamespaceArtifact (private /site/*.md edit)... re-encrypt + re-upload to Harbor");

  // Regression seed for the version-scoping fix (adversarial review must-fix #1/#2):
  // a STALE older-version row for the SAME path, R2-only (harbor_file_id NULL), with
  // a version_id that sorts BEFORE the current one. An UNSCOPED classification
  // .first() walks the (namespace,version_id,path) PK index oldest-first and would
  // return THIS row -> misclassify the private edit as plaintext-to-R2 (the leak).
  const staleVersion = `0000-stale-${Date.now()}`;
  const staleR2Key = `namespaces/stale/${staleVersion}${artifactPath}`;
  r2.seed(staleR2Key, new TextEncoder().encode("STALE old-version plaintext"), "text/markdown; charset=utf-8");
  const staleIso = new Date().toISOString();
  db.query(
    "INSERT INTO contextmem_namespace_versions (id, namespace, manifest_json, artifact_count, byte_length, created_at) VALUES (?,?,?,?,?,?)"
  ).run(staleVersion, namespace, JSON.stringify({ schemaVersion: 1 }), 1, 27, staleIso);
  db.query(
    "INSERT INTO contextmem_namespace_artifacts (namespace, version_id, path, r2_key, content_type, kind, size, sha256, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(namespace, staleVersion, artifactPath, staleR2Key, "text/markdown; charset=utf-8", "text", 27, null, staleIso);
  log("seeded stale older-version R2 row at version", staleVersion, "(unscoped .first() would pick this)");

  const r2PutsBeforeEdit = r2.putLog.length; // expected 0 so far (seed uses .seed, not .put)
  const EDITED = `harbor-smoke EDITED payload :: ${crypto.randomUUID()} :: 🔁🔐 :: ${new Date().toISOString()}`;
  const editReq = new Request(
    "https://harbor-smoke.local/api/namespaces/" + encodeURIComponent(namespace) + "/artifact-edit",
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-memwal-account-id": "anonymous" },
      body: JSON.stringify({ path: artifactPath, content: EDITED }),
    }
  );
  let editResp: Response;
  try {
    editResp = await updateNamespaceArtifact(editReq, env, namespace);
  } catch (err) {
    fail(`updateNamespaceArtifact threw: ${(err as Error).stack ?? String(err)}`);
  }
  const editJson = (await editResp.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  log("edit response status:", editResp.status, "body:", editJson);
  if (editResp.status !== 200 || editJson.ok !== true) {
    fail(`edit did not succeed: status=${editResp.status} body=${JSON.stringify(editJson)}`);
  }

  // No-plaintext-leak assertion for the EDIT path (the bug this fix closes).
  const r2PutsFromEdit = r2.putLog.length - r2PutsBeforeEdit;
  if (r2PutsFromEdit !== 0) fail(`R2 received ${r2PutsFromEdit} put(s) during private edit (expected 0): ${r2.putLog.join(", ")}`);
  log("R2 put count from edit:", r2PutsFromEdit, "(expected 0) -> NO PLAINTEXT LEAK ON EDIT");

  // harbor_file_id must rotate (new ciphertext) and the r2_key sentinel must follow.
  const artRowAfter = db
    .query("SELECT r2_key, harbor_file_id, harbor_bucket_id, size FROM contextmem_namespace_artifacts WHERE namespace = ? AND path = ?")
    .get(namespace, artifactPath) as { r2_key: string; harbor_file_id: string | null; harbor_bucket_id: string | null; size: number } | null;
  log("artifact row after edit:", artRowAfter);
  if (!artRowAfter?.harbor_file_id) fail("artifact has no harbor_file_id after edit");
  if (artRowAfter.harbor_file_id === fileId) fail("harbor_file_id did NOT rotate on edit (same ciphertext file id)");
  if (artRowAfter.r2_key !== `harbor:${artRowAfter.harbor_file_id}`) fail(`edit r2_key sentinel wrong: ${artRowAfter.r2_key}`);
  if (artRowAfter.harbor_bucket_id !== bucketId) fail("edit changed harbor_bucket_id unexpectedly");

  // The stale older-version row must be UNTOUCHED (UPDATE is version-scoped, must-fix #2).
  const staleAfter = db
    .query("SELECT r2_key, harbor_file_id FROM contextmem_namespace_artifacts WHERE namespace = ? AND version_id = ? AND path = ?")
    .get(namespace, staleVersion, artifactPath) as { r2_key: string; harbor_file_id: string | null } | null;
  if (!staleAfter || staleAfter.r2_key !== staleR2Key || staleAfter.harbor_file_id !== null) {
    fail(`edit corrupted the stale older-version row (UPDATE not version-scoped): ${JSON.stringify(staleAfter)}`);
  }
  log("stale older-version row untouched by edit (UPDATE version-scoped):", staleAfter.r2_key);

  // Read back the EDITED plaintext through the worker (downloads + Seal-decrypt).
  const editedRead = await store.readArtifact(namespace, artifactPath);
  if (!editedRead) fail("readArtifact returned undefined after edit");
  const editExact = editedRead.content === EDITED;
  log("edited readback content === EDITED:", editExact, "| new fileId:", artRowAfter.harbor_file_id);
  if (!editExact) {
    log("EXPECTED:", JSON.stringify(EDITED));
    log("GOT     :", JSON.stringify(editedRead.content));
    fail("edited round-trip mismatch");
  }

  // ============ 3) BACKWARD-COMPAT: legacy R2-only artifact (no harbor_file_id) ============
  log("\n[3] backward-compat: legacy R2 artifact (r2_key set, harbor_file_id NULL)");
  const legacyNs = `legacy-r2-${Date.now()}`;
  const legacyVersion = `v-legacy-${Date.now()}`;
  const legacyPath = "/legacy.txt";
  const legacyR2Key = `namespaces/legacy/${legacyVersion}${legacyPath}`;
  const legacyContent = `LEGACY r2 plaintext :: ${crypto.randomUUID()}`;
  r2.seed(legacyR2Key, new TextEncoder().encode(legacyContent), "text/plain; charset=utf-8");
  const nowIso = new Date().toISOString();
  db.query(
    "INSERT INTO contextmem_namespaces (namespace, target, visibility, current_version_id, manifest_json, artifact_count, byte_length, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(legacyNs, "https://example.com/legacy", "public", legacyVersion, JSON.stringify({ schemaVersion: 1 }), 1, legacyContent.length, nowIso, nowIso);
  db.query(
    "INSERT INTO contextmem_namespace_versions (id, namespace, manifest_json, artifact_count, byte_length, created_at) VALUES (?,?,?,?,?,?)"
  ).run(legacyVersion, legacyNs, JSON.stringify({ schemaVersion: 1 }), 1, legacyContent.length, nowIso);
  // harbor_file_id / harbor_bucket_id intentionally omitted -> NULL.
  db.query(
    "INSERT INTO contextmem_namespace_artifacts (namespace, version_id, path, r2_key, content_type, kind, size, sha256, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).run(legacyNs, legacyVersion, legacyPath, legacyR2Key, "text/plain; charset=utf-8", "text", legacyContent.length, null, nowIso);

  const legacyRead = await store.readArtifact(legacyNs, legacyPath);
  if (!legacyRead) fail("legacy readArtifact returned undefined");
  const legacyOk = legacyRead.encoding === "utf8" && legacyRead.content === legacyContent;
  log("legacy read from R2 ok:", legacyOk, "| encoding:", legacyRead.encoding);
  if (!legacyOk) {
    log("legacy SENT:", JSON.stringify(legacyContent), "GOT:", JSON.stringify(legacyRead.content));
    fail("backward-compat (R2 fallback) failed");
  }

  // ============ cleanup: delete the real Harbor bucket we created ============
  log("\n[cleanup] deleting Harbor bucket", bucketId);
  let cleanup = "skipped";
  try {
    const cfg = harbor.harborConfigFromEnv({
      HARBOR_BASE_URL: env.HARBOR_BASE_URL,
      HARBOR_API_KEY: env.HARBOR_API_KEY,
      HARBOR_SERVICE_PRIVATE_KEY: env.HARBOR_SERVICE_PRIVATE_KEY,
      HARBOR_DEFAULT_SPACE_ID: env.HARBOR_DEFAULT_SPACE_ID,
    });
    const res = await new harbor.HarborStorage(cfg).client.deleteBucket(bucketId);
    cleanup = `deleted ${JSON.stringify(res)}`;
  } catch (err) {
    cleanup = `cleanup-failed (non-fatal): ${(err as Error).message}`;
  }
  log("[cleanup]", cleanup);

  log("\n===== RESULT: PASS =====");
  log("harbor bucketId:", bucketId);
  log("harbor fileId:", fileId);
  log("harbor sealPolicyId:", sealPolicyId);
  log("harbor spaceId:", nsRow?.harbor_space_id ?? "(null)");
  log("round-trip byte-equal:", byteEq);
  log("R2 plaintext puts for private file:", 0);
  log("inline-edit re-encrypted to Harbor (0 R2 puts), fileId rotated:", artRowAfter?.harbor_file_id ?? "(null)");
  log("backward-compat R2 fallback:", legacyOk);
}

main().catch((err) => fail((err as Error).stack ?? String(err)));
