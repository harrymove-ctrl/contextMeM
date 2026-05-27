import type { AiQueryResult, BrandProfile, DesignSystem, PageArtifact, Styleguide, WalrusResourceRecord, WalrusSiteContext } from "@contextmem/core";

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

type JsonRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id?: string | number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

export class MemWalMcpClient {
  private sessionId?: string;
  private readonly url: string;
  private readonly authorization?: string;
  private readonly accountId?: string;

  constructor(config: MemWalConfig = {}) {
    this.url = config.url ?? process.env.MEMWAL_MCP_URL ?? "http://localhost:3005/api/mcp";
    if (!config.authorization && !process.env.MEMWAL_AUTHORIZATION && process.env.MEMWAL_BEARER) {
      console.warn("[contextmem/memwal] MEMWAL_BEARER is deprecated. Set MEMWAL_AUTHORIZATION=\"Bearer <key>\" instead.");
    }
    this.authorization = config.authorization ?? process.env.MEMWAL_AUTHORIZATION ?? (process.env.MEMWAL_BEARER ? `Bearer ${process.env.MEMWAL_BEARER}` : undefined);
    this.accountId = config.accountId ?? process.env.MEMWAL_ACCOUNT_ID;
  }

  async initialize(): Promise<void> {
    if (this.sessionId) return;
    const response = await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "contextmem",
        version: "0.1.0"
      }
    });
    void response;
  }

  async callTool<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
    await this.initialize();
    const response = await this.rpc<T>("tools/call", {
      name,
      arguments: args
    });
    return response;
  }

  async rememberSnapshot(snapshot: SiteSnapshot): Promise<unknown> {
    return this.callTool("memwal_remember", {
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

  async recallSiteContext(namespace: string, query: string): Promise<unknown> {
    return this.callTool("memwal_recall", {
      namespace,
      query
    });
  }

  async analyzeSiteMemory(namespace: string, query: string): Promise<unknown> {
    return this.callTool("memwal_analyze", {
      namespace,
      query
    });
  }

  async restoreSiteMemory(namespace: string): Promise<unknown> {
    return this.callTool("memwal_restore", {
      namespace
    });
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const response = await fetch(this.url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params
      })
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) this.sessionId = sessionId;
    if (!response.ok) {
      throw new Error(`MemWal MCP HTTP ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as JsonRpcResponse<T>;
    if (payload.error) throw new Error(`MemWal MCP ${payload.error.code}: ${payload.error.message}`);
    return payload.result as T;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    };
    if (this.authorization) headers.authorization = this.authorization;
    if (this.accountId) headers["x-memwal-account-id"] = this.accountId;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }
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
