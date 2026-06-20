import { createMcpHandler } from "agents/mcp";
import { z } from "zod";
import {
  createHostedContextMemMcpServer,
  inferHostedArtifactKind,
  isHostedTextArtifact,
  normalizeHostedArtifactPath,
  type HostedArtifactContent,
  type HostedArtifactRecord,
  type HostedNamespaceStore,
  type HostedNamespaceSummary,
  type HostedNamespaceVisibility
} from "@contextmem/mcp/hosted";
import { MemWalMcpClient } from "@contextmem/memwal";
// Harbor + Seal client (on-chain-verified). Used to encrypt private-namespace
// artifacts in the Worker and store the ciphertext in a per-namespace Harbor
// bucket instead of writing plaintext to R2. See resolveHarborConfig + the
// private branch of storeNamespaceImport / readArtifact below.
import { harbor } from "@contextmem/walrus";
// Runtime fns imported from leaf SUBPATHS (not the "@contextmem/core" barrel) so
// esbuild does NOT bundle web.ts/html.ts -> cheerio + @mozilla/readability, whose
// top-level `__dirname` reference is undefined in the Workers runtime.
import { buildChunks, renderChunksNdjson } from "@contextmem/core/chunks";
import { buildSiteFacts, generateContextQuestions } from "@contextmem/core/facts";
import { SEED_FACTS, SEED_FACTS_LIST } from "./seed-facts.js";
import { SEED_PROOFS } from "./seed-proofs.js";
import { isUtilityPageRoute } from "@contextmem/core/utils";
import type {
  BuildProfile,
  ContextChunk,
  DiscoveryStats,
  FactsModel,
  PageArtifact,
  SiteFacts
} from "@contextmem/core";

export type WorkerEnv = {
  CONTEXTMEM_DB: D1DatabaseLike;
  CONTEXTMEM_CONTEXT_BUCKET: R2BucketLike;
  CONTEXTMEM_EXTRACT_QUEUE?: QueueLike;
  CONTEXTMEM_NAMESPACE_IMPORT_TOKEN?: string;
  CONTEXTMEM_WORKER_BASE_URL?: string;
  CONTEXTMEM_DEMO_SAMPLE_TARGET?: string;
  CONTEXTMEM_WEBHOOK_SECRET?: string;
  MEMWAL_MCP_URL?: string;
  MEMWAL_API_URL?: string;
  MEMWAL_AUTHORIZATION?: string;
  MEMWAL_BEARER?: string;
  MEMWAL_PRIVATE_KEY?: string;
  MEMWAL_ACCOUNT_ID?: string;
  MEMWAL_NAMESPACES?: string;
  AI?: WorkersAiBinding;
  FIRECRAWL_API_KEY?: string;
  // Optional OpenAI-compatible chat model for grounded chat synthesis. When set,
  // it is preferred over Workers AI (higher quality). OpenRouter works here:
  // OPENAI_BASE_URL=https://openrouter.ai/api/v1, OPENAI_API_KEY=<openrouter key>.
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_MODEL?: string;
  // Harbor (Walrus) private storage. When HARBOR_API_KEY + HARBOR_SERVICE_PRIVATE_KEY
  // are set, PRIVATE namespaces are Seal-encrypted in the Worker and stored to a
  // Harbor bucket instead of R2. All optional → graceful degradation to R2 when unset.
  // Mirrors the MEMWAL_* secret pattern (HARBOR_SERVICE_PRIVATE_KEY is a Worker secret).
  HARBOR_BASE_URL?: string;
  HARBOR_API_KEY?: string;
  HARBOR_SERVICE_PRIVATE_KEY?: string;
  HARBOR_DEFAULT_SPACE_ID?: string;
};

type WorkersAiBinding = {
  run(model: string, options: { messages: Array<{ role: "system" | "user" | "assistant"; content: string }>; max_tokens?: number; temperature?: number; }): Promise<{ response?: string; result?: { response?: string } } | string>;
};

const defaultHostedWorkerBaseUrl = "https://contextmem-backend.petlofi.workers.dev";
const legacyInternalWorkerOrigin = "https://contextmem.worker";
const hostedRunDefaultOutputs = ["markdown", "images", "brand", "styleguide", "sitemap"];

type WorkerExecutionContext = {
  props?: Record<string, unknown>;
  waitUntil?: (promise: Promise<unknown>) => void;
};

type D1DatabaseLike = {
  prepare(query: string): D1PreparedStatementLike;
  batch?(statements: D1PreparedStatementLike[]): Promise<unknown>;
};

type D1PreparedStatementLike = {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] } | T[]>;
  run(): Promise<unknown>;
};

type R2BucketLike = {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(
    key: string,
    value: string | ArrayBuffer | Uint8Array,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<unknown>;
};

type R2ObjectBodyLike = {
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
};

type QueueLike = {
  send(message: unknown): Promise<unknown>;
};

type NamespaceRow = {
  namespace: string;
  target: string;
  visibility: HostedNamespaceVisibility;
  owner_id?: string | null;
  display_name?: string | null;
  description?: string | null;
  tags_json?: string | null;
  source_type?: HostedNamespaceSummary["sourceType"] | null;
  directory_enabled?: number | boolean | null;
  current_version_id: string;
  source_run_id?: string | null;
  build_kind?: "single" | "multi" | null;
  sources_json?: string | null;
  source_count?: number | null;
  artifact_count: number;
  byte_length: number;
  created_at: string;
  updated_at: string;
};

type TokenRow = {
  token_id?: string | null;
  token_hash: string;
  namespace: string;
  label?: string | null;
  created_at: string;
  last_used_at?: string | null;
  revoked_at?: string | null;
  scope?: string | null;
  expires_at?: string | null;
  snapshot_pin?: string | null;
};

type ArtifactRow = {
  namespace: string;
  version_id: string;
  path: string;
  r2_key: string;
  content_type: string;
  kind: HostedArtifactRecord["kind"];
  size: number;
  sha256?: string | null;
  updated_at: string;
  // Harbor (private, Seal-encrypted) storage. Null for legacy/public R2 artifacts.
  harbor_file_id?: string | null;
  harbor_bucket_id?: string | null;
};

type ExtractionJobRow = {
  id: string;
  owner_id: string;
  namespace: string;
  target: string;
  status: "queued" | "running" | "completed" | "failed";
  visibility: HostedNamespaceVisibility;
  display_name?: string | null;
  description?: string | null;
  tags_json?: string | null;
  directory_enabled?: number | boolean | null;
  source_type?: string | null;
  build_kind?: "single" | "multi" | null;
  sources_json?: string | null;
  source_count?: number | null;
  error?: string | null;
  result_json?: string | null;
  created_at: string;
  updated_at: string;
  completed_at?: string | null;
};

type ShareLinkRow = {
  id: string;
  namespace: string;
  target: string;
  title?: string | null;
  description?: string | null;
  source_run_id?: string | null;
  version_id: string;
  artifact_count: number;
  byte_length: number;
  created_at: string;
  updated_at: string;
};

type ScheduleRow = {
  id: string;
  owner_id: string;
  namespace: string;
  target: string;
  interval_hours: number;
  webhook_url?: string | null;
  webhook_secret?: string | null;
  active: number | boolean;
  last_run_at?: string | null;
  next_run_at: string;
  created_at: string;
  updated_at: string;
};

type AlertRow = {
  id: string;
  owner_id: string;
  schedule_id?: string | null;
  namespace: string;
  target: string;
  title: string;
  message: string;
  diff_json?: string | null;
  read_at?: string | null;
  created_at: string;
};

type HostedRunAuth = {
  ownerId: string;
  accountId: string;
  authorization: string;
  mcpUrl?: string;
};

type PublicExtractionJob = {
  id: string;
  ownerId: string;
  namespace: string;
  target: string;
  buildKind: "single" | "multi";
  sources: NamespaceBuildSource[];
  sourceCount: number;
  status: ExtractionJobRow["status"];
  visibility: HostedNamespaceVisibility;
  displayName?: string;
  description?: string;
  tags: string[];
  directoryEnabled: boolean;
  sourceType: string;
  error?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

type NamespaceBuildMode = "auto" | "web" | "walrus";

type NamespaceBuildSource = {
  id: string;
  target: string;
  label?: string;
  mode: NamespaceBuildMode;
};

type ExtractedSourceSummary = NamespaceBuildSource & {
  kind: "web" | "walrus";
  engine?: "firecrawl" | "fetch";
  status: "completed" | "failed";
  pageCount: number;
  resourceCount: number;
  artifactPrefix: string;
  error?: string;
  walrusProvenance?: Record<string, string>;
};

type ExtractedNamespaceSource = ExtractedSourceSummary & {
  manifest?: Record<string, unknown>;
  pages: Array<Record<string, unknown>>;
  images: Array<Record<string, unknown>>;
  resources: Array<Record<string, unknown>>;
  files: NamespaceImportInput["files"];
};

const namespaceImportSchema = z.object({
  namespace: z.string().min(3).max(300),
  visibility: z.enum(["private", "public"]).default("private"),
  ownerId: z.string().min(1).max(200).default("anonymous"),
  displayName: z.string().max(120).optional(),
  description: z.string().max(600).optional(),
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
  sourceType: z.enum(["web", "walrus", "upload", "extract", "import"]).default("import"),
  directoryEnabled: z.boolean().default(false),
  target: z.string().min(1),
  sourceRunId: z.string().optional(),
  buildKind: z.enum(["single", "multi"]).default("single"),
  sources: z.array(z.object({ id: z.string(), target: z.string(), label: z.string().optional(), mode: z.enum(["auto", "web", "walrus"]).default("auto") })).max(5).optional(),
  manifest: z.unknown(),
  files: z
    .array(
      z.object({
        path: z.string().min(1).max(512),
        contentType: z.string().min(1).default("text/plain; charset=utf-8"),
        encoding: z.enum(["utf8", "base64"]).default("utf8"),
        content: z.string()
      })
    )
    .min(1)
    .max(250)
});

type NamespaceImportInput = z.infer<typeof namespaceImportSchema>;
type FetchedText = { text: string; contentType: string; headers: Record<string, string>; markdown?: string; links?: string[]; engine?: "fetch" | "firecrawl" };

const namespaceUpdateSchema = z.object({
  ownerId: z.string().min(1).max(200).optional(),
  visibility: z.enum(["private", "public"]).optional(),
  displayName: z.string().max(120).optional(),
  description: z.string().max(600).optional(),
  tags: z.array(z.string().min(1).max(40)).max(12).optional(),
  directoryEnabled: z.boolean().optional()
});

const tokenCreateSchema = z.object({
  ownerId: z.string().min(1).max(200).optional(),
  label: z.string().min(1).max(80).default("read token"),
  scope: z.enum(["read"]).default("read"),
  expiresInDays: z.number().int().min(1).max(365).optional(),
  snapshotPin: z.string().min(1).max(120).optional()
});

const extractionCreateSchema = z.object({
  ownerId: z.string().min(1).max(200).default("anonymous"),
  target: z.string().url(),
  namespace: z.string().min(3).max(300).optional(),
  visibility: z.enum(["private", "public"]).default("private"),
  displayName: z.string().max(120).optional(),
  description: z.string().max(600).optional(),
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
  directoryEnabled: z.boolean().default(false)
});

type ExtractionCreateInput = z.infer<typeof extractionCreateSchema>;

const namespaceBuildSourceSchema = z.object({
  target: z.string().url(),
  label: z.string().min(1).max(120).optional(),
  mode: z.enum(["auto", "web", "walrus"]).default("auto")
});

const namespaceBuildCreateSchema = z.object({
  ownerId: z.string().min(1).max(200).default("anonymous"),
  namespace: z.string().min(3).max(300).optional(),
  visibility: z.enum(["private", "public"]).default("private"),
  displayName: z.string().max(120).optional(),
  description: z.string().max(600).optional(),
  tags: z.array(z.string().min(1).max(40)).max(12).default([]),
  directoryEnabled: z.boolean().default(false),
  sources: z.array(namespaceBuildSourceSchema).min(1).max(5)
});

type NamespaceBuildCreateInput = z.infer<typeof namespaceBuildCreateSchema>;

const demoExtractionCreateSchema = z.object({
  target: z.string().min(1).max(500).optional(),
  sample: z.boolean().default(false),
  namespace: z.string().min(1).max(120).optional(),
  displayName: z.string().min(1).max(120).optional()
});

const hostedRunCreateSchema = z.object({
  target: z.string().url(),
  mode: z.enum(["auto", "web", "walrus"]).default("auto"),
  buildProfile: z.enum(["fast", "balanced", "full"]).default("balanced"),
  outputs: z.array(z.string().min(1).max(40)).default(hostedRunDefaultOutputs),
  background: z.boolean().default(true),
  crawlOptions: z.unknown().optional()
});

const feedbackCreateSchema = z.object({
  ownerId: z.string().min(1).max(200).optional(),
  pageUrl: z.string().max(500).optional(),
  sentiment: z.enum(["positive", "neutral", "negative"]).optional(),
  message: z.string().min(1).max(4000),
  contact: z.string().max(200).optional()
});

const shareLinkCreateSchema = z.object({
  ownerId: z.string().min(1).max(200).default("anonymous"),
  target: z.string().min(1),
  title: z.string().max(160).optional(),
  description: z.string().max(600).optional(),
  sourceRunId: z.string().max(160).optional(),
  manifest: z.unknown(),
  files: namespaceImportSchema.shape.files
});

const scheduleCreateSchema = z.object({
  ownerId: z.string().min(1).max(200).default("anonymous"),
  namespace: z.string().min(3).max(300).optional(),
  target: z.string().url(),
  intervalHours: z.number().int().min(1).max(24 * 30).default(24),
  webhookUrl: z.string().url().optional(),
  webhookSecret: z.string().min(8).max(200).optional(),
  active: z.boolean().default(true)
});

const scheduleUpdateSchema = z.object({
  ownerId: z.string().min(1).max(200).optional(),
  intervalHours: z.number().int().min(1).max(24 * 30).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookSecret: z.string().min(8).max(200).nullable().optional(),
  active: z.boolean().optional()
});

export class CloudflareNamespaceStore implements HostedNamespaceStore {
  constructor(private readonly env: WorkerEnv, private readonly pin?: { namespace: string; versionId: string }) {}

  /** Returns a store whose reads for `namespace` are pinned to a fixed version. */
  pinnedTo(namespace: string, versionId: string): CloudflareNamespaceStore {
    return new CloudflareNamespaceStore(this.env, { namespace, versionId });
  }

  private versionFor(namespace: string): string | undefined {
    return this.pin && this.pin.namespace === namespace ? this.pin.versionId : undefined;
  }

  async getNamespace(namespace: string): Promise<HostedNamespaceSummary | undefined> {
    const row = await this.env.CONTEXTMEM_DB.prepare(
      `SELECT namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, build_kind, sources_json, source_count, artifact_count, byte_length, created_at, updated_at
       FROM contextmem_namespaces
       WHERE namespace = ?`
    )
      .bind(namespace)
      .first<NamespaceRow>();
    return row ? namespaceFromRow(row) : undefined;
  }

  async listArtifacts(namespace: string): Promise<HostedArtifactRecord[]> {
    const versionId = this.versionFor(namespace);
    const statement = versionId
      ? this.env.CONTEXTMEM_DB.prepare(
          `SELECT a.path, a.content_type, a.kind, a.size, a.sha256, a.updated_at
           FROM contextmem_namespace_artifacts a
           WHERE a.namespace = ?
             AND a.version_id = ?
           ORDER BY a.path`
        ).bind(namespace, versionId)
      : this.env.CONTEXTMEM_DB.prepare(
          `SELECT a.path, a.content_type, a.kind, a.size, a.sha256, a.updated_at
           FROM contextmem_namespace_artifacts a
           JOIN contextmem_namespaces n
             ON n.namespace = a.namespace
            AND n.current_version_id = a.version_id
           WHERE a.namespace = ?
           ORDER BY a.path`
        ).bind(namespace);
    const result = await statement.all<Omit<ArtifactRow, "namespace" | "version_id" | "r2_key">>();
    return allResults(result).map((row) => ({
      path: row.path,
      contentType: row.content_type,
      kind: row.kind,
      size: Number(row.size),
      sha256: row.sha256 ?? undefined,
      updatedAt: row.updated_at
    }));
  }

  async readArtifact(namespace: string, artifactPath: string): Promise<HostedArtifactContent | undefined> {
    const normalizedPath = normalizeHostedArtifactPath(artifactPath);
    const versionId = this.versionFor(namespace);
    const statement = versionId
      ? this.env.CONTEXTMEM_DB.prepare(
          `SELECT a.namespace, a.version_id, a.path, a.r2_key, a.content_type, a.kind, a.size, a.sha256, a.updated_at, a.harbor_file_id, a.harbor_bucket_id
           FROM contextmem_namespace_artifacts a
           WHERE a.namespace = ?
             AND a.version_id = ?
             AND a.path = ?`
        ).bind(namespace, versionId, normalizedPath)
      : this.env.CONTEXTMEM_DB.prepare(
          `SELECT a.namespace, a.version_id, a.path, a.r2_key, a.content_type, a.kind, a.size, a.sha256, a.updated_at, a.harbor_file_id, a.harbor_bucket_id
           FROM contextmem_namespace_artifacts a
           JOIN contextmem_namespaces n
             ON n.namespace = a.namespace
            AND n.current_version_id = a.version_id
           WHERE a.namespace = ?
             AND a.path = ?`
        ).bind(namespace, normalizedPath);
    const row = await statement.first<ArtifactRow>();
    if (!row) return undefined;

    // Harbor-backed (private, Seal-encrypted) artifact: decrypt in the Worker
    // instead of reading from R2. Keys off harbor_file_id FIRST so legacy/public
    // R2 artifacts (no harbor_file_id) fall through to the unchanged R2 path below.
    if (row.harbor_file_id && row.harbor_bucket_id) {
      const cfg = resolveHarborConfig(this.env);
      // Fail closed: artifact is Harbor-only, so we cannot serve it without creds.
      if (!cfg) return undefined;
      // seal_policy_id lives on the namespace row, not the artifact row.
      const policyRow = await this.env.CONTEXTMEM_DB.prepare(
        `SELECT harbor_seal_policy_id FROM contextmem_namespaces WHERE namespace = ?`
      )
        .bind(namespace)
        .first<{ harbor_seal_policy_id: string | null }>();
      const sealPolicyId = policyRow?.harbor_seal_policy_id;
      if (!sealPolicyId) return undefined;
      const bytes = await new harbor.HarborStorage(cfg).getDecrypted(row.harbor_bucket_id, sealPolicyId, row.harbor_file_id);
      const record = {
        path: row.path,
        contentType: row.content_type,
        kind: row.kind,
        size: Number(row.size),
        sha256: row.sha256 ?? undefined,
        updatedAt: row.updated_at
      };
      if (isHostedTextArtifact(record)) {
        return { ...record, encoding: "utf8", content: new TextDecoder().decode(bytes) };
      }
      return { ...record, encoding: "base64", content: arrayBufferToBase64(toArrayBuffer(bytes)) };
    }

    const object = await this.env.CONTEXTMEM_CONTEXT_BUCKET.get(row.r2_key);
    if (!object) return undefined;

    const record = {
      path: row.path,
      contentType: row.content_type,
      kind: row.kind,
      size: Number(row.size),
      sha256: row.sha256 ?? undefined,
      updatedAt: row.updated_at
    };
    if (isHostedTextArtifact(record)) {
      return {
        ...record,
        encoding: "utf8",
        content: await object.text()
      };
    }
    return {
      ...record,
      encoding: "base64",
      content: arrayBufferToBase64(await object.arrayBuffer())
    };
  }

  async authorizeNamespace(
    namespace: string,
    token?: string
  ): Promise<{ ok: true; summary: HostedNamespaceSummary; versionId: string } | { ok: false; status: number; message: string }> {
    const summary = await this.getNamespace(namespace);
    if (!summary) return { ok: false, status: 404, message: `ContextMeM namespace not found: ${namespace}` };
    if (summary.visibility === "public") return { ok: true, summary, versionId: summary.versionId };
    if (!token) return { ok: false, status: 401, message: "Private ContextMeM namespace requires a read token." };

    const tokenHash = await hashReadToken(token);
    const row = await this.env.CONTEXTMEM_DB.prepare(
      `SELECT token_hash, revoked_at, expires_at, snapshot_pin
       FROM contextmem_namespace_tokens
       WHERE namespace = ?
         AND token_hash = ?`
    )
      .bind(namespace, tokenHash)
      .first<{ token_hash: string; revoked_at?: string | null; expires_at?: string | null; snapshot_pin?: string | null }>();
    if (!row || row.revoked_at) return { ok: false, status: 403, message: "ContextMeM namespace token is invalid or revoked." };
    if (row.expires_at && Date.parse(row.expires_at) <= Date.now()) return { ok: false, status: 403, message: "ContextMeM namespace token has expired." };

    const pin = row.snapshot_pin?.trim();
    let versionId = summary.versionId;
    if (pin && pin !== "latest") {
      const exists = await this.env.CONTEXTMEM_DB.prepare(`SELECT id FROM contextmem_namespace_versions WHERE namespace = ? AND id = ?`).bind(namespace, pin).first<{ id: string }>();
      if (!exists) return { ok: false, status: 409, message: `Pinned snapshot version not found: ${pin}` };
      versionId = pin;
    }

    await this.env.CONTEXTMEM_DB.prepare(`UPDATE contextmem_namespace_tokens SET last_used_at = ? WHERE token_hash = ?`).bind(new Date().toISOString(), tokenHash).run();
    return { ok: true, summary, versionId };
  }
}

export default {
  async fetch(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
    return handleWorkerRequest(request, env, ctx);
  },
  async scheduled(_event: unknown, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<void> {
    const work = processDueSchedules(env, ctx);
    if (ctx.waitUntil) ctx.waitUntil(work);
    else await work;
  },
  async queue(batch: { messages: Array<{ body: unknown; ack?: () => void; retry?: () => void }> }, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body as { jobId?: string };
      if (!body.jobId) {
        message.ack?.();
        continue;
      }
      try {
        await processExtractionJob(body.jobId, env, ctx);
        message.ack?.();
      } catch {
        message.retry?.();
      }
    }
  }
};

export async function handleWorkerRequest(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext = {}): Promise<Response> {
  try {
    return await routeWorkerRequest(request, env, ctx);
  } catch (error) {
    const explicitStatus = typeof error === "object" && error && "statusCode" in error ? Number((error as { statusCode?: unknown }).statusCode) : undefined;
    const status = explicitStatus || (error instanceof z.ZodError || (error instanceof Error && /Artifact path|Namespace may/i.test(error.message)) ? 400 : 500);
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : undefined;
    const hint = typeof error === "object" && error && "hint" in error ? String((error as { hint?: unknown }).hint) : undefined;
    return json({ error: { code, message, hint }, message }, status);
  }
}

async function routeWorkerRequest(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext = {}): Promise<Response> {
  let url = new URL(request.url);
  // The hosted Settings/Workspace frontend calls /api/hosted/* paths that map 1:1 onto the
  // worker's bare /api/* handlers. Normalize them up-front (including the underlying Request so
  // downstream handlers that re-parse request.url also see the rewritten path) so the deployed
  // worker answers the requests the production frontend actually issues.
  if (url.pathname.startsWith("/api/hosted/")) {
    url = new URL(request.url);
    url.pathname = "/api/" + url.pathname.slice("/api/hosted/".length);
    request = new Request(url.toString(), request);
  }
  const store = new CloudflareNamespaceStore(env);

  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "contextmem-backend" });
  }
  if (request.method === "GET" && url.pathname === "/api/me") {
    return getHostedMe(request);
  }
  // Public Walrus Memory explorer: list curated namespaces + recall using the
  // server-side MEMWAL_* delegate (no per-user auth). Lets /app/memory show the
  // seeded recall data without first opening a run.
  if (request.method === "GET" && url.pathname === "/api/memwal/namespaces") {
    return listMemwalNamespaces(request, env);
  }
  // Public seeded Knowledge (SiteFacts) — lets the app/Visualizer browse the
  // Sui/Walrus/Seal facts graph without running a build.
  if (request.method === "GET" && url.pathname === "/api/memwal/facts") {
    const namespaces = SEED_FACTS_LIST.map((entry) => {
      const proof = SEED_PROOFS[entry.namespace];
      return proof ? { ...entry, proof: { blobId: proof.blobId, certified: proof.certified } } : { ...entry, proof: null };
    });
    return jsonCached({ namespaces }, 300);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/memwal/facts/")) {
    const ns = decodeURIComponent(url.pathname.slice("/api/memwal/facts/".length));
    // Tier 1: bundled demo facts (public, edge-cacheable).
    const seeded = SEED_FACTS[ns];
    if (seeded) return jsonCached({ namespace: ns, source: "seed", facts: seeded, proof: SEED_PROOFS[ns] ?? null }, 300);
    // Tier 2: real built namespace — public for public namespaces, read-token for private.
    const auth = await store.authorizeNamespace(ns, readAccessToken(request));
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    let facts: unknown;
    const factsArtifact = await store.readArtifact(ns, "/context/facts.json").catch(() => undefined);
    if (factsArtifact?.encoding === "utf8") facts = safeJsonParse(factsArtifact.content);
    if (!facts) {
      // Older builds may only carry facts inside the manifest.
      const manifestArtifact = await store.readArtifact(ns, "/context/manifest.json").catch(() => undefined);
      const manifest = manifestArtifact?.encoding === "utf8" ? safeJsonParse(manifestArtifact.content) : undefined;
      if (manifest && typeof manifest === "object") facts = (manifest as Record<string, unknown>).facts;
    }
    if (!facts) return json({ error: `No facts artifact for namespace "${ns}".` }, 404);
    const payload = { namespace: ns, source: "r2", facts };
    return auth.summary.visibility === "public" ? jsonCached(payload, 300) : json(payload);
  }
  if (request.method === "POST" && url.pathname === "/api/memwal/recall") {
    return memwalRecall(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/memwal/chat") {
    return memwalChat(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/runs") {
    return createHostedRun(request, env, ctx);
  }
  if (request.method === "GET" && url.pathname === "/api/runs") {
    return listHostedRuns(request, env);
  }
  const hostedRunRoute = matchHostedRunRoute(url.pathname);
  if (hostedRunRoute) {
    if (request.method === "GET" && !hostedRunRoute.action) return getHostedRun(request, env, hostedRunRoute.runId);
    if (request.method === "GET" && hostedRunRoute.action === "events") return getHostedRunEvents(request, env, hostedRunRoute.runId);
    if (request.method === "GET" && hostedRunRoute.action === "artifacts") return getHostedRunArtifacts(request, env, hostedRunRoute.runId);
    if (request.method === "GET" && hostedRunRoute.action === "artifact-files") return listHostedRunArtifactFiles(request, env, hostedRunRoute.runId);
    if (request.method === "GET" && hostedRunRoute.action === "artifact-file") return getHostedRunArtifactFile(request, env, hostedRunRoute.runId);
    if (request.method === "GET" && hostedRunRoute.action === "publish-readiness") return getHostedRunPublishReadiness(request, env, hostedRunRoute.runId);
    if (request.method === "POST" && hostedRunRoute.action === "share") return shareHostedRun(request, env, hostedRunRoute.runId);
    if (request.method === "POST" && hostedRunRoute.action === "ai-query") return aiQueryRun(request, env, hostedRunRoute.runId);
  }
  if (request.method === "POST" && url.pathname === "/api/demo/extractions") {
    return createDemoExtraction(request, env, ctx);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/demo/extractions/")) {
    return getDemoExtraction(request, env, decodeURIComponent(url.pathname.slice("/api/demo/extractions/".length)));
  }
  if (request.method === "POST" && url.pathname === "/api/feedback") {
    return createFeedback(request, env);
  }
  if (request.method === "POST" && url.pathname === "/api/share-links") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return createShareLink(request, env);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/share-links/")) {
    const suffix = decodeURIComponent(url.pathname.slice("/api/share-links/".length));
    if (suffix.endsWith("/og.svg")) return getShareLinkOgSvg(request, env, suffix.slice(0, -"/og.svg".length));
    if (suffix.endsWith("/artifacts")) return getShareLinkArtifacts(request, env, suffix.slice(0, -"/artifacts".length));
    if (suffix.endsWith("/file")) {
      return getShareLinkFile(request, env, suffix.slice(0, -"/file".length), url.searchParams.get("path") ?? "");
    }
    return getShareLink(request, env, suffix);
  }
  if (request.method === "POST" && url.pathname === "/api/namespaces/import") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return importNamespace(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/namespaces") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return listManagedNamespaces(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/directory") {
    return listDirectoryNamespaces(request, env);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/badge/")) {
    return getBadgeSvg(request, env, decodeURIComponent(url.pathname.slice("/api/badge/".length).replace(/\.svg$/, "")));
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/directory/")) {
    return getDirectoryNamespace(request, env);
  }
  const tokenMatch = matchNamespaceTokenPath(url.pathname);
  if (tokenMatch) {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    if (request.method === "GET" && !tokenMatch.tokenId) return listNamespaceTokens(request, env, tokenMatch.namespace);
    if (request.method === "POST" && !tokenMatch.tokenId) return createNamespaceToken(request, env, tokenMatch.namespace);
    if (request.method === "DELETE" && tokenMatch.tokenId) return revokeNamespaceToken(request, env, tokenMatch.namespace, tokenMatch.tokenId);
  }
  if (request.method === "PATCH" && url.pathname.startsWith("/api/namespaces/")) {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return updateNamespace(request, env, decodeURIComponent(url.pathname.slice("/api/namespaces/".length)));
  }
  if (request.method === "POST" && url.pathname.startsWith("/api/namespaces/") && url.pathname.endsWith("/artifact-edit")) {
    const slice = url.pathname.slice("/api/namespaces/".length, -"/artifact-edit".length);
    return updateNamespaceArtifact(request, env, decodeURIComponent(slice));
  }
  if (request.method === "POST" && url.pathname === "/api/extractions") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return createExtraction(request, env, ctx);
  }
  if (request.method === "POST" && url.pathname === "/api/namespace-builds") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return createNamespaceBuild(request, env, ctx);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/extractions/")) {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return getExtraction(request, env, decodeURIComponent(url.pathname.slice("/api/extractions/".length)));
  }
  if (request.method === "POST" && url.pathname === "/api/schedules") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return createSchedule(request, env);
  }
  if (request.method === "GET" && url.pathname === "/api/schedules") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return listSchedules(request, env);
  }
  if (request.method === "PATCH" && url.pathname.startsWith("/api/schedules/")) {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return updateSchedule(request, env, decodeURIComponent(url.pathname.slice("/api/schedules/".length)));
  }
  if (request.method === "GET" && url.pathname === "/api/alerts") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return listAlerts(request, env);
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/namespaces/") && url.pathname.endsWith("/artifact-file")) {
    const namespace = decodeURIComponent(url.pathname.slice("/api/namespaces/".length, -"/artifact-file".length));
    const auth = await store.authorizeNamespace(namespace, readAccessToken(request));
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    // Stored paths are absolute (/context/...); the web hook sends them without
    // the leading slash, and normalizeHostedArtifactPath throws otherwise.
    const raw = url.searchParams.get("path") ?? "";
    const artifactPath = raw.startsWith("/") ? raw : `/${raw}`;
    const readStore = auth.versionId !== auth.summary.versionId ? store.pinnedTo(namespace, auth.versionId) : store;
    const artifact = await readStore.readArtifact(namespace, artifactPath);
    if (!artifact) return cors(new Response("Artifact not found", { status: 404 }));
    return cors(new Response(artifact.content, { status: 200, headers: { "content-type": artifact.contentType } }));
  }
  if (request.method === "GET" && url.pathname.startsWith("/api/namespaces/")) {
    const namespace = decodeURIComponent(url.pathname.slice("/api/namespaces/".length));
    const auth = await store.authorizeNamespace(namespace, readAccessToken(request));
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    const readStore = auth.versionId !== auth.summary.versionId ? store.pinnedTo(namespace, auth.versionId) : store;
    return json({
      namespace: auth.summary,
      pinnedVersionId: auth.versionId !== auth.summary.versionId ? auth.versionId : undefined,
      artifacts: await readStore.listArtifacts(namespace)
    });
  }
  if ((request.method === "POST" || request.method === "GET" || request.method === "DELETE") && isMcpPath(url.pathname)) {
    const namespace = namespaceFromMcpUrl(url);
    if (request.method === "GET" && !acceptsEventStream(request)) {
      return mcpBrowserLandingResponse(request, env, namespace);
    }
    let server;
    if (namespace) {
      const auth = await store.authorizeNamespace(namespace, readAccessToken(request));
      if (!auth.ok) return mcpJsonError(auth.message, auth.status);
      const pinnedStore = auth.versionId !== auth.summary.versionId ? store.pinnedTo(namespace, auth.versionId) : store;
      server = createHostedContextMemMcpServer({ namespace, store: maybeWithMemWalRecall(pinnedStore, env, request) });
    } else {
      server = createHostedContextMemMcpServer({
        store: maybeWithMemWalRecall(store, env, request),
        authorizeNamespace: (requestedNamespace, accessToken) => store.authorizeNamespace(requestedNamespace, accessToken ?? readAccessToken(request))
      });
    }
    const mcpResponse = await createMcpHandler(server, {
      route: url.pathname,
      enableJsonResponse: true,
      corsOptions: { origin: "*" }
    })(request, env, ctx as never);
    return cors(mcpResponse);
  }
  return json({ error: "Not found" }, 404);
}

