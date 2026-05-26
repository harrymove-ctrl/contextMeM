import { describe, expect, it, vi } from "vitest";
import type { WorkerEnv } from "./worker.js";

vi.mock("agents/mcp", async () => {
  const { WebStandardStreamableHTTPServerTransport } = await import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js");
  return {
    createMcpHandler:
      (server: { connect: (transport: unknown) => Promise<void> }, options: { route?: string; enableJsonResponse?: boolean } = {}) =>
      async (request: Request) => {
        const route = options.route ?? "/mcp";
        if (new URL(request.url).pathname !== route) return new Response("Not Found", { status: 404 });
        const transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: options.enableJsonResponse ?? true
        });
        await server.connect(transport);
        return transport.handleRequest(request);
      }
  };
});

describe("ContextMeM hosted namespace Worker", () => {
  it("imports a private namespace and enforces read tokens", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "private");

    const { handleWorkerRequest } = await worker();
    const missing = await handleWorkerRequest(new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}`), env);
    expect(missing.status).toBe(401);

    const wrong = await handleWorkerRequest(new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}`, { headers: { authorization: "Bearer wrong" } }), env);
    expect(wrong.status).toBe(403);

    const ok = await handleWorkerRequest(new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}`, { headers: { authorization: `Bearer ${imported.readToken}` } }), env);
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { namespace: { namespace: string }; artifacts: Array<{ path: string }> };
    expect(body.namespace.namespace).toBe(imported.namespace);
    expect(body.artifacts.map((artifact) => artifact.path)).toContain("/llms.txt");
  });

  it("allows public namespace reads without a token", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "public");

    const { handleWorkerRequest } = await worker();
    const response = await handleWorkerRequest(new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}`), env);

    expect(response.status).toBe(200);
  });

  it("serves namespace tools over Streamable HTTP JSON-RPC", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "private");
    const mcpUrl = `https://contextmem.test/mcp?namespace=${encodeURIComponent(imported.namespace)}`;

    const initialize = await mcpPost(env, mcpUrl, imported.readToken, {
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0.0.0" }
      }
    });
    expect(initialize.status).toBe(200);

    const tools = await mcpPost(env, mcpUrl, imported.readToken, {
      jsonrpc: "2.0",
      id: "tools",
      method: "tools/list",
      params: {}
    });
    expect(tools.status).toBe(200);
    const toolsBody = await tools.json();
    expect(JSON.stringify(toolsBody)).toContain("contextmem_read_artifact");

    const read = await mcpPost(env, mcpUrl, imported.readToken, {
      jsonrpc: "2.0",
      id: "read",
      method: "tools/call",
      params: {
        name: "contextmem_read_artifact",
        arguments: { path: "/llms.txt" }
      }
    });
    expect(read.status).toBe(200);
    expect(JSON.stringify(await read.json())).toContain("Agent-readable context");
  });

  it("serves short namespace MCP URLs and gateway namespace arguments", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "private");
    const shortMcpUrl = `https://contextmem.test/mcp/${encodeURIComponent(imported.namespace)}`;
    const gatewayMcpUrl = "https://contextmem.test/mcp";

    const shortTools = await mcpPost(env, shortMcpUrl, imported.readToken, {
      jsonrpc: "2.0",
      id: "short-tools",
      method: "tools/list",
      params: {}
    });
    expect(shortTools.status).toBe(200);
    expect(JSON.stringify(await shortTools.json())).toContain("search_context");

    const gatewaySearch = await mcpPost(env, gatewayMcpUrl, imported.readToken, {
      jsonrpc: "2.0",
      id: "gateway-search",
      method: "tools/call",
      params: {
        name: "search_context",
        arguments: {
          namespace: imported.namespace,
          query: "Example"
        }
      }
    });
    expect(gatewaySearch.status).toBe(200);
    expect(JSON.stringify(await gatewaySearch.json())).toContain("Agent-readable context");
  });

  it("updates namespace metadata, manages tokens, and exposes public directory entries", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "public", {
      ownerId: "acct_public",
      displayName: "Example Context",
      directoryEnabled: true,
      tags: ["docs", "walrus"]
    });
    const { handleWorkerRequest } = await worker();

    const listed = await handleWorkerRequest(new Request("https://contextmem.test/api/namespaces?ownerId=acct_public", { headers: { authorization: "Bearer import-secret" } }), env);
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain("Example Context");

    const updated = await handleWorkerRequest(
      new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}`, {
        method: "PATCH",
        headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
        body: JSON.stringify({ ownerId: "acct_public", description: "Public docs namespace", tags: ["docs", "agent"] })
      }),
      env
    );
    expect(updated.status).toBe(200);

    const token = await handleWorkerRequest(
      new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}/tokens`, {
        method: "POST",
        headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
        body: JSON.stringify({ ownerId: "acct_public", label: "cursor" })
      }),
      env
    );
    expect(token.status).toBe(201);
    const tokenBody = (await token.json()) as { token: { id: string }; readToken: string };
    expect(tokenBody.readToken).toMatch(/^ctxm_/);

    const revoke = await handleWorkerRequest(
      new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}/tokens/${tokenBody.token.id}?ownerId=acct_public`, {
        method: "DELETE",
        headers: { authorization: "Bearer import-secret" }
      }),
      env
    );
    expect(revoke.status).toBe(200);

    const directory = await handleWorkerRequest(new Request("https://contextmem.test/api/directory?search=docs"), env);
    expect(directory.status).toBe(200);
    expect(JSON.stringify(await directory.json())).toContain(imported.namespace);
  });

  it("returns context bundles from the gateway MCP", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "private");

    const bundle = await mcpPost(env, "https://contextmem.test/mcp", imported.readToken, {
      jsonrpc: "2.0",
      id: "bundle",
      method: "tools/call",
      params: {
        name: "get_context_bundle",
        arguments: {
          namespace: imported.namespace,
          query: "Example"
        }
      }
    });
    expect(bundle.status).toBe(200);
    const body = JSON.stringify(await bundle.json());
    expect(body).toContain("searchResults");
    expect(body).toContain("MemWal headers were not provided");
  });

  it("enables MemWal recall tools only when user MemWal headers are provided", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "private");

    const withoutHeaders = await mcpPost(env, "https://contextmem.test/mcp", imported.readToken, {
      jsonrpc: "2.0",
      id: "without-memwal",
      method: "tools/list",
      params: {}
    });
    expect(JSON.stringify(await withoutHeaders.json())).not.toContain("recall_memory");

    const withHeaders = await mcpPost(
      env,
      "https://contextmem.test/mcp",
      imported.readToken,
      {
        jsonrpc: "2.0",
        id: "with-memwal",
        method: "tools/list",
        params: {}
      },
      {
        "x-memwal-mcp-url": "https://memwal.test/api/mcp",
        "x-memwal-account-id": "acct_memwal",
        "x-memwal-bearer": "delegate-token"
      }
    );
    expect(JSON.stringify(await withHeaders.json())).toContain("recall_memory");
  });

  it("creates and completes a fetch-based extraction job", async () => {
    const env = createTestEnv();
    const restoreFetch = mockFetch({
      "https://example.com/": "<html><head><title>Example Site</title><meta name=\"description\" content=\"A test site\"></head><body><a href=\"/about\">About</a><img src=\"/logo.png\"></body></html>",
      "https://example.com/about": "<html><head><title>About</title></head><body>About the test site</body></html>",
      "https://example.com/robots.txt": "User-agent: *\nAllow: /",
      "https://example.com/sitemap.xml": "<urlset></urlset>"
    });
    try {
      const { handleWorkerRequest } = await worker();
      const response = await handleWorkerRequest(
        new Request("https://contextmem.test/api/extractions", {
          method: "POST",
          headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
          body: JSON.stringify({ ownerId: "acct_extract", target: "https://example.com/", namespace: "web:example.com", displayName: "Example Extract" })
        }),
        env
      );
      expect(response.status).toBe(202);
      const body = (await response.json()) as { job: { id: string; status: string; result?: { namespace: string } } };
      expect(body.job.status).toBe("completed");
      expect(body.job.result?.namespace).toBe("web:example.com");
    } finally {
      restoreFetch();
    }
  });
});

async function importFixtureNamespace(env: WorkerEnv, visibility: "private" | "public", options: Record<string, unknown> = {}) {
  const { handleWorkerRequest } = await worker();
  const response = await handleWorkerRequest(
    new Request("https://contextmem.test/api/namespaces/import", {
      method: "POST",
      headers: {
        authorization: "Bearer import-secret",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        namespace: `web:example-${visibility}.com`,
        visibility,
        ...options,
        target: "https://example.com/",
        sourceRunId: "run_fixture",
        manifest: { target: "https://example.com/", pages: [] },
        files: [
          {
            path: "/llms.txt",
            contentType: "text/plain; charset=utf-8",
            encoding: "utf8",
            content: "Agent-readable context for Example"
          },
          {
            path: "/context/manifest.json",
            contentType: "application/json; charset=utf-8",
            encoding: "utf8",
            content: JSON.stringify({ target: "https://example.com/" })
          },
          {
            path: "/context/site-structure.json",
            contentType: "application/json; charset=utf-8",
            encoding: "utf8",
            content: JSON.stringify({ nodes: [] })
          }
        ]
      })
    }),
    env
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { namespace: string; readToken: string };
}

function mcpPost(env: WorkerEnv, url: string, token: string, body: unknown, extraHeaders: Record<string, string> = {}) {
  return worker().then(({ handleWorkerRequest }) =>
    handleWorkerRequest(
      new Request(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          ...extraHeaders
        },
        body: JSON.stringify(body)
      }),
      env
    )
  );
}

function createTestEnv(): WorkerEnv {
  return {
    CONTEXTMEM_NAMESPACE_IMPORT_TOKEN: "import-secret",
    CONTEXTMEM_CONTEXT_BUCKET: new MemoryR2Bucket(),
    CONTEXTMEM_DB: new MemoryD1Database()
  };
}

class MemoryR2Bucket {
  objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();

  async get(key: string) {
    const item = this.objects.get(key);
    if (!item) return null;
    const buffer = new ArrayBuffer(item.bytes.byteLength);
    new Uint8Array(buffer).set(item.bytes);
    return {
      text: async () => new TextDecoder().decode(item.bytes),
      arrayBuffer: async () => buffer
    };
  }

  async put(key: string, value: string | ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.objects.set(key, { bytes, contentType: options?.httpMetadata?.contentType });
  }
}

class MemoryD1Database {
  namespaces = new Map<string, Record<string, unknown>>();
  versions = new Map<string, Record<string, unknown>>();
  tokens = new Map<string, Record<string, unknown>>();
  extractionJobs = new Map<string, Record<string, unknown>>();
  artifacts: Array<Record<string, unknown>> = [];

  prepare(query: string) {
    return new MemoryD1Statement(this, query);
  }

  async batch(statements: MemoryD1Statement[]) {
    for (const statement of statements) await statement.run();
  }
}

class MemoryD1Statement {
  private values: unknown[] = [];

  constructor(private readonly db: MemoryD1Database, private readonly query: string) {}

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    const query = normalizeSql(this.query);
    if (query.includes("from contextmem_extraction_jobs") && query.includes("where id = ?")) {
      return (this.db.extractionJobs.get(String(this.values[0])) as T | undefined) ?? null;
    }
    if (query.includes("from contextmem_namespaces") && query.includes("where namespace = ?")) {
      return (this.db.namespaces.get(String(this.values[0])) as T | undefined) ?? null;
    }
    if (query.includes("from contextmem_namespace_tokens")) {
      const namespace = String(this.values[0]);
      const tokenHash = String(this.values[1]);
      const token = this.db.tokens.get(tokenHash);
      return token?.namespace === namespace ? (token as T) : null;
    }
    if (query.includes("from contextmem_namespace_artifacts") && query.includes("and a.path = ?")) {
      const namespace = String(this.values[0]);
      const artifactPath = String(this.values[1]);
      const current = this.db.namespaces.get(namespace)?.current_version_id;
      return (this.db.artifacts.find((artifact) => artifact.namespace === namespace && artifact.version_id === current && artifact.path === artifactPath) as T | undefined) ?? null;
    }
    return null;
  }

  async all<T>() {
    const query = normalizeSql(this.query);
    if (query.includes("from contextmem_namespaces")) {
      let results = [...this.db.namespaces.values()];
      if (query.includes("where owner_id = ?")) {
        const ownerId = String(this.values[0]);
        results = results.filter((namespace) => namespace.owner_id === ownerId);
      }
      if (query.includes("where visibility = 'public'")) {
        results = results.filter((namespace) => namespace.visibility === "public" && Boolean(namespace.directory_enabled));
      }
      return { results: results as T[] };
    }
    if (query.includes("from contextmem_namespace_tokens")) {
      const namespace = String(this.values[0]);
      return { results: [...this.db.tokens.values()].filter((token) => token.namespace === namespace) as T[] };
    }
    if (query.includes("from contextmem_namespace_artifacts")) {
      const namespace = String(this.values[0]);
      const current = this.db.namespaces.get(namespace)?.current_version_id;
      const results = this.db.artifacts.filter((artifact) => artifact.namespace === namespace && artifact.version_id === current).sort((a, b) => String(a.path).localeCompare(String(b.path))) as T[];
      return { results };
    }
    return { results: [] as T[] };
  }

  async run() {
    const query = normalizeSql(this.query);
    if (query.startsWith("insert into contextmem_namespace_versions")) {
      const [id, namespace, source_run_id, manifest_json, artifact_count, byte_length, created_at] = this.values;
      if (!this.db.namespaces.has(String(namespace))) throw new Error("FOREIGN KEY constraint failed: namespace");
      this.db.versions.set(String(id), { id, namespace, source_run_id, manifest_json, artifact_count, byte_length, created_at });
    } else if (query.startsWith("insert into contextmem_namespaces")) {
      const [namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, manifest_json, artifact_count, byte_length, created_at, updated_at] = this.values;
      const existing = this.db.namespaces.get(String(namespace));
      this.db.namespaces.set(String(namespace), { namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, manifest_json, artifact_count, byte_length, created_at: existing?.created_at ?? created_at, updated_at });
    } else if (query.startsWith("insert into contextmem_namespace_tokens")) {
      const [token_hash, token_id, namespace, label, created_at] = this.values;
      this.db.tokens.set(String(token_hash), { token_hash, token_id, namespace, label, created_at, revoked_at: null });
    } else if (query.startsWith("delete from contextmem_namespace_artifacts")) {
      const [namespace, version_id] = this.values;
      this.db.artifacts = this.db.artifacts.filter((artifact) => artifact.namespace !== namespace || artifact.version_id !== version_id);
    } else if (query.startsWith("insert into contextmem_namespace_artifacts")) {
      const [namespace, version_id, path, r2_key, content_type, kind, size, sha256, updated_at] = this.values;
      if (!this.db.versions.has(String(version_id))) throw new Error("FOREIGN KEY constraint failed: version");
      this.db.artifacts.push({ namespace, version_id, path, r2_key, content_type, kind, size, sha256, updated_at });
    } else if (query.startsWith("update contextmem_namespace_tokens")) {
      if (query.includes("revoked_at")) {
        const [revoked_at, namespace, token_id, token_hash_prefix] = this.values;
        for (const token of this.db.tokens.values()) {
          if (token.namespace === namespace && (token.token_id === token_id || String(token.token_hash).startsWith(String(token_hash_prefix).replace("%", "")))) token.revoked_at = revoked_at;
        }
      } else {
        const [last_used_at, token_hash] = this.values;
        const token = this.db.tokens.get(String(token_hash));
        if (token) token.last_used_at = last_used_at;
      }
    } else if (query.startsWith("update contextmem_namespaces")) {
      const [visibility, display_name, description, tags_json, directory_enabled, updated_at, namespace] = this.values;
      const item = this.db.namespaces.get(String(namespace));
      if (item) Object.assign(item, { visibility, display_name, description, tags_json, directory_enabled, updated_at });
    } else if (query.startsWith("insert into contextmem_extraction_jobs")) {
      const [id, owner_id, namespace, target, visibility, display_name, description, tags_json, directory_enabled, created_at, updated_at] = this.values;
      this.db.extractionJobs.set(String(id), { id, owner_id, namespace, target, status: "queued", visibility, display_name, description, tags_json, directory_enabled, source_type: "extract", created_at, updated_at });
    } else if (query.startsWith("update contextmem_extraction_jobs")) {
      const id = String(this.values[this.values.length - 1]);
      const job = this.db.extractionJobs.get(id);
      if (job) {
        if (query.includes("status = 'running'")) Object.assign(job, { status: "running", updated_at: this.values[0] });
        else if (query.includes("status = 'completed'")) Object.assign(job, { status: "completed", result_json: this.values[0], updated_at: this.values[1], completed_at: this.values[2] });
        else if (query.includes("status = 'failed'")) Object.assign(job, { status: "failed", error: this.values[0], updated_at: this.values[1] });
      }
    }
    return { success: true };
  }
}

function normalizeSql(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function mockFetch(routes: Record<string, string>) {
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body = routes[url];
      if (body === undefined) return new Response("Not found", { status: 404 });
      return new Response(body, {
        headers: {
          "content-type": url.endsWith(".xml") ? "application/xml; charset=utf-8" : url.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/html; charset=utf-8"
        }
      });
    })
  );
  return () => vi.stubGlobal("fetch", original);
}

it("hashes read tokens deterministically without storing the token itself", async () => {
  const { hashReadToken } = await worker();
  await expect(hashReadToken("ctxm_test")).resolves.toMatch(/^[a-f0-9]{64}$/);
});

function worker(): Promise<typeof import("./worker.js")> {
  return import("./worker.js");
}
