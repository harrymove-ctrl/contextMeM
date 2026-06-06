import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import {
  aiQueryWebsite,
  buildBrandProfileFromPages,
  buildDesignSystemFromPages,
  buildAgentReadableSite,
  buildPublishReadiness,
  buildStyleguideFromStyleSources,
  collectStyleSourcesForPages,
  captureScreenshots,
  crawlSitemap,
  crawlWebSite,
  createRunId,
  diffRunSnapshots,
  inferMode,
  inferTargetKind,
  findPriorRunForNamespace,
  listArtifactFiles,
  listRuns,
  namespaceForTarget,
  normalizeInputTarget,
  readContextManifest,
  readRunChunks,
  readRunManifest,
  readRunSnapshot,
  resolveArtifactFile,
  scrapeWebPage,
  verifySnapshot,
  type AiDatapoint,
  type BuildProfile,
  type DiscoveryStats,
  type Network,
  type RunCacheStats,
  type RunManifest,
  type RunProgress,
  type PageArtifact,
  type ScreenshotArtifact,
  type SiteSnapshotDiffEntry,
  type TargetMode,
  type VisualDiff,
  type WalrusPackageManifest
} from "@contextmem/core";
import { MemWalMcpClient, summarizeSnapshot, type SiteSnapshot } from "@contextmem/memwal";
import { SEED_FACTS, SEED_FACTS_LIST } from "./seed-facts.js";
import { getWalrusSiteHistory, materializeWalrusSite, resolveWalrusTarget, startWalrusPreview } from "@contextmem/walrus";
import { decryptSecret, encryptSecret, LocalAccountStore, publicAccount, type AccountRecord, type QuotaState } from "./account-store.js";