function isMcpPath(pathname: string): boolean {
  return pathname === "/mcp" || pathname.startsWith("/mcp/");
}

function namespaceFromMcpUrl(url: URL): string | undefined {
  const queryNamespace = url.searchParams.get("namespace")?.trim();
  if (queryNamespace) return queryNamespace;
  if (!url.pathname.startsWith("/mcp/")) return undefined;
  const encoded = url.pathname.slice("/mcp/".length).replace(/\/+$/, "");
  if (!encoded) return undefined;
  return decodeURIComponent(encoded);
}

function acceptsEventStream(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/event-stream") || accept.includes("application/json");
}

async function mcpBrowserLandingResponse(request: Request, env: WorkerEnv, namespace?: string): Promise<Response> {
  const url = namespace ? namespaceMcpUrl(request, env, namespace) : `${workerBaseUrl(request, env)}/mcp`;
  if (namespace && new URL(request.url).toString() !== url) {
    return cors(Response.redirect(url, 302));
  }
  let summary: HostedNamespaceSummary | undefined;
  if (namespace) {
    summary = await new CloudflareNamespaceStore(env).getNamespace(namespace);
  }
  const title = summary?.displayName ?? namespace ?? "ContextMeM hosted MCP";
  const target = summary?.target ?? "(namespace not found)";
  const safeNamespace = namespace ?? "<namespace>";
  const claudeSnippet = JSON.stringify(
    {
      mcpServers: {
        [`contextmem-${safeNamespace.replace(/[^a-zA-Z0-9_-]/g, "-")}`]: {
          command: "npx",
          args: ["-y", "mcp-remote", url]
        }
      }
    },
    null,
    2
  );
  const cursorSnippet = JSON.stringify({ contextmem: { url } }, null, 2);
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(title)} — ContextMeM MCP</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:760px;margin:32px auto;padding:0 20px;color:#0f172a;background:#f8fafc;}
    h1{font-size:22px;margin:0 0 6px;}
    h2{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:#475569;margin:28px 0 8px;}
    code{background:#e2e8f0;padding:1px 6px;border-radius:4px;font-size:13px;}
    pre{background:#0f172a;color:#e2e8f0;padding:14px;border-radius:10px;overflow-x:auto;font-size:12px;line-height:1.5;}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px 22px;}
    .note{background:#fffbeb;border:1px solid #fde68a;color:#78350f;padding:12px 14px;border-radius:10px;font-size:13px;}
    a{color:#1d4ed8;}
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(title)}</h1>
    <p><strong>This URL is an MCP endpoint, not a browser page.</strong> Use it inside an MCP client (Claude Desktop, Cursor, Codex, Smithery, or any other MCP host).</p>
    <p><code>${escapeHtml(url)}</code></p>
    <div class="note">target: ${escapeHtml(target)} · namespace: ${escapeHtml(safeNamespace)}${summary?.visibility === "private" ? " · requires read token" : ""}</div>

    <h2>Claude Desktop / Codex</h2>
    <pre>${escapeHtml(claudeSnippet)}</pre>

    <h2>Cursor (generic MCP)</h2>
    <pre>${escapeHtml(cursorSnippet)}</pre>

    <h2>Test from a terminal</h2>
    <pre>curl -X POST ${escapeHtml(url)} \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'</pre>

    <p style="margin-top:24px;font-size:13px;color:#64748b;">
      Browse the public directory at <a href="https://contextmem.pages.dev/showcase">contextmem.pages.dev/showcase</a>.
    </p>
  </div>
</body>
</html>`;
  return cors(
    new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300"
      }
    })
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function matchNamespaceTokenPath(pathname: string): { namespace: string; tokenId?: string } | undefined {
  const match = /^\/api\/namespaces\/([^/]+)\/tokens(?:\/([^/]+))?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return {
    namespace: decodeURIComponent(match[1]),
    tokenId: match[2] ? decodeURIComponent(match[2]) : undefined
  };
}

async function listManagedNamespaces(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const ownerId = url.searchParams.get("ownerId")?.trim();
  const search = url.searchParams.get("search")?.trim().toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 250);
  const result = ownerId
    ? await env.CONTEXTMEM_DB.prepare(
        `SELECT namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, build_kind, sources_json, source_count, artifact_count, byte_length, created_at, updated_at
         FROM contextmem_namespaces
         WHERE owner_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
        .bind(ownerId, limit)
        .all<NamespaceRow>()
    : await env.CONTEXTMEM_DB.prepare(
        `SELECT namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, build_kind, sources_json, source_count, artifact_count, byte_length, created_at, updated_at
         FROM contextmem_namespaces
         ORDER BY updated_at DESC
         LIMIT ?`
      )
        .bind(limit)
        .all<NamespaceRow>();
  let namespaces = allResults(result).map(namespaceFromRow);
  if (search) {
    namespaces = namespaces.filter((item) => `${item.namespace} ${item.target} ${item.displayName ?? ""} ${item.description ?? ""} ${(item.tags ?? []).join(" ")}`.toLowerCase().includes(search));
  }
  return json({ namespaces: namespaces.map((item) => namespaceListItem(item, request, env)) });
}

async function updateNamespace(request: Request, env: WorkerEnv, rawNamespace: string): Promise<Response> {
  const namespace = normalizeNamespace(rawNamespace);
  const input = namespaceUpdateSchema.parse(await request.json());
  const current = await assertManagedNamespace(env, namespace, input.ownerId);
  const now = new Date().toISOString();
  const tags = input.tags ? normalizeTags(input.tags) : current.tags ?? [];
  await env.CONTEXTMEM_DB.prepare(
    `UPDATE contextmem_namespaces
     SET visibility = ?, display_name = ?, description = ?, tags_json = ?, directory_enabled = ?, updated_at = ?
     WHERE namespace = ?`
  )
    .bind(
      input.visibility ?? current.visibility,
      input.displayName ?? current.displayName ?? displayNameFromTarget(current.target),
      input.description ?? current.description ?? null,
      JSON.stringify(tags),
      typeof input.directoryEnabled === "boolean" ? (input.directoryEnabled ? 1 : 0) : current.directoryEnabled ? 1 : 0,
      now,
      namespace
    )
    .run();
  const updated = await new CloudflareNamespaceStore(env).getNamespace(namespace);
  return json({ namespace: updated });
}

async function listNamespaceTokens(request: Request, env: WorkerEnv, namespace: string): Promise<Response> {
  const ownerId = new URL(request.url).searchParams.get("ownerId")?.trim() || undefined;
  await assertManagedNamespace(env, normalizeNamespace(namespace), ownerId);
  const result = await env.CONTEXTMEM_DB.prepare(
    `SELECT token_id, token_hash, namespace, label, created_at, last_used_at, revoked_at, scope, expires_at, snapshot_pin
     FROM contextmem_namespace_tokens
     WHERE namespace = ?
     ORDER BY created_at DESC`
  )
    .bind(namespace)
    .all<TokenRow>();
  return json({
    tokens: allResults(result).map(publicToken)
  });
}

async function createNamespaceToken(request: Request, env: WorkerEnv, namespace: string): Promise<Response> {
  const input = tokenCreateSchema.parse(await request.json().catch(() => ({})));
  await assertManagedNamespace(env, normalizeNamespace(namespace), input.ownerId);
  const readToken = generateReadToken();
  const tokenHash = await hashReadToken(readToken);
  const tokenId = createTokenId();
  const now = new Date().toISOString();
  const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400000).toISOString() : null;
  const snapshotPin = input.snapshotPin ?? null;
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_namespace_tokens (token_hash, token_id, namespace, label, created_at, scope, expires_at, snapshot_pin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(tokenHash, tokenId, namespace, input.label, now, input.scope, expiresAt, snapshotPin)
    .run();
  return json(
    { token: { id: tokenId, label: input.label, createdAt: now, revoked: false, scope: input.scope, expiresAt: expiresAt ?? undefined, snapshotPin: snapshotPin ?? undefined }, readToken },
    201
  );
}

async function revokeNamespaceToken(request: Request, env: WorkerEnv, namespace: string, tokenId: string): Promise<Response> {
  const ownerId = new URL(request.url).searchParams.get("ownerId")?.trim() || undefined;
  await assertManagedNamespace(env, normalizeNamespace(namespace), ownerId);
  const now = new Date().toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `UPDATE contextmem_namespace_tokens
     SET revoked_at = ?
     WHERE namespace = ?
       AND (token_id = ? OR token_hash LIKE ?)`
  )
    .bind(now, namespace, tokenId, `${tokenId}%`)
    .run();
  return json({ ok: true, tokenId, revokedAt: now });
}

async function listDirectoryNamespaces(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  const search = url.searchParams.get("search")?.trim().toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 100);
  const result = await env.CONTEXTMEM_DB.prepare(
    `SELECT namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, build_kind, sources_json, source_count, artifact_count, byte_length, created_at, updated_at
     FROM contextmem_namespaces
     WHERE visibility = 'public'
       AND directory_enabled = 1
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(limit)
    .all<NamespaceRow>();
  let namespaces = allResults(result).map(namespaceFromRow);
  if (search) {
    namespaces = namespaces.filter((item) => `${item.namespace} ${item.target} ${item.displayName ?? ""} ${item.description ?? ""} ${(item.tags ?? []).join(" ")}`.toLowerCase().includes(search));
  }
  return json({
    namespaces: namespaces.map((item) => directoryItem(item, request, env))
  });
}

async function getDirectoryNamespace(request: Request, env: WorkerEnv): Promise<Response> {
  const namespace = decodeURIComponent(new URL(request.url).pathname.slice("/api/directory/".length));
  const summary = await new CloudflareNamespaceStore(env).getNamespace(namespace);
  if (!summary || summary.visibility !== "public" || !summary.directoryEnabled) return json({ error: "Directory namespace not found." }, 404);
  return json({
    namespace: directoryItem(summary, request, env),
    artifacts: await new CloudflareNamespaceStore(env).listArtifacts(namespace)
  });
}

async function getBadgeSvg(_request: Request, env: WorkerEnv, namespace: string): Promise<Response> {
  const summary = await new CloudflareNamespaceStore(env).getNamespace(namespace);
  const live = summary && summary.visibility === "public" && summary.directoryEnabled;
  const labelLeft = "Powered by ContextMeM";
  const labelRight = live ? namespace.slice(0, 28) : "offline";
  const charWidth = 6.6;
  const leftWidth = Math.ceil(labelLeft.length * charWidth) + 16;
  const rightWidth = Math.ceil(labelRight.length * charWidth) + 16;
  const total = leftWidth + rightWidth;
  const rightFill = live ? "#0f172a" : "#7f1d1d";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="22" role="img" aria-label="${labelLeft}: ${labelRight}">
  <linearGradient id="bg" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <mask id="m"><rect width="${total}" height="22" rx="4" fill="#fff"/></mask>
  <g mask="url(#m)">
    <rect width="${leftWidth}" height="22" fill="#1e293b"/>
    <rect x="${leftWidth}" width="${rightWidth}" height="22" fill="${rightFill}"/>
    <rect width="${total}" height="22" fill="url(#bg)"/>
  </g>
  <g fill="#fff" font-family="ui-monospace,Menlo,monospace" font-size="11">
    <text x="${leftWidth / 2}" y="15" text-anchor="middle">${labelLeft}</text>
    <text x="${leftWidth + rightWidth / 2}" y="15" text-anchor="middle">${labelRight}</text>
  </g>
</svg>`;
  return cors(
    new Response(svg, {
      status: 200,
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=300"
      }
    })
  );
}

async function importNamespace(request: Request, env: WorkerEnv): Promise<Response> {
  const input = namespaceImportSchema.parse(await request.json());
  const result = await storeNamespaceImport(input, request, env);
  return json(result, 201);
}

export async function updateNamespaceArtifact(request: Request, env: WorkerEnv, namespace: string): Promise<Response> {
  const body = await request.json().catch(() => null);
  const parsed = z.object({ path: z.string().min(1), content: z.string() }).safeParse(body);
  if (!parsed.success) return json({ error: "Body must be { path: string, content: string }." }, 400);
  const artifactPath = normalizeHostedArtifactPath(parsed.data.path);
  if (!artifactPath.startsWith("/site/") || !artifactPath.endsWith(".md")) {
    return json({ error: "Only /site/*.md artifacts can be edited inline." }, 400);
  }

  const row = await env.CONTEXTMEM_DB.prepare(
    `SELECT namespace, owner_id, current_version_id, byte_length, manifest_json, harbor_seal_policy_id FROM contextmem_namespaces WHERE namespace = ?`
  )
    .bind(namespace)
    .first<{ namespace: string; owner_id: string; current_version_id: string; byte_length: number; manifest_json: string | null; harbor_seal_policy_id: string | null }>();
  if (!row) return json({ error: "Namespace not found." }, 404);

  // Authorize the edit against a VERIFIED owner, never a self-asserted header (#23):
  //  - the trusted server-to-server proxy (holds the import secret), or
  //  - a hosted delegate whose secret matches its trust-on-first-use binding, or
  //  - the demo owner derived from the caller's own request.
  const callerDemoOwner = demoOwnerId(request);
  const importAuth = requireImportAuthorization(request, env);
  const verifiedOwner = await resolveDelegateOwner(request, env);
  const ownerMatch =
    importAuth.ok ||
    (verifiedOwner !== undefined && verifiedOwner === row.owner_id) ||
    (row.owner_id.startsWith("demo:") && row.owner_id === callerDemoOwner);
  if (!ownerMatch) {
    return json({ error: "You do not own this namespace. Pass a verified x-memwal-account-id delegate or the import token." }, 403);
  }

  const store = new CloudflareNamespaceStore(env);
  let existing: Awaited<ReturnType<CloudflareNamespaceStore["readArtifact"]>>;
  try {
    existing = await store.readArtifact(namespace, artifactPath);
  } catch {
    // Harbor-backed reads hit the network + Seal decrypt; a transient blip should
    // surface as 503, not an uncaught 500.
    return json({ error: "Could not read the current artifact (storage temporarily unavailable). Try again shortly." }, 503);
  }
  if (!existing) return json({ error: "Artifact not found in this namespace." }, 404);

  const newBytes = new TextEncoder().encode(parsed.data.content);
  const newSha = await sha256Hex(newBytes);

  // Harbor-aware write: if this artifact lives in a Seal-encrypted Harbor bucket,
  // the edit MUST be re-encrypted and re-uploaded to Harbor — never written as
  // plaintext to R2. A plaintext R2 write here would both (a) leak the private
  // content and (b) be silently ignored, since readArtifact keys off
  // harbor_file_id first. Public / legacy artifacts keep the R2 path.
  // Classify against the SAME row readArtifact serves: scope to the current
  // version. The artifacts PK is (namespace, version_id, path) and old-version
  // rows are never pruned, so an unscoped .first() can return a stale R2 row and
  // misclassify a private Harbor edit as plaintext-to-R2 (the original leak).
  const artStorage = await env.CONTEXTMEM_DB.prepare(
    `SELECT harbor_file_id, harbor_bucket_id FROM contextmem_namespace_artifacts WHERE namespace = ? AND version_id = ? AND path = ?`
  )
    .bind(namespace, row.current_version_id, artifactPath)
    .first<{ harbor_file_id: string | null; harbor_bucket_id: string | null }>();
  const harborBacked = Boolean(artStorage?.harbor_file_id && artStorage?.harbor_bucket_id);
  const harborCfg = harborBacked ? resolveHarborConfig(env) : null;

  let harborNewFileId: string | null = null;
  let harborStorage: harbor.HarborStorage | null = null;
  let oldHarborFileId: string | null = null;
  let oldHarborBucketId: string | null = null;
  if (harborBacked) {
    if (!harborCfg || !row.harbor_seal_policy_id) {
      // Fail closed: encrypted artifact but Harbor unavailable — do NOT fall back
      // to a plaintext R2 write.
      return json(
        { error: "This namespace is Seal-encrypted (Harbor) but Harbor is not configured on this server; cannot edit." },
        503
      );
    }
    oldHarborBucketId = artStorage!.harbor_bucket_id as string;
    oldHarborFileId = artStorage!.harbor_file_id as string;
    harborStorage = new harbor.HarborStorage(harborCfg);
    const harborFileName = artifactPath.replace(/^\/+/, "").replace(/\/+/g, "_") || "artifact";
    harborNewFileId = await harborStorage.putEncrypted(
      oldHarborBucketId,
      row.harbor_seal_policy_id,
      newBytes,
      harborFileName
    );
    // NB: the superseded ciphertext is deleted only AFTER the new harbor_file_id is
    // durably persisted to D1 (below). Deleting here would risk a dangling pointer.
  } else {
    const r2Key = `namespaces/${await sha256Hex(namespace)}/${row.current_version_id}${artifactPath}`;
    await env.CONTEXTMEM_CONTEXT_BUCKET.put(r2Key, newBytes, {
      httpMetadata: { contentType: existing.contentType ?? "text/markdown; charset=utf-8" },
      customMetadata: {
        namespace,
        versionId: row.current_version_id,
        path: artifactPath,
        sha256: newSha
      }
    });
  }

  let manifestJson = row.manifest_json;
  if (manifestJson) {
    try {
      const manifest = JSON.parse(manifestJson) as { pages?: Array<{ artifactPath?: string; markdown?: string }> };
      if (Array.isArray(manifest.pages)) {
        for (const page of manifest.pages) {
          if (page.artifactPath === artifactPath) {
            page.markdown = parsed.data.content;
          }
        }
        manifestJson = JSON.stringify(manifest, null, 2);
      }
    } catch {
      // leave manifest_json untouched on parse failure
    }
  }

  const oldSize = existing.encoding === "utf8" ? new TextEncoder().encode(existing.content).byteLength : 0;
  const byteDelta = newBytes.byteLength - oldSize;
  const updates = await env.CONTEXTMEM_DB.prepare(
    `UPDATE contextmem_namespaces SET byte_length = byte_length + ?, manifest_json = ?, updated_at = ? WHERE namespace = ?`
  )
    .bind(byteDelta, manifestJson, new Date().toISOString(), namespace)
    .run();
  void updates;

  if (harborNewFileId) {
    // Persist the new ciphertext pointer BEFORE deleting the old file, and do NOT
    // swallow this error: a dangling harbor_file_id would make the private artifact
    // permanently unreadable. Until this commits, D1 still points at the old file
    // (still present), so readArtifact keeps serving the pre-edit content.
    try {
      await env.CONTEXTMEM_DB.prepare(
        `UPDATE contextmem_namespace_artifacts SET size = ?, sha256 = ?, harbor_file_id = ?, r2_key = ?, updated_at = ? WHERE namespace = ? AND version_id = ? AND path = ?`
      )
        .bind(newBytes.byteLength, newSha, harborNewFileId, `harbor:${harborNewFileId}`, new Date().toISOString(), namespace, row.current_version_id, artifactPath)
        .run();
    } catch {
      // Rotation failed: the new file is an orphan, the old file + pointer are intact,
      // so the artifact still reads back as the pre-edit content. Surface the failure.
      return json({ error: "Failed to persist the encrypted edit; the previous version is unchanged." }, 500);
    }
    // Pointer durably rotated -> the superseded ciphertext is now safe to remove.
    if (harborStorage && oldHarborBucketId && oldHarborFileId) {
      try {
        await harborStorage.client.deleteBucketFile(oldHarborBucketId, oldHarborFileId);
      } catch {
        // orphaned old file is harmless; non-fatal
      }
    }
  } else {
    await env.CONTEXTMEM_DB.prepare(
      `UPDATE contextmem_namespace_artifacts SET size = ?, sha256 = ?, updated_at = ? WHERE namespace = ? AND version_id = ? AND path = ?`
    )
      .bind(newBytes.byteLength, newSha, new Date().toISOString(), namespace, row.current_version_id, artifactPath)
      .run()
      .catch(() => undefined);
  }

  return json({ ok: true, path: artifactPath, size: newBytes.byteLength });
}

function matchHostedRunRoute(pathname: string): { runId: string; action?: string } | undefined {
  const match = /^\/api\/runs\/([^/]+)(?:\/(.+))?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  return {
    runId: decodeURIComponent(match[1]),
    action: match[2]
  };
}

function getHostedMe(request: Request): Response {
  const auth = readHostedRunAuth(request);
  if (!auth) {
    return json({
      authenticated: false,
      account: null,
      quota: { limit: 1, used: 0, remaining: 0 },
      access: {
        canPreview: true,
        canRun: false,
        reason: "Import MemWal SDK credentials to unlock private hosted runs."
      }
    });
  }
  return json(hostedMe(auth));
}

async function listHostedRuns(request: Request, env: WorkerEnv): Promise<Response> {
  const auth = requireHostedRunAuth(request);
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 25) || 25, 100);
  // Same browser sometimes builds via demo:* (no auth) and via hosted:* (delegate).
  // Surface both for this caller so the Runs page shows the run they just built,
  // regardless of which submission path was used. Demo rows are filtered to this
  // request's IP so an authed user only sees their own demo extractions.
  const demoOwner = demoOwnerId(request);
  const result = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, owner_id, namespace, target, status, visibility, display_name, description, tags_json, directory_enabled, source_type, build_kind, sources_json, source_count, error, result_json, created_at, updated_at, completed_at
     FROM contextmem_extraction_jobs
     WHERE owner_id = ? OR owner_id = ?
     ORDER BY updated_at DESC
     LIMIT ?`
  )
    .bind(auth.ownerId, demoOwner, limit)
    .all<ExtractionJobRow>();
  return json(allResults(result).map((row) => hostedRunHistoryItem(publicExtractionJobFromRow(row, env))));
}

async function createHostedRun(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
  const auth = requireHostedRunAuth(request);
  const input = hostedRunCreateSchema.parse(await request.json());
  const target = validatePublicDemoTarget(input.target);
  const outputs = normalizeTags(input.outputs).length ? normalizeTags(input.outputs) : hostedRunDefaultOutputs;
  const namespace = normalizeNamespace(`${target.hostname.endsWith(".wal.app") ? "walrus" : "web"}:${slugNamespace(target.hostname)}:${createShortId()}`);
  const job = await createExtractionJob(
    {
      ownerId: auth.ownerId,
      target: target.toString(),
      namespace,
      visibility: "private",
      displayName: displayNameFromTarget(target.toString()),
      description: "Private hosted ContextMeM build",
      tags: ["hosted", target.hostname.endsWith(".wal.app") ? "walrus" : "web", `profile:${input.buildProfile}`, ...outputs.map((output) => `output:${output}`)],
      directoryEnabled: false
    },
    env,
    ctx
  );
  if (!job) throw statusError("Hosted run could not be created.", 500);
  const artifact = job.status === "completed" ? await artifactManifestForJob(env, job).catch(() => undefined) : undefined;
  return json(hostedRunResponse(job, artifact), 202);
}

async function getHostedRun(request: Request, env: WorkerEnv, runId: string): Promise<Response> {
  const job = await requireRunReadAccess(request, env, runId);
  return json(hostedRunManifest(job));
}

async function getHostedRunEvents(request: Request, env: WorkerEnv, runId: string): Promise<Response> {
  const job = await requireRunReadAccess(request, env, runId);
  return sse([{ event: "progress", data: hostedRunManifest(job) }, ...(job.status === "completed" || job.status === "failed" ? [{ event: "done", data: hostedRunManifest(job) }] : [])]);
}

async function getHostedRunArtifacts(request: Request, env: WorkerEnv, runId: string): Promise<Response> {
  const job = await requireRunReadAccess(request, env, runId);
  return json(await artifactManifestForJob(env, job));
}

async function listHostedRunArtifactFiles(request: Request, env: WorkerEnv, runId: string): Promise<Response> {
  const job = await requireRunReadAccess(request, env, runId);
  const artifacts = await new CloudflareNamespaceStore(env).listArtifacts(job.namespace);
  return json(artifacts.map(hostedArtifactFileRecord));
}

async function getHostedRunArtifactFile(request: Request, env: WorkerEnv, runId: string): Promise<Response> {
  const job = await requireRunReadAccess(request, env, runId);
  const artifactPath = new URL(request.url).searchParams.get("path") ?? "";
  if (!artifactPath) return json({ error: "Missing artifact path." }, 400);
  const artifact = await new CloudflareNamespaceStore(env).readArtifact(job.namespace, artifactPath);
  if (!artifact) return json({ error: "Artifact not found." }, 404);
  const body = artifact.encoding === "utf8" ? artifact.content : toArrayBuffer(base64ToBytes(artifact.content));
  const headers = new Headers({
    "content-type": artifact.contentType,
    "cache-control": "no-store"
  });
  if (new URL(request.url).searchParams.get("download") === "1") headers.set("content-disposition", `attachment; filename="${artifact.path.split("/").pop() || "artifact"}"`);
  return cors(new Response(body, { headers }));
}

async function getHostedRunPublishReadiness(request: Request, env: WorkerEnv, runId: string): Promise<Response> {
  const job = await requireRunReadAccess(request, env, runId);
  const [artifact, files] = await Promise.all([artifactManifestForJob(env, job).catch(() => undefined), new CloudflareNamespaceStore(env).listArtifacts(job.namespace)]);
  const paths = new Set(files.map((file) => file.path));
  const routeCount = Array.isArray(artifact?.pages) ? artifact.pages.length : 0;
  return json({
    ready: paths.has("/llms.txt") && paths.has("/context/manifest.json"),
    routeCount,
    artifactCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + Number(file.size || 0), 0),
    missing: [!paths.has("/llms.txt") ? "/llms.txt" : undefined, !paths.has("/context/manifest.json") ? "/context/manifest.json" : undefined].filter(Boolean)
  });
}

async function shareHostedRun(request: Request, env: WorkerEnv, runId: string): Promise<Response> {
  const job = await requireHostedRunAccess(request, env, runId);
  const input = z.object({ title: z.string().max(160).optional(), description: z.string().max(600).optional() }).parse(await request.json().catch(() => ({})));
  const files = redactImportFiles(await namespaceFiles(env, job.namespace));
  const shareId = `shr_${cryptoRandomId(10)}`;
  const shareNamespace = normalizeNamespace(`share:${shareId}`);
  const imported = await storeNamespaceImport(
    {
      namespace: shareNamespace,
      visibility: "public",
      ownerId: job.ownerId,
      displayName: input.title ?? job.displayName ?? displayNameFromTarget(job.target),
      description: input.description ?? job.description,
      tags: ["share", "contextmem"],
      sourceType: "import",
      directoryEnabled: false,
      target: job.target,
      sourceRunId: job.id,
      buildKind: job.buildKind,
      sources: job.sources,
      manifest: redactUnknown(await artifactManifestForJob(env, job).catch(() => ({ target: job.target }))),
      files
    },
    request,
    env
  );
  const now = new Date().toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_share_links (id, namespace, target, title, description, source_run_id, version_id, artifact_count, byte_length, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(shareId, shareNamespace, job.target, input.title ?? job.displayName ?? null, input.description ?? job.description ?? null, job.id, imported.versionId, imported.artifactCount, imported.byteLength, now, now)
    .run();
  const shareInput = {
    ownerId: job.ownerId,
    target: job.target,
    title: input.title ?? job.displayName,
    description: input.description ?? job.description,
    sourceRunId: job.id,
    manifest: {},
    files
  };
  return json({ share: shareLinkFromImport(shareId, shareNamespace, shareInput, imported, now, request, env), url: `${workerBaseUrl(request, env)}/share/${shareId}` }, 201);
}

async function aiQueryRun(request: Request, env: WorkerEnv, runId: string): Promise<Response> {
  const job = await getExtractionJob(env, runId);
  if (!job) return jsonError("RUN_NOT_FOUND", "Run not found.", 404);
  const isDemo = String(job.ownerId).startsWith("demo:");
  if (!isDemo) {
    const auth = readHostedRunAuth(request);
    if (!auth || auth.ownerId !== job.ownerId) return jsonError("HOSTED_DELEGATE_REQUIRED", "Hosted runs require MemWal SDK delegate headers.", 401, "Import your MemWal credentials in /app/settings to query this run.");
  }
  const input = z.object({ question: z.string().min(1).max(2000), schema: z.unknown().optional() }).parse(await request.json().catch(() => ({})));
  const manifest = await artifactManifestForJob(env, job).catch(() => undefined);
  if (!manifest) return jsonError("MANIFEST_MISSING", "No manifest available for this run.", 404);
  const pages = Array.isArray((manifest as Record<string, unknown>).pages) ? ((manifest as Record<string, unknown>).pages as Array<{ url?: string; routePath?: string; title?: string; markdown?: string; artifactPath?: string }>) : [];
  const contextSnippets = pages.slice(0, 8).map((page, index) => {
    const body = (page.markdown ?? "").slice(0, 3000);
    return `### Source ${index + 1}: ${page.title ?? page.routePath ?? page.url ?? ""}\nURL: ${page.url ?? "n/a"}\nRoute: ${page.routePath ?? "n/a"}\n\n${body}`;
  });
  const systemPrompt = "You are ContextMeM, an assistant that answers questions about a website. Use ONLY the provided context. If the answer is not in the context, say you don't have enough information. Reply with a single short JSON object on the FIRST line containing keys answer (string), key_points (array of 3-6 short strings), and confidence (0-1). After the JSON, write a short human paragraph. Do not invent sources.";
  const userPrompt = `Question: ${input.question}\n\nContext (from extracted Walrus Site pages):\n\n${contextSnippets.join("\n\n---\n\n")}`;
  let answerText = "";
  let usedProvider = "workers-ai:@cf/meta/llama-3.1-8b-instruct";
  if (!env.AI) {
    usedProvider = "fallback:no-ai-binding";
    answerText = `{"answer":"This worker is missing the Workers AI binding. Re-deploy with the AI binding configured.","key_points":["No env.AI binding available"],"confidence":0}\n\nAdd the \`ai\` binding to wrangler.jsonc and run \`wrangler deploy\`.`;
  } else {
    try {
      const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 800,
        temperature: 0.2
      });
      if (typeof aiResponse === "string") answerText = aiResponse;
      else if (typeof (aiResponse as { response?: string })?.response === "string") answerText = (aiResponse as { response: string }).response;
      else if (typeof (aiResponse as { result?: { response?: string } })?.result?.response === "string") answerText = (aiResponse as { result: { response: string } }).result.response;
      else answerText = JSON.stringify(aiResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      usedProvider = `error:${message.slice(0, 80)}`;
      answerText = `{"answer":"AI call failed: ${message.replace(/[\\"]/g, "")}","key_points":[],"confidence":0}`;
    }
  }
  let parsedData: Record<string, unknown> = { answer: answerText.trim() };
  let confidence = 0.5;
  // Strip a leading ```json ... ``` markdown code-fence if the model wrapped
  // its JSON in one. Llama-3.1-8b does this often despite the system prompt.
  // Capture both the JSON payload and the trailing prose after the closing fence.
  const fenceMatch = answerText.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```([\s\S]*)$/i);
  let jsonCandidate: string | null = null;
  let trailingProse = "";
  if (fenceMatch) {
    jsonCandidate = fenceMatch[1]!.trim();
    trailingProse = (fenceMatch[2] ?? "").trim();
  } else {
    // No fence — try the original first-line heuristic (raw JSON on line 1).
    const firstBrace = answerText.indexOf("{");
    const firstNewline = answerText.indexOf("\n");
    if (firstBrace === 0 && firstNewline > 0) {
      jsonCandidate = answerText.slice(0, firstNewline).trim();
      trailingProse = answerText.slice(firstNewline).trim();
    } else if (firstBrace === 0) {
      // Single-line response, no newline — try the whole thing as JSON.
      jsonCandidate = answerText.trim();
    }
  }
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      parsedData = parsed;
      if (typeof parsed.confidence === "number") confidence = Math.max(0, Math.min(1, parsed.confidence));
      if (trailingProse) parsedData.explanation = trailingProse;
    } catch {
      parsedData = { answer: answerText.trim() };
    }
  }
  const sources = pages.slice(0, 8).map((page) => ({
    url: page.url ?? "",
    routePath: page.routePath,
    resourcePath: page.artifactPath,
    quote: (page.markdown ?? "").slice(0, 240)
  }));
  return json({
    target: job.target,
    schema: input.schema ?? null,
    data: parsedData,
    confidence,
    usedProvider,
    sources
  });
}

async function requireHostedRunAccess(request: Request, env: WorkerEnv, runId: string): Promise<PublicExtractionJob> {
  const auth = requireHostedRunAuth(request);
  const job = await getExtractionJob(env, runId);
  if (!job || job.ownerId !== auth.ownerId) throw statusError("Hosted run not found.", 404);
  return job;
}

// Looser read-only guard: accepts a job if (a) the caller has a hosted delegate
// matching the run's owner, OR (b) the run is public-visibility (covers demo:*
// extractions, public shares, anonymous <img src=...> fetches without headers).
// Use this for READ endpoints. Keep requireHostedRunAccess for write ops.
async function requireRunReadAccess(request: Request, env: WorkerEnv, runId: string): Promise<PublicExtractionJob> {
  const job = await getExtractionJob(env, runId);
  if (!job) throw statusError("Run not found.", 404);
  if (job.visibility === "public") return job;
  const auth = readHostedRunAuth(request);
  if (auth && job.ownerId === auth.ownerId) return job;
  throw statusError("Run not found.", 404);
}

function readHostedRunAuth(request: Request): HostedRunAuth | undefined {
  const accountId = request.headers.get("x-memwal-account-id")?.trim();
  const authorizationHeader = request.headers.get("x-memwal-authorization")?.trim();
  const bearerHeader = request.headers.get("x-memwal-bearer")?.trim();
  const rawSecret = authorizationHeader ?? bearerHeader;
  if (!accountId || !rawSecret) return undefined;
  const delegate = normalizeDelegateSecret(rawSecret);
  if (delegate.length < 12) return undefined;
  return {
    ownerId: hostedOwnerId(accountId),
    accountId,
    authorization: authorizationHeader?.match(/^Bearer\s+/i) ? authorizationHeader : `Bearer ${delegate}`,
    mcpUrl: request.headers.get("x-memwal-mcp-url")?.trim() || undefined
  };
}

function requireHostedRunAuth(request: Request): HostedRunAuth {
  const auth = readHostedRunAuth(request);
  if (!auth) {
    throw statusError(
      "Hosted runs require MemWal SDK delegate headers.",
      401,
      "HOSTED_DELEGATE_REQUIRED",
      "Import your MemWal account ID and delegate private key in Settings on contextmem.pages.dev."
    );
  }
  return auth;
}

function hostedMe(auth: HostedRunAuth) {
  const now = new Date().toISOString();
  return {
    authenticated: true,
    account: {
      id: auth.ownerId,
      ownerAddress: auth.accountId,
      provider: "unknown",
      memwalAccountId: auth.accountId,
      hasDelegateKey: true,
      createdAt: now,
      updatedAt: now
    },
    quota: { limit: 0, used: 0, remaining: 0, unlimited: true },
    access: {
      canPreview: true,
      canRun: true,
      reason: "Hosted MemWal delegate is available for this browser session."
    }
  };
}

function hostedOwnerId(accountId: string): string {
  return `hosted:${accountId.toLowerCase().replace(/[^a-z0-9:._-]+/g, "-").slice(0, 180)}`;
}

function normalizeDelegateSecret(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

// Verify the hosted delegate identity so a spoofed `x-memwal-account-id` header
// cannot impersonate another owner (#23). The Worker has no signup/session, so we
// bind each hosted owner to the FIRST delegate secret we see (trust-on-first-use)
// and reject any later request that presents a different secret for that owner.
// Returns the canonical hosted owner id when the delegate is verified (or freshly
// bound), or undefined when no delegate is present or the secret does not match.
// The salted hash (sha256(ownerId:secret)) means the raw delegate secret is never
// stored.
async function resolveDelegateOwner(request: Request, env: WorkerEnv): Promise<string | undefined> {
  const auth = readHostedRunAuth(request);
  if (!auth) return undefined;
  const rawSecret = request.headers.get("x-memwal-authorization") ?? request.headers.get("x-memwal-bearer") ?? "";
  const secret = normalizeDelegateSecret(rawSecret);
  if (secret.length < 12) return undefined;
  const secretHash = await sha256Hex(`${auth.ownerId}:${secret}`);
  const now = new Date().toISOString();
  const existing = await env.CONTEXTMEM_DB.prepare(
    `SELECT secret_hash FROM contextmem_hosted_delegates WHERE owner_id = ?`
  )
    .bind(auth.ownerId)
    .first<{ secret_hash: string }>();
  if (!existing) {
    // Trust on first use: bind this owner to the delegate secret presented now.
    await env.CONTEXTMEM_DB.prepare(
      `INSERT INTO contextmem_hosted_delegates (owner_id, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id) DO NOTHING`
    )
      .bind(auth.ownerId, secretHash, now, now)
      .run();
    // Re-read so a concurrent first-write race resolves to whichever secret won.
    const bound = await env.CONTEXTMEM_DB.prepare(
      `SELECT secret_hash FROM contextmem_hosted_delegates WHERE owner_id = ?`
    )
      .bind(auth.ownerId)
      .first<{ secret_hash: string }>();
    return bound && constantTimeEqual(bound.secret_hash, secretHash) ? auth.ownerId : undefined;
  }
  if (!constantTimeEqual(existing.secret_hash, secretHash)) return undefined;
  await env.CONTEXTMEM_DB.prepare(`UPDATE contextmem_hosted_delegates SET last_seen_at = ? WHERE owner_id = ?`)
    .bind(now, auth.ownerId)
    .run();
  return auth.ownerId;
}

// Resolve the authoritative owner for an owner-scoped route. A trusted
// server-to-server caller (one that holds the import secret — i.e. the local Fastify
// proxy, which has already verified its own user's session) may delegate an explicit
// owner id. Everyone else is scoped to their verified hosted delegate. The `?ownerId=`
// param is NEVER trusted on its own. Returns undefined when no trustworthy owner is
// available, so callers fail closed instead of falling back to a shared "anonymous"
// bucket that would leak cross-owner rows.
async function resolveScopedOwner(request: Request, env: WorkerEnv): Promise<string | undefined> {
  if (requireImportAuthorization(request, env).ok) {
    const delegated = new URL(request.url).searchParams.get("ownerId")?.trim();
    if (delegated) return delegated;
  }
  return resolveDelegateOwner(request, env);
}

async function createDemoExtraction(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
  const input = demoExtractionCreateSchema.parse(await request.json().catch(() => ({})));
  const target = validatePublicDemoTarget(input.sample ? demoSampleTarget(env) : input.target ?? demoSampleTarget(env));
  const sample = input.sample || !input.target;
  const authedDelegate = readHostedRunAuth(request);
  if (!sample && !authedDelegate) await consumeDemoQuota(request, env);
  const namespace = input.namespace
    ? normalizeNamespace(input.namespace.startsWith("demo:") ? input.namespace : `demo:${input.namespace}`)
    : normalizeNamespace(`demo:${slugNamespace(target.hostname)}:${createShortId()}`);
  const jobInput: ExtractionCreateInput = {
    ownerId: demoOwnerId(request),
    target: target.toString(),
    namespace,
    visibility: "public",
    displayName: input.displayName?.trim() || displayNameFromTarget(target.toString()),
    // No placeholder description. The extractor pulls og:description from the
    // page itself; the share page should fall back to display name + URL when
    // the site provides no description, not to a generic "Public ContextMeM
    // demo extraction" lie.
    description: undefined,
    // Demo builds are interactive: the user waits on a spinner. Use the 'fast'
    // profile (10 pages / map 40) so a real crawl finishes inside the client's
    // poll window instead of timing out at "did not finish in time".
    tags: ["demo", target.hostname.endsWith(".wal.app") ? "walrus" : "web", "profile:fast"],
    directoryEnabled: false
  };
  const job = await createExtractionJob(jobInput, env, ctx);
  return json({ job, demo: { sample, target: target.toString(), remainingToday: sample ? 1 : 0 } }, 202);
}

async function getDemoExtraction(request: Request, env: WorkerEnv, rawJobId: string): Promise<Response> {
  if (rawJobId.endsWith("/events")) {
    const jobId = rawJobId.slice(0, -"/events".length);
    const job = await getExtractionJob(env, jobId);
    if (!job || !String(job.ownerId).startsWith("demo:")) return json({ error: "Demo extraction not found." }, 404);
    return sse([{ event: "status", data: job }, ...(job.status === "completed" || job.status === "failed" ? [{ event: "done", data: job }] : [])]);
  }
  const job = await getExtractionJob(env, rawJobId);
  if (!job || !String(job.ownerId).startsWith("demo:")) return json({ error: "Demo extraction not found." }, 404);
  return json({ job });
}

async function createFeedback(request: Request, env: WorkerEnv): Promise<Response> {
  const input = feedbackCreateSchema.parse(await request.json());
  const id = `fb_${cryptoRandomId(12)}`;
  const now = new Date().toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_feedback (id, owner_id, page_url, sentiment, message, contact, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, input.ownerId ?? null, input.pageUrl ?? null, input.sentiment ?? null, input.message, input.contact ?? null, request.headers.get("user-agent") ?? null, now)
    .run();
  return json({ ok: true, id, createdAt: now }, 201);
}

async function createShareLink(request: Request, env: WorkerEnv): Promise<Response> {
  const input = shareLinkCreateSchema.parse(await request.json());
  const shareId = `shr_${cryptoRandomId(10)}`;
  const namespace = normalizeNamespace(`share:${shareId}`);
  const files = redactImportFiles(input.files);
  const imported = await storeNamespaceImport(
    {
      namespace,
      visibility: "public",
      ownerId: input.ownerId,
      displayName: input.title ?? displayNameFromTarget(input.target),
      description: input.description,
      tags: ["share", "contextmem"],
      sourceType: "import",
      directoryEnabled: false,
      target: input.target,
      sourceRunId: input.sourceRunId,
      buildKind: "single",
      sources: [{ id: "source-1", target: input.target, label: input.title ?? displayNameFromTarget(input.target), mode: input.target.includes(".wal.app") ? "walrus" : "web" }],
      manifest: redactUnknown(input.manifest),
      files
    },
    request,
    env
  );
  const now = new Date().toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_share_links (id, namespace, target, title, description, source_run_id, version_id, artifact_count, byte_length, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(shareId, namespace, input.target, input.title ?? null, input.description ?? null, input.sourceRunId ?? null, imported.versionId, imported.artifactCount, imported.byteLength, now, now)
    .run();
  return json({ share: shareLinkFromImport(shareId, namespace, input, imported, now, request, env), url: `${workerBaseUrl(request, env)}/share/${shareId}` }, 201);
}

async function getShareLink(request: Request, env: WorkerEnv, shareId: string): Promise<Response> {
  const share = await getShareLinkRow(env, shareId);
  if (!share) return json({ error: "Share link not found." }, 404);
  const store = new CloudflareNamespaceStore(env);
  const manifest = await store.readArtifact(share.namespace, "/context/manifest.json").catch(() => undefined);
  return json({ share: publicShareLink(share, request, env), manifest: manifest?.encoding === "utf8" ? safeJsonParse(manifest.content) : undefined });
}

async function getShareLinkArtifacts(request: Request, env: WorkerEnv, shareId: string): Promise<Response> {
  const share = await getShareLinkRow(env, shareId);
  if (!share) return json({ error: "Share link not found." }, 404);
  return json({ share: publicShareLink(share, request, env), artifacts: await new CloudflareNamespaceStore(env).listArtifacts(share.namespace) });
}

async function getShareLinkFile(_request: Request, env: WorkerEnv, shareId: string, artifactPath: string): Promise<Response> {
  const share = await getShareLinkRow(env, shareId);
  if (!share) return json({ error: "Share link not found." }, 404);
  if (!artifactPath) return json({ error: "Missing path query parameter." }, 400);
  const artifact = await new CloudflareNamespaceStore(env).readArtifact(share.namespace, artifactPath);
  if (!artifact) return json({ error: "Artifact not found in this share." }, 404);
  const isText = artifact.encoding === "utf8";
  return cors(
    new Response(isText ? artifact.content : artifact.content, {
      status: 200,
      headers: {
        "content-type": artifact.contentType ?? (isText ? "text/plain; charset=utf-8" : "application/octet-stream"),
        "cache-control": "public, max-age=120"
      }
    })
  );
}

async function getShareLinkOgSvg(_request: Request, env: WorkerEnv, shareId: string): Promise<Response> {
  const share = await getShareLinkRow(env, shareId);
  if (!share) {
    return cors(new Response("<svg/>", { status: 404, headers: { "content-type": "image/svg+xml; charset=utf-8" } }));
  }
  const title = svgEscape((share.title ?? share.target).slice(0, 64));
  const namespace = svgEscape(share.namespace.slice(0, 48));
  const artifactCount = share.artifact_count ?? 0;
  const description = svgEscape((share.description ?? "Verified public context package").slice(0, 120));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="40" y="40" width="1120" height="550" rx="28" fill="none" stroke="#334155" stroke-width="2"/>
  <text x="80" y="120" fill="#94a3b8" font-family="ui-monospace,Menlo,monospace" font-size="20" letter-spacing="6">CONTEXTMEM · SHARE</text>
  <text x="80" y="240" fill="#f8fafc" font-family="Inter,system-ui,sans-serif" font-size="56" font-weight="700">${title}</text>
  <text x="80" y="320" fill="#cbd5f5" font-family="Inter,system-ui,sans-serif" font-size="26">${description}</text>
  <g transform="translate(80,440)" fill="#94a3b8" font-family="ui-monospace,Menlo,monospace" font-size="22">
    <text>namespace · ${namespace}</text>
    <text y="36">artifacts · ${artifactCount}</text>
  </g>
  <text x="80" y="565" fill="#475569" font-family="Inter,system-ui,sans-serif" font-size="20">Walrus-native context for agents · contextmem.pages.dev</text>
</svg>`;
  return cors(
    new Response(svg, {
      status: 200,
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=600"
      }
    })
  );
}

