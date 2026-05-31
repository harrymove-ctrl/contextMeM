import type { AiQueryResult, BrandProfile, ContextChunk, DesignSystem, MemoryWritePlan, PageArtifact, Styleguide, WalrusResourceRecord, WalrusSiteContext } from "@contextmem/core";
import { planMemoryWrite } from "@contextmem/core/chunks";
import { MemWal } from "@mysten-incubation/memwal";

export type MemWalConfig = {
  url?: string;
  authorization?: string;
  accountId?: string;
};

export type SiteSnapshot = {
  namespace: string;
  target: string;
  createdAt: string;
  summary: string;
  pages?: PageArtifact[];
  brand?: BrandProfile;
  styleguide?: Styleguide;
  designSystem?: DesignSystem;
  aiQuery?: AiQueryResult;
  walrus?: {
    site: WalrusSiteContext;
    resources: WalrusResourceRecord[];
  };
};

export type RememberDeltaInput = {
  namespace: string;
  target: string;
  createdAt: string;
  chunks: ContextChunk[];
  priorChunks?: ContextChunk[];
  artifactDigest?: string;
  chunkGraphDigest?: string;
};

export type RememberDeltaResult = {
  namespace: string;
  writeMode: "full" | "delta";
  written: number;
  added: number;
  changed: number;
  skipped: number;
  removed: number;
  results: unknown[];
};

type JsonRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id?: string | number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

// Backed by the official @mysten-incubation/memwal SDK. The class name and
// public method shape are kept for callers (CLI + Worker), but under the hood
// every call goes through MemWal.create() — which handles Ed25519-signed
// requests against the relayer at MEMWAL_API_URL (default
// https://relayer.memwal.ai/, override to https://relayer.staging.memwal.ai
// for staging). The bridge no longer speaks raw MCP JSON-RPC.
//
// MemWalConfig fields:
//   url           — accepted for back-compat; mapped to the SDK's serverUrl
//   authorization — DEPRECATED, ignored (SDK signs locally)
//   accountId     — MemWal account object ID
// Auth is sourced from MEMWAL_PRIVATE_KEY (raw Ed25519 hex seed) by default;
// callers can also pass it via MemWalConfig.privateKey.

export class MemWalMcpClient {
  private readonly accountId: string;
  private readonly privateKey: string;
  private readonly serverUrl: string;
  private clientCache = new Map<string, MemWal>();

  constructor(config: MemWalConfig & { privateKey?: string } = {}) {
    const accountId = config.accountId ?? process.env.MEMWAL_ACCOUNT_ID;
    const privateKey = config.privateKey ?? process.env.MEMWAL_PRIVATE_KEY ?? extractKeyFromAuthorization(config.authorization ?? process.env.MEMWAL_AUTHORIZATION);
    const serverUrl = config.url ?? process.env.MEMWAL_API_URL ?? process.env.MEMWAL_MCP_URL ?? "https://relayer.memwal.ai/";
    if (!accountId) throw new Error("MEMWAL_ACCOUNT_ID is not configured.");
    if (!privateKey) throw new Error("MEMWAL_PRIVATE_KEY (Ed25519 hex seed) is not configured. The Bearer-token bridge is no longer supported; the relayer requires Ed25519 signed requests.");
    this.accountId = accountId;
    this.privateKey = privateKey;
    this.serverUrl = stripMcpPath(serverUrl);
  }

  private client(namespace: string): MemWal {
    let client = this.clientCache.get(namespace);
    if (!client) {
      client = MemWal.create({ key: this.privateKey, accountId: this.accountId, serverUrl: this.serverUrl, namespace });
      this.clientCache.set(namespace, client);
    }
    return client;
  }

  async initialize(): Promise<void> {
    // Kept for back-compat with the old MCP bridge surface; the SDK has no
    // initialize step — it builds a SessionKey lazily on first use.
  }

  async rememberSnapshot(snapshot: SiteSnapshot): Promise<unknown> {
    const sdk = this.client(snapshot.namespace);
    const text = renderSnapshotPayload(snapshot);
    const accepted = await sdk.rememberAsync(text);
    const completed = await sdk.waitForRememberJob(accepted.job_id).catch(() => accepted);
    return { namespace: snapshot.namespace, ...accepted, completed };
  }