function loadLocalEnv(rootDir: string): void {
  let raw = "";
  try {
    raw = readFileSync(path.join(rootDir, ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
  }
}

const workspaceRoot = findWorkspaceRoot(process.cwd());
loadLocalEnv(workspaceRoot);

const runsDir = path.resolve(process.env.CONTEXTMEM_RUNS_DIR ?? path.join(workspaceRoot, "runs"));
const accountStore = new LocalAccountStore(path.join(runsDir, ".account-state.json"));
const accountSecret = process.env.CONTEXTMEM_ACCOUNT_SECRET ?? "contextmem-local-dev-account-secret";
const memwalCredentialsPath = expandHomePath(process.env.MEMWAL_MCP_CREDENTIALS_PATH ?? "~/.memwal/credentials.json");
const hostedApiUrl = process.env.CONTEXTMEM_HOSTED_API_URL;
const hostedImportToken = process.env.CONTEXTMEM_HOSTED_IMPORT_TOKEN;
const memwalMcpLoginCommands = ["npx -y @mysten-incubation/memwal-mcp login --prod"];
const memwalMcpRequiredQuery = ["port", "publicKey", "delegateAddress", "label", "relayer", "state"];
const app = Fastify({ logger: true });

app.addHook("onRequest", async (_req, reply) => {
  reply.header("access-control-allow-origin", "*");
  reply.header("access-control-allow-methods", "GET,POST,PATCH,OPTIONS");
  reply.header("access-control-allow-headers", "content-type, authorization");
});

app.options("/*", async (_req, reply) => reply.status(204).send());

app.setErrorHandler((error, _request, reply) => {
  const message = error instanceof Error ? error.message : String(error);
  const explicitStatus = typeof (error as Error & { statusCode?: unknown }).statusCode === "number" ? ((error as Error & { statusCode: number }).statusCode) : undefined;
  const statusCode = explicitStatus ?? (error instanceof z.ZodError || message.startsWith("Walrus URL") || message.startsWith("AI query requires") ? 400 : 500);
  reply.status(statusCode).send({
    statusCode,
    error: statusCode === 400 ? "Bad Request" : statusCode === 401 ? "Unauthorized" : statusCode === 403 ? "Forbidden" : statusCode === 404 ? "Not Found" : statusCode === 429 ? "Too Many Requests" : "Internal Server Error",
    message
  });
});

const runSchema = z.object({
  target: z.string().min(1),
  mode: z.enum(["auto", "web", "walrus"]).default("auto"),
  network: z.enum(["testnet", "mainnet"]).default("mainnet"),
  buildProfile: z.enum(["fast", "balanced", "full"]).default("balanced"),
  outputs: z.array(z.string()).optional(),
  background: z.boolean().default(false),
  crawlOptions: z
    .object({
      maxPages: z.number().int().min(1).max(500).optional(),
      maxDepth: z.number().int().min(0).max(25).optional(),
      urlRegex: z.string().optional(),
      includeImages: z.boolean().optional(),
      includeLinks: z.boolean().optional(),
      concurrency: z.number().int().min(1).max(24).optional()
    })
    .default({})
});

type RunInput = z.infer<typeof runSchema>;

const demoExtractionCreateSchema = z.object({
  target: z.string().min(1).optional(),
  sample: z.boolean().default(false)
});

const buildProfileOutputs: Record<BuildProfile, string[]> = {
  fast: ["markdown", "sitemap"],
  balanced: ["markdown", "images", "brand", "styleguide", "sitemap"],
  full: ["markdown", "images", "brand", "styleguide", "sitemap", "screenshots"]
};

type AuthContext = {
  account: AccountRecord;
  quota: QuotaState;
};

app.get("/health", async () => ({ ok: true, service: "contextmem-api" }));

app.get("/api/ext/activate", extensionActivation);
app.post("/api/ext/activate", extensionActivation);

app.get("/api/me", async (request) => {
  const auth = await getOptionalAuth(request.headers.authorization);
  if (!auth) {
    return {
      authenticated: false,
      account: null,
      quota: { limit: 1, used: 0, remaining: 0 },
      access: {
        canPreview: true,
        canRun: false,
        reason: "Import MemWal SDK credentials for verified recall and memory."
      }
    };
  }
  return serializeMe(auth.account, auth.quota);
});

app.get("/api/ext/auth-token", extensionAuthToken);
app.post("/api/ext/auth-token", extensionAuthToken);

app.post("/api/memwal/connect", async (request) => {
  const input = z
    .object({
      mode: z.enum(["local"]).default("local")
    })
    .parse(request.body ?? {});

  if (input.mode === "local") {
    const auth = await requireAuth(request.headers.authorization);
    return importLocalMemWalCredentials(auth);
  }
});

async function importLocalMemWalCredentials(auth: AuthContext) {
  const localCredentials = await readLocalMemWalCredentials();

  if (localCredentials.status === "ready") {
    const credentialOwner = localCredentials.credentials.walletAddress;
    if (credentialOwner && !sameSuiAddress(credentialOwner, auth.account.ownerAddress)) {
      return {
        status: "account-mismatch",
        imported: false,
        message: `Local MemWal MCP credentials belong to ${compactAddress(credentialOwner)}, but this ContextMeM session is ${compactAddress(auth.account.ownerAddress)}. Import matching MemWal SDK credentials, then use local MCP creds again.`,
        commands: memwalMcpLoginCommands,
        requiredQuery: memwalMcpRequiredQuery
      };
    }

    const updated = await accountStore.saveDelegate(auth.account.id, localCredentials.credentials.accountId, encryptSecret(localCredentials.credentials.delegatePrivateKey, accountSecret));
    return {
      status: "imported-local-credentials",
      imported: true,
      me: serializeMe(updated, await accountStore.getQuota(updated.id)),
      credentials: {
        accountId: localCredentials.credentials.accountId,
        walletAddress: localCredentials.credentials.walletAddress,
        delegateAddress: localCredentials.credentials.delegateAddress,
        relayerUrl: localCredentials.credentials.relayerUrl
      },
      message: "Imported local MemWal MCP credentials for this ContextMeM account."
    };
  }

  return {
    status: localCredentials.status,
    imported: false,
    message: `${localCredentials.message} The MemWal MCP connect page must be opened by @mysten-incubation/memwal-mcp so the URL includes ${memwalMcpRequiredQuery.join(", ")}.`,
    commands: memwalMcpLoginCommands,
    requiredQuery: memwalMcpRequiredQuery
  };
}

app.post("/api/memwal/import-delegate", async (request) => {
  const input = z.object({ memwalAccountId: z.string().min(1), delegateKey: z.string().min(12) }).parse(request.body ?? {});
  const auth = await getOptionalAuth(request.headers.authorization);
  const account = auth?.account ?? (await accountStore.upsertAccount(input.memwalAccountId, "unknown"));
  const updated = await accountStore.saveDelegate(account.id, input.memwalAccountId, encryptSecret(normalizeDelegateSecret(input.delegateKey), accountSecret));
  const token = auth ? undefined : await accountStore.createSession(updated.id, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
  const me = serializeMe(updated, await accountStore.getQuota(updated.id));
  return token ? { token, me } : me;
});

app.get("/api/memwal/facts", async () => ({ namespaces: SEED_FACTS_LIST }));

app.get("/api/memwal/facts/:namespace", async (request, reply) => {
  const ns = decodeURIComponent((request.params as { namespace: string }).namespace);
  const facts = SEED_FACTS[ns];
  if (!facts) {
    reply.code(404);
    return { error: `No seeded facts for namespace "${ns}".` };
  }
  return { namespace: ns, facts };
});

app.get("/api/memwal/namespaces", async () => {
  const raw = process.env.MEMWAL_NAMESPACES?.trim();
  let namespaces = [
    { namespace: "demo:sui-docs", label: "Sui Docs" },
    { namespace: "demo:walrus-docs", label: "Walrus Docs" },
    { namespace: "demo:seal-docs", label: "Seal Docs" }
  ];
  if (raw) {
    const parsed = raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const eq = entry.indexOf("=");
        const namespace = (eq === -1 ? entry : entry.slice(0, eq)).trim();
        const label = (eq === -1 ? "" : entry.slice(eq + 1).trim()) || namespace.replace(/^demo:/, "");
        return { namespace, label };
      })
      .filter((entry) => entry.namespace);
    if (parsed.length) namespaces = parsed;
  }
  const configured = Boolean(process.env.MEMWAL_ACCOUNT_ID && (process.env.MEMWAL_PRIVATE_KEY || process.env.MEMWAL_AUTHORIZATION));
  return { namespaces, configured };
});

app.post("/api/memwal/recall", async (request, reply) => {
  const input = z.object({ namespace: z.string().min(1), query: z.string().min(1).max(500) }).parse(request.body ?? {});
  // Prefer the signed-in account's imported delegate (the one the Settings UI
  // saved + the existing run recall uses). Fall back to env for anonymous dev.
  let memwal: MemWalMcpClient | null = null;
  try {
    const auth = await getOptionalAuth(request.headers.authorization);
    if (auth?.account?.delegateKeyCiphertext) {
      memwal = memwalClientForAccount(auth.account);
    }
  } catch {
    /* not signed in — try env below */
  }
  if (!memwal) {
    const privateKey = (process.env.MEMWAL_PRIVATE_KEY ?? process.env.MEMWAL_BEARER ?? "")
      .trim()
      .replace(/^bearer\s+/i, "")
      .replace(/^0x/i, "")
      .trim();
    const accountId = process.env.MEMWAL_ACCOUNT_ID?.trim();
    if (!privateKey || !accountId) {
      reply.code(503);
      return { error: "Walrus Memory recall needs an imported delegate (Settings) or MEMWAL_PRIVATE_KEY + MEMWAL_ACCOUNT_ID in the local environment." };
    }
    const url = process.env.MEMWAL_API_URL ?? process.env.MEMWAL_MCP_URL ?? "https://relayer.memwal.ai";
    memwal = new MemWalMcpClient({ url, privateKey, accountId });
  }
  try {
    const result = await memwal.recallSiteContext(input.namespace, input.query);
    return { namespace: input.namespace, query: input.query, result };
  } catch (error) {
    reply.code(502);
    return { error: error instanceof Error ? error.message : String(error) };
  }
});

// Build a rich grounded context block from a namespace's verified knowledge
// graph (identity + entities + topics + claims + stats + Q&A).
function localFactsGrounding(namespace: string): { block: string; lines: string[] } {
  const facts = SEED_FACTS[namespace];
  if (!facts) return { block: "", lines: [] };
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
  return { block: lines.join("\n"), lines };
}

// Keyword-rank a namespace's facts against a query (deterministic, no LLM).
function localFactsFallback(namespace: string, query: string): Array<{ text: string; score: number }> {
  const facts = SEED_FACTS[namespace];
  if (!facts) return [];
  const candidates: string[] = [];
  if (facts.identity?.oneLiner) candidates.push(`${facts.identity.name}: ${facts.identity.oneLiner}`);
  for (const q of facts.questions ?? []) if (q.answer) candidates.push(`${q.question} — ${q.answer}`);
  for (const c of facts.claims ?? []) if (c.text) candidates.push(c.text);
  for (const e of facts.entities ?? []) if (e.description) candidates.push(`${e.name}: ${e.description}`);
  for (const s of facts.stats ?? []) if (s.valueRaw) candidates.push(`${s.label}: ${s.valueRaw}`);
  const queryTokens = new Set((query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2));
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
  return scored.length ? scored : candidates.slice(0, 5).map((text) => ({ text, score: 0 }));
}

// POST /api/memwal/chat — local mirror of the Worker's grounded chat. Recall
// from Walrus Memory (imported delegate or env) + verified facts, then
// synthesize with an OpenAI-compatible model if OPENAI_API_KEY is set, else
// return a deterministic facts-grounded answer so local dev never dead-errors.
app.post("/api/memwal/chat", async (request, reply) => {
  const input = z
    .object({
      namespace: z.string().min(1),
      messages: z.array(z.object({ role: z.enum(["user", "assistant"]).optional(), content: z.string() })).optional()
    })
    .parse(request.body ?? {});
  const namespace = input.namespace.trim();
  const messages = (input.messages ?? [])
    .map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: (m.content ?? "").trim().slice(0, 2000) }))
    .filter((m) => m.content)
    .slice(-8);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const query = (lastUser?.content ?? "").slice(0, 500);
  if (!query) {
    reply.code(400);
    return { error: "namespace and a user message are required." };
  }

  // 1) Optional Walrus Memory recall (imported delegate, else env).
  let recallHits: Array<{ text: string; distance?: number }> = [];
  let memwal: MemWalMcpClient | null = null;
  try {
    const auth = await getOptionalAuth(request.headers.authorization);
    if (auth?.account?.delegateKeyCiphertext) memwal = memwalClientForAccount(auth.account);
  } catch {
    /* not signed in */
  }
  if (!memwal) {
    const privateKey = (process.env.MEMWAL_PRIVATE_KEY ?? process.env.MEMWAL_BEARER ?? "").trim().replace(/^bearer\s+/i, "").replace(/^0x/i, "").trim();
    const accountId = process.env.MEMWAL_ACCOUNT_ID?.trim();
    if (/^[0-9a-fA-F]{64}$/.test(privateKey) && accountId) {
      const url = process.env.MEMWAL_API_URL ?? process.env.MEMWAL_MCP_URL ?? "https://relayer.memwal.ai";
      memwal = new MemWalMcpClient({ url, privateKey, accountId });
    }
  }
  if (memwal) {
    try {
      const result = (await memwal.recallSiteContext(namespace, query)) as { results?: Array<{ text?: string; distance?: number }> };
      recallHits = (result?.results ?? [])
        .map((r) => ({ text: String(r.text ?? "").trim(), distance: typeof r.distance === "number" ? r.distance : undefined }))
        .filter((r) => r.text)
        .slice(0, 6);
    } catch {
      /* fall through to facts grounding */
    }
  }

  const { block: factsBlock } = localFactsGrounding(namespace);
  const hasRecall = recallHits.length > 0;
  const source: "walrus-memory" | "facts" | "mixed" = hasRecall && factsBlock ? "mixed" : hasRecall ? "walrus-memory" : "facts";
  const facts = SEED_FACTS[namespace];
  const subject = facts?.identity?.name ?? namespace;

  const groundingParts: string[] = [];
  if (hasRecall) groundingParts.push("[Walrus Memory recall]\n" + recallHits.map((h, i) => `(${i + 1}) ${h.text.slice(0, 700)}`).join("\n"));
  if (factsBlock) groundingParts.push("[Verified facts]\n" + factsBlock);
  const grounding = groundingParts.join("\n\n") || "(no stored context available for this namespace yet)";

  let data: { answer: string; key_points: string[] } = { answer: "", key_points: [] };
  let confidence = 0.5;
  let usedProvider = "facts-grounded";

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `You are ContextMeM, chatting naturally about "${subject}". Answer the user's latest message using ONLY this context (entities, topics, claims, stats, Q&A). Synthesize across ALL of it — entities and topics describe how it works and what it's made of. Be specific. Only if nothing is relevant, say you don't have that detail in memory yet; never invent specifics. Return strict JSON: {"answer": string, "key_points": string[2-5], "confidence": number}.\n\nContext:\n${grounding}`
            },
            ...messages
          ]
        })
      });
      if (response.ok) {
        const jsonResp = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const parsed = JSON.parse(jsonResp.choices?.[0]?.message?.content ?? "{}") as Record<string, unknown>;
        data = {
          answer: typeof parsed.answer === "string" ? parsed.answer : "",
          key_points: Array.isArray(parsed.key_points) ? parsed.key_points.map((k) => String(k)).filter(Boolean).slice(0, 6) : []
        };
        if (typeof parsed.confidence === "number") confidence = Math.max(0, Math.min(1, parsed.confidence));
        usedProvider = "openai-compatible";
      }
    } catch {
      /* fall through to deterministic answer */
    }
  }

  if (!data.answer) {
    // Deterministic facts-grounded answer (no LLM key required).
    const ranked = hasRecall ? recallHits.map((h) => ({ text: h.text, score: 1 })) : localFactsFallback(namespace, query);
    const top = ranked.slice(0, 4);
    data = {
      answer: top.length
        ? `Here's what ContextMeM has on ${subject} for that: ${top.map((t) => t.text).join(" ").slice(0, 600)}`
        : `I don't have anything in memory for ${subject} that matches that yet.`,
      key_points: top.map((t) => t.text.slice(0, 160))
    };
    confidence = top.length ? 0.4 : 0.1;
  }

  const sources = hasRecall
    ? recallHits.map((h, i) => ({ url: "", routePath: `walrus-memory#${i + 1}`, quote: h.text.slice(0, 280), blobId: typeof h.distance === "number" ? `distance ${h.distance.toFixed(3)}` : undefined }))
    : localFactsFallback(namespace, query).slice(0, 4).map((r, i) => ({ url: "", routePath: `verified-fact#${i + 1}`, quote: r.text.slice(0, 280) }));

  return { namespace, target: subject, source, data, confidence, usedProvider, sources };
});