function svgEscape(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

async function createSchedule(request: Request, env: WorkerEnv): Promise<Response> {
  const input = scheduleCreateSchema.parse(await request.json());
  const schedule = await insertSchedule(input, env);
  return json({ schedule }, 201);
}

async function listSchedules(request: Request, env: WorkerEnv): Promise<Response> {
  // Fail closed: only a verified owner (trusted-proxy delegation or a verified hosted
  // delegate) is scoped here; never default to a shared "anonymous" bucket (#23).
  const ownerId = await resolveScopedOwner(request, env);
  if (!ownerId) return json({ schedules: [] });
  const result = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, owner_id, namespace, target, interval_hours, webhook_url, webhook_secret, active, last_run_at, next_run_at, created_at, updated_at
     FROM contextmem_schedules
     WHERE owner_id = ?
     ORDER BY updated_at DESC`
  )
    .bind(ownerId)
    .all<ScheduleRow>();
  return json({ schedules: allResults(result).map(publicSchedule) });
}

async function updateSchedule(request: Request, env: WorkerEnv, scheduleId: string): Promise<Response> {
  const input = scheduleUpdateSchema.parse(await request.json());
  const current = await getScheduleRow(env, scheduleId, input.ownerId);
  if (!current) return json({ error: "Schedule not found." }, 404);
  const intervalHours = input.intervalHours ?? Number(current.interval_hours);
  const now = new Date().toISOString();
  const nextRunAt = new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `UPDATE contextmem_schedules
     SET interval_hours = ?, webhook_url = ?, webhook_secret = ?, active = ?, next_run_at = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      intervalHours,
      input.webhookUrl === undefined ? current.webhook_url ?? null : input.webhookUrl,
      input.webhookSecret === undefined ? current.webhook_secret ?? null : input.webhookSecret,
      input.active === undefined ? (current.active ? 1 : 0) : input.active ? 1 : 0,
      nextRunAt,
      now,
      scheduleId
    )
    .run();
  return json({ schedule: publicSchedule((await getScheduleRow(env, scheduleId))!) });
}