  /**
   * Change-aware write: only persists chunks that were added or edited since
   * the prior snapshot, plus a snapshot-index memory. Saves bandwidth on
   * scheduled re-scrapes. Each chunk's identity (chunkId, routePath, heading,
   * contentHash) is encoded into the text content itself since the SDK's
   * remember(text) takes a single string — no separate metadata channel.
   */
  async rememberSnapshotDelta(input: RememberDeltaInput): Promise<RememberDeltaResult> {
    const plan = planMemoryWrite(input.chunks, input.priorChunks ?? []);
    const toWrite = [...plan.added, ...plan.changed];
    const sdk = this.client(input.namespace);
    const results: unknown[] = [];
    for (const chunk of toWrite) {
      const text = encodeChunkPayload(chunk);
      const accepted = await sdk.rememberAsync(text);
      results.push(accepted);
    }
    const indexText = renderSnapshotIndex(input);
    const acceptedIndex = await sdk.rememberAsync(indexText);
    results.push(acceptedIndex);
    return {
      namespace: input.namespace,
      writeMode: "delta",
      written: toWrite.length,
      added: plan.added.length,
      changed: plan.changed.length,
      skipped: plan.unchanged.length,
      removed: plan.removed.length,
      results
    };
  }

  async recallSiteContext(namespace: string, query: string): Promise<unknown> {
    return this.client(namespace).recall({ query });
  }

  async analyzeSiteMemory(namespace: string, query: string): Promise<unknown> {
    // SDK ships an analyze path; some staging deployments still report it as
    // unsupported, so fall back to recall when analyze 4xxs.
    const sdk = this.client(namespace);
    const anyClient = sdk as unknown as { analyze?: (args: { query: string }) => Promise<unknown> };
    if (typeof anyClient.analyze === "function") {
      try {
        return await anyClient.analyze({ query });
      } catch {
        // fall through
      }
    }
    return sdk.recall({ query });
  }

  async restoreSiteMemory(namespace: string, limit?: number): Promise<unknown> {
    const sdk = this.client(namespace);
    const anyClient = sdk as unknown as { restore?: (namespace: string, limit?: number) => Promise<unknown> };
    if (typeof anyClient.restore === "function") return anyClient.restore(namespace, limit);
    throw new Error("MemWal SDK does not expose a restore method on this version.");
  }
}

function extractKeyFromAuthorization(value?: string): string | undefined {
  if (!value) return undefined;
  return value.replace(/^Bearer\s+/i, "").trim() || undefined;
}

function stripMcpPath(url: string): string {
  // The SDK's serverUrl is the relayer base, not the /api/mcp JSON-RPC route.
  return url.replace(/\/?api\/mcp\/?$/, "").replace(/\/$/, "");
}

function renderSnapshotPayload(snapshot: SiteSnapshot): string {
  return [
    `# ContextMeM snapshot`,
    `target: ${snapshot.target}`,
    `createdAt: ${snapshot.createdAt}`,
    `pages: ${snapshot.pages?.length ?? 0}`,
    `walrusResources: ${snapshot.walrus?.resources.length ?? 0}`,
    "",
    "## summary",
    snapshot.summary,
    "",
    "## payload",
    JSON.stringify(snapshot)
  ].join("\n");
}

function encodeChunkPayload(chunk: ContextChunk): string {
  const header = JSON.stringify({
    kind: "chunk",
    chunkId: chunk.chunkId,
    routePath: chunk.routePath,
    heading: chunk.heading,
    headingPath: chunk.headingPath,
    contentHash: chunk.contentHash
  });
  return `[ctxm-chunk] ${header}\n\n${chunk.text}`;
}

function renderSnapshotIndex(input: RememberDeltaInput): string {
  return [
    `ContextMeM snapshot index for ${input.target}`,
    `Captured: ${input.createdAt}`,
    `Chunks: ${input.chunks.length}`,
    input.artifactDigest ? `artifactDigest: ${input.artifactDigest}` : undefined,
    input.chunkGraphDigest ? `chunkGraphDigest: ${input.chunkGraphDigest}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

export function summarizeSnapshot(snapshot: SiteSnapshot): string {
  const parts = [
    `Target: ${snapshot.target}`,
    `Pages: ${snapshot.pages?.length ?? 0}`,
    `Walrus resources: ${snapshot.walrus?.resources.length ?? 0}`,
    snapshot.brand?.name ? `Brand: ${snapshot.brand.name}` : undefined,
    snapshot.styleguide?.colors.palette.length ? `Colors: ${snapshot.styleguide.colors.palette.slice(0, 8).join(", ")}` : undefined,
    snapshot.designSystem?.components.length ? `Design components: ${snapshot.designSystem.components.map((component) => component.type).slice(0, 8).join(", ")}` : undefined
  ].filter(Boolean);
  return parts.join("\n");
}

export { MemWalSdkClient, selectMemWalTransport, type MemWalSdkConfig, type MemWalSdkPackage } from "./sdk.js";