app.get("/api/runs", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const query = request.query as { limit?: string };
  const ownedRunIds = new Set(await accountStore.listOwnedRunIds(auth.account.id));
  const runs = await listRuns(runsDir, Math.min(Number(query.limit ?? 100) || 100, 500));
  return runs.filter((run) => ownedRunIds.has(run.runId));
});

app.post("/api/runs", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  requireMemWalDelegate(auth.account);
  const input = runSchema.parse(request.body);
  const buildProfile = input.buildProfile as BuildProfile;
  const outputs = normalizeRunOutputs(buildProfile, input.outputs);
  const mode = inferMode(input.target, input.mode as TargetMode);
  const runId = createRunId(mode);
  const artifactDir = path.join(runsDir, runId);
  await fs.mkdir(artifactDir, { recursive: true });
  await accountStore.setRunOwner(runId, auth.account.id);
  const now = new Date().toISOString();
  const manifest: RunManifest = {
    runId,
    target: input.target,
    normalizedTarget: normalizeInputTarget(input.target),
    targetKind: inferTargetKind(input.target),
    mode,
    status: input.background ? "queued" : "running",
    createdAt: now,
    updatedAt: now,
    namespace: namespaceForTarget(input.target, mode),
    outputs,
    buildProfile,
    progress: {
      phase: input.background ? "queued" : "resolving",
      label: input.background ? "Queued local context build" : "Resolving target",
      updatedAt: now
    },
    timings: {},
    cacheStats: emptyRunCacheStats(),
    errors: [],
    artifactDir
  };
  await writeRunManifest(artifactDir, manifest);

  const execution = executeContextRun({ input, outputs, buildProfile, mode, artifactDir, manifest });
  if (input.background) {
    void execution.catch((error) => app.log.error({ err: error, runId }, "Background context build failed"));
    return { manifest };
  }
  return execution;
});

async function executeContextRun({
  input,
  outputs,
  buildProfile,
  mode,
  artifactDir,
  manifest
}: {
  input: RunInput;
  outputs: string[];
  buildProfile: BuildProfile;
  mode: TargetMode;
  artifactDir: string;
  manifest: RunManifest;
}): Promise<unknown> {
  const selectedOutputs = new Set(outputs);
  const timings = manifest.timings ?? {};
  const cacheStats = manifest.cacheStats ?? emptyRunCacheStats();
  let writeQueue = Promise.resolve();
  let lastProgressWriteAt = 0;
  const writeQueuedManifest = () => {
    writeQueue = writeQueue.then(() => writeRunManifest(artifactDir, manifest));
    return writeQueue;
  };
  const setProgress = async (progress: Omit<RunProgress, "updatedAt">) => {
    const now = new Date().toISOString();
    manifest.status = "running";
    manifest.progress = { ...progress, updatedAt: now };
    manifest.updatedAt = now;
    manifest.timings = timings;
    manifest.cacheStats = cacheStats;
    const done = typeof progress.itemsDone === "number" && progress.itemsDone === progress.itemsTotal;
    const phaseOnly = progress.itemsDone === undefined && progress.itemsTotal === undefined;
    const shouldWrite = done || phaseOnly || Date.now() - lastProgressWriteAt > 450;
    if (!shouldWrite) return;
    lastProgressWriteAt = Date.now();
    await writeQueuedManifest();
  };

  try {
    await setProgress({ phase: "resolving", label: "Resolving target" });
    if (mode === "walrus") {
      const site = await measureRunTiming(timings, "resolveTarget", () => resolveWalrusTarget(input.target, { network: input.network as Network }));
      manifest.namespace = namespaceForTarget(input.target, "walrus", site.network, site.siteObjectId);
      await writeQueuedManifest();
      const materialized = await materializeWalrusSite(site, artifactDir, {
        outputs,
        concurrency: input.crawlOptions.concurrency,
        discoveryMode: buildProfile,
        cacheDir: path.join(runsDir, ".cache"),
        captureScreenshots: selectedOutputs.has("screenshots"),
        onProgress: setProgress
      });
      Object.assign(timings, prefixTimings("walrus", materialized.timings));
      Object.assign(cacheStats, materialized.cacheStats);
      await setProgress({ phase: "completed", label: "Context package ready", itemsDone: materialized.resources.length, itemsTotal: materialized.resources.length });
      manifest.status = "completed";
      manifest.updatedAt = new Date().toISOString();
      manifest.timings = timings;
      manifest.cacheStats = cacheStats;
      await writeQueuedManifest();
      await writeQueue;
      return {
        manifest,
        walrus: {
          site,
          resources: materialized.resources.length,
          pages: materialized.pages.length
        }
      };
    }

    const includeImages = selectedOutputs.has("images") || selectedOutputs.has("brand") || selectedOutputs.has("styleguide") || selectedOutputs.has("screenshots");
    const shouldCrawl = selectedOutputs.has("crawl") || selectedOutputs.has("sitemap");
    const sitemapPromise = selectedOutputs.has("sitemap") ? measureRunTiming(timings, "sitemap", () => crawlSitemap(input.target).catch(() => undefined)) : Promise.resolve(undefined);
    const sitemapSeed = await sitemapPromise;
    await setProgress({ phase: "crawling_pages", label: shouldCrawl ? "Crawling website pages" : "Fetching target page" });
    let discovery: DiscoveryStats | undefined;
    const pages = await measureRunTiming(timings, "crawlPages", () =>
      shouldCrawl
        ? crawlWebSite(input.target, {
            ...input.crawlOptions,
            includeImages,
            includeLinks: true,
            seedUrls: sitemapSeed?.urls,
            onDiscovery: (stats) => {
              discovery = stats;
            }
          })
        : scrapeWebPage({ url: input.target, includeImages, includeLinks: true }).then((page) => [page])
    );
    const sitemap = sitemapSeed;

    let brand: ReturnType<typeof buildBrandProfileFromPages> | undefined;
    let styleguide: ReturnType<typeof buildStyleguideFromStyleSources> | undefined;
    let designSystem: ReturnType<typeof buildDesignSystemFromPages> | undefined;
    if (selectedOutputs.has("brand") || selectedOutputs.has("styleguide")) {
      await setProgress({ phase: "extracting_metadata", label: "Extracting brand and design metadata", itemsDone: 0, itemsTotal: pages.length });
      const styleSources = await measureRunTiming(timings, "styleSources", () => collectStyleSourcesForPages(pages));
      const metadataStyleguide = buildStyleguideFromStyleSources(styleSources);
      styleguide = selectedOutputs.has("styleguide") ? metadataStyleguide : undefined;
      brand = selectedOutputs.has("brand") || selectedOutputs.has("styleguide")
        ? buildBrandProfileFromPages(input.target, pages, {
            colors: metadataStyleguide.colors.palette,
            fonts: metadataStyleguide.typography.fontFamilies
          })
        : undefined;
      designSystem = selectedOutputs.has("styleguide")
        ? buildDesignSystemFromPages({
            target: input.target,
            pages,
            brand,
            styleSources
          })
        : undefined;
    }

    const screenshotCapture = selectedOutputs.has("screenshots")
      ? await measureRunTiming(timings, "captureScreenshots", async () => {
          await setProgress({ phase: "capturing_screenshots", label: "Capturing screenshots and component previews" });
          return captureScreenshots({
            outputDir: artifactDir,
            pages,
            designSystem
          }).catch((error) => ({
            screenshots: [],
            componentPreviews: [],
            warnings: [error instanceof Error ? error.message : String(error)]
          }));
        })
      : undefined;

    await setProgress({ phase: "building_artifacts", label: "Writing agent-readable context artifacts" });
    await measureRunTiming(timings, "buildArtifacts", () =>
      buildAgentReadableSite({
        runId: manifest.runId,
        target: input.target,
        outputDir: artifactDir,
        pages,
        sitemap,
        discovery,
        images: selectedOutputs.has("images") ? undefined : [],
        brand,
        styleguide,
        designSystem,
        screenshots: screenshotCapture?.screenshots,
        componentPreviews: screenshotCapture?.componentPreviews
      })
    );
    manifest.errors.push(...(screenshotCapture?.warnings ?? []));
    await setProgress({ phase: "completed", label: "Context package ready", itemsDone: pages.length, itemsTotal: pages.length });
    manifest.status = "completed";
    manifest.updatedAt = new Date().toISOString();
    manifest.buildProfile = buildProfile;
    manifest.timings = timings;
    manifest.cacheStats = cacheStats;
    await writeQueuedManifest();
    await writeQueue;
    return { manifest, pages: pages.length, sitemap, brand, styleguide, designSystem };
  } catch (error) {
    manifest.status = "failed";
    manifest.progress = {
      phase: "failed",
      label: "Context build failed",
      updatedAt: new Date().toISOString()
    };
    manifest.errors.push(error instanceof Error ? error.message : String(error));
    manifest.updatedAt = new Date().toISOString();
    manifest.timings = timings;
    manifest.cacheStats = cacheStats;
    await writeQueuedManifest();
    await writeQueue;
    throw error;
  }
}