async function listAlerts(request: Request, env: WorkerEnv): Promise<Response> {
  // Fail closed: see listSchedules — never default to a shared "anonymous" bucket (#23).
  const ownerId = await resolveScopedOwner(request, env);
  if (!ownerId) return json({ alerts: [] });
  const result = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, owner_id, schedule_id, namespace, target, title, message, diff_json, read_at, created_at
     FROM contextmem_alerts
     WHERE owner_id = ?
     ORDER BY created_at DESC
     LIMIT 100`
  )
    .bind(ownerId)
    .all<AlertRow>();
  return json({ alerts: allResults(result).map(publicAlert) });
}

export async function storeNamespaceImport(input: NamespaceImportInput, request: Request, env: WorkerEnv) {
  const namespace = normalizeNamespace(input.namespace);
  const now = new Date().toISOString();
  const versionId = createVersionId();
  const readToken = generateReadToken();
  const tokenHash = await hashReadToken(readToken);
  const tokenId = createTokenId();
  const tags = normalizeTags(input.tags);
  const importSources = input.sources?.length ? input.sources : [{ id: "source-1", target: input.target, label: input.displayName ?? displayNameFromTarget(input.target), mode: input.target.endsWith(".wal.app/") || input.target.includes(".wal.app") ? "walrus" : "web" }];
  const buildKind = input.buildKind ?? (importSources.length > 1 ? "multi" : "single");
  const files = await Promise.all(
    dedupeFiles(input.files).map(async (file) => {
      const artifactPath = normalizeHostedArtifactPath(file.path);
      const bytes = decodeImportContent(file.content, file.encoding);
      const contentType = file.contentType;
      const r2Key = `namespaces/${await sha256Hex(namespace)}/${versionId}${artifactPath}`;
      return {
        path: artifactPath,
        contentType,
        kind: inferHostedArtifactKind(artifactPath, contentType),
        bytes,
        size: bytes.byteLength,
        sha256: await sha256Hex(bytes),
        r2Key
      };
    })
  );
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);

  // --- Storage backend: Harbor (private + encrypted) vs R2 (public/plaintext) ---
  // For PRIVATE namespaces, when Harbor is configured we Seal-encrypt each artifact
  // in the Worker and upload the ciphertext to a per-namespace Harbor bucket — and
  // we do NOT write plaintext bytes to R2. Public namespaces (and any namespace when
  // Harbor is not configured) keep using R2 exactly as before. Fail-closed: a Harbor
  // bucket-create/upload error propagates and aborts the import rather than silently
  // leaking plaintext to R2.
  const isPrivate = input.visibility === "private";
  const harborCfg = isPrivate ? resolveHarborConfig(env) : null;
  let harborSpaceId: string | null = null;
  let harborBucketId: string | null = null;
  let harborSealPolicyId: string | null = null;
  // harbor_file_id per artifact, aligned to `files` by index (null when stored in R2).
  const harborFileIds: Array<string | null> = files.map(() => null);

  if (harborCfg) {
    const storage = new harbor.HarborStorage(harborCfg);
    // Track whether THIS call created the bucket, so a later upload failure can roll
    // it back (a leaked bucket counts against the space's bucket cap). Never delete a
    // reused/pre-existing bucket — it may hold other versions' ciphertext.
    let createdNewBucket = false;
    // Reuse the namespace's existing bucket across re-imports so every version lands
    // under the SAME Seal policy; only create a bucket on first import.
    const existing = await env.CONTEXTMEM_DB.prepare(
      `SELECT harbor_space_id, harbor_bucket_id, harbor_seal_policy_id FROM contextmem_namespaces WHERE namespace = ?`
    )
      .bind(namespace)
      .first<{ harbor_space_id: string | null; harbor_bucket_id: string | null; harbor_seal_policy_id: string | null }>();
    if (existing?.harbor_bucket_id && existing.harbor_seal_policy_id) {
      harborSpaceId = existing.harbor_space_id ?? harborCfg.defaultSpaceId ?? null;
      harborBucketId = existing.harbor_bucket_id;
      harborSealPolicyId = existing.harbor_seal_policy_id;
    } else {
      // Resolve the space: configured default, else the first personal space.
      let spaceId = harborCfg.defaultSpaceId;
      if (!spaceId) {
        const spaces = await storage.client.listSpaces({ type: "personal" });
        spaceId = spaces[0]?.id;
        if (!spaceId) throw new Error("Harbor: no personal space available to create a private bucket.");
      }
      const created = await storage.createPrivateBucket(spaceId, `ctxm-ns-${await sha256Hex(namespace)}`);
      if (!created.sealPolicyId) throw new Error(`Harbor: bucket ${created.bucketId} has no seal policy id (private bucket expected).`);
      harborSpaceId = spaceId;
      harborBucketId = created.bucketId;
      harborSealPolicyId = created.sealPolicyId;
      createdNewBucket = true;
    }
    // Encrypt + upload each artifact (ciphertext only; NO plaintext to R2).
    // Harbor rejects file names containing slashes, but artifact paths are nested
    // (e.g. "/context/facts.json"). Flatten to a slash-free name — the real path
    // lives in D1 and retrieval is keyed by harbor_file_id, so this name is only a
    // display/content-type hint. Keep the extension so contentTypeFromName works.
    try {
      for (let i = 0; i < files.length; i += 1) {
        const harborFileName = files[i]!.path.replace(/^\/+/, "").replace(/\/+/g, "_") || "artifact";
        harborFileIds[i] = await storage.putEncrypted(harborBucketId, harborSealPolicyId, files[i]!.bytes, harborFileName);
      }
    } catch (err) {
      // Roll back a freshly-created bucket so a failed first import doesn't leak a
      // bucket against the space cap. Reused buckets are left intact.
      if (createdNewBucket && harborBucketId) {
        try {
          await storage.client.deleteBucket(harborBucketId);
        } catch {
          // best-effort; surfacing the original upload error matters more
        }
      }
      throw err;
    }
  } else {
    // Public namespace, or Harbor not configured: store plaintext bytes in R2 as today.
    await Promise.all(
      files.map((file) =>
        env.CONTEXTMEM_CONTEXT_BUCKET.put(file.r2Key, file.bytes, {
          httpMetadata: { contentType: file.contentType },
          customMetadata: {
            namespace,
            versionId,
            path: file.path,
            sha256: file.sha256
          }
        })
      )
    );
  }

  const statements = [
    env.CONTEXTMEM_DB.prepare(
      `INSERT INTO contextmem_namespaces (namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, build_kind, sources_json, source_count, manifest_json, artifact_count, byte_length, harbor_space_id, harbor_bucket_id, harbor_seal_policy_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(namespace) DO UPDATE SET
         target = excluded.target,
         visibility = excluded.visibility,
         owner_id = excluded.owner_id,
         display_name = excluded.display_name,
         description = excluded.description,
         tags_json = excluded.tags_json,
         source_type = excluded.source_type,
         directory_enabled = excluded.directory_enabled,
         current_version_id = excluded.current_version_id,
         source_run_id = excluded.source_run_id,
         build_kind = excluded.build_kind,
         sources_json = excluded.sources_json,
         source_count = excluded.source_count,
         manifest_json = excluded.manifest_json,
         artifact_count = excluded.artifact_count,
         byte_length = excluded.byte_length,
         harbor_space_id = COALESCE(excluded.harbor_space_id, harbor_space_id),
         harbor_bucket_id = COALESCE(excluded.harbor_bucket_id, harbor_bucket_id),
         harbor_seal_policy_id = COALESCE(excluded.harbor_seal_policy_id, harbor_seal_policy_id),
         updated_at = excluded.updated_at`
    ).bind(
      namespace,
      input.target,
      input.visibility,
      input.ownerId,
      input.displayName ?? displayNameFromTarget(input.target),
      input.description ?? null,
      JSON.stringify(tags),
      input.sourceType,
      input.directoryEnabled ? 1 : 0,
      versionId,
      input.sourceRunId ?? null,
      buildKind,
      JSON.stringify(importSources),
      importSources.length,
      JSON.stringify(input.manifest),
      files.length,
      totalBytes,
      harborSpaceId,
      harborBucketId,
      harborSealPolicyId,
      now,
      now
    ),
    env.CONTEXTMEM_DB.prepare(
      `INSERT INTO contextmem_namespace_versions (id, namespace, source_run_id, manifest_json, artifact_count, byte_length, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(versionId, namespace, input.sourceRunId ?? null, JSON.stringify(input.manifest), files.length, totalBytes, now),
    env.CONTEXTMEM_DB.prepare(
      `INSERT INTO contextmem_namespace_tokens (token_hash, token_id, namespace, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(tokenHash, tokenId, namespace, `import:${versionId}`, now),
    env.CONTEXTMEM_DB.prepare(`DELETE FROM contextmem_namespace_artifacts WHERE namespace = ? AND version_id = ?`).bind(namespace, versionId),
    ...files.map((file, i) => {
      const harborFileId = harborFileIds[i];
      // r2_key is NOT NULL: for Harbor artifacts store a `harbor:<fileId>` sentinel
      // (the read path keys off harbor_file_id first, never this value).
      const r2KeyValue = harborFileId ? `harbor:${harborFileId}` : file.r2Key;
      return env.CONTEXTMEM_DB.prepare(
        `INSERT INTO contextmem_namespace_artifacts (namespace, version_id, path, r2_key, content_type, kind, size, sha256, harbor_file_id, harbor_bucket_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(namespace, versionId, file.path, r2KeyValue, file.contentType, file.kind, file.size, file.sha256, harborFileId, harborFileId ? harborBucketId : null, now);
    })
  ];

  if (env.CONTEXTMEM_DB.batch) await env.CONTEXTMEM_DB.batch(statements);
  else {
    for (const statement of statements) await statement.run();
  }

  return buildImportResponse(request, env, namespace, input.visibility, input.target, input.sourceRunId, versionId, files.length, totalBytes, readToken, {
    ownerId: input.ownerId,
    displayName: input.displayName ?? displayNameFromTarget(input.target),
    description: input.description,
    tags,
    sourceType: input.sourceType,
    directoryEnabled: input.directoryEnabled,
    buildKind,
    sources: importSources as NamespaceBuildSource[],
    sourceCount: importSources.length
  });
}

async function createExtraction(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
  const input = extractionCreateSchema.parse(await request.json());
  const job = await createExtractionJob(input, env, ctx);
  return json({ job }, 202);
}

async function createExtractionJob(input: ExtractionCreateInput, env: WorkerEnv, ctx: WorkerExecutionContext) {
  const target = new URL(input.target);
  return createNamespaceBuildJob(
    {
      ...input,
      namespace: input.namespace ?? namespaceForExtractTarget(target),
      sources: [{ target: target.toString(), label: input.displayName, mode: target.hostname.endsWith(".wal.app") ? "walrus" : "web" }]
    },
    env,
    ctx
  );
}

async function createNamespaceBuild(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
  const input = namespaceBuildCreateSchema.parse(await request.json());
  const job = await createNamespaceBuildJob(input, env, ctx);
  return json({ job }, 202);
}

async function createNamespaceBuildJob(input: NamespaceBuildCreateInput, env: WorkerEnv, ctx: WorkerExecutionContext) {
  const sources = normalizeNamespaceBuildSources(input.sources);
  const primary = sources[0];
  if (!primary) throw statusError("At least one namespace source is required.", 400);
  const target = new URL(primary.target);
  const namespace = normalizeNamespace(input.namespace ?? namespaceForBuildSources(sources));
  const jobId = createJobId();
  const now = new Date().toISOString();
  const buildKind = sources.length > 1 ? "multi" : "single";
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_extraction_jobs (id, owner_id, namespace, target, status, visibility, display_name, description, tags_json, directory_enabled, source_type, build_kind, sources_json, source_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 'extract', ?, ?, ?, ?, ?)`
  )
    .bind(
      jobId,
      input.ownerId,
      namespace,
      target.toString(),
      input.visibility,
      input.displayName ?? displayNameFromTarget(target.toString()),
      input.description ?? null,
      JSON.stringify(normalizeTags(input.tags)),
      input.directoryEnabled ? 1 : 0,
      buildKind,
      JSON.stringify(sources),
      sources.length,
      now,
      now
    )
    .run();

  const message = { jobId };
  if (env.CONTEXTMEM_EXTRACT_QUEUE) await env.CONTEXTMEM_EXTRACT_QUEUE.send(message);
  else {
    const work = processExtractionJob(jobId, env, ctx);
    if (ctx.waitUntil) ctx.waitUntil(work);
    else await work;
  }

  return getExtractionJob(env, jobId);
}

async function getExtraction(request: Request, env: WorkerEnv, jobId: string): Promise<Response> {
  const ownerId = new URL(request.url).searchParams.get("ownerId")?.trim();
  const job = await getExtractionJob(env, jobId);
  if (!job) return json({ error: "Extraction job not found." }, 404);
  if (ownerId && job.ownerId !== ownerId) return json({ error: "Extraction job not found." }, 404);
  return json({ job });
}

export async function processExtractionJob(jobId: string, env: WorkerEnv, requestContext: WorkerExecutionContext = {}): Promise<void> {
  const job = await getExtractionJobRow(env, jobId);
  if (!job || job.status === "completed") return;
  const now = new Date().toISOString();
  await env.CONTEXTMEM_DB.prepare(`UPDATE contextmem_extraction_jobs SET status = 'running', updated_at = ? WHERE id = ?`).bind(now, jobId).run();
  try {
    const extracted = await extractNamespaceContext(job, env);
    const importResult = await storeNamespaceImport(
      {
        namespace: job.namespace,
        visibility: job.visibility,
        ownerId: job.owner_id,
        displayName: job.display_name ?? displayNameFromTarget(job.target),
        description: job.description ?? undefined,
        tags: parseTags(job.tags_json),
        sourceType: "extract",
        directoryEnabled: Boolean(job.directory_enabled),
        target: job.target,
        sourceRunId: job.id,
        buildKind: job.build_kind ?? "single",
        sources: sourcesForJob(job),
        manifest: extracted.manifest,
        files: extracted.files
      },
      new Request("https://contextmem.worker/internal-extraction"),
      env
    );
    const share = job.owner_id.startsWith("demo:") ? await createShareForExtraction(job, importResult, env) : undefined;
    await env.CONTEXTMEM_DB.prepare(
      `UPDATE contextmem_extraction_jobs
       SET status = 'completed', result_json = ?, updated_at = ?, completed_at = ?
       WHERE id = ?`
    )
      .bind(JSON.stringify(share ? { ...importResult, share } : importResult), new Date().toISOString(), new Date().toISOString(), jobId)
      .run();
  } catch (error) {
    await env.CONTEXTMEM_DB.prepare(
      `UPDATE contextmem_extraction_jobs
       SET status = 'failed', error = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(error instanceof Error ? error.message : String(error), new Date().toISOString(), jobId)
      .run();
    throw error;
  }
  void requestContext;
}

