// Experimental: direct MemWal SDK transport.
//
// The default transport is MCP-over-HTTP (MemWalMcpClient). This file scaffolds
// an alternative transport that delegates to the official @memwal/sdk package
// when it is installed at runtime. It implements the same surface as
// MemWalMcpClient so call sites can swap transports without further changes.
//
// The package import is lazy + dynamic on purpose: the SDK is not a hard
// dependency of @contextmem/memwal, so installs that only need the MCP bridge
// keep working with zero extra packages. If the SDK is missing at runtime the
// transport throws a clear, actionable error pointing at the install command.

import type {
  RememberDeltaInput,
  RememberDeltaResult,
  SiteSnapshot
} from "./index.js";

export type MemWalSdkConfig = {
  apiUrl?: string;
  apiKey?: string;
  accountId?: string;
};

type SdkLike = {
  remember(args: { namespace: string; content: string; metadata?: Record<string, unknown> }): Promise<unknown>;
  recall(args: { namespace: string; query: string; limit?: number }): Promise<unknown>;
  analyze(args: { namespace: string; query: string }): Promise<unknown>;
  restore(args: { namespace: string; limit?: number }): Promise<unknown>;
};

export type MemWalSdkPackage = {
  createClient(config: { apiUrl?: string; apiKey?: string; accountId?: string }): SdkLike;
};

let cachedSdk: MemWalSdkPackage | null | undefined;

async function loadSdk(): Promise<MemWalSdkPackage> {
  if (cachedSdk === undefined) {
    try {
      // The exact entrypoint name follows MemWal's published package; adjust
      // once the SDK ships its public API. Until then this stays scaffolded.
      const moduleName = "@memwal/sdk";
      cachedSdk = (await import(/* @vite-ignore */ moduleName)) as MemWalSdkPackage;
    } catch {
      cachedSdk = null;
    }
  }
  if (!cachedSdk) {
    throw new Error(
      "MemWal SDK transport requested but @memwal/sdk is not installed. " +
        "Run `bun add @memwal/sdk` (or set MEMWAL_TRANSPORT=mcp to use the default MCP bridge)."
    );
  }
  return cachedSdk;
}

export class MemWalSdkClient {
  private readonly config: MemWalSdkConfig;
  private client?: SdkLike;

  constructor(config: MemWalSdkConfig = {}) {
    this.config = {
      apiUrl: config.apiUrl ?? process.env.MEMWAL_API_URL,
      apiKey: config.apiKey ?? process.env.MEMWAL_API_KEY ?? process.env.MEMWAL_AUTHORIZATION?.replace(/^Bearer\s+/i, ""),
      accountId: config.accountId ?? process.env.MEMWAL_ACCOUNT_ID
    };
  }

  private async ensureClient(): Promise<SdkLike> {
    if (this.client) return this.client;
    const sdk = await loadSdk();
    this.client = sdk.createClient(this.config);
    return this.client;
  }

  async rememberSnapshot(snapshot: SiteSnapshot): Promise<unknown> {
    const client = await this.ensureClient();
    return client.remember({
      namespace: snapshot.namespace,
      content: JSON.stringify(snapshot),
      metadata: {
        target: snapshot.target,
        createdAt: snapshot.createdAt,
        pageCount: snapshot.pages?.length ?? 0,
        resourceCount: snapshot.walrus?.resources.length ?? 0
      }
    });
  }

  async rememberSnapshotDelta(input: RememberDeltaInput): Promise<RememberDeltaResult> {
    const client = await this.ensureClient();
    const results: unknown[] = [];
    for (const chunk of [...input.chunks]) {
      results.push(
        await client.remember({
          namespace: input.namespace,
          content: chunk.text,
          metadata: {
            kind: "chunk",
            chunkId: chunk.chunkId,
            routePath: chunk.routePath,
            heading: chunk.heading,
            headingPath: chunk.headingPath,
            contentHash: chunk.contentHash
          }
        })
      );
    }
    return {
      namespace: input.namespace,
      writeMode: "delta",
      written: input.chunks.length,
      added: input.chunks.length,
      changed: 0,
      skipped: 0,
      removed: 0,
      results
    };
  }

  async recallSiteContext(namespace: string, query: string): Promise<unknown> {
    const client = await this.ensureClient();
    return client.recall({ namespace, query });
  }

  async analyzeSiteMemory(namespace: string, query: string): Promise<unknown> {
    const client = await this.ensureClient();
    return client.analyze({ namespace, query });
  }

  async restoreSiteMemory(namespace: string): Promise<unknown> {
    const client = await this.ensureClient();
    return client.restore({ namespace });
  }
}

export function selectMemWalTransport(transport: "mcp" | "sdk" | "auto" = "auto"): "mcp" | "sdk" {
  if (transport === "mcp" || transport === "sdk") return transport;
  const env = (process.env.MEMWAL_TRANSPORT ?? "").toLowerCase();
  if (env === "sdk") return "sdk";
  return "mcp";
}