app.get("/api/runs/:id", async (request) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  return readRunManifest(runsDir, id);
});

app.get("/api/runs/:id/events", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "access-control-allow-origin": "*"
  });
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const manifest = await readRunManifest(runsDir, id).catch(() => undefined);
    if (manifest) {
      writeSse(reply, "progress", {
        runId: id,
        status: manifest.status,
        progress: manifest.progress,
        updatedAt: manifest.updatedAt
      });
      if (manifest.status === "completed" || manifest.status === "failed") {
        writeSse(reply, "done", manifest);
        break;
      }
    }
    await delay(750);
  }
  reply.raw.end();
  return reply;
});

app.get("/api/runs/:id/artifacts", async (request) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  return readContextManifest(runsDir, id);
});

app.get("/api/runs/:id/artifact-files", async (request) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  return listArtifactFiles(path.join(runsDir, id));
});

app.get("/api/runs/:id/artifact-file", async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const query = request.query as { path?: string; download?: string; accessToken?: string };
  await requireRunAccess(request.headers.authorization ?? (query.accessToken ? `Bearer ${query.accessToken}` : undefined), id);
  if (!query.path) throw new Error("Artifact path is required.");
  const { absolutePath, record } = await resolveArtifactFile(path.join(runsDir, id), query.path);
  const body = await fs.readFile(absolutePath);
  reply.type(record.contentType);
  if (query.download === "1" || query.download === "true") {
    reply.header("content-disposition", `attachment; filename="${path.basename(record.path)}"`);
  }
  return body;
});

app.get("/api/runs/:id/publish-readiness", async (request) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  return buildPublishReadiness(path.join(runsDir, id), id);
});

app.post("/api/runs/:id/hosted/import", async (request) => {
  const id = (request.params as { id: string }).id;
  const auth = await requireRunAccess(request.headers.authorization, id);
  const input = z
    .object({
      visibility: z.enum(["private", "public"]).default("private"),
      namespace: z.string().min(3).max(300).optional(),
      displayName: z.string().max(120).optional(),
      description: z.string().max(600).optional(),
      tags: z.array(z.string().min(1).max(40)).max(12).default([]),
      directoryEnabled: z.boolean().default(false)
    })
    .parse(request.body ?? {});
  if (!hostedApiUrl || !hostedImportToken) {
    return badRequest("Hosted namespace import is not configured. Set CONTEXTMEM_HOSTED_API_URL and CONTEXTMEM_HOSTED_IMPORT_TOKEN.");
  }

  const artifact = await readContextManifest(runsDir, id);
  const namespace = input.namespace?.trim() || namespaceForArtifact(artifact);
  const files = await collectHostedNamespaceFiles(path.join(runsDir, id));
  const response = await fetch(new URL("/api/namespaces/import", hostedApiUrl).toString(), {
    method: "POST",
    headers: {
      authorization: `Bearer ${hostedImportToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      namespace,
      visibility: input.visibility,
      ownerId: auth.account.id,
      displayName: input.displayName,
      description: input.description,
      tags: input.tags,
      sourceType: artifact.walrus ? "walrus" : "web",
      directoryEnabled: input.directoryEnabled,
      target: artifact.target,
      sourceRunId: id,
      manifest: artifact,
      files
    })
  });
  if (!response.ok) throw new Error(`Hosted namespace import failed (${response.status}): ${await response.text()}`);
  return response.json();
});

app.post("/api/runs/:id/share", async (request) => {
  const id = (request.params as { id: string }).id;
  const auth = await requireRunAccess(request.headers.authorization, id);
  const input = z
    .object({
      title: z.string().max(160).optional(),
      description: z.string().max(600).optional()
    })
    .parse(request.body ?? {});
  if (!hostedApiUrl || !hostedImportToken) {
    return badRequest("Share links require CONTEXTMEM_HOSTED_API_URL and CONTEXTMEM_HOSTED_IMPORT_TOKEN.");
  }

  const artifact = await readContextManifest(runsDir, id);
  const files = await collectHostedNamespaceFiles(path.join(runsDir, id));
  return hostedWorkerJson("/api/share-links", {
    method: "POST",
    body: JSON.stringify({
      ownerId: auth.account.id,
      target: artifact.target,
      title: input.title ?? displayNameFromTarget(artifact.target),
      description: input.description,
      sourceRunId: id,
      manifest: artifact,
      files
    })
  });
});

app.get("/api/share-links/:shareId", async (request) => {
  const { shareId } = request.params as { shareId: string };
  return publicHostedWorkerJson(`/api/share-links/${encodeURIComponent(shareId)}`);
});

app.get("/api/share-links/:shareId/artifacts", async (request) => {
  const { shareId } = request.params as { shareId: string };
  return publicHostedWorkerJson(`/api/share-links/${encodeURIComponent(shareId)}/artifacts`);
});

app.get("/api/share-links/:shareId/og.svg", async (request, reply) => {
  const { shareId } = request.params as { shareId: string };
  const response = await publicHostedWorkerResponse(`/api/share-links/${encodeURIComponent(shareId)}/og.svg`);
  if (!response.ok) {
    reply.status(response.status);
    reply.type("image/svg+xml; charset=utf-8");
    reply.header("cache-control", "no-store");
    return notFoundOgSvg(shareId);
  }
  reply.status(response.status);
  const contentType = response.headers.get("content-type");
  const cacheControl = response.headers.get("cache-control");
  if (contentType) reply.type(contentType);
  if (cacheControl) reply.header("cache-control", cacheControl);
  return Buffer.from(await response.arrayBuffer());
});

app.post("/api/demo/extractions", async (request) => {
  const input = demoExtractionCreateSchema.parse(request.body ?? {});
  return publicHostedWorkerJson("/api/demo/extractions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input)
  });
});

app.get("/api/demo/extractions/:jobId/events", async (request, reply) => {
  const { jobId } = request.params as { jobId: string };
  const response = await publicHostedWorkerResponse(`/api/demo/extractions/${encodeURIComponent(jobId)}/events`);
  reply.status(response.status);
  const contentType = response.headers.get("content-type");
  const cacheControl = response.headers.get("cache-control");
  if (contentType) reply.type(contentType);
  if (cacheControl) reply.header("cache-control", cacheControl);
  return response.text();
});

app.get("/api/demo/extractions/:jobId", async (request) => {
  const { jobId } = request.params as { jobId: string };
  return publicHostedWorkerJson(`/api/demo/extractions/${encodeURIComponent(jobId)}`);
});

app.get("/api/hosted/namespaces", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  return hostedWorkerJson(`/api/namespaces?ownerId=${encodeURIComponent(auth.account.id)}`);
});

app.patch("/api/hosted/namespaces/:namespace", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const namespace = (request.params as { namespace: string }).namespace;
  const input = z
    .object({
      visibility: z.enum(["private", "public"]).optional(),
      displayName: z.string().max(120).optional(),
      description: z.string().max(600).optional(),
      tags: z.array(z.string().min(1).max(40)).max(12).optional(),
      directoryEnabled: z.boolean().optional()
    })
    .parse(request.body ?? {});
  return hostedWorkerJson(`/api/namespaces/${encodeURIComponent(namespace)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...input, ownerId: auth.account.id })
  });
});