async function createShareForExtraction(job: ExtractionJobRow, imported: Awaited<ReturnType<typeof storeNamespaceImport>>, env: WorkerEnv) {
  const shareId = `shr_${cryptoRandomId(10)}`;
  const now = new Date().toISOString();
  const title = job.display_name ?? displayNameFromTarget(job.target);
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_share_links (id, namespace, target, title, description, source_run_id, version_id, artifact_count, byte_length, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(shareId, job.namespace, job.target, title, job.description ?? null, job.id, imported.versionId, imported.artifactCount, imported.byteLength, now, now)
    .run();
  return {
    id: shareId,
    namespace: job.namespace,
    target: job.target,
    title,
    description: job.description ?? undefined,
    sourceRunId: job.id,
    versionId: imported.versionId,
    artifactCount: imported.artifactCount,
    byteLength: imported.byteLength,
    createdAt: now,
    updatedAt: now
  };
}

async function extractNamespaceContext(job: ExtractionJobRow, env: WorkerEnv): Promise<{ manifest: Record<string, unknown>; files: NamespaceImportInput["files"] }> {
  const sources = sourcesForJob(job);
  const extracted: ExtractedNamespaceSource[] = [];

  for (const [index, source] of sources.entries()) {
    const kind = sourceKind(source);
    try {
      const single = await extractTargetContext(
        {
          ...job,
          id: `${job.id}-${source.id}`,
          target: source.target,
          display_name: source.label ?? displayNameFromTarget(source.target),
          build_kind: "single",
          source_count: 1,
          sources_json: JSON.stringify([source])
        },
        env
      );
      extracted.push(sourceFromSingleExtraction(source, single, index, kind));
    } catch (error) {
      extracted.push({
        ...source,
        kind,
        status: "failed",
        pageCount: 0,
        resourceCount: 0,
        artifactPrefix: `/site/${source.id}`,
        error: error instanceof Error ? error.message : String(error),
        pages: [],
        images: [],
        resources: [],
        files: []
      });
    }
  }

  const completed = extracted.filter((source) => source.status === "completed");
  if (!completed.length) {
    throw new Error(`All namespace sources failed: ${extracted.map((source) => `${source.label ?? source.target}: ${source.error ?? "unknown error"}`).join("; ")}`);
  }

  return buildCombinedNamespaceBundle(job, extracted);
}

function sourceFromSingleExtraction(
  source: NamespaceBuildSource,
  single: { manifest: Record<string, unknown>; files: NamespaceImportInput["files"] },
  sourceIndex: number,
  kind: "web" | "walrus"
): ExtractedNamespaceSource {
  const manifest = single.manifest;
  const rawPages = Array.isArray(manifest.pages) ? (manifest.pages as Array<Record<string, unknown>>) : [];
  const pages: Array<Record<string, unknown>> = rawPages.map((page, index) => {
    const artifactPath = `/site/${source.id}/${index === 0 ? "index" : `page-${index}`}.md`;
    return {
      ...page,
      sourceId: source.id,
      sourceLabel: source.label ?? displayNameFromTarget(source.target),
      sourceTarget: source.target,
      artifactPath
    };
  });
  const pageFiles: NamespaceImportInput["files"] = pages.map((page, index) => ({
    path: String(page.artifactPath),
    contentType: "text/markdown; charset=utf-8",
    encoding: "utf8",
    content: `# ${String(page.title ?? page.url ?? source.label ?? source.target)}\n\n${String(page.markdown ?? "")}`
  }));
  const extraFiles = single.files
    .filter((file) => file.path.startsWith("/site/") && !/^\/site\/(?:index|page-\d+)\.md$/.test(file.path))
    .map((file) => ({ ...file, path: `/site/${source.id}/${file.path.slice("/site/".length)}` }));
  const images = (Array.isArray(manifest.images) ? (manifest.images as Array<Record<string, unknown>>) : []).map((image) => ({
    ...image,
    sourceId: source.id,
    sourceLabel: source.label ?? displayNameFromTarget(source.target)
  }));
  const resources = (Array.isArray(manifest.resources) ? (manifest.resources as Array<Record<string, unknown>>) : []).map((resource) => ({
    ...resource,
    sourceId: source.id,
    sourceLabel: source.label ?? displayNameFromTarget(source.target)
  }));
  const sourceText = String(manifest.source ?? "");
  const walrusHeaders = manifest.walrusHeaders && typeof manifest.walrusHeaders === "object" ? (manifest.walrusHeaders as Record<string, string>) : undefined;
  return {
    ...source,
    kind,
    engine: sourceText.includes("firecrawl") ? "firecrawl" : "fetch",
    status: "completed",
    pageCount: pages.length,
    resourceCount: resources.length,
    artifactPrefix: `/site/${source.id}`,
    walrusProvenance: walrusHeaders && Object.keys(walrusHeaders).length ? walrusHeaders : undefined,
    manifest,
    pages,
    images,
    resources,
    files: [...pageFiles, ...extraFiles]
  };
}

function buildCombinedNamespaceBundle(job: ExtractionJobRow, sources: ExtractedNamespaceSource[]): { manifest: Record<string, unknown>; files: NamespaceImportInput["files"] } {
  const now = new Date().toISOString();
  const completed = sources.filter((source) => source.status === "completed");
  const primary = completed[0]!;
  const pages = completed.flatMap((source) => source.pages);
  const images = completed.flatMap((source) => source.images);
  const resources = completed.flatMap((source) => source.resources);
  const sourceSummaries: ExtractedSourceSummary[] = sources.map(({ manifest: _manifest, files: _files, pages: _pages, images: _images, resources: _resources, ...summary }) => summary);
  const sourceIndex = pages.map((page) => ({
    sourceId: String(page.sourceId ?? ""),
    sourceLabel: String(page.sourceLabel ?? ""),
    sourceTarget: String(page.sourceTarget ?? ""),
    url: String(page.url ?? ""),
    routePath: page.routePath,
    title: page.title,
    artifactPath: page.artifactPath
  }));
  const title = job.display_name ?? primary.label ?? displayNameFromTarget(job.target);
  const description = job.description ?? String(primary.manifest?.description ?? "");
  const manifest: Record<string, unknown> = {
    runId: job.id,
    namespace: job.namespace,
    target: job.target,
    generatedAt: now,
    mode: sources.some((source) => source.kind === "walrus") ? "mixed" : "web",
    status: "completed",
    source: "multi-source-namespace-builder",
    buildKind: job.build_kind ?? (sourceSummaries.length > 1 ? "multi" : "single"),
    sourceCount: sourceSummaries.length,
    sources: sourceSummaries,
    sourceIndex,
    title,
    description,
    metadata: primary.manifest?.metadata ?? {},
    pages,
    toc: completed.flatMap((source) =>
      (Array.isArray(source.manifest?.toc) ? (source.manifest!.toc as Array<Record<string, unknown>>) : []).map((entry) => ({ ...entry, sourceId: source.id, sourceLabel: source.label ?? displayNameFromTarget(source.target) }))
    ),
    codeBlocks: completed.flatMap((source) =>
      (Array.isArray(source.manifest?.codeBlocks) ? (source.manifest!.codeBlocks as Array<Record<string, unknown>>) : []).map((entry) => ({ ...entry, sourceId: source.id, sourceLabel: source.label ?? displayNameFromTarget(source.target) }))
    ),
    siteStructure: buildCombinedSiteStructure(job, sourceSummaries, pages, resources, now),
    images,
    brand: primary.manifest?.brand,
    styleguide: primary.manifest?.styleguide,
    designSystem: primary.manifest?.designSystem,
    walrus: buildCombinedWalrusSummary(sources),
    resources,
    errors: sources.filter((source) => source.status === "failed").map((source) => ({ sourceId: source.id, target: source.target, error: source.error }))
  };

  const llms = renderNamespaceLlms(title, description, job, sourceSummaries, pages);
  const llmsFull = renderNamespaceLlmsFull(title, description, job, sourceSummaries, pages);
  const files: NamespaceImportInput["files"] = [
    { path: "/llms.txt", contentType: "text/plain; charset=utf-8", encoding: "utf8", content: llms },
    { path: "/llms-full.txt", contentType: "text/plain; charset=utf-8", encoding: "utf8", content: llmsFull },
    { path: "/context/manifest.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(manifest, null, 2) },
    { path: "/context/sources.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(sourceSummaries, null, 2) },
    { path: "/context/source-index.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(sourceIndex, null, 2) },
    { path: "/context/site-structure.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(manifest.siteStructure, null, 2) },
    { path: "/context/resources.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(resources, null, 2) },
    { path: "/context/chunks.ndjson", contentType: "application/x-ndjson; charset=utf-8", encoding: "utf8", content: renderChunksNdjson(buildChunks(pages as unknown as PageArtifact[])) }
  ];
  if (manifest.brand) files.push({ path: "/context/brand.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(manifest.brand, null, 2) });
  if (manifest.designSystem) files.push({ path: "/context/design-system.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(manifest.designSystem, null, 2) });
  for (const source of completed) files.push(...source.files);
  const firstPage = pages[0];
  if (firstPage) {
    files.push({
      path: "/site/index.md",
      contentType: "text/markdown; charset=utf-8",
      encoding: "utf8",
      content: `# ${String(firstPage.title ?? firstPage.url ?? title)}\n\n${String(firstPage.markdown ?? "")}`
    });
  }
  return { manifest, files: dedupeFiles(files) };
}

function buildCombinedSiteStructure(job: ExtractionJobRow, sources: ExtractedSourceSummary[], pages: Array<Record<string, unknown>>, resources: Array<Record<string, unknown>>, generatedAt: string) {
  return {
    target: job.target,
    generatedAt,
    summary: {
      pages: pages.length,
      docs: sources.length,
      assets: resources.length,
      brandAssets: 0,
      agentFiles: 4,
      walrusResources: sources.filter((source) => source.kind === "walrus").reduce((sum, source) => sum + source.resourceCount, 0)
    },
    nodes: sources.map((source) => ({
      id: source.id,
      label: source.label ?? displayNameFromTarget(source.target),
      kind: "group",
      path: source.target,
      children: pages
        .filter((page) => page.sourceId === source.id)
        .map((page, index) => ({
          id: `${source.id}-page-${index}`,
          label: String(page.title ?? page.routePath ?? page.url ?? `Page ${index + 1}`),
          kind: "page",
          path: String(page.routePath ?? (new URL(String(page.url ?? source.target)).pathname || "/")),
          artifactPath: String(page.artifactPath ?? "")
        }))
    }))
  };
}

function buildCombinedWalrusSummary(sources: ExtractedNamespaceSource[]) {
  const walrusSources = sources.filter((source) => source.kind === "walrus" && source.status === "completed");
  if (!walrusSources.length) return undefined;
  return {
    sources: walrusSources.map((source) => ({
      id: source.id,
      target: source.target,
      label: source.label,
      provenance: source.walrusProvenance,
      resources: source.resourceCount
    })),
    resources: walrusSources.flatMap((source) => source.resources)
  };
}

function renderNamespaceLlms(title: string, description: string, job: ExtractionJobRow, sources: ExtractedSourceSummary[], pages: Array<Record<string, unknown>>): string {
  return [
    `# ${title}`,
    "",
    description || `Context namespace extracted from ${sources.length} source${sources.length === 1 ? "" : "s"}.`,
    "",
    `Namespace: ${job.namespace}`,
    `Sources: ${sources.length}`,
    "",
    "## Sources",
    ...sources.map((source) => `- ${source.label ?? displayNameFromTarget(source.target)} — ${source.target} (${source.status}${source.engine ? `, ${source.engine}` : ""}${source.kind === "walrus" ? ", walrus provenance" : ""})`),
    "",
    "## Useful Pages",
    ...pages.slice(0, 40).map((page) => `- [${String(page.sourceLabel ?? "")}] ${String(page.url ?? "")}${page.title ? ` — ${String(page.title)}` : ""}`)
  ].join("\n");
}

function renderNamespaceLlmsFull(title: string, description: string, job: ExtractionJobRow, sources: ExtractedSourceSummary[], pages: Array<Record<string, unknown>>): string {
  return [
    `# ${title}`,
    "",
    description || `Context namespace extracted from ${sources.length} source${sources.length === 1 ? "" : "s"}.`,
    "",
    `Namespace: ${job.namespace}`,
    `Generated: ${new Date().toISOString()}`,
    "",
    "---",
    "",
    ...pages.flatMap((page) => [
      `## [${String(page.sourceLabel ?? "")}] ${String(page.title ?? page.url ?? "")}`,
      String(page.url ?? ""),
      "",
      String(page.markdown ?? "").slice(0, 30000),
      "",
      "---",
      ""
    ])
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Crawl tuning — profile-driven page budget + candidate signal ranking.
// ----------------------------------------------------------------------------

/** Read the build profile straight off the job row's tags (mirror hostedRunBuildProfile). */
function extractionJobBuildProfile(job: ExtractionJobRow): BuildProfile {
  const profile = parseTags(job.tags_json).find((tag) => tag.startsWith("profile:"))?.slice("profile:".length);
  return profile === "fast" || profile === "balanced" || profile === "full" ? profile : "balanced";
}

// Profile drives the crawl footprint. 'balanced' is kept near today's 15-page
// default so cost/quota stays flat; 'full' goes wide for the facts/question LLM.
const PROFILE_PAGE_LIMIT: Record<BuildProfile, number> = { fast: 10, balanced: 15, full: 50 };
const PROFILE_MAP_LIMIT: Record<BuildProfile, number> = { fast: 40, balanced: 100, full: 150 };
// Only the top few ranked pages get the larger markdown budget so the highest-
// signal pages feed the LLM with full content while staying within Worker memory.
const TOP_PAGE_MARKDOWN_CHARS = 40000;
const TAIL_PAGE_MARKDOWN_CHARS = 25000;
const TOP_PAGE_COUNT = 5;

const HIGH_SIGNAL_PATH = /\/(docs?|guide|guides|product|products|features?|pricing|plans?|about|how|how-it-works|api|use-cases?|solutions?|integrations?|customers?|security)\b/i;
const UTILITY_PATH = /\/(login|signin|sign-in|signup|sign-up|register|cart|checkout|account|privacy|terms|cookie|legal|gdpr|sitemap|rss|feed|tag|tags|category|categories|author|search|404|unsubscribe|careers?|jobs)\b/i;
const UTILITY_LABEL = /\b(login|log in|sign in|sign up|register|privacy|terms|cookie|cookies|legal|contact us|careers?)\b/i;

/**
 * Score a candidate URL by context-signal so high-value pages (docs/pricing/
 * product/about) win the page budget over footer/utility links. Higher is better.
 */
function scoreCandidateUrl(url: URL, label: string | undefined, fromSitemap: boolean): { score: number; reason: string } {
  const reasons: string[] = [];
  let score = 0;
  const pathname = url.pathname.toLowerCase();
  if (HIGH_SIGNAL_PATH.test(pathname)) {
    score += 3;
    reasons.push("high-signal path");
  }
  const labelWords = (label ?? "").trim().split(/\s+/).filter(Boolean);
  if (labelWords.length > 2 && !UTILITY_LABEL.test(label ?? "")) {
    score += 2;
    reasons.push("content-y label");
  }
  if (isUtilityPageRoute(pathname) || UTILITY_PATH.test(pathname) || UTILITY_LABEL.test(label ?? "")) {
    score -= 5;
    reasons.push("utility route");
  }
  // Deep, query-heavy URLs are usually pagination/filter noise.
  if (url.search.length > 1 || pathname.split("/").filter(Boolean).length > 4) {
    score -= 2;
    reasons.push("deep/query-heavy");
  }
  // Sitemap URLs are ground-truth structure — give them a bonus so listed
  // high-value pages are guaranteed in-budget rather than competing flat.
  if (fromSitemap) {
    score += 2;
    reasons.push("sitemap");
  }
  // Shallow top-level sections are usually primary navigation.
  if (pathname.split("/").filter(Boolean).length <= 1) {
    score += 1;
    reasons.push("shallow");
  }
  return { score, reason: reasons.join(", ") || "default" };
}

// ----------------------------------------------------------------------------
// Facts — env.AI Workers-AI model adapter + grounded llms.txt sections.
// ----------------------------------------------------------------------------

/**
 * Wrap env.AI (@cf/meta/llama-3.1-8b-instruct) as a FactsModel.complete() that
 * returns parsed JSON or null on ANY failure (never throws). Reuses aiQueryRun's
 * fenced-```json + first-line-JSON parser so the 8b model's fenced output parses.
 */
function workersAiFactsModel(env: WorkerEnv): FactsModel | undefined {
  if (!env.AI) return undefined;
  return {
    provider: "workers-ai",
    complete: async (system: string, user: string): Promise<Record<string, unknown> | null> => {
      try {
        const aiResponse = await env.AI!.run("@cf/meta/llama-3.1-8b-instruct", {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ],
          max_tokens: 1500,
          temperature: 0.1
        });
        let text = "";
        if (typeof aiResponse === "string") text = aiResponse;
        else if (typeof (aiResponse as { response?: string })?.response === "string") text = (aiResponse as { response: string }).response;
        else if (typeof (aiResponse as { result?: { response?: string } })?.result?.response === "string") text = (aiResponse as { result: { response: string } }).result.response;
        else text = JSON.stringify(aiResponse);
        return parseFactsJson(text);
      } catch {
        return null;
      }
    }
  };
}

/**
 * Extract a JSON object from a Workers-AI text response. Handles a leading
 * ```json fence, a first-line raw JSON object, or the first balanced {...} span.
 * Returns null on any parse failure (so facts degrade to heuristic, never fail).
 */
function parseFactsJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    const fenced = tryParse(fenceMatch[1].trim());
    if (fenced) return fenced;
  }
  const trimmed = text.trim();
  const whole = tryParse(trimmed);
  if (whole) return whole;
  // First balanced {...} span (handles trailing prose after the JSON).
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const span = tryParse(trimmed.slice(first, last + 1));
    if (span) return span;
  }
  return null;
}

/** Grounded '## What this site is' / '## Key Facts' / '## FAQ' lines for llms.txt. */
function factsLlmsSections(facts: SiteFacts): string[] {
  const lines: string[] = [];
  const identity = facts.identity;
  if (identity && (identity.oneLiner || identity.category || identity.audience?.length)) {
    lines.push("", "## What this site is");
    if (identity.oneLiner) lines.push(identity.oneLiner);
    if (identity.category) lines.push(`Category: ${identity.category}`);
    if (identity.audience?.length) lines.push(`Audience: ${identity.audience.join(", ")}`);
  }
  const keyFacts: string[] = [];
  for (const claim of facts.claims.slice(0, 5)) {
    const route = claim.sources[0]?.routePath;
    keyFacts.push(`- ${claim.text}${route ? ` (${route})` : ""}`);
  }
  for (const stat of facts.stats.slice(0, 5)) {
    const route = stat.sources[0]?.routePath;
    keyFacts.push(`- ${stat.label}: ${stat.valueRaw}${route ? ` (${route})` : ""}`);
  }
  if (keyFacts.length) lines.push("", "## Key Facts", ...keyFacts.slice(0, 8));
  if (facts.questions.length) {
    lines.push("", "## FAQ");
    for (const q of facts.questions.slice(0, 12)) {
      lines.push(`### ${q.question}`);
      lines.push(q.unanswerable || !q.answer ? "Not covered on this site." : q.answer);
      lines.push("");
    }
  }
  return lines;
}

async function extractTargetContext(job: ExtractionJobRow, env: WorkerEnv): Promise<{ manifest: Record<string, unknown>; files: NamespaceImportInput["files"] }> {
  const target = new URL(job.target);
  const fetchedAt = new Date().toISOString();
  const home = await fetchPageContent(target.toString(), env);
  const usingFirecrawl = home.engine === "firecrawl";
  // Firecrawl scrapes the rendered page but does not expose Walrus response
  // headers (x-walrus-site-object-id / x-wal-* / x-resource-*). For .wal.app
  // targets we grab those once with a raw fetch so the Walrus provenance
  // survives the engine swap.
  let walrusHeaderSource = home.headers;
  if (usingFirecrawl && target.hostname.endsWith(".wal.app")) {
    walrusHeaderSource = await fetchText(target.toString()).then((raw) => raw.headers).catch(() => ({}));
  }
  const title = extractTitle(home.text) ?? job.display_name ?? target.hostname;
  // PREFER the page's actual meta description / og:description over whatever
  // the job submitter passed in. The demo path injects a generic placeholder
  // ("Public ContextMeM demo extraction") that has zero signal value — never
  // surface it on the manifest if the page itself describes itself.
  const pageDescription = extractDescription(home.text);
  const description = pageDescription
    ?? (job.description && !/^Public ContextMeM demo extraction$/i.test(job.description) ? job.description : undefined)
    ?? "";
  const metadata = extractPageMetadata(home.text);
  const walrusHeaders = target.hostname.endsWith(".wal.app") ? extractWalrusHeaders(walrusHeaderSource) : {};
  const links = extractLinks(home.text, target).slice(0, 120);
  const resources = dedupeByUrl([...extractResourceLinks(home.text, target), ...metadataResourceLinks(metadata, target)]).slice(0, 200);
  const imageResources = resources.filter((resource) => resource.kind === "image");
  const walrusResources = resources.map((resource) => ({
    path: resource.url.pathname || "/",
    blobId: "",
    blobHash: "",
    contentType: resource.kind,
    aggregatorUrl: resource.url.toString()
  }));
  const extras = await fetchOptionalTextFiles(target);
  const sitemapUrls = parseSitemapUrls(extras, target);
  // Profile drives the crawl footprint: fast=10, balanced=15 (~today), full=50.
  const buildProfile = extractionJobBuildProfile(job);
  const PAGE_LIMIT = PROFILE_PAGE_LIMIT[buildProfile];
  const targetKey = normalizeCrawlKey(target);
  const candidateUrls = new Map<string, { url: URL; label?: string; fromSitemap: boolean }>();
  function pushCandidate(url: URL, label?: string, fromSitemap = false) {
    if (url.origin !== target.origin) return;
    const key = normalizeCrawlKey(url);
    if (!key || key === targetKey) return;
    const existing = candidateUrls.get(key);
    if (existing) {
      // Sitemap membership / a better label can arrive on a later pass.
      if (fromSitemap) existing.fromSitemap = true;
      if (!existing.label && label) existing.label = label;
      return;
    }
    candidateUrls.set(key, { url, label, fromSitemap });
  }
  // Sitemap-first: sitemap URLs are ground-truth structure, seed them ahead of
  // HTML anchors so listed high-value pages are guaranteed a ranking bonus.
  for (const sitemapUrl of sitemapUrls) pushCandidate(sitemapUrl, undefined, true);
  for (const link of links) pushCandidate(link.url, link.label);
  // Firecrawl /map gives far better URL coverage on JS-rendered docs sites than
  // parsing anchors out of the home HTML. Merge it into the candidate set.
  if (usingFirecrawl && env.FIRECRAWL_API_KEY) {
    const mapped = await firecrawlMap(target.toString(), env.FIRECRAWL_API_KEY, PROFILE_MAP_LIMIT[buildProfile]).catch(() => [] as URL[]);
    for (const mappedUrl of mapped) pushCandidate(mappedUrl);
  }
  // SIGNAL RANKING: score every candidate by context-signal (docs/pricing/product
  // win; utility/footer lose) and take the top PAGE_LIMIT instead of insertion order.
  const rankedCandidates = Array.from(candidateUrls.values())
    .map((candidate) => ({ ...candidate, ...scoreCandidateUrl(candidate.url, candidate.label, candidate.fromSitemap) }))
    .sort((a, b) => b.score - a.score || a.url.pathname.length - b.url.pathname.length || a.url.toString().localeCompare(b.url.toString()));
  const rankedPages: DiscoveryStats["rankedPages"] = rankedCandidates.map((candidate) => ({ url: candidate.url.toString(), score: candidate.score, reason: candidate.reason }));
  const sameOriginPages = rankedCandidates.slice(0, PAGE_LIMIT);
  // The top few ranked pages get the larger markdown budget; the long tail is capped.
  const pageResults = await Promise.allSettled(
    sameOriginPages.map(async (link, rankIndex) => {
      const page = await fetchPageContent(link.url.toString(), env);
      const cap = rankIndex < TOP_PAGE_COUNT ? TOP_PAGE_MARKDOWN_CHARS : TAIL_PAGE_MARKDOWN_CHARS;
      return {
        url: link.url.toString(),
        title: extractTitle(page.text) ?? link.label ?? link.url.pathname,
        text: (page.markdown ?? htmlToText(page.text)).slice(0, cap),
        html: page.text
      };
    })
  );
  // NEAR-DUPLICATE GUARD: drop a fetched page whose normalized content matches an
  // already-emitted page (catches /index vs / and printer-friendly mirrors) before
  // it consumes a slot, on top of the URL-key dedupe already done by pushCandidate.
  const seenContentHashes = new Set<string>();
  const fetchedPages = pageResults
    .filter((result): result is PromiseFulfilledResult<{ url: string; title: string; text: string; html: string }> => result.status === "fulfilled")
    .map((result) => result.value)
    .filter((page) => {
      const hash = crawlContentHash(page.text);
      if (!hash || seenContentHashes.has(hash)) return false;
      seenContentHashes.add(hash);
      return true;
    });
  const manifest = {
    runId: job.id,
    namespace: job.namespace,
    target: target.toString(),
    generatedAt: fetchedAt,
    mode: target.hostname.endsWith(".wal.app") ? "walrus" : "web",
    status: "completed",
    source: usingFirecrawl ? "firecrawl-v2" : "cloudflare-fetch-extractor",
    title,
    description,
    metadata,
    walrusHeaders: Object.keys(walrusHeaders).length ? walrusHeaders : undefined,
    pages: [{ url: target.toString(), title, routePath: "/", artifactPath: "/site/index.md", markdown: (home.markdown ?? htmlToText(home.text)).slice(0, 40000), headings: [] as HeadingNode[] }, ...fetchedPages.map((page, index) => ({ url: page.url, title: page.title, routePath: new URL(page.url).pathname, artifactPath: `/site/page-${index + 1}.md`, markdown: page.text, headings: [] as HeadingNode[] }))],
    images: imageResources.map((resource) => ({
      src: resource.url.toString(),
      absoluteUrl: resource.url.toString(),
      role: resource.label,
      contentType: resource.kind
    })),
    walrus: target.hostname.endsWith(".wal.app")
      ? {
          site: {
            network: "mainnet",
            siteObjectId: walrusHeaders["x-walrus-site-object-id"] ?? extractWalrusSiteObjectIdFromHtml(home.text) ?? "unknown",
            aggregatorUrl: target.toString()
          },
          resources: walrusResources
        }
      : undefined,
    resources: resources.map((resource) => ({ url: resource.url.toString(), label: resource.label, kind: resource.kind })),
    errors: []
  };
  const siteStructure = {
    target: target.toString(),
    generatedAt: fetchedAt,
    summary: {
      pages: 1 + fetchedPages.length,
      docs: extras.length,
      assets: resources.length,
      brandAssets: 0,
      agentFiles: 3,
      walrusResources: target.hostname.endsWith(".wal.app") ? resources.length : 0
    },
    nodes: [
      {
        id: "pages",
        label: "Pages",
        kind: "group",
        children: [{ id: "home", label: title, kind: "page", path: "/", artifactPath: "/site/index.md" }, ...fetchedPages.map((page, index) => ({ id: `page-${index}`, label: page.title || page.url, kind: "page", path: new URL(page.url).pathname, artifactPath: `/site/page-${index + 1}.md` }))]
      },
      {
        id: "resources",
        label: "Resources",
        kind: "group",
        children: resources.slice(0, 40).map((resource, index) => ({ id: `resource-${index}`, label: resource.label || resource.url.pathname, kind: "asset", path: resource.url.pathname, contentType: resource.kind }))
      }
    ]
  };
  (manifest as Record<string, unknown>).siteStructure = siteStructure;
  const styleBundle = await collectAllStyles(home.text, target).catch(() => collectInlineStyles(home.text));
  const framework = detectDocsFramework(home.text, metadata);
  const varMap = buildCssVarMap(styleBundle);
  const brand = buildBrandProfile({ html: home.text, target, title, description, metadata, walrusHeaders, css: styleBundle, framework, varMap });
  (manifest as Record<string, unknown>).brand = brand;
  const designSystem = await buildDesignSystem({ html: home.text, target, css: styleBundle, framework, varMap });
  // Cross-pollinate: surface brand identity + logo assets in the design system tab.
  const dsRecord = designSystem as Record<string, unknown>;
  const dsIdentity = dsRecord.identity as Record<string, unknown>;
  if (brand.name) dsIdentity.name = brand.name;
  if (brand.description) dsIdentity.description = brand.description;
  const favicon = brand.logos.find((logo) => logo.role === "favicon" || logo.role === "apple-touch-icon");
  const ogImage = brand.logos.find((logo) => logo.role === "og-image");
  if (favicon) dsIdentity.favicon = { url: favicon.absoluteUrl };
  if (ogImage) dsIdentity.primaryLogo = { url: ogImage.absoluteUrl };
  dsRecord.assets = brand.logos.map((logo) => ({
    kind: logo.type ?? "image",
    label: logo.role ?? "logo",
    url: logo.absoluteUrl,
    contentType: logo.contentType,
    alt: logo.alt
  }));
  if (brand.confidence > (dsIdentity.confidence as number ?? 0)) dsIdentity.confidence = brand.confidence;
  (manifest as Record<string, unknown>).designSystem = designSystem;

  // T2: per-page heading outline tree + flat TOC + code-block index.
  // We extract from the raw HTML, not the stripped markdown, because
  // htmlToText() drops <h>, <pre>, and other structural tags.
  const manifestPages = (manifest as Record<string, unknown>).pages as Array<{ url: string; title?: string; routePath?: string; markdown: string; headings?: HeadingNode[] }>;
  const pageHtmlByUrl = new Map<string, string>();
  pageHtmlByUrl.set(target.toString(), home.text);
  for (const fp of fetchedPages) pageHtmlByUrl.set(fp.url, fp.html);
  const tocFlat: Array<{ pageUrl: string; routePath?: string; path: string[] }> = [];
  const codeBlocks: CodeBlockEntry[] = [];
  for (const page of manifestPages) {
    const pageHtml = pageHtmlByUrl.get(page.url) ?? "";
    const headings = extractHeadingTreeFromHtml(pageHtml);
    page.headings = headings;
    for (const headingPath of flattenHeadingPaths(headings)) {
      tocFlat.push({ pageUrl: page.url, routePath: page.routePath, path: headingPath });
    }
    for (const block of extractCodeBlocksFromHtml(pageHtml, page.url, page.routePath)) {
      codeBlocks.push(block);
    }
  }
  (manifest as Record<string, unknown>).toc = tocFlat.slice(0, 500);
  (manifest as Record<string, unknown>).codeBlocks = codeBlocks.slice(0, 300);

  // Grounded, viz-ready SiteFacts + auto context-questions. Built from the page
  // markdown via @contextmem/core. The whole block is gated in try/catch and
  // degrades to deterministic heuristic facts on ANY failure so a run never fails.
  let facts: SiteFacts | undefined;
  const factsPages: PageArtifact[] = manifestPages.map((page) => ({
    url: page.url,
    routePath: page.routePath,
    title: page.title,
    markdown: page.markdown ?? "",
    html: "",
    text: page.markdown ?? "",
    metadata: {},
    links: [],
    images: [],
    contentHash: ""
  }));
  let factsChunks: ContextChunk[] = [];
  try {
    factsChunks = buildChunks(factsPages);
    const model = workersAiFactsModel(env);
    facts = await buildSiteFacts(target.toString(), factsPages, factsChunks, { model });
    facts = { ...facts, questions: await generateContextQuestions(target.toString(), factsChunks, facts, { model }) };
  } catch {
    // Heuristic fallback (no model) — never let facts fail the run.
    try {
      if (!factsChunks.length) factsChunks = buildChunks(factsPages);
      facts = await buildSiteFacts(target.toString(), factsPages, factsChunks);
      facts = { ...facts, questions: await generateContextQuestions(target.toString(), factsChunks, facts) };
    } catch {
      facts = undefined;
    }
  }
  if (facts) {
    // Map FactSourceRef.routePath -> artifactPath so 'why' popovers can link the
    // worker's walrus page artifacts (/site/page-N.md), not just the route.
    const artifactPathByRoute = new Map<string, string>();
    for (const page of manifestPages) {
      const artifactPath = (page as { artifactPath?: string }).artifactPath;
      if (page.routePath && artifactPath) artifactPathByRoute.set(page.routePath, artifactPath);
    }
    for (const refList of [
      ...facts.entities.map((entity) => entity.sources),
      ...facts.claims.map((claim) => claim.sources),
      ...facts.stats.map((stat) => stat.sources),
      ...facts.relationships.map((rel) => rel.sources),
      facts.identity.sources,
      ...facts.questions.map((question) => question.sources)
    ]) {
      for (const ref of refList) {
        if (!ref.resourcePath && ref.routePath && artifactPathByRoute.has(ref.routePath)) ref.resourcePath = artifactPathByRoute.get(ref.routePath);
      }
    }
    (manifest as Record<string, unknown>).facts = facts;
  }
  const factsSections = facts ? factsLlmsSections(facts) : [];

  // Discovery diagnostics: chosen profile + signal-ranked candidate pages with
  // per-page scores + reasons, so the UI can show WHY each page was chosen.
  const discovery: DiscoveryStats = {
    strategy: target.hostname.endsWith(".wal.app") ? "walrus" : "web",
    profile: buildProfile,
    totalCandidates: candidateUrls.size,
    pagesEmitted: 1 + fetchedPages.length,
    skippedUtilityOrRedirect: Math.max(0, candidateUrls.size - sameOriginPages.length),
    sitemapSources: sitemapUrls.slice(0, 50).map((url) => url.toString()),
    markdownFallbacks: 0,
    fetchErrors: pageResults.filter((result) => result.status === "rejected").length,
    rankedPages: rankedPages.slice(0, 100)
  };
  (manifest as Record<string, unknown>).discovery = discovery;

  // T2: llms-full.txt — concatenated markdown of all pages with section headers.
  // This is the agent-consumption format. We keep llms.txt as the index.
  const llmsFullContent = [
    `# ${title}`,
    "",
    description || `Context bundle extracted from ${target.toString()}`,
    "",
    `Source: ${target.toString()}`,
    `Generated: ${fetchedAt}`,
    `Pages: ${manifestPages.length}`,
    "",
    "---",
    "",
    ...manifestPages.flatMap((page) => [
      `## ${page.title || page.url}`,
      page.url,
      "",
      page.markdown.slice(0, 30000),
      "",
      "---",
      ""
    ]),
    // Grounded self-describing sections so the agent file is self-contained.
    ...factsSections
  ].join("\n");

  const llms = [
    `# ${title}`,
    "",
    description,
    "",
    `Target: ${target.toString()}`,
    `Namespace: ${job.namespace}`,
    `Generated: ${fetchedAt}`,
    "",
    "## Product Metadata",
    ...metadataSummaryLines(metadata, walrusHeaders),
    "",
    "## Useful Pages",
    `- ${target.toString()}${title ? ` — ${title}` : ""}`,
    ...fetchedPages.map((page) => `- ${page.url}${page.title ? ` — ${page.title}` : ""}`),
    "",
    "## Resources",
    ...resources.slice(0, 20).map((resource) => `- ${resource.url.toString()}`),
    // What this site is / Key Facts / FAQ — the most-consumed file describes itself.
    ...factsSections
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const files: NamespaceImportInput["files"] = [
    { path: "/llms.txt", contentType: "text/plain; charset=utf-8", encoding: "utf8", content: llms },
    { path: "/llms-full.txt", contentType: "text/plain; charset=utf-8", encoding: "utf8", content: llmsFullContent },
    { path: "/index.html", contentType: home.contentType, encoding: "utf8", content: home.text.slice(0, 500_000) },
    { path: "/site/index.md", contentType: "text/markdown; charset=utf-8", encoding: "utf8", content: `# ${title}\n\n${(home.markdown ?? htmlToText(home.text)).slice(0, 12000)}` },
    { path: "/context/manifest.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(manifest, null, 2) },
    { path: "/context/metadata.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify({ title, description, metadata, walrus: walrusHeaders }, null, 2) },
    { path: "/context/site-structure.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(siteStructure, null, 2) },
    { path: "/context/brand.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(brand, null, 2) },
    { path: "/context/design-system.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(designSystem, null, 2) },
    { path: "/context/toc.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(tocFlat.slice(0, 500), null, 2) },
    { path: "/context/code-blocks.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(codeBlocks.slice(0, 300), null, 2) },
    { path: "/context/resources.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(resources.map((resource) => ({ url: resource.url.toString(), label: resource.label, kind: resource.kind })), null, 2) },
    { path: "/context/chunks.ndjson", contentType: "application/x-ndjson; charset=utf-8", encoding: "utf8", content: renderChunksNdjson(buildChunks(manifestPages as unknown as PageArtifact[])) },
    { path: "/context/discovery.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(discovery, null, 2) }
  ];
  if (facts) {
    files.push({ path: "/context/facts.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(facts, null, 2) });
  }
  fetchedPages.forEach((page, index) => {
    files.push({ path: `/site/page-${index + 1}.md`, contentType: "text/markdown; charset=utf-8", encoding: "utf8", content: `# ${page.title || page.url}\n\n${page.text}` });
  });
  for (const extra of extras) {
    files.push(extra);
  }
  return { manifest, files };
}

async function fetchText(url: string): Promise<FetchedText> {
  const response = await fetch(url, {
    headers: {
      "user-agent": "ContextMCP Cloudflare Extractor/0.1 (+https://contextmem.ai)"
    }
  });
  if (!response.ok) throw new Error(`Fetch failed ${response.status} for ${url}`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > 1_500_000) throw new Error(`Fetch response is too large for demo extraction: ${url}`);
  const contentType = response.headers.get("content-type") ?? "text/html; charset=utf-8";
  const text = await response.text();
  if (text.length > 1_500_000) throw new Error(`Fetch response is too large for demo extraction: ${url}`);
  return { text, contentType, headers: responseHeaderMap(response.headers), engine: "fetch" };
}

const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2";

type FirecrawlScrapeData = {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  metadata?: { title?: string | string[]; description?: string | string[]; statusCode?: number; contentType?: string; url?: string; sourceURL?: string };
};

async function firecrawlScrape(url: string, apiKey: string): Promise<FetchedText> {
  const response = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      url,
      formats: ["markdown", "rawHtml", "links"],
      onlyMainContent: true,
      blockAds: true,
      timeout: 45000
    })
  });
  if (!response.ok) throw new Error(`Firecrawl scrape ${response.status} for ${url}: ${(await response.text()).slice(0, 200)}`);
  const body = (await response.json()) as { success?: boolean; data?: FirecrawlScrapeData; error?: string };
  if (!body.success || !body.data) throw new Error(`Firecrawl scrape failed for ${url}: ${body.error ?? "no data"}`);
  const data = body.data;
  const html = data.rawHtml ?? data.html ?? "";
  const contentType = (Array.isArray(data.metadata?.contentType) ? data.metadata?.contentType[0] : data.metadata?.contentType) ?? "text/html; charset=utf-8";
  return {
    text: html,
    markdown: data.markdown ?? "",
    links: Array.isArray(data.links) ? data.links : [],
    contentType,
    headers: {},
    engine: "firecrawl"
  };
}

async function firecrawlMap(url: string, apiKey: string, limit = 30): Promise<URL[]> {
  const response = await fetch(`${FIRECRAWL_BASE}/map`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ url, limit, sitemap: "include", ignoreQueryParameters: true })
  });
  if (!response.ok) throw new Error(`Firecrawl map ${response.status} for ${url}`);
  const body = (await response.json()) as { success?: boolean; links?: Array<{ url?: string } | string> };
  if (!body.success || !Array.isArray(body.links)) return [];
  const urls: URL[] = [];
  for (const entry of body.links) {
    const raw = typeof entry === "string" ? entry : entry?.url;
    if (!raw) continue;
    try {
      urls.push(new URL(raw));
    } catch {
      // skip malformed
    }
  }
  return urls;
}

// Unified page fetch: Firecrawl when a key is configured (JS-rendered, clean
// markdown), otherwise the raw fetch + htmlToText fallback. Returns rawHtml as
// `text` so all downstream HTML enrichment (brand, design, headings, code
// blocks) keeps working, plus `markdown` for page content.
async function fetchPageContent(url: string, env: WorkerEnv): Promise<FetchedText> {
  if (env.FIRECRAWL_API_KEY) {
    try {
      const result = await firecrawlScrape(url, env.FIRECRAWL_API_KEY);
      if (!result.markdown && result.text) result.markdown = htmlToText(result.text).slice(0, 40000);
      return result;
    } catch (error) {
      console.warn(`[firecrawl] falling back to raw fetch for ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const raw = await fetchText(url);
  raw.markdown = htmlToText(raw.text);
  return raw;
}

/**
 * Cheap synchronous content fingerprint for the near-duplicate crawl guard.
 * Hashes the whitespace-normalized leading content so /index vs / and printer-
 * friendly mirrors collide. Not cryptographic — collision-tolerant by design.
 */
function crawlContentHash(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, 4000);
  if (!normalized) return "";
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash + normalized.charCodeAt(i)) >>> 0;
  }
  return `${normalized.length}:${hash.toString(36)}`;
}

function normalizeCrawlKey(url: URL): string {
  let pathname = url.pathname;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  pathname = pathname.toLowerCase();
  return `${url.origin}${pathname || "/"}`;
}

function parseSitemapUrls(extras: NamespaceImportInput["files"], target: URL): URL[] {
  const sitemap = extras.find((file) => file.path === "/site/sitemap.xml" && file.encoding === "utf8");
  if (!sitemap || sitemap.encoding !== "utf8" || !sitemap.content) return [];
  const urls: URL[] = [];
  const seen = new Set<string>();
  const locMatches = sitemap.content.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
  for (const match of locMatches) {
    const raw = match[1];
    if (!raw) continue;
    try {
      const parsed = new URL(raw, target);
      const key = parsed.toString();
      if (seen.has(key)) continue;
      seen.add(key);
      urls.push(parsed);
    } catch {
      // ignore unparseable loc entries
    }
    if (urls.length >= 60) break;
  }
  return urls;
}

async function fetchOptionalTextFiles(target: URL): Promise<NamespaceImportInput["files"]> {
  const files: NamespaceImportInput["files"] = [];
  for (const name of ["robots.txt", "sitemap.xml"]) {
    try {
      const url = new URL(`/${name}`, target);
      const response = await fetch(url.toString());
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") ?? (name.endsWith(".xml") ? "application/xml; charset=utf-8" : "text/plain; charset=utf-8");
      const text = await response.text();
      if (isHtmlFallback(contentType, text)) continue;
      files.push({ path: `/site/${name}`, contentType, encoding: "utf8", content: text.slice(0, 500_000) });
    } catch {
      // optional
    }
  }
  return files;
}

function responseHeaderMap(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  headers.forEach((value, key) => {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("x-resource-") || normalized.startsWith("x-wal-") || normalized === "x-unix-time-cached" || normalized === "last-modified") {
      output[normalized] = value;
    }
  });
  return output;
}

function extractWalrusHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.startsWith("x-resource-") || key.startsWith("x-wal-") || key === "x-unix-time-cached"));
}

// Best-effort Walrus site object ID extraction from HTML when headers don't
// expose it. .wal.app gateway pages sometimes embed it as a meta tag or in a
// canonical/og link pointing at walrus.site/0x... or include a raw Sui object
// ID hex (0x + 64 hex chars) in the page.
function extractWalrusSiteObjectIdFromHtml(html: string): string | undefined {
  // 1. Meta tag with walrus-related name/property
  const metaRegex = /<meta\b[^>]*(?:name|property)=["']([^"']*walrus[^"']*(?:object|site)[^"']*)["'][^>]*content=["']([^"']+)["']/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRegex.exec(html))) {
    const value = metaMatch[2]!.trim();
    if (/^0x[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  }
  // 2. Reverse meta order: content first, name after
  const metaRegex2 = /<meta\b[^>]*content=["']([^"']+)["'][^>]*(?:name|property)=["']([^"']*walrus[^"']*(?:object|site)[^"']*)["']/gi;
  let metaMatch2: RegExpExecArray | null;
  while ((metaMatch2 = metaRegex2.exec(html))) {
    const value = metaMatch2[1]!.trim();
    if (/^0x[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  }
  // 3. Any walrus.site URL containing /0x.../
  const urlMatch = /https?:\/\/[^"']*walrus\.site\/(0x[0-9a-f]{64})\b/i.exec(html);
  if (urlMatch?.[1]) return urlMatch[1].toLowerCase();
  // 4. Raw Sui object ID hex in head (rough). Only match in <head> to reduce
  //    false positives from in-content code samples.
  const headMatch = /<head\b[\s\S]{0,12000}<\/head>/i.exec(html);
  if (headMatch) {
    const hexMatch = /\b(0x[0-9a-f]{64})\b/i.exec(headMatch[0]);
    if (hexMatch?.[1]) return hexMatch[1].toLowerCase();
  }
  return undefined;
}

type HeadingNode = {
  level: number;
  text: string;
  anchor: string;
  children: HeadingNode[];
};

type CodeBlockEntry = {
  language: string;
  snippet: string;
  pageUrl: string;
  routePath?: string;
  parentHeading?: string;
  byteLength: number;
};

// Build a nested heading tree from markdown.
// ATX style: # H1, ## H2, ### H3, etc. Setext-style (=== / ---) ignored.
function extractHeadingTree(markdown: string): HeadingNode[] {
  if (!markdown) return [];
  const flat: HeadingNode[] = [];
  const headingRegex = /^(#{1,6})\s+(.+?)\s*#*\s*$/gm;
  let match: RegExpExecArray | null;
  const slugCount = new Map<string, number>();
  while ((match = headingRegex.exec(markdown))) {
    const level = match[1]!.length;
    const text = match[2]!.trim();
    if (!text) continue;
    let slug = text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
    if (!slug) slug = `h${flat.length + 1}`;
    const n = slugCount.get(slug) ?? 0;
    slugCount.set(slug, n + 1);
    const anchor = n === 0 ? slug : `${slug}-${n}`;
    flat.push({ level, text, anchor, children: [] });
  }
  // Stack-based nesting
  const root: HeadingNode = { level: 0, text: "", anchor: "", children: [] };
  const stack: HeadingNode[] = [root];
  for (const node of flat) {
    while (stack.length > 1 && stack[stack.length - 1]!.level >= node.level) stack.pop();
    stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  }
  return root.children;
}

function flattenHeadingPaths(nodes: HeadingNode[], prefix: string[] = [], out: string[][] = []): string[][] {
  for (const node of nodes) {
    const path = [...prefix, node.text];
    out.push(path);
    if (node.children.length) flattenHeadingPaths(node.children, path, out);
  }
  return out;
}

// HTML-based heading extractor: walks <h1>-<h6> tags in document order, strips
// inner markup. Use this when the source is HTML, not markdown (our extractor
// stores stripped text in pages, not markdown ATX).
function extractHeadingTreeFromHtml(html: string): HeadingNode[] {
  if (!html) return [];
  const flat: HeadingNode[] = [];
  const headingRegex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  const slugCount = new Map<string, number>();
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(html))) {
    const level = Number(match[1]);
    const raw = match[2] ?? "";
    const text = (decodeHtml(raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) ?? "").trim();
    if (!text || text.length > 200) continue;
    let slug = text.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").slice(0, 80);
    if (!slug) slug = `h${flat.length + 1}`;
    const n = slugCount.get(slug) ?? 0;
    slugCount.set(slug, n + 1);
    const anchor = n === 0 ? slug : `${slug}-${n}`;
    flat.push({ level, text, anchor, children: [] });
  }
  const root: HeadingNode = { level: 0, text: "", anchor: "", children: [] };
  const stack: HeadingNode[] = [root];
  for (const node of flat) {
    while (stack.length > 1 && stack[stack.length - 1]!.level >= node.level) stack.pop();
    stack[stack.length - 1]!.children.push(node);
    stack.push(node);
  }
  return root.children;
}

// HTML-based code-block extractor. Handles <pre><code class="language-X">...
// and the Prism/Shiki/Docusaurus pattern <pre class="... language-X ...">.
// Tracks the most recent preceding heading by walking HTML linearly.
function extractCodeBlocksFromHtml(html: string, pageUrl: string, routePath: string | undefined, snippetCap = 1200): CodeBlockEntry[] {
  if (!html) return [];
  const out: CodeBlockEntry[] = [];
  // Walk HTML linearly to track heading context as we encounter code blocks.
  // Pattern: matches both <h>...</h> and <pre>...</pre> in document order.
  const interleavedRegex = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>|<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi;
  let lastHeading: string | undefined;
  let match: RegExpExecArray | null;
  while ((match = interleavedRegex.exec(html))) {
    if (match[1]) {
      // It's a heading
      const raw = match[2] ?? "";
      const text = (decodeHtml(raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()) ?? "").trim();
      if (text && text.length <= 200) lastHeading = text;
    } else if (match[4] !== undefined) {
      // It's a <pre> block
      const attrs = match[3] ?? "";
      const body = match[4] ?? "";
      const langMatch = /language-([a-zA-Z0-9_+\-]+)/i.exec(attrs);
      const language = langMatch ? langMatch[1]!.toLowerCase() : "text";
      // Strip inner tags (<code>, <span>, <br>, etc.) while preserving newlines.
      const cleaned = decodeHtml(
        body
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<\/(div|p|li)>/gi, "\n")
          .replace(/<[^>]+>/g, "")
      ) ?? "";
      const snippet = cleaned.trim();
      if (snippet.length < 2 || snippet.length > 40000) continue;
      out.push({
        language,
        snippet: snippet.length > snippetCap ? `${snippet.slice(0, snippetCap)}…` : snippet,
        pageUrl,
        routePath,
        parentHeading: lastHeading,
        byteLength: snippet.length
      });
    }
  }
  return out;
}

// Extract fenced code blocks from markdown. Tracks current heading context.
function extractCodeBlocks(markdown: string, pageUrl: string, routePath: string | undefined, snippetCap = 1200): CodeBlockEntry[] {
  if (!markdown) return [];
  const out: CodeBlockEntry[] = [];
  const fenceRegex = /(?:^|\n)(#{1,6}\s+.+?\n[\s\S]*?)?(?:^|\n)```([a-zA-Z0-9_+\-]*)\s*\n([\s\S]*?)(?:^|\n)```/g;
  // Track heading state by scanning sequentially
  let lastHeading: string | undefined;
  const lines = markdown.split("\n");
  let inFence = false;
  let fenceLang = "";
  let fenceBuf: string[] = [];
  for (const line of lines) {
    if (!inFence) {
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading) {
        lastHeading = heading[2]!.trim();
        continue;
      }
      const open = /^```([a-zA-Z0-9_+\-]*)\s*$/.exec(line);
      if (open) {
        inFence = true;
        fenceLang = open[1] || "text";
        fenceBuf = [];
        continue;
      }
    } else {
      if (/^```\s*$/.test(line)) {
        // End of fence
        const snippet = fenceBuf.join("\n");
        if (snippet.trim().length >= 2) {
          out.push({
            language: fenceLang,
            snippet: snippet.length > snippetCap ? `${snippet.slice(0, snippetCap)}…` : snippet,
            pageUrl,
            routePath,
            parentHeading: lastHeading,
            byteLength: snippet.length
          });
        }
        inFence = false;
        fenceLang = "";
        fenceBuf = [];
      } else {
        fenceBuf.push(line);
      }
    }
  }
  // Quiet unused-var (template covers both regex strategies)
  void fenceRegex;
  return out;
}

function isHtmlFallback(contentType: string, text: string): boolean {
  return /text\/html/i.test(contentType) && /^\s*(<!doctype html|<html\b)/i.test(text);
}

function buildImportResponse(
  request: Request,
  env: WorkerEnv,
  namespace: string,
  visibility: HostedNamespaceVisibility,
  target: string,
  sourceRunId: string | undefined,
  versionId: string,
  artifactCount: number,
  byteLength: number,
  readToken: string,
  metadata?: {
    ownerId?: string;
    displayName?: string;
    description?: string;
    tags?: string[];
    sourceType?: HostedNamespaceSummary["sourceType"];
    directoryEnabled?: boolean;
    buildKind?: "single" | "multi";
    sources?: NamespaceBuildSource[];
    sourceCount?: number;
  }
) {
  const baseUrl = workerBaseUrl(request, env);
  const mcpUrl = namespaceMcpUrl(request, env, namespace);
  const gatewayMcpUrl = `${baseUrl}/mcp`;
  const serverName = `contextmem-${slugNamespace(namespace)}`;
  const authorization = `Bearer ${readToken}`;
  return {
    namespace,
    target,
    sourceRunId,
    versionId,
    visibility,
    artifactCount,
    byteLength,
    ownerId: metadata?.ownerId,
    displayName: metadata?.displayName,
    description: metadata?.description,
    tags: metadata?.tags ?? [],
    sourceType: metadata?.sourceType,
    directoryEnabled: metadata?.directoryEnabled ?? false,
    buildKind: metadata?.buildKind,
    sources: metadata?.sources ?? [],
    sourceCount: metadata?.sourceCount ?? metadata?.sources?.length ?? 1,
    mcpUrl,
    gatewayMcpUrl,
    readToken,
    snippets: {
      claudeDesktop: {
        mcpServers: {
          [serverName]: {
            command: "npx",
            args: ["mcp-remote", mcpUrl, "--header", `Authorization: ${authorization}`]
          }
        }
      },
      cursor: {
        mcpServers: {
          [serverName]: {
            url: mcpUrl,
            headers: {
              Authorization: authorization
            }
          }
        }
      },
      codex: {
        command: `codex mcp add ${serverName} -- npx -y mcp-remote ${mcpUrl} --header "Authorization: ${authorization}"`
      },
      generic: {
        mcpServers: {
          [serverName]: {
            url: mcpUrl,
            headers: {
              Authorization: authorization
            }
          }
        }
      },
      contextMcpGateway: {
        mcpServers: {
          contextmcp: {
            url: gatewayMcpUrl,
            headers: {
              Authorization: authorization
            }
          }
        },
        defaultArguments: {
          namespace
        }
      },
      mcpRemote: {
        command: "npx",
        args: ["mcp-remote", mcpUrl, "--header", `Authorization: ${authorization}`]
      }
    }
  };
}

// The Memory page namespace picker must list EVERY seeded namespace (same set the
// Namespaces page shows), so opening any namespace card lands on a real chip and
// not a fallback. Derived from SEED_FACTS_LIST so the two surfaces never drift.
const DEFAULT_MEMWAL_NAMESPACES: Array<{ namespace: string; label: string }> = (
  SEED_FACTS_LIST as ReadonlyArray<{ namespace: string; displayName?: string }>
).map((entry) => ({
  namespace: entry.namespace,
  label: entry.displayName || prettyNamespaceLabel(entry.namespace)
}));

function prettyNamespaceLabel(namespace: string): string {
  return namespace
    .replace(/^demo:/, "")
    .replace(/[-_:]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

// Walrus Memory relayer base. Must match the host the data was seeded against —
// the SDK (packages/memwal), .env.example, and the seed scripts all use
// relayer.memwal.ai, so recall MUST default to the same host or it queries an
// index that never received the writes and returns nothing.
const DEFAULT_MEMWAL_RELAYER = "https://relayer.memwal.ai";

function memwalConfigured(env: WorkerEnv): boolean {
  return Boolean((env.MEMWAL_PRIVATE_KEY ?? env.MEMWAL_BEARER) && env.MEMWAL_ACCOUNT_ID);
}

// Resolve MemWal delegate creds from per-request headers first (the browser's
// imported delegate is sent as x-memwal-* headers), then env secrets. Lets recall
// work either anonymously (server-configured) or with the user's own delegate —
// without the private key ever being persisted server-side.
// The SDK signs with a raw Ed25519 hex seed; strip a Bearer prefix, a 0x prefix,
// and surrounding whitespace so a copy-pasted delegate key doesn't crash hexToBytes.
function sanitizeMemwalKey(key?: string | null): string | undefined {
  const cleaned = key?.trim().replace(/^bearer\s+/i, "").replace(/^0x/i, "").trim();
  return cleaned || undefined;
}

// A valid MemWal delegate seed is a 64-char hex Ed25519 seed.
function isMemwalSeed(key?: string): boolean {
  return Boolean(key && /^[0-9a-fA-F]{64}$/.test(key));
}

function resolveMemwalCreds(request: Request, env: WorkerEnv): { url: string; privateKey?: string; accountId?: string } {
  const headerKey = sanitizeMemwalKey(request.headers.get("x-memwal-private-key") ?? request.headers.get("x-memwal-bearer") ?? request.headers.get("x-memwal-authorization"));
  const envKey = sanitizeMemwalKey(env.MEMWAL_PRIVATE_KEY ?? env.MEMWAL_BEARER);
  const headerAccount = request.headers.get("x-memwal-account-id")?.trim();
  const envAccount = env.MEMWAL_ACCOUNT_ID?.trim();
  const url = request.headers.get("x-memwal-api-url") ?? request.headers.get("x-memwal-mcp-url") ?? env.MEMWAL_API_URL ?? env.MEMWAL_MCP_URL ?? DEFAULT_MEMWAL_RELAYER;
  // Prefer a VALID header delegate; a malformed browser delegate must not shadow a
  // configured env key. Pair the account id with whichever key we actually use.
  if (isMemwalSeed(headerKey)) return { url, privateKey: headerKey, accountId: headerAccount ?? envAccount };
  if (isMemwalSeed(envKey)) return { url, privateKey: envKey, accountId: envAccount ?? headerAccount };
  return { url, privateKey: headerKey ?? envKey, accountId: headerAccount ?? envAccount };
}

// Harbor (Walrus private storage) is "configured" only when BOTH the API key and
// the Seal service private key are present. baseUrl + defaultSpaceId are optional.
// Gate ALL Harbor behavior on this so an unconfigured Worker degrades to plain R2.
function isHarborConfigured(env: WorkerEnv): boolean {
  return Boolean(env.HARBOR_API_KEY && env.HARBOR_SERVICE_PRIVATE_KEY);
}

// Build a HarborConfig from the Worker `env` binding (NOT process.env, which is
// empty in the Workers runtime). Reuses harbor.harborConfigFromEnv but feeds it the
// per-request env. Returns null (instead of throwing) when Harbor is not configured
// so callers can transparently fall back to R2.
function resolveHarborConfig(env: WorkerEnv): harbor.HarborConfig | null {
  if (!isHarborConfigured(env)) return null;
  return harbor.harborConfigFromEnv({
    HARBOR_BASE_URL: env.HARBOR_BASE_URL,
    HARBOR_API_KEY: env.HARBOR_API_KEY,
    HARBOR_SERVICE_PRIVATE_KEY: env.HARBOR_SERVICE_PRIVATE_KEY,
    HARBOR_DEFAULT_SPACE_ID: env.HARBOR_DEFAULT_SPACE_ID
  });
}

// GET /api/memwal/namespaces — curated namespace picker for the Memory explorer.
// Override via the MEMWAL_NAMESPACES env (comma-separated "namespace=Label").
function listMemwalNamespaces(request: Request, env: WorkerEnv): Response {
  // `configured` is true when recall can succeed without the user importing a
  // delegate: either server env creds, OR the request already carries delegate headers.
  const headerDelegate = Boolean(
    (request.headers.get("x-memwal-authorization") || request.headers.get("x-memwal-bearer") || request.headers.get("x-memwal-private-key")) && request.headers.get("x-memwal-account-id")
  );
  const raw = env.MEMWAL_NAMESPACES?.trim();
  let namespaces = DEFAULT_MEMWAL_NAMESPACES;
  if (raw) {
    const parsed = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const eq = entry.indexOf("=");
        const namespace = (eq === -1 ? entry : entry.slice(0, eq)).trim();
        const label = eq === -1 ? "" : entry.slice(eq + 1).trim();
        return { namespace, label: label || prettyNamespaceLabel(namespace) };
      })
      .filter((entry) => entry.namespace);
    if (parsed.length) namespaces = parsed;
  }
  return json({ namespaces, configured: memwalConfigured(env) || headerDelegate });
}

// When Walrus Memory recall isn't available (no valid delegate), answer the query
// from the namespace's verified facts so the Memory tab is never a dead error.
function factsFallbackRecall(namespace: string, query: string): { results: Array<{ text: string; score: number }> } | null {
  const facts = SEED_FACTS[namespace];
  if (!facts) return null;
  const candidates: string[] = [];
  if (facts.identity?.oneLiner) candidates.push(`${facts.identity.name}: ${facts.identity.oneLiner}`);
  for (const q of facts.questions ?? []) if (q.answer) candidates.push(`${q.question} — ${q.answer}`);
  for (const c of facts.claims ?? []) if (c.text) candidates.push(c.text);
  for (const e of facts.entities ?? []) if (e.description) candidates.push(`${e.name}: ${e.description}`);
  for (const s of facts.stats ?? []) if (s.valueRaw) candidates.push(`${s.label}: ${s.valueRaw}`);
  const queryTokens = new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((token) => token.length > 2));
  const scored = candidates
    .map((text) => {
      const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
      let score = 0;
      for (const token of tokens) if (queryTokens.has(token)) score += 1;
      return { text, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  const results = scored.length ? scored : candidates.slice(0, 5).map((text) => ({ text, score: 0 }));
  return { results };
}

// POST /api/memwal/recall { namespace, query } — recall via the server-side delegate.
async function memwalRecall(request: Request, env: WorkerEnv): Promise<Response> {
  let body: { namespace?: unknown; query?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const namespace = typeof body.namespace === "string" ? body.namespace.trim() : "";
  const query = typeof body.query === "string" ? body.query.trim().slice(0, 500) : "";
  if (!namespace || !query) return json({ error: "namespace and query are required." }, 400);
  const { url, privateKey, accountId } = resolveMemwalCreds(request, env);
  // Try real Walrus Memory recall when we have a valid delegate.
  if (isMemwalSeed(privateKey) && accountId) {
    try {
      const result = await new MemWalMcpClient({ url, privateKey, accountId }).recallSiteContext(namespace, query);
      return json({ namespace, query, source: "walrus-memory", result });
    } catch {
      /* fall through to the facts fallback so the Memory tab still answers */
    }
  }
  // Fallback: answer from the namespace's verified facts (no delegate required).
  const fallback = factsFallbackRecall(namespace, query);
  if (fallback) return json({ namespace, query, source: "facts", result: fallback });
  return json({ error: "Walrus Memory recall needs a valid 64-char hex delegate. Re-import your delegate in Settings, or set MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID on the Worker." }, 503);
}

// Llama-3.1-8b ignores "JSON only" instructions often: it wraps JSON in a
// ```json fence, or emits prose first. Recover {answer,key_points,confidence}
// from whatever shape came back; degrade to the raw text as the answer.
function parseChatEnvelope(answerText: string): { data: { answer: string; key_points: string[] }; confidence: number } {
  let confidence = 0.5;
  let jsonCandidate: string | null = null;
  let trailingProse = "";
  const fenceMatch = answerText.match(/```(?:json)?\s*([\s\S]*?)\s*```([\s\S]*)$/i);
  if (fenceMatch) {
    jsonCandidate = fenceMatch[1]!.trim();
    trailingProse = (fenceMatch[2] ?? "").trim();
  } else {
    const firstBrace = answerText.indexOf("{");
    if (firstBrace >= 0) {
      // Grab from the first brace to the matching end — tolerate prose after it.
      const lastBrace = answerText.lastIndexOf("}");
      if (lastBrace > firstBrace) {
        jsonCandidate = answerText.slice(firstBrace, lastBrace + 1).trim();
        trailingProse = answerText.slice(lastBrace + 1).trim();
      }
    }
  }
  if (jsonCandidate) {
    try {
      const parsed = JSON.parse(jsonCandidate) as Record<string, unknown>;
      const answer = typeof parsed.answer === "string" && parsed.answer.trim() ? parsed.answer.trim() : trailingProse || answerText.trim();
      const keyPoints = Array.isArray(parsed.key_points)
        ? parsed.key_points.map((k) => String(k)).filter(Boolean).slice(0, 6)
        : Array.isArray((parsed as { keyFacts?: unknown }).keyFacts)
          ? ((parsed as { keyFacts: unknown[] }).keyFacts.map((k) => String(k)).filter(Boolean).slice(0, 6))
          : [];
      if (typeof parsed.confidence === "number") confidence = Math.max(0, Math.min(1, parsed.confidence));
      return { data: { answer, key_points: keyPoints }, confidence };
    } catch {
      /* fall through to raw text */
    }
  }
  return { data: { answer: answerText.trim(), key_points: [] }, confidence };
}

// Build a rich, grounded context block from a namespace's verified knowledge
// graph: identity + entities (what it's made of) + topics + claims + stats +
// Q&A. The more grounded material the model sees, the fewer "I don't know"s.
function factsGroundingBlock(namespace: string): string {
  const facts = SEED_FACTS[namespace];
  if (!facts) return "";
  const lines: string[] = [];
  if (facts.identity?.name) lines.push(`Project: ${facts.identity.name}${facts.identity.oneLiner ? ` — ${facts.identity.oneLiner}` : ""}`);
  if (facts.identity?.category) lines.push(`Category: ${facts.identity.category}`);
  const topics = (facts.topics ?? []).map((t) => t.label).filter(Boolean);
  if (topics.length) lines.push(`Topics: ${topics.slice(0, 12).join(", ")}`);
  const entities = [...(facts.entities ?? [])].sort((a, b) => (b.salience ?? 0) - (a.salience ?? 0)).slice(0, 16);
  for (const e of entities) if (e.description) lines.push(`Entity (${e.type}) ${e.name}: ${e.description}`);
  for (const c of (facts.claims ?? []).slice(0, 12)) if (c.text) lines.push(`Claim: ${c.text}`);
  for (const s of (facts.stats ?? []).slice(0, 12)) if (s.valueRaw) lines.push(`Stat: ${s.label} = ${s.valueRaw}`);
  for (const q of (facts.questions ?? []).slice(0, 10)) if (q.answer) lines.push(`Q: ${q.question}\nA: ${q.answer}`);
  return lines.join("\n");
}

// POST /api/memwal/chat { namespace, messages:[{role,content}], topK?, maxDistance? }
// Multi-turn grounded chat: recall from Walrus Memory (when a delegate is present)
// + the namespace's verified facts, synthesize a conversational answer with
// Workers AI, and return an AiQueryResult-compatible envelope. Never a dead
// error — falls back to facts-only grounding when recall is unavailable.
async function memwalChat(request: Request, env: WorkerEnv): Promise<Response> {
  let body: { namespace?: unknown; messages?: unknown; topK?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const namespace = typeof body.namespace === "string" ? body.namespace.trim() : "";
  const rawMessages = Array.isArray(body.messages) ? body.messages : [];
  const messages = rawMessages
    .map((m) => {
      const role = (m as { role?: unknown })?.role === "assistant" ? "assistant" : "user";
      const content = typeof (m as { content?: unknown })?.content === "string" ? (m as { content: string }).content.trim().slice(0, 2000) : "";
      return { role: role as "user" | "assistant", content };
    })
    .filter((m) => m.content)
    .slice(-8); // keep the request small; replay only the last 8 turns
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const query = lastUser ? lastUser.content.slice(0, 500) : "";
  if (!namespace || !query) return json({ error: "namespace and a user message are required." }, 400);

  const { url, privateKey, accountId } = resolveMemwalCreds(request, env);

  // 1) Grounding — real Walrus Memory recall when we have a valid delegate.
  let recallHits: Array<{ text: string; distance?: number }> = [];
  if (isMemwalSeed(privateKey) && accountId) {
    try {
      const result = (await new MemWalMcpClient({ url, privateKey, accountId }).recallSiteContext(namespace, query)) as {
        results?: Array<{ text?: string; distance?: number }>;
      };
      recallHits = (result?.results ?? [])
        .map((r) => ({ text: String(r.text ?? "").trim(), distance: typeof r.distance === "number" ? r.distance : undefined }))
        .filter((r) => r.text)
        .slice(0, 6);
    } catch {
      /* fall through to facts-only grounding so chat still answers */
    }
  }
  const factsBlock = factsGroundingBlock(namespace);
  const hasRecall = recallHits.length > 0;
  const source: "walrus-memory" | "facts" | "mixed" = hasRecall && factsBlock ? "mixed" : hasRecall ? "walrus-memory" : "facts";

  const groundingParts: string[] = [];
  if (hasRecall) groundingParts.push("[Walrus Memory recall — stored context for this namespace]\n" + recallHits.map((h, i) => `(${i + 1}) ${h.text.slice(0, 700)}`).join("\n"));
  if (factsBlock) groundingParts.push("[Verified facts — extracted knowledge graph]\n" + factsBlock);
  const grounding = groundingParts.join("\n\n") || "(no stored context available for this namespace yet)";

  const facts = SEED_FACTS[namespace];
  const subject = facts?.identity?.name ?? namespace;
  const systemPrompt = `You are ContextMeM, a helpful assistant that chats naturally about "${subject}". Answer the user's latest message using ONLY the provided context (Walrus Memory recall + the verified knowledge graph: entities, topics, claims, stats, Q&A). Synthesize across ALL of it — the entities and topics describe how it works and what it's made of, so use them to answer "how it works" and "key facts" questions. When the user asks for numbers, metrics, limits, prices, or costs, surface the specific Stat values from the context verbatim — do NOT abstain whenever any relevant Stat or fact is present. Be conversational and specific. Only when NOTHING in the context relates to the question should you say you don't have that detail in memory yet — never invent specifics that aren't in the context. Reply with a single JSON object on the FIRST line with keys: answer (string, a natural conversational reply), key_points (array of 2-5 short strings), confidence (0-1). You may add a short human paragraph after the JSON.\n\nContext for namespace ${namespace}:\n\n${grounding}`;

  let answerText = "";
  let usedProvider = "";
  const aiMessages = [{ role: "system" as const, content: systemPrompt }, ...messages];
  const openAiKey = env.OPENAI_API_KEY?.trim();
  if (openAiKey) {
    // Prefer an OpenAI-compatible model (OpenRouter, OpenAI, etc.) — higher
    // quality than the on-edge llama. Set OPENAI_BASE_URL + OPENAI_MODEL to pick.
    const baseUrl = (env.OPENAI_BASE_URL?.trim() || "https://openrouter.ai/api/v1").replace(/\/$/, "");
    const model = env.OPENAI_MODEL?.trim() || "openai/gpt-4o-mini";
    usedProvider = `openai-compatible:${model}`;
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${openAiKey}`,
          "content-type": "application/json",
          "HTTP-Referer": "https://contextmem.pages.dev",
          "X-Title": "ContextMeM"
        },
        body: JSON.stringify({ model, messages: aiMessages, max_tokens: 800, temperature: 0.3 })
      });
      if (!response.ok) throw new Error(`${response.status} ${(await response.text()).slice(0, 160)}`);
      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      answerText = payload.choices?.[0]?.message?.content ?? "";
      if (!answerText.trim()) throw new Error("empty completion");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      usedProvider = `error:${message.slice(0, 80)}`;
      answerText = `{"answer":"AI synthesis failed: ${message.replace(/[\\"]/g, "")}","key_points":[],"confidence":0}`;
    }
  } else if (env.AI) {
    usedProvider = "workers-ai:@cf/meta/llama-3.1-8b-instruct";
    try {
      const aiResponse = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
        messages: aiMessages,
        max_tokens: 800,
        temperature: 0.3
      });
      if (typeof aiResponse === "string") answerText = aiResponse;
      else if (typeof (aiResponse as { response?: string })?.response === "string") answerText = (aiResponse as { response: string }).response;
      else if (typeof (aiResponse as { result?: { response?: string } })?.result?.response === "string") answerText = (aiResponse as { result: { response: string } }).result.response;
      else answerText = JSON.stringify(aiResponse);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      usedProvider = `error:${message.slice(0, 80)}`;
      answerText = `{"answer":"AI synthesis failed: ${message.replace(/[\\"]/g, "")}","key_points":[],"confidence":0}`;
    }
  } else {
    usedProvider = "fallback:no-ai-binding";
    answerText = `{"answer":"This worker has no chat model configured (set OPENAI_API_KEY or bind Workers AI). Showing grounded facts only.","key_points":[],"confidence":0}`;
  }

  const { data, confidence } = parseChatEnvelope(answerText);
  const sources = hasRecall
    ? recallHits.map((h, index) => ({ url: "", routePath: `walrus-memory#${index + 1}`, quote: h.text.slice(0, 280), blobId: typeof h.distance === "number" ? `distance ${h.distance.toFixed(3)}` : undefined }))
    : (factsFallbackRecall(namespace, query)?.results ?? []).slice(0, 4).map((r, index) => ({ url: "", routePath: `verified-fact#${index + 1}`, quote: r.text.slice(0, 280) }));

  return json({ namespace, target: subject, source, data, confidence, usedProvider, sources });
}

function maybeWithMemWalRecall(store: CloudflareNamespaceStore, env: WorkerEnv, request: Request): HostedNamespaceStore {
  // The Ed25519-signed MemWal SDK needs serverUrl + privateKey + accountId.
  // Header overrides let the web client supply per-session credentials; env
  // secrets are the fallback so anonymous-but-server-configured deployments
  // still expose recall/restore tools.
  const headerKey = request.headers.get("x-memwal-private-key") ?? request.headers.get("x-memwal-bearer") ?? request.headers.get("x-memwal-authorization")?.replace(/^Bearer\s+/i, "");
  const url = request.headers.get("x-memwal-api-url") ?? request.headers.get("x-memwal-mcp-url") ?? env.MEMWAL_API_URL ?? env.MEMWAL_MCP_URL;
  const privateKey = headerKey ?? env.MEMWAL_PRIVATE_KEY ?? env.MEMWAL_BEARER;
  const accountId = request.headers.get("x-memwal-account-id") ?? env.MEMWAL_ACCOUNT_ID;
  if (!url || !privateKey || !accountId) return store;
  const buildClient = () => new MemWalMcpClient({ url, privateKey, accountId });
  return {
    getNamespace: (namespace) => store.getNamespace(namespace),
    listArtifacts: (namespace) => store.listArtifacts(namespace),
    readArtifact: (namespace, artifactPath) => store.readArtifact(namespace, artifactPath),
    recallMemory: (namespace, query) => buildClient().recallSiteContext(namespace, query),
    restoreMemory: (namespace) => buildClient().restoreSiteMemory(namespace)
  };
}

async function assertManagedNamespace(env: WorkerEnv, namespace: string, ownerId?: string): Promise<HostedNamespaceSummary> {
  const summary = await new CloudflareNamespaceStore(env).getNamespace(namespace);
  if (!summary || (ownerId && summary.ownerId !== ownerId)) throw statusError(`Namespace not found: ${namespace}`, 404);
  return summary;
}

async function getExtractionJobRow(env: WorkerEnv, jobId: string): Promise<ExtractionJobRow | undefined> {
  const row = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, owner_id, namespace, target, status, visibility, display_name, description, tags_json, directory_enabled, source_type, build_kind, sources_json, source_count, error, result_json, created_at, updated_at, completed_at
     FROM contextmem_extraction_jobs
     WHERE id = ?`
  )
    .bind(jobId)
    .first<ExtractionJobRow>();
  return row ?? undefined;
}

async function getExtractionJob(env: WorkerEnv, jobId: string) {
  const row = await getExtractionJobRow(env, jobId);
  if (!row) return undefined;
  return publicExtractionJobFromRow(row, env);
}

function publicExtractionJobFromRow(row: ExtractionJobRow, env: WorkerEnv): PublicExtractionJob {
  const result = row.result_json ? normalizeExtractionResultLinks(JSON.parse(row.result_json) as Record<string, unknown>, row.namespace, env) : undefined;
  const sources = sourcesForJob(row);
  return {
    id: row.id,
    ownerId: row.owner_id,
    namespace: row.namespace,
    target: row.target,
    buildKind: row.build_kind ?? (sources.length > 1 ? "multi" : "single"),
    sources,
    sourceCount: Number(row.source_count ?? sources.length),
    status: row.status,
    visibility: row.visibility,
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    tags: parseTags(row.tags_json),
    directoryEnabled: Boolean(row.directory_enabled),
    sourceType: row.source_type ?? "extract",
    error: row.error ?? undefined,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined
  };
}

function hostedRunManifest(job: PublicExtractionJob) {
  return {
    runId: job.id,
    target: job.target,
    buildKind: job.buildKind,
    sources: job.sources,
    sourceCount: job.sourceCount,
    mode: hostedRunMode(job.target),
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    artifactDir: `hosted:${job.namespace}`,
    namespace: job.namespace,
    outputs: hostedRunOutputs(job),
    buildProfile: hostedRunBuildProfile(job),
    progress: hostedRunProgress(job),
    errors: job.error ? [job.error] : []
  };
}

function hostedRunResponse(job: PublicExtractionJob, artifact?: Record<string, unknown>) {
  const resources = Array.isArray(artifact?.resources) ? artifact.resources.length : Array.isArray((artifact?.walrus as { resources?: unknown[] } | undefined)?.resources) ? (artifact?.walrus as { resources?: unknown[] }).resources!.length : 0;
  const pages = Array.isArray(artifact?.pages) ? artifact.pages.length : undefined;
  return {
    manifest: hostedRunManifest(job),
    pages,
    sourceCount: job.sourceCount,
    sources: job.sources,
    walrus: hostedRunMode(job.target) === "walrus" ? { resources, pages: pages ?? 0 } : undefined
  };
}

function hostedRunHistoryItem(job: PublicExtractionJob) {
  const manifest = hostedRunManifest(job);
  return {
    runId: manifest.runId,
    target: manifest.target,
    mode: manifest.mode,
    status: manifest.status,
    namespace: manifest.namespace,
    updatedAt: manifest.updatedAt,
    pages: Number((job.result as { pages?: unknown } | undefined)?.pages ?? 0),
    images: 0,
    resources: Number((job.result as { artifactCount?: unknown } | undefined)?.artifactCount ?? 0),
    hasDesignSystem: false,
    hasScreenshots: false,
    sourceCount: job.sourceCount,
    sources: job.sources,
    errors: manifest.errors
  };
}

async function artifactManifestForJob(env: WorkerEnv, job: PublicExtractionJob): Promise<Record<string, unknown>> {
  const artifact = await new CloudflareNamespaceStore(env).readArtifact(job.namespace, "/context/manifest.json");
  if (!artifact || artifact.encoding !== "utf8") throw statusError("Run artifact manifest not found.", 404);
  return normalizeHostedArtifactManifest(safeJsonParse(artifact.content), job);
}

function normalizeHostedArtifactManifest(value: unknown, job: PublicExtractionJob): Record<string, unknown> {
  const source = value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
  const pages = Array.isArray(source.pages) ? source.pages : [];
  const resources = Array.isArray(source.resources) ? (source.resources as Array<Record<string, unknown>>) : [];
  const images = Array.isArray(source.images)
    ? source.images
    : resources
        .filter((resource) => String(resource.kind ?? "").includes("image"))
        .map((resource) => ({
          src: resource.url,
          absoluteUrl: String(resource.url ?? job.target),
          role: "resource",
          contentType: resource.kind
        }));
  const normalized: Record<string, unknown> = {
    ...source,
    runId: String(source.runId ?? job.id),
    target: String(source.target ?? job.target),
    generatedAt: String(source.generatedAt ?? job.completedAt ?? job.updatedAt),
    pages,
    images
  };
  const rawWalrus = source.walrus;
  const hasStructuredWalrus = rawWalrus && typeof rawWalrus === "object" && Array.isArray((rawWalrus as { resources?: unknown }).resources);
  if (hasStructuredWalrus) return normalized;
  if (hostedRunMode(job.target) === "walrus") {
    normalized.walrus = {
      site: {
        network: "mainnet",
        siteObjectId: String((source.metadata as Record<string, unknown> | undefined)?.["x-walrus-site-object-id"] ?? "unknown"),
        aggregatorUrl: job.target
      },
      resources: resources.map((resource, index) => ({
        path: new URL(String(resource.url ?? job.target), job.target).pathname || `/resource-${index + 1}`,
        blobId: String(resource.blobId ?? ""),
        blobHash: String(resource.blobHash ?? ""),
        contentType: String(resource.kind ?? "resource"),
        aggregatorUrl: String(resource.url ?? job.target)
      }))
    };
  } else {
    delete normalized.walrus;
  }
  return normalized;
}

function hostedRunMode(target: string): "web" | "walrus" {
  try {
    return new URL(target).hostname.endsWith(".wal.app") ? "walrus" : "web";
  } catch {
    return "web";
  }
}

function hostedRunOutputs(job: PublicExtractionJob): string[] {
  const outputs = job.tags.flatMap((tag) => (tag.startsWith("output:") ? [tag.slice("output:".length)] : []));
  return outputs.length ? outputs : hostedRunDefaultOutputs;
}

function hostedRunBuildProfile(job: PublicExtractionJob): "fast" | "balanced" | "full" {
  const profile = job.tags.find((tag) => tag.startsWith("profile:"))?.slice("profile:".length);
  return profile === "fast" || profile === "balanced" || profile === "full" ? profile : "balanced";
}

function hostedRunProgress(job: PublicExtractionJob) {
  const phase = job.status === "queued" ? "queued" : job.status === "running" ? "crawling_pages" : job.status === "completed" ? "completed" : "failed";
  const label =
    job.status === "completed"
      ? "Hosted context package is ready"
      : job.status === "failed"
        ? job.error ?? "Hosted context build failed"
        : job.status === "running"
          ? "Fetching the target and writing hosted artifacts"
          : "Queued hosted context build";
  return {
    phase,
    label,
    updatedAt: job.updatedAt
  };
}

async function namespaceFiles(env: WorkerEnv, namespace: string): Promise<NamespaceImportInput["files"]> {
  const store = new CloudflareNamespaceStore(env);
  const artifacts = await store.listArtifacts(namespace);
  const files: NamespaceImportInput["files"] = [];
  for (const artifact of artifacts) {
    const content = await store.readArtifact(namespace, artifact.path);
    if (!content) continue;
    files.push({
      path: artifact.path,
      contentType: artifact.contentType,
      encoding: content.encoding,
      content: content.content
    });
  }
  return files;
}

function hostedArtifactFileRecord(artifact: HostedArtifactRecord) {
  const kind = hostedArtifactKind(artifact);
  return {
    path: artifact.path,
    size: artifact.size,
    updatedAt: artifact.updatedAt,
    contentType: artifact.contentType,
    kind,
    group: artifactGroup(artifact.path, kind),
    previewable: ["json", "markdown", "html", "css", "text"].includes(kind),
    downloadable: true
  };
}

function hostedArtifactKind(artifact: HostedArtifactRecord): "json" | "markdown" | "html" | "image" | "css" | "text" | "binary" | "other" {
  if (/^image\//i.test(artifact.contentType)) return "image";
  const kind = inferHostedArtifactKind(artifact.path, artifact.contentType);
  if (kind === "json" || kind === "markdown" || kind === "html" || kind === "css" || kind === "text" || kind === "binary") return kind;
  return "other";
}

function artifactGroup(path: string, kind: string): "core" | "design-system" | "walrus" | "screenshots" | "package" | "pages" | "assets" | "other" {
  if (path === "/llms.txt" || path === "/context/manifest.json") return "core";
  if (path.includes("design") || path.includes("styleguide") || path.includes("brand")) return "design-system";
  if (path.includes("walrus") || path.includes("resources")) return "walrus";
  if (path.includes("screenshot")) return "screenshots";
  if (path.startsWith("/site/")) return "pages";
  if (kind === "image") return "assets";
  if (path.startsWith("/context/")) return "package";
  return "other";
}

async function insertSchedule(input: z.infer<typeof scheduleCreateSchema>, env: WorkerEnv) {
  const target = validatePublicDemoTarget(input.target);
  const now = new Date().toISOString();
  const id = `sch_${cryptoRandomId(10)}`;
  const namespace = normalizeNamespace(input.namespace ?? namespaceForExtractTarget(target));
  const nextRunAt = new Date(Date.now() + input.intervalHours * 60 * 60 * 1000).toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_schedules (id, owner_id, namespace, target, interval_hours, webhook_url, webhook_secret, active, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, input.ownerId, namespace, target.toString(), input.intervalHours, input.webhookUrl ?? null, input.webhookSecret ?? null, input.active ? 1 : 0, nextRunAt, now, now)
    .run();
  return publicSchedule((await getScheduleRow(env, id))!);
}

async function getScheduleRow(env: WorkerEnv, scheduleId: string, ownerId?: string): Promise<ScheduleRow | undefined> {
  const row = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, owner_id, namespace, target, interval_hours, webhook_url, webhook_secret, active, last_run_at, next_run_at, created_at, updated_at
     FROM contextmem_schedules
     WHERE id = ?`
  )
    .bind(scheduleId)
    .first<ScheduleRow>();
  if (!row || (ownerId && row.owner_id !== ownerId)) return undefined;
  return row;
}

export async function processDueSchedules(env: WorkerEnv, ctx: WorkerExecutionContext = {}): Promise<void> {
  const now = new Date();
  const result = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, owner_id, namespace, target, interval_hours, webhook_url, webhook_secret, active, last_run_at, next_run_at, created_at, updated_at
     FROM contextmem_schedules
     WHERE active = 1
       AND next_run_at <= ?
     ORDER BY next_run_at ASC
     LIMIT 10`
  )
    .bind(now.toISOString())
    .all<ScheduleRow>();
  for (const schedule of allResults(result)) {
    await runSchedule(schedule, env, ctx).catch(() => undefined);
  }
}

async function runSchedule(schedule: ScheduleRow, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<void> {
  const runId = `sr_${cryptoRandomId(10)}`;
  const now = new Date().toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_schedule_runs (id, schedule_id, status, created_at)
     VALUES (?, ?, 'running', ?)`
  )
    .bind(runId, schedule.id, now)
    .run();
  try {
    const existingNamespace = await new CloudflareNamespaceStore(env).getNamespace(schedule.namespace).catch(() => undefined);
    const sources = existingNamespace?.sources?.length
      ? existingNamespace.sources.map((source) => ({ target: source.target, label: source.label, mode: source.mode ?? "auto" }))
      : [{ target: schedule.target, label: displayNameFromTarget(schedule.target), mode: schedule.target.includes(".wal.app") ? "walrus" as const : "web" as const }];
    const job = await createNamespaceBuildJob(
      {
        ownerId: schedule.owner_id,
        namespace: schedule.namespace,
        visibility: "private",
        displayName: displayNameFromTarget(schedule.target),
        tags: ["schedule", "context"],
        directoryEnabled: false,
        sources
      },
      env,
      ctx
    );
    const summary = await diffSummaryForNamespace(env, schedule.namespace);
    await env.CONTEXTMEM_DB.prepare(
      `UPDATE contextmem_schedule_runs
       SET extraction_job_id = ?, status = 'completed', diff_json = ?, completed_at = ?
       WHERE id = ?`
    )
      .bind(job?.id ?? null, JSON.stringify(summary), new Date().toISOString(), runId)
      .run();
    await createAlertForSchedule(schedule, summary, env);
    const nextRunAt = new Date(Date.now() + Number(schedule.interval_hours) * 60 * 60 * 1000).toISOString();
    await env.CONTEXTMEM_DB.prepare(
      `UPDATE contextmem_schedules
       SET last_run_at = ?, next_run_at = ?, updated_at = ?
       WHERE id = ?`
    )
      .bind(new Date().toISOString(), nextRunAt, new Date().toISOString(), schedule.id)
      .run();
  } catch (error) {
    await env.CONTEXTMEM_DB.prepare(
      `UPDATE contextmem_schedule_runs
       SET status = 'failed', error = ?, completed_at = ?
       WHERE id = ?`
    )
      .bind(error instanceof Error ? error.message : String(error), new Date().toISOString(), runId)
      .run();
    throw error;
  }
}

async function createAlertForSchedule(schedule: ScheduleRow, diffSummary: unknown, env: WorkerEnv): Promise<void> {
  const alertId = `al_${cryptoRandomId(10)}`;
  const now = new Date().toISOString();
  const message = `Scheduled ContextMeM re-scrape completed for ${schedule.target}.`;
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_alerts (id, owner_id, schedule_id, namespace, target, title, message, diff_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(alertId, schedule.owner_id, schedule.id, schedule.namespace, schedule.target, "Context changed", message, JSON.stringify(diffSummary), now)
    .run();
  if (schedule.webhook_url) await deliverWebhook(alertId, schedule, diffSummary, env);
}

async function deliverWebhook(alertId: string, schedule: ScheduleRow, diffSummary: unknown, env: WorkerEnv): Promise<void> {
  if (!schedule.webhook_url) return;
  const deliveryId = `wh_${cryptoRandomId(10)}`;
  const now = new Date().toISOString();
  const body = JSON.stringify({
    type: "contextmem.schedule.completed",
    alertId,
    scheduleId: schedule.id,
    namespace: schedule.namespace,
    target: schedule.target,
    diffSummary,
    createdAt: now
  });
  const signature = await signWebhookPayload(body, schedule.webhook_secret ?? env.CONTEXTMEM_WEBHOOK_SECRET ?? "contextmem-dev-webhook-secret");
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_webhook_deliveries (id, alert_id, webhook_url, status, attempts, created_at, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?)`
  )
    .bind(deliveryId, alertId, schedule.webhook_url, now, now)
    .run();
  try {
    const response = await fetch(schedule.webhook_url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-contextmem-signature": signature
      },
      body
    });
    await env.CONTEXTMEM_DB.prepare(
      `UPDATE contextmem_webhook_deliveries
       SET status = ?, status_code = ?, attempts = 1, updated_at = ?
       WHERE id = ?`
    )
      .bind(response.ok ? "sent" : "failed", response.status, new Date().toISOString(), deliveryId)
      .run();
  } catch (error) {
    await env.CONTEXTMEM_DB.prepare(
      `UPDATE contextmem_webhook_deliveries
       SET status = 'failed', error = ?, attempts = 1, updated_at = ?
       WHERE id = ?`
    )
      .bind(error instanceof Error ? error.message : String(error), new Date().toISOString(), deliveryId)
      .run();
  }
}

async function signWebhookPayload(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `sha256=${[...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function diffSummaryForNamespace(env: WorkerEnv, namespace: string) {
  const result = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, manifest_json, created_at
     FROM contextmem_namespace_versions
     WHERE namespace = ?
     ORDER BY created_at DESC
     LIMIT 2`
  )
    .bind(namespace)
    .all<{ id: string; manifest_json: string; created_at: string }>();
  const versions = allResults(result);
  const current = versions[0]?.manifest_json ? (safeJsonParse(versions[0].manifest_json) as Record<string, unknown> | undefined) : undefined;
  const previous = versions[1]?.manifest_json ? (safeJsonParse(versions[1].manifest_json) as Record<string, unknown> | undefined) : undefined;
  return {
    pages: diffRecordArrays(previous?.pages, current?.pages, "url", "markdown"),
    resources: diffRecordArrays(previous?.resources, current?.resources, "url", "kind"),
    images: diffRecordArrays(previous?.images, current?.images, "absoluteUrl", "contentType"),
    designTokens: diffDesignTokens(previous?.designSystem, current?.designSystem)
  };
}

function diffRecordArrays(beforeValue: unknown, afterValue: unknown, keyField: string, hashField: string) {
  const before = mapRecordArray(beforeValue, keyField, hashField);
  const after = mapRecordArray(afterValue, keyField, hashField);
  return countDiffMaps(before, after);
}

function mapRecordArray(value: unknown, keyField: string, hashField: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(value)) return map;
  value.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    const key = String(record[keyField] ?? record.path ?? record.routePath ?? `${index}`);
    map.set(key, JSON.stringify(record[hashField] ?? record));
  });
  return map;
}

function diffDesignTokens(beforeValue: unknown, afterValue: unknown) {
  const beforeColors = tokenMap(beforeValue);
  const afterColors = tokenMap(afterValue);
  return countDiffMaps(beforeColors, afterColors);
}

function tokenMap(value: unknown): Map<string, string> {
  const colors = value && typeof value === "object" ? ((value as Record<string, unknown>).tokens as Record<string, unknown> | undefined)?.colors : undefined;
  const map = new Map<string, string>();
  if (!Array.isArray(colors)) return map;
  colors.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    map.set(String(record.name ?? index), String(record.value ?? JSON.stringify(record)));
  });
  return map;
}

function countDiffMaps(before: Map<string, string>, after: Map<string, string>) {
  let added = 0;
  let removed = 0;
  let changed = 0;
  let unchanged = 0;
  for (const [key, value] of after) {
    if (!before.has(key)) added++;
    else if (before.get(key) === value) unchanged++;
    else changed++;
  }
  for (const key of before.keys()) {
    if (!after.has(key)) removed++;
  }
  return { added, removed, changed, unchanged };
}

async function getShareLinkRow(env: WorkerEnv, shareId: string): Promise<ShareLinkRow | undefined> {
  const row = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, namespace, target, title, description, source_run_id, version_id, artifact_count, byte_length, created_at, updated_at
     FROM contextmem_share_links
     WHERE id = ?`
  )
    .bind(shareId)
    .first<ShareLinkRow>();
  return row ?? undefined;
}

function publicSchedule(row: ScheduleRow) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    namespace: row.namespace,
    target: row.target,
    intervalHours: Number(row.interval_hours),
    webhookUrl: row.webhook_url ?? undefined,
    webhookConfigured: Boolean(row.webhook_url),
    active: Boolean(row.active),
    lastRunAt: row.last_run_at ?? undefined,
    nextRunAt: row.next_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function publicAlert(row: AlertRow) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    scheduleId: row.schedule_id ?? undefined,
    namespace: row.namespace,
    target: row.target,
    title: row.title,
    message: row.message,
    diffSummary: row.diff_json ? safeJsonParse(row.diff_json) : undefined,
    readAt: row.read_at ?? undefined,
    createdAt: row.created_at
  };
}

function publicShareLink(row: ShareLinkRow, request: Request, env: WorkerEnv) {
  return {
    id: row.id,
    namespace: row.namespace,
    target: row.target,
    title: row.title ?? undefined,
    description: row.description ?? undefined,
    sourceRunId: row.source_run_id ?? undefined,
    versionId: row.version_id,
    artifactCount: Number(row.artifact_count),
    byteLength: Number(row.byte_length),
    url: `${workerBaseUrl(request, env)}/share/${row.id}`,
    mcpUrl: namespaceMcpUrl(request, env, row.namespace),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function shareLinkFromImport(shareId: string, namespace: string, input: z.infer<typeof shareLinkCreateSchema>, imported: Awaited<ReturnType<typeof storeNamespaceImport>>, now: string, request: Request, env: WorkerEnv) {
  return {
    id: shareId,
    namespace,
    target: input.target,
    title: input.title,
    description: input.description,
    sourceRunId: input.sourceRunId,
    versionId: imported.versionId,
    artifactCount: imported.artifactCount,
    byteLength: imported.byteLength,
    url: `${workerBaseUrl(request, env)}/share/${shareId}`,
    mcpUrl: namespaceMcpUrl(request, env, namespace),
    createdAt: now,
    updatedAt: now
  };
}

function validatePublicDemoTarget(value: string): URL {
  if (/^0x[0-9a-f]{32,}$/i.test(value.trim())) {
    throw statusError("Hosted demo accepts public http(s) URLs. Random Sui object IDs need the full local Walrus run flow.", 400);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw statusError("Demo target must be a full http(s) URL.", 400);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw statusError("Demo target must use http or https.", 400);
  if (url.username || url.password) throw statusError("Demo target may not include credentials.", 400);
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".local")) throw statusError("Demo target must be public, not localhost.", 400);
  if (isPrivateIpv4(host)) throw statusError("Demo target must be public, not a private IP.", 400);
  if (process.env.CONTEXTMEM_ALLOW_PLACEHOLDER_HOSTS !== "true" && isReservedExampleHost(host)) {
    throw statusError(
      "example.com / .org / .net are IANA placeholder domains with no real content. Try a real product site — e.g., a .wal.app Walrus Site or your own marketing URL.",
      400,
      "DEMO_PLACEHOLDER_HOST",
      "Paste a real Walrus Site (e.g., https://fmsprint.wal.app/) or a public product URL so the demo has actual content to extract."
    );
  }
  url.hash = "";
  return url;
}

function normalizeNamespaceBuildSources(input: Array<z.infer<typeof namespaceBuildSourceSchema>>): NamespaceBuildSource[] {
  const seen = new Set<string>();
  return input.map((source, index) => {
    const target = validatePublicDemoTarget(source.target);
    target.search = "";
    const normalizedTarget = target.toString();
    if (seen.has(normalizedTarget)) throw statusError(`Duplicate namespace source: ${normalizedTarget}`, 400);
    seen.add(normalizedTarget);
    const label = source.label?.trim() || displayNameFromTarget(normalizedTarget);
    return {
      id: uniqueSourceId(label, target, index),
      target: normalizedTarget,
      label,
      mode: source.mode ?? "auto"
    };
  });
}

function sourcesForJob(job: Pick<ExtractionJobRow, "target" | "display_name" | "sources_json">): NamespaceBuildSource[] {
  if (job.sources_json) {
    try {
      const parsed = JSON.parse(job.sources_json) as unknown;
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.slice(0, 5).map((source, index) => {
          const record = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
          const target = String(record.target ?? job.target);
          const url = validatePublicDemoTarget(target);
          const label = typeof record.label === "string" && record.label.trim() ? record.label.trim() : displayNameFromTarget(url.toString());
          const modeValue = record.mode === "web" || record.mode === "walrus" || record.mode === "auto" ? record.mode : "auto";
          return {
            id: typeof record.id === "string" && record.id.trim() ? record.id.trim() : uniqueSourceId(label, url, index),
            target: url.toString(),
            label,
            mode: modeValue
          };
        });
      }
    } catch {
      // fall through to single-source compatibility
    }
  }
  const target = validatePublicDemoTarget(job.target);
  const label = job.display_name ?? displayNameFromTarget(target.toString());
  return [{ id: uniqueSourceId(label, target, 0), target: target.toString(), label, mode: target.hostname.endsWith(".wal.app") ? "walrus" : "web" }];
}

function sourceKind(source: NamespaceBuildSource): "web" | "walrus" {
  if (source.mode === "walrus") return "walrus";
  if (source.mode === "web") return "web";
  return new URL(source.target).hostname.endsWith(".wal.app") ? "walrus" : "web";
}

function namespaceForBuildSources(sources: NamespaceBuildSource[]): string {
  const first = new URL(sources[0]!.target);
  if (sources.length === 1) return namespaceForExtractTarget(first);
  return `ctx:${slugNamespace(first.hostname)}:${createShortId()}`;
}

function uniqueSourceId(label: string, target: URL, index: number): string {
  const base = slugNamespace(label || target.hostname) || slugNamespace(target.hostname) || "source";
  return `${base.slice(0, 36)}-${index + 1}`;
}

function isReservedExampleHost(host: string): boolean {
  const reserved = new Set([
    "example.com",
    "example.org",
    "example.net",
    "example.edu",
    "test.com",
    "invalid",
    "localhost"
  ]);
  if (reserved.has(host)) return true;
  return /(^|\.)example\.(com|org|net|edu)$/.test(host) || host.endsWith(".test") || host.endsWith(".invalid") || host.endsWith(".example");
}

function isPrivateIpv4(host: string): boolean {
  const parts = host.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

async function consumeDemoQuota(request: Request, env: WorkerEnv): Promise<void> {
  const ip = clientIp(request);
  const day = new Date().toISOString().slice(0, 10);
  const ipHash = await sha256Hex(ip);
  const key = `${day}:${ipHash}`;
  const existing = await env.CONTEXTMEM_DB.prepare(`SELECT bucket_key, count FROM contextmem_demo_limits WHERE bucket_key = ?`).bind(key).first<{ bucket_key: string; count: number }>();
  if (existing && Number(existing.count) >= 1) throw statusError("Demo limit reached for today. Import MemWal credentials to unlock unlimited builds.", 429, "DEMO_LIMIT_EXCEEDED", "Open /app/settings, paste your MemWal account ID and delegate private key, then run the build again — the demo quota is bypassed once the delegate is attached.");
  const now = new Date().toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_demo_limits (bucket_key, ip_hash, day, count, updated_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(bucket_key) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at`
  )
    .bind(key, ipHash, day, now)
    .run();
}

function clientIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "127.0.0.1";
}

function demoOwnerId(request: Request): string {
  return `demo:${clientIp(request).replace(/[^a-zA-Z0-9_.:-]/g, "_")}`;
}

function normalizeExtractionResultLinks(result: Record<string, unknown>, namespace: string, env: WorkerEnv): Record<string, unknown> {
  const request = new Request(`${workerBaseUrlFromEnv(env)}/internal`);
  const next: Record<string, unknown> = {
    ...result,
    mcpUrl: namespaceMcpUrl(request, env, namespace),
    gatewayMcpUrl: `${workerBaseUrl(request, env)}/mcp`
  };
  const share = typeof result.share === "object" && result.share ? (result.share as Record<string, unknown>) : undefined;
  if (share) {
    next.share = {
      ...share,
      mcpUrl: namespaceMcpUrl(request, env, String(share.namespace ?? namespace))
    };
  }
  return next;
}

function demoSampleTarget(env: WorkerEnv): string {
  return env.CONTEXTMEM_DEMO_SAMPLE_TARGET ?? "https://fmsprint.wal.app/";
}

function redactImportFiles(files: NamespaceImportInput["files"]): NamespaceImportInput["files"] {
  return files.map((file) => (file.encoding === "utf8" ? { ...file, content: redactSecrets(file.content) } : file));
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, /secret|token|key|authorization|bearer/i.test(key) ? "[REDACTED]" : redactUnknown(item)]));
  }
  return value;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY|AUTHORIZATION|BEARER)[A-Z0-9_]*|(?:VITE|NEXT_PUBLIC|REACT_APP|CF|AWS)_[A-Z0-9_]+)\s*[:=]\s*["']?[^"'\s<>{}]+/gi, (match) => match.replace(/[:=].*$/, "=[REDACTED]"))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [REDACTED]")
    .replace(/\bctxm_[A-Za-z0-9_-]{16,}/g, "ctxm_[REDACTED]");
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function sse(events: Array<{ event: string; data: unknown }>): Response {
  const body = events.map((event) => `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join("");
  return cors(
    new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store"
      }
    })
  );
}

function createShortId(): string {
  return cryptoRandomId(5);
}

function cryptoRandomId(bytesLength: number): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function publicToken(row: TokenRow) {
  const id = row.token_id || row.token_hash.slice(0, 16);
  const expired = Boolean(row.expires_at && Date.parse(row.expires_at) <= Date.now());
  return {
    id,
    label: row.label ?? "read token",
    hashPrefix: row.token_hash.slice(0, 12),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revoked: Boolean(row.revoked_at),
    scope: row.scope ?? "read",
    expiresAt: row.expires_at ?? undefined,
    expired,
    snapshotPin: row.snapshot_pin ?? undefined
  };
}

function directoryItem(summary: HostedNamespaceSummary, request: Request, env: WorkerEnv) {
  const item = namespaceListItem(summary, request, env);
  return {
    ...item,
    snippets: {
      generic: {
        mcpServers: {
          [`contextmem-${slugNamespace(summary.namespace)}`]: {
            url: item.mcpUrl
          }
        }
      }
    }
  };
}

function namespaceListItem(summary: HostedNamespaceSummary, request: Request, env: WorkerEnv) {
  const mcpUrl = namespaceMcpUrl(request, env, summary.namespace);
  const gatewayMcpUrl = `${workerBaseUrl(request, env)}/mcp`;
  return {
    ...summary,
    mcpUrl,
    gatewayMcpUrl
  };
}

function requireImportAuthorization(request: Request, env: WorkerEnv): { ok: true } | { ok: false; status: number; message: string } {
  if (!env.CONTEXTMEM_NAMESPACE_IMPORT_TOKEN) return { ok: false, status: 401, message: "Namespace import is not enabled on this deployment." };
  const provided = readAccessToken(request);
  if (!provided || !constantTimeEqual(provided, env.CONTEXTMEM_NAMESPACE_IMPORT_TOKEN)) return { ok: false, status: 401, message: "Namespace import requires a valid bearer token." };
  return { ok: true };
}

function readAccessToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const url = new URL(request.url);
  return url.searchParams.get("access_token") ?? url.searchParams.get("token") ?? undefined;
}

function normalizeNamespace(value: string): string {
  const namespace = value.trim();
  if (!/^[a-zA-Z0-9:._-]+$/.test(namespace)) throw new Error("Namespace may only contain letters, numbers, colon, dot, underscore, and dash.");
  return namespace;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 12);
}

function parseTags(value?: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? normalizeTags(parsed.filter((item): item is string => typeof item === "string")) : [];
  } catch {
    return [];
  }
}

function displayNameFromTarget(target: string): string {
  try {
    const url = new URL(target);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return target.slice(0, 80);
  }
}

function dedupeFiles<T extends { path: string }>(files: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const file of files) {
    const normalized = normalizeHostedArtifactPath(file.path);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push({ ...file, path: normalized });
  }
  return deduped;
}

function decodeImportContent(content: string, encoding: "utf8" | "base64"): Uint8Array {
  if (encoding === "utf8") return new TextEncoder().encode(content);
  return base64ToBytes(content);
}

export function generateReadToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `ctxm_${bytesToBase64Url(bytes)}`;
}

export async function hashReadToken(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function createVersionId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `ver_${new Date().toISOString().replaceAll(/[:.]/g, "-")}_${bytesToBase64Url(bytes)}`;
}

function createTokenId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `tok_${bytesToBase64Url(bytes)}`;
}

function createJobId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `job_${bytesToBase64Url(bytes)}`;
}

function namespaceFromRow(row: NamespaceRow): HostedNamespaceSummary {
  const sources = parseNamespaceSources(row.sources_json, row.target, row.display_name ?? undefined);
  return {
    namespace: row.namespace,
    target: row.target,
    visibility: row.visibility,
    ownerId: row.owner_id ?? undefined,
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    tags: parseTags(row.tags_json),
    sourceType: row.source_type ?? "import",
    directoryEnabled: Boolean(row.directory_enabled),
    versionId: row.current_version_id,
    sourceRunId: row.source_run_id ?? undefined,
    buildKind: row.build_kind ?? "single",
    sources,
    sourceCount: Number(row.source_count ?? sources.length),
    artifactCount: Number(row.artifact_count),
    byteLength: Number(row.byte_length),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function parseNamespaceSources(value: string | null | undefined, fallbackTarget: string, fallbackLabel?: string): NamespaceBuildSource[] {
  if (value) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed) && parsed.length) {
        return parsed.slice(0, 5).map((source, index) => {
          const record = source && typeof source === "object" ? (source as Record<string, unknown>) : {};
          const target = String(record.target ?? fallbackTarget);
          const label = typeof record.label === "string" ? record.label : fallbackLabel ?? displayNameFromTarget(target);
          const mode = record.mode === "web" || record.mode === "walrus" || record.mode === "auto" ? record.mode : target.includes(".wal.app") ? "walrus" : "web";
          return {
            id: typeof record.id === "string" ? record.id : `source-${index + 1}`,
            target,
            label,
            mode
          };
        });
      }
    } catch {
      // use fallback
    }
  }
  return [{ id: "source-1", target: fallbackTarget, label: fallbackLabel ?? displayNameFromTarget(fallbackTarget), mode: fallbackTarget.includes(".wal.app") ? "walrus" : "web" }];
}

function namespaceForExtractTarget(target: URL): string {
  return `web:${target.hostname.replace(/^www\./, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

function allResults<T>(result: { results?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : result.results ?? [];
}

function workerBaseUrlFromEnv(env: WorkerEnv): string {
  const configured = env.CONTEXTMEM_WORKER_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured && configured !== legacyInternalWorkerOrigin) return configured;
  return defaultHostedWorkerBaseUrl;
}

function workerBaseUrl(request: Request, env: WorkerEnv): string {
  const configured = env.CONTEXTMEM_WORKER_BASE_URL?.trim().replace(/\/+$/, "");
  if (configured && configured !== legacyInternalWorkerOrigin) return configured;
  const origin = new URL(request.url).origin.replace(/\/+$/, "");
  return origin === legacyInternalWorkerOrigin ? defaultHostedWorkerBaseUrl : origin;
}

function namespaceMcpUrl(request: Request, env: WorkerEnv, namespace: string): string {
  const url = new URL("/mcp", workerBaseUrl(request, env));
  url.searchParams.set("namespace", namespace);
  return url.toString();
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return arrayBufferToBase64(toArrayBuffer(bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replaceAll("-", "+").replaceAll("_", "/"));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function arrayBufferToBase64(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]!);
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function slugNamespace(namespace: string): string {
  return namespace.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "namespace";
}

function extractTitle(html: string): string | undefined {
  return decodeHtml(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.replace(/\s+/g, " ").trim() ?? "");
}

function extractDescription(html: string): string | undefined {
  const match = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i.exec(html) ?? /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i.exec(html);
  return decodeHtml(match?.[1]?.trim() ?? "");
}

function extractPageMetadata(html: string): Record<string, string> {
  const metadata: Record<string, string> = {};
  const pattern = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    const attrs = extractTagAttributes(match[0] ?? "");
    const key = attrs.name ?? attrs.property ?? attrs.itemprop;
    const value = attrs.content;
    if (!key || !value) continue;
    metadata[key.toLowerCase()] = value;
  }
  return metadata;
}

function extractTagAttributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(tag))) {
    const key = match[1]?.toLowerCase();
    const value = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
    if (key && value) attrs[key] = value;
  }
  return attrs;
}

function metadataResourceLinks(metadata: Record<string, string>, base: URL): Array<{ url: URL; label: string; kind: string }> {
  const resources: Array<{ url: URL; label: string; kind: string }> = [];
  for (const key of ["og:image", "twitter:image", "image"]) {
    const value = metadata[key];
    if (!value) continue;
    try {
      const url = new URL(value, base);
      if (/^https?:$/.test(url.protocol)) resources.push({ url, label: key, kind: "image" });
    } catch {
      // ignore malformed metadata URLs
    }
  }
  return resources;
}

function metadataSummaryLines(metadata: Record<string, string>, walrusHeaders: Record<string, string>): string[] {
  const preferredKeys = ["title", "description", "keywords", "author", "og:title", "og:description", "og:image", "twitter:image"];
  const lines = preferredKeys.flatMap((key) => (metadata[key] ? [`- ${key}: ${metadata[key]}`] : []));
  const walrusLines = Object.entries(walrusHeaders).map(([key, value]) => `- ${key}: ${value}`);
  return [...lines, ...walrusLines].length ? [...lines, ...walrusLines] : ["- No metadata found in the initial HTML."];
}

function extractLinks(html: string, base: URL): Array<{ url: URL; label: string }> {
  const links: Array<{ url: URL; label: string }> = [];
  const pattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) {
    try {
      const url = new URL(match[1]!, base);
      if (!/^https?:$/.test(url.protocol)) continue;
      links.push({ url, label: htmlToText(match[2] ?? "").slice(0, 120) || url.pathname || url.hostname });
    } catch {
      // ignore malformed URLs
    }
  }
  return dedupeByUrl(links);
}

function extractResourceLinks(html: string, base: URL): Array<{ url: URL; label: string; kind: string }> {
  const resources: Array<{ url: URL; label: string; kind: string }> = [];
  // Process <img> FIRST so when the same URL appears as both <img src> and
  // <link rel="preload" as="image"> the image classification wins through dedupe.
  const imgRegex = /<img\b[^>]*>/gi;
  let imgMatch: RegExpExecArray | null;
  while ((imgMatch = imgRegex.exec(html))) {
    const attrs = extractTagAttributes(imgMatch[0]!);
    if (!attrs.src) continue;
    try {
      const url = new URL(attrs.src, base);
      if (!/^https?:$/.test(url.protocol)) continue;
      resources.push({ url, label: attrs.alt || url.pathname.split("/").pop() || url.hostname, kind: "image" });
    } catch { /* ignore */ }
  }
  // <link> tags are classified by rel + as. Icon and preload-as-image become
  // image resources too. Stylesheets stay stylesheet. Other rels are skipped.
  const linkRegex = /<link\b[^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(html))) {
    const attrs = extractTagAttributes(linkMatch[0]!);
    if (!attrs.href) continue;
    const rel = (attrs.rel ?? "").toLowerCase();
    const asAttr = (attrs.as ?? "").toLowerCase();
    let kind: string | undefined;
    if (rel.includes("stylesheet")) kind = "stylesheet";
    else if (rel.includes("icon") || rel.includes("apple-touch-icon")) kind = "image";
    else if (rel.includes("preload") && asAttr === "image") kind = "image";
    else if (rel.includes("preload") && asAttr === "style") kind = "stylesheet";
    else if (rel.includes("preload") && asAttr === "script") kind = "script";
    if (!kind) continue;
    try {
      const url = new URL(attrs.href, base);
      if (/^https?:$/.test(url.protocol)) resources.push({ url, label: url.pathname.split("/").pop() || url.hostname, kind });
    } catch { /* ignore */ }
  }
  // <script src>
  const scriptRegex = /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi;
  let scriptMatch: RegExpExecArray | null;
  while ((scriptMatch = scriptRegex.exec(html))) {
    try {
      const url = new URL(scriptMatch[1]!, base);
      if (/^https?:$/.test(url.protocol)) resources.push({ url, label: url.pathname.split("/").pop() || url.hostname, kind: "script" });
    } catch { /* ignore */ }
  }
  // <source srcset> in <picture> / <video poster> as additional image signal.
  const sourceRegex = /<(?:source|img)\b[^>]*srcset=["']([^"']+)["']/gi;
  let sourceMatch: RegExpExecArray | null;
  while ((sourceMatch = sourceRegex.exec(html))) {
    const first = sourceMatch[1]!.split(",")[0]!.trim().split(/\s+/)[0]!;
    try {
      const url = new URL(first, base);
      if (/^https?:$/.test(url.protocol)) resources.push({ url, label: url.pathname.split("/").pop() || url.hostname, kind: "image" });
    } catch { /* ignore */ }
  }
  return dedupeByUrl(resources);
}

function dedupeByUrl<T extends { url: URL }>(items: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = item.url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

const SOCIAL_HOSTS = ["twitter.com", "x.com", "github.com", "linkedin.com", "t.me", "telegram.me", "discord.gg", "discord.com", "youtube.com", "instagram.com", "facebook.com", "mastodon.social", "warpcast.com", "farcaster.xyz", "bsky.app"];

function collectInlineStyles(html: string): string {
  let combined = "";
  const styleRegex = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let match: RegExpExecArray | null;
  while ((match = styleRegex.exec(html))) combined += `\n${match[1] ?? ""}`;
  return combined;
}

type DocsFramework = "docusaurus" | "mintlify" | "nextra" | "vitepress" | "gitbook" | null;

type FrameworkFingerprint = {
  colors: Set<string>;
  fonts: Set<string>;
  fontFamilyPrefixes: string[];
  varPrefixes: string[];
};

const FRAMEWORK_DEFAULTS: Record<Exclude<DocsFramework, null>, FrameworkFingerprint> = {
  docusaurus: {
    // Infima neutral ramp + alert state palette (info/success/warning/danger
    // content + background ramps) + common defaults observed across
    // Docusaurus 2/3. Anything in this set will be filtered from brand output.
    colors: new Set([
      "#ffffff", "#000000",
      // Neutral ramp (light + dark)
      "#fbffea", "#e0e2e6", "#d0d7de", "#ebedf0", "#eef2f5", "#f5f6f7", "#f6f8fa", "#fafbfc",
      "#1c1e21", "#18191a", "#242526", "#2b2d2f", "#0f0f0f", "#303846", "#343940", "#444444", "#474748",
      "#fdfdfe",
      // Primary blue/teal defaults
      "#3578e5", "#25c2a0", "#606770",
      // Alert / state palette (info)
      "#eef9fd", "#193c47", "#ebf2fc", "#102445",
      // Alert (success)
      "#e6f6e6", "#003100",
      // Alert (warning)
      "#fff8e6", "#4d3800",
      // Alert (danger)
      "#ffebec", "#4b1113",
      // Misc Infima accents that show up in default themes
      "#9fffc0"
    ]),
    fonts: new Set([
      // Apple system stack
      "system-ui", "-apple-system", "blinkmacsystemfont", "apple color emoji",
      // Windows
      "segoe ui", "segoe ui emoji", "segoe ui symbol",
      // GNOME / Ubuntu / Android fallback
      "roboto", "ubuntu", "cantarell", "oxygen", "oxygen sans", "fira sans", "droid sans",
      // Generic
      "helvetica neue", "helvetica", "arial", "sans-serif",
      // Mono
      "ui-monospace", "sfmono-regular", "menlo", "monaco", "consolas",
      "liberation mono", "courier new", "monospace",
      // Noto family
      "noto sans", "noto color emoji"
    ]),
    fontFamilyPrefixes: [],
    varPrefixes: ["--ifm-", "--docusaurus-", "--docsearch-"]
  },
  mintlify: {
    colors: new Set(["#ffffff", "#000000", "#0f172a", "#f8fafc", "#e2e8f0", "#94a3b8", "#64748b"]),
    fonts: new Set(["inter", "system-ui", "-apple-system", "sans-serif", "ui-monospace", "menlo", "monaco"]),
    fontFamilyPrefixes: [],
    varPrefixes: ["--mintlify-"]
  },
  nextra: {
    colors: new Set(["#ffffff", "#000000", "#171717", "#525252", "#737373", "#a3a3a3"]),
    fonts: new Set(["inter", "system-ui", "-apple-system", "sans-serif", "ui-monospace"]),
    fontFamilyPrefixes: [],
    varPrefixes: ["--nextra-"]
  },
  vitepress: {
    colors: new Set(["#ffffff", "#000000", "#213547", "#42b883", "#f6f6f7", "#e2e2e3"]),
    fonts: new Set(["inter", "system-ui", "-apple-system", "sans-serif", "menlo", "monaco"]),
    fontFamilyPrefixes: [],
    varPrefixes: ["--vp-"]
  },
  gitbook: {
    colors: new Set(["#ffffff", "#000000", "#0f172a", "#64748b", "#94a3b8"]),
    fonts: new Set(["inter", "system-ui", "-apple-system", "sans-serif"]),
    fontFamilyPrefixes: [],
    varPrefixes: ["--gitbook-"]
  }
};

function detectDocsFramework(html: string, metadata: Record<string, string>): DocsFramework {
  const generator = (metadata["generator"] ?? "").toLowerCase();
  if (generator.includes("docusaurus")) return "docusaurus";
  if (generator.includes("vitepress")) return "vitepress";
  if (generator.includes("nextra")) return "nextra";
  if (generator.includes("mintlify")) return "mintlify";
  const sample = html.slice(0, 20000).toLowerCase();
  if (sample.includes("data-theme=\"docusaurus\"") || sample.includes("theme-doc-") || sample.includes("--ifm-")) return "docusaurus";
  if (sample.includes("mintlify") || sample.includes("--mintlify-")) return "mintlify";
  if (sample.includes("nextra-") || sample.includes("--nextra-")) return "nextra";
  if (sample.includes("vitepress") || sample.includes("--vp-")) return "vitepress";
  if (sample.includes("gitbook")) return "gitbook";
  return null;
}

// Build a :root + [data-theme] custom-property map from a CSS bundle. Used to
// substitute var(--name) refs with their resolved value before serializing.
function buildCssVarMap(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const blockRegex = /(:root|\[data-theme[^\]]*\]|html)\s*\{([^}]+)\}/g;
  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = blockRegex.exec(css))) {
    const block = blockMatch[2] ?? "";
    const decRegex = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let decMatch: RegExpExecArray | null;
    while ((decMatch = decRegex.exec(block))) {
      const name = decMatch[1]!;
      const value = (decMatch[2] ?? "").trim();
      if (value.length < 200 && !(name in out)) out[name] = value;
    }
  }
  return out;
}

// Resolve var(--name [, fallback]) refs by looking up the var map.
// Handles 1-level nested fallback: var(--a, var(--b, lit)).
function resolveCssVarRef(value: string, varMap: Record<string, string>, depth = 0): string {
  if (depth > 4) return value;
  return value.replace(/var\(\s*(--[a-zA-Z0-9_-]+)\s*(?:,\s*([^)]+))?\)/g, (_match, name: string, fallback?: string) => {
    const resolved = varMap[name];
    if (resolved && !/var\(/.test(resolved)) return resolved;
    if (resolved) return resolveCssVarRef(resolved, varMap, depth + 1);
    if (fallback) return resolveCssVarRef(fallback.trim(), varMap, depth + 1);
    return _match; // unresolvable — keep as-is so caller can drop
  });
}

function isVarUnresolved(value: string): boolean {
  return /var\(/.test(value);
}

function isFrameworkColor(hex: string, framework: DocsFramework): boolean {
  if (!framework) return false;
  return FRAMEWORK_DEFAULTS[framework].colors.has(hex.toLowerCase());
}

function isFrameworkFont(font: string, framework: DocsFramework): boolean {
  if (!framework) return false;
  const fp = FRAMEWORK_DEFAULTS[framework];
  const lowered = font.toLowerCase().replace(/^["']|["']$/g, "").trim();
  if (fp.fonts.has(lowered)) return true;
  return fp.fontFamilyPrefixes.some((prefix) => lowered.startsWith(prefix));
}

const FONT_CSS_HOSTS = new Set(["fonts.googleapis.com", "fonts.bunny.net", "use.typekit.net", "rsms.me"]);

async function collectAllStyles(html: string, target: URL): Promise<string> {
  let combined = collectInlineStyles(html);
  const cssLinks: URL[] = [];
  const linkRegex = /<link\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = linkRegex.exec(html))) {
    const tag = tagMatch[0]!;
    const attrs = extractTagAttributes(tag);
    const rel = (attrs.rel ?? "").toLowerCase();
    const href = attrs.href;
    if (!href) continue;
    const isStyle = rel.includes("stylesheet") || (rel.includes("preload") && (attrs.as ?? "").toLowerCase() === "style");
    if (!isStyle) continue;
    try {
      const url = new URL(href, target);
      if (!/^https?:$/.test(url.protocol)) continue;
      if (url.origin !== target.origin && !FONT_CSS_HOSTS.has(url.hostname)) continue;
      cssLinks.push(url);
    } catch { /* ignore */ }
    if (cssLinks.length >= 5) break;
  }
  if (!cssLinks.length) return combined;
  const fetched = await Promise.allSettled(cssLinks.map(async (url) => {
    const response = await fetch(url.toString(), {
      headers: { "user-agent": "ContextMCP Cloudflare Extractor/0.1 (+https://contextmem.ai)" }
    });
    if (!response.ok) return "";
    const length = Number(response.headers.get("content-length") ?? 0);
    if (length > 800_000) return "";
    const text = await response.text();
    return text.slice(0, 500_000);
  }));
  fetched.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value) {
      combined += `\n/* ${cssLinks[index]!.toString()} */\n${result.value}`;
    }
  });
  return combined;
}

function extractHexColors(text: string): string[] {
  const freq = new Map<string, number>();
  const regex = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text))) {
    let hex = `#${match[1]!.toLowerCase()}`;
    if (hex.length === 4) hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
    if (hex === "#000000" || hex === "#ffffff") { freq.set(hex, (freq.get(hex) ?? 0) + 1); continue; }
    freq.set(hex, (freq.get(hex) ?? 0) + 1);
  }
  return Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).map(([hex]) => hex);
}

function extractCssValues(css: string, property: string): string[] {
  const freq = new Map<string, number>();
  const regex = new RegExp(`${property}\\s*:\\s*([^;}\\n]+)`, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(css))) {
    const value = (match[1] ?? "").trim().replace(/!important$/, "").trim();
    if (!value || value.length > 200) continue;
    freq.set(value, (freq.get(value) ?? 0) + 1);
  }
  return Array.from(freq.entries()).sort((a, b) => b[1] - a[1]).map(([value]) => value);
}

