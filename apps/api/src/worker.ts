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

export type WorkerEnv = {
  CONTEXTMEM_DB: D1DatabaseLike;
  CONTEXTMEM_CONTEXT_BUCKET: R2BucketLike;
  CONTEXTMEM_EXTRACT_QUEUE?: QueueLike;
  CONTEXTMEM_NAMESPACE_IMPORT_TOKEN?: string;
  CONTEXTMEM_WORKER_BASE_URL?: string;
  CONTEXTMEM_DEMO_SAMPLE_TARGET?: string;
  CONTEXTMEM_WEBHOOK_SECRET?: string;
  MEMWAL_MCP_URL?: string;
  MEMWAL_AUTHORIZATION?: string;
  MEMWAL_BEARER?: string;
  MEMWAL_ACCOUNT_ID?: string;
};

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
type FetchedText = { text: string; contentType: string; headers: Record<string, string> };

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
  label: z.string().min(1).max(80).default("read token")
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

const demoExtractionCreateSchema = z.object({
  target: z.string().min(1).max(500).optional(),
  sample: z.boolean().default(false)
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
  constructor(private readonly env: WorkerEnv) {}

  async getNamespace(namespace: string): Promise<HostedNamespaceSummary | undefined> {
    const row = await this.env.CONTEXTMEM_DB.prepare(
      `SELECT namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, artifact_count, byte_length, created_at, updated_at
       FROM contextmem_namespaces
       WHERE namespace = ?`
    )
      .bind(namespace)
      .first<NamespaceRow>();
    return row ? namespaceFromRow(row) : undefined;
  }

  async listArtifacts(namespace: string): Promise<HostedArtifactRecord[]> {
    const result = await this.env.CONTEXTMEM_DB.prepare(
      `SELECT a.path, a.content_type, a.kind, a.size, a.sha256, a.updated_at
       FROM contextmem_namespace_artifacts a
       JOIN contextmem_namespaces n
         ON n.namespace = a.namespace
        AND n.current_version_id = a.version_id
       WHERE a.namespace = ?
       ORDER BY a.path`
    )
      .bind(namespace)
      .all<Omit<ArtifactRow, "namespace" | "version_id" | "r2_key">>();
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
    const row = await this.env.CONTEXTMEM_DB.prepare(
      `SELECT a.namespace, a.version_id, a.path, a.r2_key, a.content_type, a.kind, a.size, a.sha256, a.updated_at
       FROM contextmem_namespace_artifacts a
       JOIN contextmem_namespaces n
         ON n.namespace = a.namespace
        AND n.current_version_id = a.version_id
       WHERE a.namespace = ?
         AND a.path = ?`
    )
      .bind(namespace, normalizedPath)
      .first<ArtifactRow>();
    if (!row) return undefined;

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

  async authorizeNamespace(namespace: string, token?: string): Promise<{ ok: true; summary: HostedNamespaceSummary } | { ok: false; status: number; message: string }> {
    const summary = await this.getNamespace(namespace);
    if (!summary) return { ok: false, status: 404, message: `ContextMeM namespace not found: ${namespace}` };
    if (summary.visibility === "public") return { ok: true, summary };
    if (!token) return { ok: false, status: 401, message: "Private ContextMeM namespace requires a read token." };

    const tokenHash = await hashReadToken(token);
    const row = await this.env.CONTEXTMEM_DB.prepare(
      `SELECT token_hash, revoked_at
       FROM contextmem_namespace_tokens
       WHERE namespace = ?
         AND token_hash = ?`
    )
      .bind(namespace, tokenHash)
      .first<{ token_hash: string; revoked_at?: string | null }>();
    if (!row || row.revoked_at) return { ok: false, status: 403, message: "ContextMeM namespace token is invalid or revoked." };

    await this.env.CONTEXTMEM_DB.prepare(`UPDATE contextmem_namespace_tokens SET last_used_at = ? WHERE token_hash = ?`).bind(new Date().toISOString(), tokenHash).run();
    return { ok: true, summary };
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
  const url = new URL(request.url);
  const store = new CloudflareNamespaceStore(env);

  if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "contextmem-hosted-namespace-mcp" });
  }
  if (request.method === "GET" && url.pathname === "/api/me") {
    return json({
      authenticated: false,
      account: null,
      quota: { limit: 1, used: 0, remaining: 0 },
      access: {
        canPreview: true,
        canRun: false,
        reason: "Import MemWal SDK credentials in the local app for verified recall and memory."
      }
    });
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
  if (request.method === "POST" && url.pathname === "/api/extractions") {
    const auth = requireImportAuthorization(request, env);
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return createExtraction(request, env, ctx);
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
  if (request.method === "GET" && url.pathname.startsWith("/api/namespaces/")) {
    const namespace = decodeURIComponent(url.pathname.slice("/api/namespaces/".length));
    const auth = await store.authorizeNamespace(namespace, readAccessToken(request));
    if (!auth.ok) return json({ error: auth.message }, auth.status);
    return json({
      namespace: auth.summary,
      artifacts: await store.listArtifacts(namespace)
    });
  }
  if ((request.method === "POST" || request.method === "GET" || request.method === "DELETE") && isMcpPath(url.pathname)) {
    const namespace = namespaceFromMcpUrl(url);
    if (request.method === "GET" && !acceptsEventStream(request)) {
      return mcpBrowserLandingResponse(request, env, namespace);
    }
    const mcpStore = maybeWithMemWalRecall(store, env, request);
    let server;
    if (namespace) {
      const auth = await store.authorizeNamespace(namespace, readAccessToken(request));
      if (!auth.ok) return mcpJsonError(auth.message, auth.status);
      server = createHostedContextMemMcpServer({ namespace, store: mcpStore });
    } else {
      server = createHostedContextMemMcpServer({
        store: mcpStore,
        authorizeNamespace: (requestedNamespace, accessToken) => store.authorizeNamespace(requestedNamespace, accessToken ?? readAccessToken(request))
      });
    }
    return createMcpHandler(server, {
      route: url.pathname,
      enableJsonResponse: true,
      corsOptions: { origin: "*" }
    })(request, env, ctx as never);
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
  const mcpUrl = new URL(request.url);
  mcpUrl.search = "";
  const url = mcpUrl.toString();
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
        `SELECT namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, artifact_count, byte_length, created_at, updated_at
         FROM contextmem_namespaces
         WHERE owner_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
        .bind(ownerId, limit)
        .all<NamespaceRow>()
    : await env.CONTEXTMEM_DB.prepare(
        `SELECT namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, artifact_count, byte_length, created_at, updated_at
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
    `SELECT token_id, token_hash, namespace, label, created_at, last_used_at, revoked_at
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
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_namespace_tokens (token_hash, token_id, namespace, label, created_at)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(tokenHash, tokenId, namespace, input.label, now)
    .run();
  return json({ token: { id: tokenId, label: input.label, createdAt: now, revoked: false }, readToken }, 201);
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
    `SELECT namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, artifact_count, byte_length, created_at, updated_at
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

async function createDemoExtraction(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
  const input = demoExtractionCreateSchema.parse(await request.json().catch(() => ({})));
  const target = validatePublicDemoTarget(input.sample ? demoSampleTarget(env) : input.target ?? demoSampleTarget(env));
  const sample = input.sample || !input.target;
  if (!sample) await consumeDemoQuota(request, env);
  const namespace = normalizeNamespace(`demo:${slugNamespace(target.hostname)}:${createShortId()}`);
  const jobInput: ExtractionCreateInput = {
    ownerId: demoOwnerId(request),
    target: target.toString(),
    namespace,
    visibility: "public",
    displayName: displayNameFromTarget(target.toString()),
    description: "Public ContextMeM demo extraction",
    tags: ["demo", target.hostname.endsWith(".wal.app") ? "walrus" : "web"],
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

async function getShareLinkOgSvg(_request: Request, env: WorkerEnv, shareId: string): Promise<Response> {
  const share = await getShareLinkRow(env, shareId);
  if (!share) {
    return new Response("<svg/>", { status: 404, headers: { "content-type": "image/svg+xml; charset=utf-8" } });
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
  const ownerId = new URL(request.url).searchParams.get("ownerId")?.trim() || "anonymous";
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
  const ownerId = new URL(request.url).searchParams.get("ownerId")?.trim() || "anonymous";
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

async function storeNamespaceImport(input: NamespaceImportInput, request: Request, env: WorkerEnv) {
  const namespace = normalizeNamespace(input.namespace);
  const now = new Date().toISOString();
  const versionId = createVersionId();
  const readToken = generateReadToken();
  const tokenHash = await hashReadToken(readToken);
  const tokenId = createTokenId();
  const tags = normalizeTags(input.tags);
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

  const statements = [
    env.CONTEXTMEM_DB.prepare(
      `INSERT INTO contextmem_namespaces (namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, manifest_json, artifact_count, byte_length, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
         manifest_json = excluded.manifest_json,
         artifact_count = excluded.artifact_count,
         byte_length = excluded.byte_length,
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
      JSON.stringify(input.manifest),
      files.length,
      totalBytes,
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
    ...files.map((file) =>
      env.CONTEXTMEM_DB.prepare(
        `INSERT INTO contextmem_namespace_artifacts (namespace, version_id, path, r2_key, content_type, kind, size, sha256, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(namespace, versionId, file.path, file.r2Key, file.contentType, file.kind, file.size, file.sha256, now)
    )
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
    directoryEnabled: input.directoryEnabled
  });
}

async function createExtraction(request: Request, env: WorkerEnv, ctx: WorkerExecutionContext): Promise<Response> {
  const input = extractionCreateSchema.parse(await request.json());
  const job = await createExtractionJob(input, env, ctx);
  return json({ job }, 202);
}

async function createExtractionJob(input: ExtractionCreateInput, env: WorkerEnv, ctx: WorkerExecutionContext) {
  const target = new URL(input.target);
  const namespace = normalizeNamespace(input.namespace ?? namespaceForExtractTarget(target));
  const jobId = createJobId();
  const now = new Date().toISOString();
  await env.CONTEXTMEM_DB.prepare(
    `INSERT INTO contextmem_extraction_jobs (id, owner_id, namespace, target, status, visibility, display_name, description, tags_json, directory_enabled, source_type, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, 'extract', ?, ?)`
  )
    .bind(jobId, input.ownerId, namespace, target.toString(), input.visibility, input.displayName ?? displayNameFromTarget(target.toString()), input.description ?? null, JSON.stringify(normalizeTags(input.tags)), input.directoryEnabled ? 1 : 0, now, now)
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
    const extracted = await extractTargetContext(job);
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

async function extractTargetContext(job: ExtractionJobRow): Promise<{ manifest: Record<string, unknown>; files: NamespaceImportInput["files"] }> {
  const target = new URL(job.target);
  const fetchedAt = new Date().toISOString();
  const home = await fetchText(target.toString());
  const title = extractTitle(home.text) ?? job.display_name ?? target.hostname;
  const description = extractDescription(home.text) ?? job.description ?? "";
  const metadata = extractPageMetadata(home.text);
  const walrusHeaders = target.hostname.endsWith(".wal.app") ? extractWalrusHeaders(home.headers) : {};
  const links = extractLinks(home.text, target).slice(0, 40);
  const resources = dedupeByUrl([...extractResourceLinks(home.text, target), ...metadataResourceLinks(metadata, target)]).slice(0, 80);
  const sameOriginPages = links.filter((link) => link.url.origin === target.origin).slice(0, 3);
  const fetchedPages = [];
  for (const link of sameOriginPages) {
    try {
      const page = await fetchText(link.url.toString());
      fetchedPages.push({
        url: link.url.toString(),
        title: extractTitle(page.text) ?? link.label,
        text: htmlToText(page.text).slice(0, 12000)
      });
    } catch {
      // Keep extraction best-effort for remote agents.
    }
  }

  const extras = await fetchOptionalTextFiles(target);
  const manifest = {
    runId: job.id,
    namespace: job.namespace,
    target: target.toString(),
    generatedAt: fetchedAt,
    mode: target.hostname.endsWith(".wal.app") ? "walrus" : "web",
    status: "completed",
    source: "cloudflare-fetch-extractor",
    title,
    description,
    metadata,
    walrus: Object.keys(walrusHeaders).length ? walrusHeaders : undefined,
    pages: [{ url: target.toString(), title, routePath: "/", markdown: htmlToText(home.text).slice(0, 20000) }, ...fetchedPages.map((page) => ({ url: page.url, title: page.title, markdown: page.text }))],
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
    ...resources.slice(0, 20).map((resource) => `- ${resource.url.toString()}`)
  ]
    .filter((line) => line !== undefined)
    .join("\n");

  const files: NamespaceImportInput["files"] = [
    { path: "/llms.txt", contentType: "text/plain; charset=utf-8", encoding: "utf8", content: llms },
    { path: "/index.html", contentType: home.contentType, encoding: "utf8", content: home.text.slice(0, 500_000) },
    { path: "/site/index.md", contentType: "text/markdown; charset=utf-8", encoding: "utf8", content: `# ${title}\n\n${htmlToText(home.text).slice(0, 12000)}` },
    { path: "/context/manifest.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(manifest, null, 2) },
    { path: "/context/metadata.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify({ title, description, metadata, walrus: walrusHeaders }, null, 2) },
    { path: "/context/site-structure.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(siteStructure, null, 2) },
    { path: "/context/resources.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify(resources.map((resource) => ({ url: resource.url.toString(), label: resource.label, kind: resource.kind })), null, 2) }
  ];
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
  return { text, contentType, headers: responseHeaderMap(response.headers) };
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

function maybeWithMemWalRecall(store: CloudflareNamespaceStore, env: WorkerEnv, request: Request): HostedNamespaceStore {
  const url = request.headers.get("x-memwal-mcp-url") ?? env.MEMWAL_MCP_URL;
  const authorization =
    request.headers.get("x-memwal-authorization") ??
    env.MEMWAL_AUTHORIZATION ??
    (request.headers.get("x-memwal-bearer") ? `Bearer ${request.headers.get("x-memwal-bearer")}` : undefined) ??
    (env.MEMWAL_BEARER ? `Bearer ${env.MEMWAL_BEARER}` : undefined);
  const accountId = request.headers.get("x-memwal-account-id") ?? env.MEMWAL_ACCOUNT_ID;
  if (!url || !authorization || !accountId) return store;
  return {
    getNamespace: (namespace) => store.getNamespace(namespace),
    listArtifacts: (namespace) => store.listArtifacts(namespace),
    readArtifact: (namespace, artifactPath) => store.readArtifact(namespace, artifactPath),
    recallMemory: (namespace, query) =>
      new MemWalMcpClient({
        url,
        authorization,
        accountId
      }).recallSiteContext(namespace, query)
  };
}

async function assertManagedNamespace(env: WorkerEnv, namespace: string, ownerId?: string): Promise<HostedNamespaceSummary> {
  const summary = await new CloudflareNamespaceStore(env).getNamespace(namespace);
  if (!summary || (ownerId && summary.ownerId !== ownerId)) throw statusError(`Namespace not found: ${namespace}`, 404);
  return summary;
}

async function getExtractionJobRow(env: WorkerEnv, jobId: string): Promise<ExtractionJobRow | undefined> {
  const row = await env.CONTEXTMEM_DB.prepare(
    `SELECT id, owner_id, namespace, target, status, visibility, display_name, description, tags_json, directory_enabled, source_type, error, result_json, created_at, updated_at, completed_at
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
  return {
    id: row.id,
    ownerId: row.owner_id,
    namespace: row.namespace,
    target: row.target,
    status: row.status,
    visibility: row.visibility,
    displayName: row.display_name ?? undefined,
    description: row.description ?? undefined,
    tags: parseTags(row.tags_json),
    directoryEnabled: Boolean(row.directory_enabled),
    sourceType: row.source_type ?? "extract",
    error: row.error ?? undefined,
    result: row.result_json ? JSON.parse(row.result_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined
  };
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
    const job = await createExtractionJob(
      {
        ownerId: schedule.owner_id,
        target: schedule.target,
        namespace: schedule.namespace,
        visibility: "private",
        displayName: displayNameFromTarget(schedule.target),
        tags: ["schedule", "context"],
        directoryEnabled: false
      },
      env,
      ctx
    );
    const summary = diffSummaryForNamespace(env, schedule.namespace);
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

function diffSummaryForNamespace(_env: WorkerEnv, _namespace: string) {
  return {
    pages: { added: 0, removed: 0, changed: 1, unchanged: 0 },
    resources: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    images: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    designTokens: { added: 0, removed: 0, changed: 0, unchanged: 0 }
  };
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
  url.hash = "";
  return url;
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
  if (existing && Number(existing.count) >= 1) throw statusError("Demo limit reached for today. Import credentials for unlimited local runs.", 429, "DEMO_LIMIT_EXCEEDED", "Open /app/settings, generate a CONTEXTMEM_ACCOUNT_SECRET and import MemWal SDK credentials to remove the 1/day demo quota.");
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

function demoSampleTarget(env: WorkerEnv): string {
  return env.CONTEXTMEM_DEMO_SAMPLE_TARGET ?? "https://rememe.wal.app/";
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
  return {
    id,
    label: row.label ?? "read token",
    hashPrefix: row.token_hash.slice(0, 12),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    revoked: Boolean(row.revoked_at)
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
  if (!env.CONTEXTMEM_NAMESPACE_IMPORT_TOKEN) return { ok: false, status: 500, message: "Namespace import token is not configured." };
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
    artifactCount: Number(row.artifact_count),
    byteLength: Number(row.byte_length),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function namespaceForExtractTarget(target: URL): string {
  return `web:${target.hostname.replace(/^www\./, "").toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}`;
}

function allResults<T>(result: { results?: T[] } | T[]): T[] {
  return Array.isArray(result) ? result : result.results ?? [];
}

function workerBaseUrl(request: Request, env: WorkerEnv): string {
  return (env.CONTEXTMEM_WORKER_BASE_URL ?? new URL(request.url).origin).replace(/\/+$/, "");
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
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "stylesheet", regex: /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi },
    { kind: "script", regex: /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi },
    { kind: "image", regex: /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi }
  ];
  for (const { kind, regex } of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html))) {
      try {
        const url = new URL(match[1]!, base);
        if (/^https?:$/.test(url.protocol)) resources.push({ url, label: url.pathname.split("/").pop() || url.hostname, kind });
      } catch {
        // ignore malformed URLs
      }
    }
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
  headers.set("access-control-allow-headers", "content-type, authorization, accept, mcp-session-id, mcp-protocol-version, x-memwal-mcp-url, x-memwal-account-id, x-memwal-authorization, x-memwal-bearer");
  headers.set("access-control-expose-headers", "mcp-session-id");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