app.get("/api/hosted/namespaces/:namespace/tokens", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const namespace = (request.params as { namespace: string }).namespace;
  return hostedWorkerJson(`/api/namespaces/${encodeURIComponent(namespace)}/tokens?ownerId=${encodeURIComponent(auth.account.id)}`);
});

app.post("/api/hosted/namespaces/:namespace/tokens", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const namespace = (request.params as { namespace: string }).namespace;
  const input = z.object({ label: z.string().min(1).max(80).default("read token") }).parse(request.body ?? {});
  return hostedWorkerJson(`/api/namespaces/${encodeURIComponent(namespace)}/tokens`, {
    method: "POST",
    body: JSON.stringify({ ...input, ownerId: auth.account.id })
  });
});

app.delete("/api/hosted/namespaces/:namespace/tokens/:tokenId", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const params = request.params as { namespace: string; tokenId: string };
  return hostedWorkerJson(`/api/namespaces/${encodeURIComponent(params.namespace)}/tokens/${encodeURIComponent(params.tokenId)}?ownerId=${encodeURIComponent(auth.account.id)}`, { method: "DELETE" });
});

app.get("/api/hosted/directory", async (request) => {
  const query = request.query as { search?: string; limit?: string };
  const search = query.search ? `&search=${encodeURIComponent(query.search)}` : "";
  const limit = query.limit ? `limit=${encodeURIComponent(query.limit)}` : "limit=50";
  return publicHostedWorkerJson(`/api/directory?${limit}${search}`);
});

app.post("/api/hosted/extractions", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const input = z
    .object({
      target: z.string().url(),
      namespace: z.string().min(3).max(300).optional(),
      visibility: z.enum(["private", "public"]).default("private"),
      displayName: z.string().max(120).optional(),
      description: z.string().max(600).optional(),
      tags: z.array(z.string().min(1).max(40)).max(12).default([]),
      directoryEnabled: z.boolean().default(false)
    })
    .parse(request.body ?? {});
  return hostedWorkerJson("/api/extractions", {
    method: "POST",
    body: JSON.stringify({ ...input, ownerId: auth.account.id })
  });
});

app.post("/api/hosted/namespace-builds", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const input = z
    .object({
      namespace: z.string().min(3).max(300).optional(),
      visibility: z.enum(["private", "public"]).default("private"),
      displayName: z.string().max(120).optional(),
      description: z.string().max(600).optional(),
      tags: z.array(z.string().min(1).max(40)).max(12).default([]),
      directoryEnabled: z.boolean().default(false),
      sources: z
        .array(
          z.object({
            target: z.string().url(),
            label: z.string().min(1).max(120).optional(),
            mode: z.enum(["auto", "web", "walrus"]).default("auto")
          })
        )
        .min(1)
        .max(5)
    })
    .parse(request.body ?? {});
  return hostedWorkerJson("/api/namespace-builds", {
    method: "POST",
    body: JSON.stringify({ ...input, ownerId: auth.account.id })
  });
});

app.get("/api/hosted/extractions/:jobId", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const jobId = (request.params as { jobId: string }).jobId;
  return hostedWorkerJson(`/api/extractions/${encodeURIComponent(jobId)}?ownerId=${encodeURIComponent(auth.account.id)}`);
});

app.post("/api/hosted/schedules", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const input = z
    .object({
      namespace: z.string().min(3).max(300).optional(),
      target: z.string().url(),
      intervalHours: z.number().int().min(1).max(24 * 30).default(24),
      webhookUrl: z.string().url().optional(),
      webhookSecret: z.string().min(8).max(200).optional(),
      active: z.boolean().default(true)
    })
    .parse(request.body ?? {});
  return hostedWorkerJson("/api/schedules", {
    method: "POST",
    body: JSON.stringify({ ...input, ownerId: auth.account.id })
  });
});

app.get("/api/hosted/schedules", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  return hostedWorkerJson(`/api/schedules?ownerId=${encodeURIComponent(auth.account.id)}`);
});