function extractCssVariables(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  const regex = /(--[a-zA-Z0-9_-]+)\s*:\s*([^;}\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(css))) {
    const name = match[1]!;
    const value = (match[2] ?? "").trim();
    if (value.length > 200) continue;
    if (!(name in out)) out[name] = value;
  }
  return out;
}

function buildBrandProfile(input: { html: string; target: URL; title?: string; description?: string; metadata: Record<string, string>; walrusHeaders: Record<string, string>; css?: string; framework?: DocsFramework; varMap?: Record<string, string> }): {
  name?: string;
  domain?: string;
  description?: string;
  colors: string[];
  fonts: string[];
  logos: Array<{ src?: string; absoluteUrl?: string; role?: string; contentType?: string; alt?: string; type?: string }>;
  socials: string[];
  confidence: number;
  framework?: { name: string; defaultsSubtracted: number };
} {
  const { html, target, title, description, metadata, css, framework = null, varMap = {} } = input;
  const siteName = metadata["og:site_name"] || metadata["application-name"] || (title ? title.split("|")[0]!.trim() : undefined);
  const inlineStyles = css ?? collectInlineStyles(html);
  const rawFontFamilies = extractCssValues(inlineStyles, "font-family")
    .map((value) => isVarUnresolved(value) ? resolveCssVarRef(value, varMap) : value)
    .flatMap((value) => value.split(",").map((token) => token.trim().replace(/^["']|["']$/g, "")))
    .filter((font) => font && !/^(inherit|initial|unset|revert)$/i.test(font))
    .filter((font) => !isVarUnresolved(font));
  const fontsBeforeFilter = Array.from(new Set(rawFontFamilies));
  const fonts = fontsBeforeFilter.filter((font) => !isFrameworkFont(font, framework)).slice(0, 12);
  const fontsSubtracted = fontsBeforeFilter.length - fonts.length;
  const rawColors = extractHexColors(inlineStyles);
  // Filter framework defaults FIRST, then slice — otherwise a stylesheet whose
  // top 32 colors are all framework defaults produces an empty brand palette
  // even when real brand colors exist further down the frequency list.
  const colorsAfterFilter = rawColors.filter((hex) => !isFrameworkColor(hex, framework));
  const colors = colorsAfterFilter.slice(0, 16);
  const colorsSubtracted = rawColors.length - colorsAfterFilter.length;
  const defaultsSubtracted = colorsSubtracted + fontsSubtracted;
  if (metadata["theme-color"] && /^#?[0-9a-fA-F]{3,6}$/.test(metadata["theme-color"])) {
    const themeHex = metadata["theme-color"].startsWith("#") ? metadata["theme-color"].toLowerCase() : `#${metadata["theme-color"].toLowerCase()}`;
    if (!colors.includes(themeHex)) colors.unshift(themeHex);
  }
  const logos: Array<{ absoluteUrl?: string; role?: string; contentType?: string; alt?: string; type?: string }> = [];
  const iconRegex = /<link\b[^>]*rel=["']([^"']*(?:icon|apple-touch-icon)[^"']*)["'][^>]*href=["']([^"']+)["'][^>]*>/gi;
  let iconMatch: RegExpExecArray | null;
  while ((iconMatch = iconRegex.exec(html))) {
    try {
      const url = new URL(iconMatch[2]!, target);
      logos.push({ absoluteUrl: url.toString(), role: iconMatch[1]!.includes("apple") ? "apple-touch-icon" : "favicon", type: "icon" });
    } catch { /* ignore */ }
  }
  if (metadata["og:image"]) {
    try { logos.push({ absoluteUrl: new URL(metadata["og:image"], target).toString(), role: "og-image", type: "image" }); } catch { /* ignore */ }
  }
  const socials = new Set<string>();
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let linkMatch: RegExpExecArray | null;
  while ((linkMatch = linkRegex.exec(html))) {
    try {
      const url = new URL(linkMatch[1]!, target);
      if (SOCIAL_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) socials.add(url.toString());
    } catch { /* ignore */ }
  }
  // Honest confidence: count brand-DISTINCT-from-framework signals.
  // Logo + OG image + non-default colors surviving subtraction + named site + socials.
  // A site whose only "signals" are framework defaults will land near 0.
  let signals = 0;
  if (siteName) signals += 1;
  if (logos.find((logo) => logo.role === "og-image")) signals += 1;
  if (logos.find((logo) => logo.role === "favicon" || logo.role === "apple-touch-icon")) signals += 0.5;
  if (colors.length >= 2) signals += 1; // post-subtraction count
  if (fonts.length >= 1) signals += 0.5; // post-subtraction count
  if (socials.size) signals += 0.5;
  if (description) signals += 0.5;
  const confidence = Math.min(1, Number((signals / 5).toFixed(2)));
  return {
    name: siteName,
    domain: target.hostname,
    description,
    colors,
    fonts,
    logos,
    socials: Array.from(socials).slice(0, 12),
    confidence,
    ...(framework ? { framework: { name: framework, defaultsSubtracted } } : {})
  };
}

async function buildDesignSystem(input: { html: string; target: URL; css?: string; framework?: DocsFramework; varMap?: Record<string, string> }): Promise<Record<string, unknown>> {
  const { html, target, css, framework = null, varMap = {} } = input;
  const inlineStyles = css ?? collectInlineStyles(html);
  // Font families: resolve var refs, drop unresolved, filter framework defaults.
  const rawFontValues = extractCssValues(inlineStyles, "font-family")
    .map((value) => isVarUnresolved(value) ? resolveCssVarRef(value, varMap) : value);
  const fontFamiliesRaw = rawFontValues
    .flatMap((value) => value.split(",").map((token) => token.trim().replace(/^["']|["']$/g, "")))
    .filter((font) => font && !/^(inherit|initial|unset|revert)$/i.test(font))
    .filter((font) => !isVarUnresolved(font));
  const fontFamiliesBeforeFilter = Array.from(new Set(fontFamiliesRaw));
  const fontFamilies = fontFamiliesBeforeFilter.filter((font) => !isFrameworkFont(font, framework)).slice(0, 8);
  const fontFamiliesSubtracted = fontFamiliesBeforeFilter.length - fontFamilies.length;
  const fontSizesRaw = extractCssValues(inlineStyles, "font-size")
    .map((value) => isVarUnresolved(value) ? resolveCssVarRef(value, varMap) : value)
    .filter((value) => !isVarUnresolved(value));
  const fontSizes = fontSizesRaw.slice(0, 12);
  const spacingPool = [...extractCssValues(inlineStyles, "padding"), ...extractCssValues(inlineStyles, "margin"), ...extractCssValues(inlineStyles, "gap")];
  const spacingFreq = new Map<string, number>();
  for (const rawValue of spacingPool) {
    const value = isVarUnresolved(rawValue) ? resolveCssVarRef(rawValue, varMap) : rawValue;
    if (isVarUnresolved(value)) continue;
    for (const token of value.split(/\s+/)) {
      if (/^-?\d/.test(token) && /(px|rem|em|%)$/.test(token)) spacingFreq.set(token, (spacingFreq.get(token) ?? 0) + 1);
    }
  }
  const spacing = Array.from(spacingFreq.entries()).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([value]) => value);
  const radii = extractCssValues(inlineStyles, "border-radius")
    .map((value) => isVarUnresolved(value) ? resolveCssVarRef(value, varMap) : value)
    .filter((value) => !isVarUnresolved(value))
    .slice(0, 8);
  const shadows = extractCssValues(inlineStyles, "box-shadow")
    .map((value) => isVarUnresolved(value) ? resolveCssVarRef(value, varMap) : value)
    .filter((value) => !isVarUnresolved(value))
    .slice(0, 6);
  const borders = extractCssValues(inlineStyles, "border")
    .map((value) => isVarUnresolved(value) ? resolveCssVarRef(value, varMap) : value)
    .filter((value) => !isVarUnresolved(value))
    .slice(0, 6);
  // Same "filter before slice" discipline as buildBrandProfile.
  const paletteRaw = extractHexColors(inlineStyles);
  const paletteAfterFilter = paletteRaw.filter((hex) => !isFrameworkColor(hex, framework));
  const palette = paletteAfterFilter.slice(0, 14);
  const paletteSubtracted = paletteRaw.length - paletteAfterFilter.length;
  // Drop framework-prefix custom properties from the surfaced css var snapshot.
  // The user sees only brand-distinct custom properties.
  // Use the scoped :root / [data-theme] var map (not extractCssVariables, which
  // matches --name: value anywhere including inside button selectors and dumps
  // garbage). Prefer the resolved varMap passed in; rebuild from CSS otherwise.
  const cssVariablesAll = Object.keys(varMap).length ? varMap : buildCssVarMap(inlineStyles);
  const frameworkVarPrefixes = framework ? FRAMEWORK_DEFAULTS[framework].varPrefixes : [];
  const cssVariables: Record<string, string> = {};
  for (const [name, value] of Object.entries(cssVariablesAll)) {
    if (frameworkVarPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    cssVariables[name] = value;
  }
  const tokenColors = palette.slice(0, 8).map((hex, index) => ({
    name: index === 0 ? "primary" : index === 1 ? "secondary" : `accent-${index}`,
    value: hex,
    role: index === 0 ? "primary" : index === 1 ? "secondary" : "accent"
  }));
  const tailwindThemePartial = palette.length ? `// tailwind palette (top ${palette.length}, framework defaults subtracted)\ncolors: {\n${palette.map((hex, index) => `  brand${index + 1}: "${hex}"`).join(",\n")}\n}` : "";
  const tokensCss = Object.entries(cssVariables).slice(0, 40).map(([name, value]) => `${name}: ${value};`).join("\n");
  // Honest confidence. Raw value count post-subtraction is a weak signal —
  // a Docusaurus alert ramp can still ship 8+ colors that pass the blocklist.
  // We weight HARDER signals (custom CSS vars in the site's own prefix space,
  // many post-subtraction colors, a brand-distinct font that isn't a system
  // fallback) and divide by a higher denominator so the score gradients down.
  let signals = 0;
  if (palette.length >= 4) signals += 1; // raised threshold
  if (palette.length >= 8) signals += 0.5;
  if (fontFamilies.length >= 1) signals += 0.5;
  if (fontFamilies.length >= 3) signals += 0.5; // multiple distinct fonts = real brand
  if (Object.keys(cssVariables).length >= 4) signals += 0.5; // real :root vars (not garbage)
  if (spacing.length >= 4) signals += 0.5;
  if (radii.length >= 2) signals += 0.5;
  // Cap at 4 so a "high confidence" demands at least primary palette + font + vars + spacing.
  const identityConfidence = Math.min(1, Number((signals / 4).toFixed(2)));
  return {
    identity: {
      name: undefined,
      domain: target.hostname,
      description: undefined,
      confidence: identityConfidence
    },
    tokens: {
      colors: tokenColors,
      rawPalette: palette,
      cssVariables,
      typography: {
        fontFamilies,
        scale: fontSizes.map((size, index) => ({ name: `size-${index + 1}`, fontSize: size })),
        headings: []
      },
      spacing,
      radii,
      shadows,
      borders,
      layout: { breakpoints: [], maxWidths: [], zIndices: [] }
    },
    components: [],
    assets: [],
    motion: [],
    ...(framework ? { framework: { name: framework, defaultsSubtracted: paletteSubtracted + fontFamiliesSubtracted } } : {}),
    exports: {
      figmaTokens: JSON.stringify({ colors: palette, fonts: fontFamilies }, null, 2),
      styleDictionary: JSON.stringify({ color: Object.fromEntries(palette.map((hex, index) => [`brand-${index + 1}`, { value: hex }])) }, null, 2),
      tailwindTheme: tailwindThemePartial,
      tokensCss,
      webBrandKit: `Domain: ${target.hostname}\nColors: ${palette.slice(0, 6).join(", ") || "(none — framework defaults only)"}\nFonts: ${fontFamilies.slice(0, 4).join(", ") || "(none — framework defaults only)"}`,
      videoBrandKit: palette.length ? `Primary: ${palette[0]}\nSecondary: ${palette[1] ?? "n/a"}` : "Brand colors not detected (framework defaults only)",
      markdown: `# Design tokens\n\n**Domain:** ${target.hostname}\n${framework ? `**Framework:** ${framework} — default tokens filtered\n` : ""}\n**Palette:** ${palette.slice(0, 8).join(", ") || "(none — framework defaults only)"}\n\n**Fonts:** ${fontFamilies.slice(0, 4).join(", ") || "(none — framework defaults only)"}`,
      rawJson: ""
    }
  };
}

function htmlToText(html: string): string {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim()
  ) ?? "";
}

function decodeHtml(value: string): string | undefined {
  if (!value) return undefined;
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'")
    .trim();
}

function statusError(message: string, statusCode: number, code?: string, hint?: string): Error {
  const error = new Error(message) as Error & { statusCode: number; code?: string; hint?: string };
  error.statusCode = statusCode;
  if (code) error.code = code;
  if (hint) error.hint = hint;
  return error;
}

function jsonError(code: string, message: string, status: number, hint?: string): Response {
  return json({ error: { code, message, hint }, message }, status);
}

function json(value: unknown, status = 200): Response {
  return cors(
    new Response(JSON.stringify(value, null, 2), {
      status,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    })
  );
}

// Like json() but edge-cacheable — for public, static-ish payloads (e.g. seeded
// facts) the Visualizer fetches repeatedly. Never use for private/token data.
function jsonCached(value: unknown, maxAgeSeconds = 300): Response {
  return cors(
    new Response(JSON.stringify(value, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": `public, max-age=${maxAgeSeconds}, must-revalidate`
      }
    })
  );
}

function mcpJsonError(message: string, status: number): Response {
  return cors(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: status === 404 ? -32001 : -32000,
          message
        },
        id: null
      }),
      {
        status,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        }
      }
    )
  );
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization, accept, mcp-session-id, mcp-protocol-version, x-memwal-mcp-url, x-memwal-api-url, x-memwal-account-id, x-memwal-authorization, x-memwal-bearer, x-memwal-private-key");
  headers.set("access-control-expose-headers", "mcp-session-id");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