app.patch("/api/hosted/schedules/:id", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  const id = (request.params as { id: string }).id;
  const input = z
    .object({
      intervalHours: z.number().int().min(1).max(24 * 30).optional(),
      webhookUrl: z.string().url().nullable().optional(),
      webhookSecret: z.string().min(8).max(200).nullable().optional(),
      active: z.boolean().optional()
    })
    .parse(request.body ?? {});
  return hostedWorkerJson(`/api/schedules/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ ...input, ownerId: auth.account.id })
  });
});

app.get("/api/hosted/alerts", async (request) => {
  const auth = await requireAuth(request.headers.authorization);
  return hostedWorkerJson(`/api/alerts?ownerId=${encodeURIComponent(auth.account.id)}`);
});

app.get("/api/runs/:id/walrus/history", async (request) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  const query = request.query as { limit?: string; maxTransactions?: string };
  const artifact = await readContextManifest(runsDir, id);
  if (!artifact.walrus?.site) throw new Error("Run does not include a Walrus site.");
  return getWalrusSiteHistory(artifact.walrus.site, {
    limit: Math.min(Number(query.limit ?? 30) || 30, 100),
    maxTransactions: Math.min(Number(query.maxTransactions ?? 500) || 500, 2000)
  });
});

app.get("/api/walrus/history", async (request) => {
  const query = z
    .object({
      target: z.string().min(1),
      network: z.enum(["testnet", "mainnet"]).default("mainnet"),
      limit: z.string().optional(),
      maxTransactions: z.string().optional()
    })
    .parse(request.query);
  const site = await resolveWalrusTarget(query.target, { network: query.network as Network });
  return getWalrusSiteHistory(site, {
    limit: Math.min(Number(query.limit ?? 30) || 30, 100),
    maxTransactions: Math.min(Number(query.maxTransactions ?? 500) || 500, 2000)
  });
});

app.post("/api/runs/:id/diff", async (request) => {
  const id = (request.params as { id: string }).id;
  const auth = await requireRunAccess(request.headers.authorization, id);
  const body = z.object({ compareToRunId: z.string().optional() }).default({}).parse(request.body ?? {});
  if (body.compareToRunId) await requireRunAccess(request.headers.authorization, body.compareToRunId);
  const compareToRunId = body.compareToRunId ?? (await findOwnedPreviousRunId(auth.account.id, id));
  return diffRunSnapshots(runsDir, id, compareToRunId);
});

app.post("/api/runs/:id/visual-diff", async (request) => {
  const id = (request.params as { id: string }).id;
  const auth = await requireRunAccess(request.headers.authorization, id);
  const body = z.object({ compareToRunId: z.string().optional() }).default({}).parse(request.body ?? {});
  if (body.compareToRunId) await requireRunAccess(request.headers.authorization, body.compareToRunId);
  const compareToRunId = body.compareToRunId ?? (await findOwnedPreviousRunId(auth.account.id, id));
  const diff = await diffRunSnapshots(runsDir, id, compareToRunId);
  return buildVisualDiff(id, compareToRunId, diff.pages);
});

app.post("/api/runs/:id/ai-query", async (request) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  const datapoints = parseAiQueryDatapoints(request.body);
  const artifact = await readContextManifest(runsDir, id);
  const result = await aiQueryWebsite(artifact.target, datapoints, artifact.pages);
  artifact.aiQuery = result;
  await fs.writeFile(path.join(runsDir, id, "context", "manifest.json"), `${JSON.stringify(artifact, null, 2)}\n`);
  await fs.writeFile(path.join(runsDir, id, "context", "ai-query.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
});

app.get("/api/runs/:id/verify", async (request) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  return verifySnapshot(path.join(runsDir, id));
});

app.post("/api/runs/:id/memwal/remember", async (request) => {
  const id = (request.params as { id: string }).id;
  const auth = await requireRunAccess(request.headers.authorization, id);
  const memwal = memwalClientForAccount(auth.account);
  const input = z.object({ writeMode: z.enum(["delta", "full"]).default("delta") }).parse(request.body ?? {});
  const artifact = await readContextManifest(runsDir, id);
  const namespace = namespaceForArtifact(artifact);
  const chunks = await readRunChunks(runsDir, id);

  if (input.writeMode === "delta" && chunks.length) {
    const priorRunId = await findPriorRunForNamespace(runsDir, id, namespace);
    const priorChunks = priorRunId ? await readRunChunks(runsDir, priorRunId) : [];
    const snapshot = await readRunSnapshot(runsDir, id);
    const result = await memwal.rememberSnapshotDelta({
      namespace,
      target: artifact.target,
      createdAt: artifact.generatedAt,
      chunks,
      priorChunks,
      artifactDigest: snapshot?.artifactDigest,
      chunkGraphDigest: snapshot?.chunkGraphDigest
    });
    return { priorRunId, ...result };
  }

  const snapshot = siteSnapshotForArtifact(artifact, namespace);
  const result = await memwal.rememberSnapshot(snapshot);
  return { namespace, writeMode: "full", result };
});

app.post("/api/runs/:id/memwal/recall", async (request) => {
  const id = (request.params as { id: string }).id;
  const auth = await requireRunAccess(request.headers.authorization, id);
  const memwal = memwalClientForAccount(auth.account);
  const input = z.object({ query: z.string().min(1).default("latest ContextMeM snapshot") }).parse(request.body ?? {});
  const artifact = await readContextManifest(runsDir, id);
  const namespace = namespaceForArtifact(artifact);
  try {
    const result = await memwal.recallSiteContext(namespace, input.query);
    return { namespace, result };
  } catch (err) {
    if (!isMemWalUnavailableError(err)) throw err;
    request.log.warn({ err, runId: id, namespace }, "MemWal recall unavailable; serving local ContextMeM fallback");
    return localMemWalFallbackResponse(artifact, namespace, input.query, "recall", err);
  }
});

app.post("/api/runs/:id/memwal/query", async (request) => {
  const id = (request.params as { id: string }).id;
  const auth = await requireRunAccess(request.headers.authorization, id);
  const memwal = memwalClientForAccount(auth.account);
  const input = z.object({ query: z.string().min(1) }).parse(request.body ?? {});
  const artifact = await readContextManifest(runsDir, id);
  const namespace = namespaceForArtifact(artifact);
  try {
    const result = await memwal.analyzeSiteMemory(namespace, input.query);
    return { namespace, result };
  } catch (err) {
    if (!isMemWalUnavailableError(err)) throw err;
    request.log.warn({ err, runId: id, namespace }, "MemWal query unavailable; serving local ContextMeM fallback");
    return localMemWalFallbackResponse(artifact, namespace, input.query, "query", err);
  }
});

app.post("/api/runs/:id/walrus/preview", async (request) => {
  const id = (request.params as { id: string }).id;
  await requireRunAccess(request.headers.authorization, id);
  const siteDir = path.join(runsDir, id, "site");
  const preview = await startWalrusPreview(siteDir, { port: 0 });
  return { url: preview.url };
});

function serializeMe(account: AccountRecord, quota: QuotaState) {
  const hasDelegateKey = Boolean(account.delegateKeyCiphertext && account.memwalAccountId);
  const accountQuota = hasDelegateKey ? { ...quota, remaining: Number.MAX_SAFE_INTEGER, unlimited: true } : quota;
  return {
    authenticated: true,
    account: publicAccount(account),
    quota: accountQuota,
    access: {
      canPreview: true,
      canRun: hasDelegateKey,
      reason: hasDelegateKey ? "Ready to build Walrus context." : "Import MemWal SDK credentials before building context."
    }
  };
}

async function extensionActivation(_request: FastifyRequest, reply: FastifyReply) {
  reply.header("cache-control", "no-store");
  return {
    ok: true,
    active: true,
    service: "contextmem",
    apiBase: publicApiUrl("/"),
    auth: {
      storageKey: "contextmem.session",
      header: "Authorization: Bearer <token>",
      tokenEndpoint: "/api/ext/auth-token"
    },
    capabilities: ["runs", "artifact-files", "walrus-history", "memwal-memory"]
  };
}

async function extensionAuthToken(request: FastifyRequest, reply: FastifyReply) {
  reply.header("cache-control", "no-store");
  const bearer = readBearerToken(request.headers.authorization);
  const auth = await getOptionalAuth(request.headers.authorization);

  return {
    ok: true,
    authenticated: Boolean(auth),
    token: auth && bearer ? bearer : "",
    tokenType: "bearer",
    storageKey: "contextmem.session",
    me: auth ? serializeMe(auth.account, auth.quota) : null,
    message: auth ? "Bearer token is valid for ContextMeM API requests." : "No ContextMeM bearer token was provided. Read contextmem.session from this origin, then call this endpoint with Authorization."
  };
}

async function getOptionalAuth(authorization?: string): Promise<AuthContext | undefined> {
  const token = readBearerToken(authorization);
  if (!token) return undefined;
  const session = await accountStore.getSession(token);
  if (!session) return undefined;
  const account = await accountStore.getAccount(session.accountId);
  if (!account) return undefined;
  return { account, quota: await accountStore.getQuota(account.id) };
}

async function requireAuth(authorization?: string): Promise<AuthContext> {
  const auth = await getOptionalAuth(authorization);
  if (!auth) return unauthorized("Import MemWal SDK credentials to unlock ContextMeM.");
  return auth;
}

async function requireRunAccess(authorization: string | undefined, runId: string): Promise<AuthContext> {
  const auth = await requireAuth(authorization);
  const owner = await accountStore.getRunOwner(runId);
  if (owner !== auth.account.id) {
    return forbidden("This run belongs to another account or predates account-scoped storage.");
  }
  return auth;
}

function requireMemWalDelegate(account: AccountRecord): void {
  if (!account.memwalAccountId || !account.delegateKeyCiphertext) {
    forbidden("Import MemWal SDK credentials before building context.");
  }
}

function memwalClientForAccount(account: AccountRecord): MemWalMcpClient {
  requireMemWalDelegate(account);
  return new MemWalMcpClient({
    accountId: account.memwalAccountId,
    authorization: `Bearer ${decryptSecret(account.delegateKeyCiphertext!, accountSecret)}`
  });
}

async function hostedWorkerJson(pathname: string, init: RequestInit = {}): Promise<unknown> {
  if (!hostedApiUrl || !hostedImportToken) {
    return badRequest("Hosted namespace import is not configured. Set CONTEXTMEM_HOSTED_API_URL and CONTEXTMEM_HOSTED_IMPORT_TOKEN.");
  }
  return publicHostedWorkerJson(pathname, {
    ...init,
    headers: {
      authorization: `Bearer ${hostedImportToken}`,
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

async function publicHostedWorkerJson(pathname: string, init: RequestInit = {}): Promise<unknown> {
  const response = await publicHostedWorkerResponse(pathname, init);
  if (!response.ok) statusError(`Hosted namespace request failed (${response.status}): ${await response.text()}`, response.status);
  return response.json();
}

async function publicHostedWorkerResponse(pathname: string, init: RequestInit = {}): Promise<Response> {
  if (!hostedApiUrl) {
    return badRequest("Hosted namespace API is not configured. Set CONTEXTMEM_HOSTED_API_URL.");
  }
  return fetch(new URL(pathname, hostedApiUrl).toString(), init);
}

function namespaceForArtifact(artifact: WalrusPackageManifest): string {
  return namespaceForTarget(artifact.target, artifact.walrus ? "walrus" : "web", artifact.walrus?.site?.network, artifact.walrus?.site?.siteObjectId);
}

function displayNameFromTarget(target: string): string {
  try {
    return new URL(target).hostname.replace(/^www\./, "");
  } catch {
    return target.slice(0, 80);
  }
}

function notFoundOgSvg(shareId: string): string {
  const id = svgText(shareId.slice(0, 80));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" role="img">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0f172a"/>
      <stop offset="1" stop-color="#1e293b"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <rect x="40" y="40" width="1120" height="550" rx="28" fill="none" stroke="#334155" stroke-width="2"/>
  <text x="80" y="120" fill="#94a3b8" font-family="ui-monospace,Menlo,monospace" font-size="20" letter-spacing="6">CONTEXTMEM SHARE</text>
  <text x="80" y="260" fill="#f8fafc" font-family="Inter,system-ui,sans-serif" font-size="60" font-weight="700">Share link not found</text>
  <text x="80" y="340" fill="#cbd5f5" font-family="Inter,system-ui,sans-serif" font-size="26">${id}</text>
  <text x="80" y="565" fill="#475569" font-family="Inter,system-ui,sans-serif" font-size="20">Create or open a valid ContextMeM share id first.</text>
</svg>`;
}

function svgText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function collectHostedNamespaceFiles(runDir: string): Promise<Array<{ path: string; contentType: string; encoding: "utf8"; content: string }>> {
  const maxFileBytes = 2 * 1024 * 1024;
  const textKinds = new Set(["json", "markdown", "html", "css", "text"]);
  const files = await listArtifactFiles(runDir);
  const selected = files.filter((file) => file.previewable && textKinds.has(file.kind) && file.size <= maxFileBytes);
  const payload: Array<{ path: string; contentType: string; encoding: "utf8"; content: string }> = [];
  for (const file of selected) {
    const { absolutePath, record } = await resolveArtifactFile(runDir, file.path);
    payload.push({
      path: record.path,
      contentType: record.contentType,
      encoding: "utf8",
      content: await fs.readFile(absolutePath, "utf8")
    });
  }
  return payload;
}

async function buildVisualDiff(runId: string, compareToRunId: string | undefined, pageEntries: SiteSnapshotDiffEntry[]): Promise<VisualDiff> {
  const current = await readContextManifest(runsDir, runId);
  const previous = compareToRunId ? await readContextManifest(runsDir, compareToRunId).catch(() => undefined) : undefined;
  const beforeScreenshots = mapScreenshots(previous?.screenshots ?? []);
  const afterScreenshots = mapScreenshots(current.screenshots ?? []);
  return {
    baseRunId: runId,
    compareRunId: compareToRunId,
    generatedAt: new Date().toISOString(),
    pages: pageEntries.map((entry) => {
      const beforePage = asPageArtifact(entry.before);
      const afterPage = asPageArtifact(entry.after);
      const routePath = afterPage?.routePath ?? beforePage?.routePath ?? entry.key;
      const beforeScreenshot = screenshotForPage(beforeScreenshots, routePath, beforePage?.url);
      const afterScreenshot = screenshotForPage(afterScreenshots, routePath, afterPage?.url);
      return {
        routePath,
        status: entry.status,
        beforeScreenshot: beforeScreenshot?.path,
        afterScreenshot: afterScreenshot?.path,
        boxes: diffBoxes(entry.status, beforeScreenshot, afterScreenshot),
        markdownDiff: markdownLineDiff(beforePage?.markdown, afterPage?.markdown)
      };
    })
  };
}

function mapScreenshots(screenshots: ScreenshotArtifact[]): Map<string, ScreenshotArtifact> {
  const map = new Map<string, ScreenshotArtifact>();
  for (const screenshot of screenshots) {
    if (screenshot.routePath) map.set(`route:${screenshot.routePath}`, screenshot);
    map.set(`url:${screenshot.url}`, screenshot);
  }
  return map;
}

function screenshotForPage(map: Map<string, ScreenshotArtifact>, routePath: string, url?: string): ScreenshotArtifact | undefined {
  return map.get(`route:${routePath}`) ?? (url ? map.get(`url:${url}`) : undefined);
}

function diffBoxes(status: SiteSnapshotDiffEntry["status"], before?: ScreenshotArtifact, after?: ScreenshotArtifact): VisualDiff["pages"][number]["boxes"] {
  if (status === "unchanged") return [];
  const screenshot = after ?? before;
  if (!screenshot?.path) return [];
  return [
    {
      x: 0,
      y: 0,
      width: screenshot.width,
      height: screenshot.height,
      label: status === "added" ? "New page snapshot" : status === "removed" ? "Removed page snapshot" : "Changed page snapshot",
      tone: status
    }
  ];
}

function markdownLineDiff(before?: string, after?: string): VisualDiff["pages"][number]["markdownDiff"] | undefined {
  if (before === after) return undefined;
  const beforeLines = lineSet(before);
  const afterLines = lineSet(after);
  const added = [...afterLines].filter((line) => !beforeLines.has(line)).slice(0, 12);
  const removed = [...beforeLines].filter((line) => !afterLines.has(line)).slice(0, 12);
  if (!added.length && !removed.length) return undefined;
  return { added, removed };
}

function lineSet(value?: string): Set<string> {
  return new Set(
    (value ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  );
}

function asPageArtifact(value: unknown): PageArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<PageArtifact>;
  return typeof candidate.url === "string" && typeof candidate.markdown === "string" ? (candidate as PageArtifact) : undefined;
}

function siteSnapshotForArtifact(artifact: WalrusPackageManifest, namespace = namespaceForArtifact(artifact)): SiteSnapshot {
  const snapshot: SiteSnapshot = {
    namespace,
    target: artifact.target,
    createdAt: artifact.generatedAt ?? new Date().toISOString(),
    summary: "",
    pages: artifact.pages,
    brand: artifact.brand,
    styleguide: artifact.styleguide,
    designSystem: artifact.designSystem,
    aiQuery: artifact.aiQuery,
    walrus: artifact.walrus
  };
  snapshot.summary = summarizeSnapshot(snapshot);
  return snapshot;
}

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localMemWalFallbackResponse(artifact: WalrusPackageManifest, namespace: string, query: string, kind: "recall" | "query", err: unknown) {
  const snapshot = siteSnapshotForArtifact(artifact, namespace);
  const pages = artifact.pages ?? [];
  const images = artifact.images ?? [];
  const resources = artifact.walrus?.resources ?? [];
  const colorCount = artifact.designSystem?.tokens.colors.length ?? artifact.styleguide?.colors.palette.length ?? 0;
  const topPages = pages.slice(0, 5).map((page) => page.title || page.routePath || page.url);
  const topResources = resources.slice(0, 5).map((resource) => resource.path || resource.blobId || resource.blobHash).filter(Boolean);
  const verb = kind === "recall" ? "recall prior MemWal memory" : "query MemWal memory";
  const answer = [
    `I could not ${verb} because the MemWal MCP service is not reachable from the ContextMeM API right now.`,
    "I used the active local ContextMeM package instead, so you can keep working from this run.",
    "",
    snapshot.summary,
    "",
    topPages.length ? `Important pages in this package:\n${topPages.map((page) => `- ${page}`).join("\n")}` : "No pages were captured in this package.",
    topResources.length ? `Walrus resources sampled:\n${topResources.map((resource) => `- ${resource}`).join("\n")}` : undefined,
    "",
    "Suggested agent memory:",
    `- Namespace: ${namespace}`,
    `- Target: ${artifact.target}`,
    `- Current package has ${pages.length} pages, ${resources.length} Walrus resources, ${images.length} images, and ${colorCount} color tokens.`,
    `- Original question: ${query}`
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n");

  const fallback = {
    namespace,
    degraded: true,
    source: "local-context-package",
    reason: "memwal-mcp-unavailable",
    cause: err instanceof Error ? err.message : String(err),
    answer,
    packageSummary: {
      runId: artifact.runId,
      target: artifact.target,
      generatedAt: artifact.generatedAt,
      pages: pages.length,
      images: images.length,
      walrusResources: resources.length,
      colorTokens: colorCount,
      sampledPages: topPages,
      sampledResources: topResources
    }
  };

  return {
    result: fallback,
    ...fallback
  };
}

function isMemWalUnavailableError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /unable to connect|fetch failed|network|ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|terminated|MCP HTTP (502|503|504)/i.test(message);
}

type LocalMemWalCredentials =
  | {
      status: "ready";
      credentials: {
        accountId: string;
        delegatePrivateKey: string;
        walletAddress?: string;
        delegateAddress?: string;
        relayerUrl?: string;
      };
    }
  | {
      status: "credentials-missing" | "credentials-invalid";
      message: string;
    };

async function readLocalMemWalCredentials(): Promise<LocalMemWalCredentials> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(memwalCredentialsPath, "utf8")) as unknown;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return {
        status: "credentials-missing",
        message: `No local MemWal MCP credentials found at ${memwalCredentialsPath}.`
      };
    }
    return {
      status: "credentials-invalid",
      message: `Could not read local MemWal MCP credentials at ${memwalCredentialsPath}.`
    };
  }

  if (!raw || typeof raw !== "object") {
    return {
      status: "credentials-invalid",
      message: `Local MemWal MCP credentials at ${memwalCredentialsPath} are not a JSON object.`
    };
  }

  const record = raw as Record<string, unknown>;
  const account = typeof record.account === "object" && record.account ? (record.account as Record<string, unknown>) : {};
  const accountId = firstString(record.accountId, record.account_id, record.memwalAccountId, record.memwal_account_id, account.id);
  const delegatePrivateKey = normalizeDelegateSecret(
    firstString(record.delegatePrivateKey, record.delegateKey, record.delegate_key, record.privateKey, record.private_key, record.authorization, record.bearer, record.token) ?? ""
  );

  if (!accountId || delegatePrivateKey.length < 12) {
    return {
      status: "credentials-invalid",
      message: `Local MemWal MCP credentials at ${memwalCredentialsPath} are missing accountId or delegatePrivateKey.`
    };
  }

  return {
    status: "ready",
    credentials: {
      accountId,
      delegatePrivateKey,
      walletAddress: firstString(record.walletAddress, record.wallet_address, record.ownerAddress, record.owner),
      delegateAddress: firstString(record.delegateAddress, record.delegate_address),
      relayerUrl: firstString(record.relayerUrl, record.relayer_url)
    }
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function normalizeDelegateSecret(value: string): string {
  return value.replace(/^Bearer\s+/i, "").trim();
}

function sameSuiAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function compactAddress(address: string): string {
  const value = address.trim();
  if (value.length <= 16) return value;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

async function findOwnedPreviousRunId(accountId: string, runId: string): Promise<string | undefined> {
  const owned = new Set((await accountStore.listOwnedRunIds(accountId)).filter((id) => id !== runId));
  const current = await readRunManifest(runsDir, runId);
  const runs = await listRuns(runsDir, 500);
  return runs.find((item) => owned.has(item.runId) && item.namespace === current.namespace && Date.parse(item.updatedAt) < Date.parse(current.updatedAt))?.runId;
}

function readBearerToken(authorization?: string): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1];
}

function cryptoRandomId(): string {
  return crypto.randomUUID();
}

function unauthorized(message: string): never {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 401;
  throw error;
}

function forbidden(message: string): never {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 403;
  throw error;
}

function badRequest(message: string): never {
  statusError(message, 400);
}

function statusError(message: string, statusCode: number): never {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  throw error;
}

function normalizeRunOutputs(buildProfile: BuildProfile, requested?: string[]): string[] {
  const base = requested?.length ? requested : buildProfileOutputs[buildProfile];
  const normalized = [...new Set(base.map((output) => output.trim()).filter(Boolean))];
  return normalized.length ? normalized : buildProfileOutputs[buildProfile];
}

function emptyRunCacheStats(): RunCacheStats {
  return {
    hits: 0,
    misses: 0,
    writes: 0,
    bytesRead: 0,
    bytesWritten: 0
  };
}

async function measureRunTiming<T>(timings: Record<string, number>, key: string, fn: () => T | Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings[key] = (timings[key] ?? 0) + Date.now() - started;
  }
}

function prefixTimings(prefix: string, timings: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(timings).map(([key, value]) => [`${prefix}.${key}`, value]));
}

async function writeRunManifest(artifactDir: string, manifest: RunManifest): Promise<void> {
  await fs.writeFile(path.join(artifactDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function findWorkspaceRoot(startDir: string): string {
  let current = startDir;
  while (true) {
    try {
      const packageJson = JSON.parse(readFileSync(path.join(current, "package.json"), "utf8")) as { workspaces?: unknown };
      if (packageJson.workspaces) return current;
    } catch {
      // Keep walking.
    }
    const parent = path.dirname(current);
    if (parent === current) return startDir;
    current = parent;
  }
}

function expandHomePath(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

function publicApiUrl(pathname: string): string {
  const base = process.env.CONTEXTMEM_PUBLIC_API_URL ?? `http://localhost:${process.env.CONTEXTMEM_API_PORT ?? 8791}`;
  return new URL(pathname, base).toString();
}

const aiDatapointSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  type: z.enum(["text", "number", "boolean", "list", "object"]).default("text"),
  example: z.unknown().optional()
});

function parseAiQueryDatapoints(body: unknown): AiDatapoint[] {
  const input = z
    .object({
      question: z.string().optional(),
      datapoints: z.array(aiDatapointSchema).optional(),
      schema: z.union([z.array(aiDatapointSchema), z.record(z.string(), z.unknown())]).optional()
    })
    .parse(body);

  if (input.datapoints?.length) return input.datapoints;
  if (Array.isArray(input.schema) && input.schema.length) return input.schema;

  if (input.schema && !Array.isArray(input.schema)) {
    const datapoints = Object.entries(input.schema).map(([name, raw]) => {
      const normalized = normalizeAiSchemaValue(raw);
      const description = [input.question, normalized.description || undefined].filter(Boolean).join("\n");
      return {
        name,
        description: description || `Extract ${name}`,
        type: normalized.type
      } satisfies AiDatapoint;
    });
    if (datapoints.length) return datapoints;
  }

  if (input.question) {
    return [{ name: "answer", description: input.question, type: "text" }];
  }

  throw new Error("AI query requires datapoints, schema, or question.");
}

function normalizeAiSchemaValue(raw: unknown): Pick<AiDatapoint, "description" | "type"> {
  if (typeof raw === "string") return { description: "", type: normalizeAiType(raw) };
  if (raw && typeof raw === "object") {
    const value = raw as { description?: unknown; type?: unknown };
    return {
      description: typeof value.description === "string" ? value.description : "",
      type: normalizeAiType(typeof value.type === "string" ? value.type : undefined)
    };
  }
  return { description: "", type: "text" };
}

function normalizeAiType(value = "text"): AiDatapoint["type"] {
  if (value === "string") return "text";
  if (value === "array") return "list";
  if (["text", "number", "boolean", "list", "object"].includes(value)) return value as AiDatapoint["type"];
  return "text";
}

const port = Number(process.env.CONTEXTMEM_API_PORT ?? 8791);
await app.listen({ port, host: "0.0.0.0" });
