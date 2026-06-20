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
    expect(imported.mcpUrl).toBe(`https://contextmem.test/mcp?namespace=${encodeURIComponent(imported.namespace)}`);

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

  it("rejects an expired namespace token", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "private");
    const { handleWorkerRequest, hashReadToken } = await worker();

    const expiredToken = "ctxm_expired_token_abcdef0123456789";
    await env.CONTEXTMEM_DB.prepare(
      `INSERT INTO contextmem_namespace_tokens (token_hash, token_id, namespace, label, created_at, scope, expires_at, snapshot_pin) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(await hashReadToken(expiredToken), "tok_expired", imported.namespace, "expired", new Date(Date.now() - 86400000).toISOString(), "read", new Date(Date.now() - 1000).toISOString(), null)
      .run();

    const response = await handleWorkerRequest(
      new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}`, { headers: { authorization: `Bearer ${expiredToken}` } }),
      env
    );
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).toContain("expired");
  });

  it("serves the pinned snapshot version when a token has snapshot_pin", async () => {
    const env = createTestEnv();
    const { handleWorkerRequest } = await worker();
    const namespace = "web:pinned-example.com";
    const importVersion = async (llms: string) => {
      const res = await handleWorkerRequest(
        new Request("https://contextmem.test/api/namespaces/import", {
          method: "POST",
          headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
          body: JSON.stringify({
            namespace,
            visibility: "private",
            target: "https://demo-product.wal.app/",
            sourceRunId: "run_fixture",
            manifest: { target: "https://demo-product.wal.app/", pages: [] },
            files: [
              { path: "/llms.txt", contentType: "text/plain; charset=utf-8", encoding: "utf8", content: llms },
              { path: "/context/manifest.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify({ target: "x" }) }
            ]
          })
        }),
        env
      );
      expect(res.status).toBe(201);
      return (await res.json()) as { readToken: string };
    };

    await importVersion("V1 ONLY CONTENT");
    const v1Versions = [...(env.CONTEXTMEM_DB as MemoryD1Database).versions.values()].filter((version) => version.namespace === namespace);
    const v1Id = String(v1Versions[v1Versions.length - 1]!.id);
    const v2 = await importVersion("V2 DIFFERENT CONTENT LONGER");

    const tokenRes = await handleWorkerRequest(
      new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(namespace)}/tokens`, {
        method: "POST",
        headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
        body: JSON.stringify({ label: "pinned", snapshotPin: v1Id })
      }),
      env
    );
    expect(tokenRes.status).toBe(201);
    const pinnedToken = ((await tokenRes.json()) as { readToken: string }).readToken;

    const pinned = await handleWorkerRequest(new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(namespace)}`, { headers: { authorization: `Bearer ${pinnedToken}` } }), env);
    expect(pinned.status).toBe(200);
    const pinnedBody = (await pinned.json()) as { pinnedVersionId?: string; artifacts: Array<{ path: string; size: number }> };
    expect(pinnedBody.pinnedVersionId).toBe(v1Id);
    expect(pinnedBody.artifacts.find((artifact) => artifact.path === "/llms.txt")?.size).toBe(Buffer.byteLength("V1 ONLY CONTENT"));

    const current = await handleWorkerRequest(new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(namespace)}`, { headers: { authorization: `Bearer ${v2.readToken}` } }), env);
    const currentBody = (await current.json()) as { pinnedVersionId?: string; artifacts: Array<{ path: string; size: number }> };
    expect(currentBody.pinnedVersionId).toBeUndefined();
    expect(currentBody.artifacts.find((artifact) => artifact.path === "/llms.txt")?.size).toBe(Buffer.byteLength("V2 DIFFERENT CONTENT LONGER"));
  });

  it("allows public namespace reads without a token", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "public");

    const { handleWorkerRequest } = await worker();
    const response = await handleWorkerRequest(new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}`), env);

    expect(response.status).toBe(200);
  });

  it("serves an artifact file over the public artifact-file route and 404s missing paths", async () => {
    const env = createTestEnv();
    const { handleWorkerRequest } = await worker();
    const namespace = "web:chunks-public.com";
    // The browser graph view fetches chunks.ndjson with no token, so this must
    // work on a PUBLIC namespace and accept the leading-slash-less path the
    // web hook sends (path=context/chunks.ndjson).
    const chunkLine = JSON.stringify({ chunkId: "abc1234567890def", routePath: "/", url: "https://x/", headingPath: [], text: "hi", contentHash: "h", byteLength: 2, order: 0 });
    const imported = await handleWorkerRequest(
      new Request("https://contextmem.test/api/namespaces/import", {
        method: "POST",
        headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
        body: JSON.stringify({
          namespace,
          visibility: "public",
          target: "https://demo-product.wal.app/",
          sourceRunId: "run_fixture",
          manifest: { target: "https://demo-product.wal.app/", pages: [] },
          files: [
            { path: "/llms.txt", contentType: "text/plain; charset=utf-8", encoding: "utf8", content: "ctx" },
            { path: "/context/manifest.json", contentType: "application/json; charset=utf-8", encoding: "utf8", content: JSON.stringify({ target: "x" }) },
            { path: "/context/chunks.ndjson", contentType: "application/x-ndjson; charset=utf-8", encoding: "utf8", content: `${chunkLine}\n` }
          ]
        })
      }),
      env
    );
    expect(imported.status).toBe(201);

    const ok = await handleWorkerRequest(
      new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(namespace)}/artifact-file?path=${encodeURIComponent("context/chunks.ndjson")}`),
      env
    );
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("ndjson");
    const firstLine = (await ok.text()).split("\n")[0]!;
    expect((JSON.parse(firstLine) as { chunkId?: string }).chunkId).toBe("abc1234567890def");

    const missing = await handleWorkerRequest(
      new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(namespace)}/artifact-file?path=${encodeURIComponent("context/missing.json")}`),
      env
    );
    expect(missing.status).toBe(404);
  });

  it("rejects artifact-file reads on a private namespace without a token", async () => {
    const env = createTestEnv();
    const imported = await importFixtureNamespace(env, "private");
    const { handleWorkerRequest } = await worker();
    const denied = await handleWorkerRequest(
      new Request(`https://contextmem.test/api/namespaces/${encodeURIComponent(imported.namespace)}/artifact-file?path=${encodeURIComponent("context/manifest.json")}`),
      env
    );
    expect(denied.status).toBe(401);
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
      "https://demo-product.wal.app/": "<html><head><title>Example Site</title><meta name=\"description\" content=\"A test site\"></head><body><a href=\"/about\">About</a><img src=\"/logo.png\"></body></html>",
      "https://demo-product.wal.app/about": "<html><head><title>About</title></head><body>About the test site</body></html>",
      "https://demo-product.wal.app/robots.txt": "User-agent: *\nAllow: /",
      "https://demo-product.wal.app/sitemap.xml": "<urlset></urlset>"
    });
    try {
      const { handleWorkerRequest, CloudflareNamespaceStore } = await worker();
      const response = await handleWorkerRequest(
        new Request("https://contextmem.test/api/extractions", {
          method: "POST",
          headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
          body: JSON.stringify({ ownerId: "acct_extract", target: "https://demo-product.wal.app/", namespace: "web:demo-product.wal.app", displayName: "Demo Product Extract" })
        }),
        env
      );
      expect(response.status).toBe(202);
      const body = (await response.json()) as { job: { id: string; status: string; result?: { namespace: string } } };
      expect(body.job.status).toBe("completed");
      expect(body.job.result?.namespace).toBe("web:demo-product.wal.app");

      // extractTargetContext must also emit chunks.ndjson for the graph view.
      const chunks = await new CloudflareNamespaceStore(env).readArtifact("web:demo-product.wal.app", "/context/chunks.ndjson");
      expect(chunks).toBeDefined();
      const firstChunkLine = String(chunks?.content).split("\n")[0]!;
      expect((JSON.parse(firstChunkLine) as { chunkId?: string }).chunkId).toBeTruthy();
    } finally {
      restoreFetch();
    }
  });

  it("builds one hosted namespace from multiple website and Walrus sources", async () => {
    const env = createTestEnv();
    const restoreFetch = mockFetch({
      "https://docs-one.dev/": "<html><head><title>Docs One</title><meta name=\"description\" content=\"First docs\"></head><body><a href=\"/pricing\">Pricing</a>Docs one home</body></html>",
      "https://docs-one.dev/pricing": "<html><head><title>Pricing</title></head><body>Pricing is usage based</body></html>",
      "https://docs-two.dev/": "<html><head><title>Docs Two</title></head><body><a href=\"/api\">API</a>Second docs home</body></html>",
      "https://docs-two.dev/api": "<html><head><title>API</title></head><body>API reference content</body></html>",
      "https://demo-product.wal.app/": "<html><head><title>Walrus App</title></head><body>Walrus hosted context</body></html>"
    });
    try {
      const { handleWorkerRequest, CloudflareNamespaceStore } = await worker();
      const response = await handleWorkerRequest(
        new Request("https://contextmem.test/api/namespace-builds", {
          method: "POST",
          headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
          body: JSON.stringify({
            ownerId: "acct_multi",
            namespace: "ctx:multi-source",
            displayName: "Multi Source Context",
            sources: [
              { target: "https://docs-one.dev/", label: "Docs One", mode: "web" },
              { target: "https://docs-two.dev/", label: "Docs Two", mode: "web" },
              { target: "https://demo-product.wal.app/", label: "Walrus App", mode: "walrus" }
            ]
          })
        }),
        env
      );
      expect(response.status).toBe(202);
      const body = (await response.json()) as { job: { status: string; sourceCount: number; result?: { namespace: string; sourceCount: number; readToken: string } } };
      expect(body.job.status).toBe("completed");
      expect(body.job.sourceCount).toBe(3);
      expect(body.job.result?.sourceCount).toBe(3);

      const store = new CloudflareNamespaceStore(env);
      const artifacts = await store.listArtifacts("ctx:multi-source");
      expect(artifacts.map((artifact) => artifact.path)).toEqual(expect.arrayContaining(["/context/sources.json", "/context/source-index.json", "/llms-full.txt", "/site/docs-one-1/index.md"]));

      const manifest = await store.readArtifact("ctx:multi-source", "/context/manifest.json");
      expect(manifest?.content).toContain("\"buildKind\": \"multi\"");
      expect(manifest?.content).toContain("\"kind\": \"walrus\"");

      // The combined builder must emit chunks.ndjson so the browser graph view
      // has per-chunk data without re-deriving it from raw markdown.
      const chunks = await store.readArtifact("ctx:multi-source", "/context/chunks.ndjson");
      expect(chunks).toBeDefined();
      const firstChunkLine = String(chunks?.content).split("\n")[0]!;
      expect((JSON.parse(firstChunkLine) as { chunkId?: string }).chunkId).toBeTruthy();

      const search = await mcpPost(env, `https://contextmem.test/mcp?namespace=${encodeURIComponent("ctx:multi-source")}`, body.job.result!.readToken, {
        jsonrpc: "2.0",
        id: "search-multi",
        method: "tools/call",
        params: { name: "search_context", arguments: { query: "pricing", limit: 5 } }
      });
      expect(search.status).toBe(200);
      const searchText = JSON.stringify(await search.json());
      expect(searchText).toContain("Docs One");
      expect(searchText).toContain("sourceTarget");
    } finally {
      restoreFetch();
    }
  });

  it("uses Firecrawl when configured and falls back to raw fetch when it fails", async () => {
    const env = { ...createTestEnv(), FIRECRAWL_API_KEY: "fc-test" };
    const restoreFetch = mockFetch({
      "https://api.firecrawl.dev/v2/scrape": JSON.stringify({
        success: true,
        data: {
          markdown: "# Firecrawl Page\n\nRendered firecrawl content",
          rawHtml: "<html><head><title>Firecrawl Page</title></head><body>Rendered firecrawl content</body></html>",
          links: []
        }
      }),
      "https://api.firecrawl.dev/v2/map": JSON.stringify({ success: true, links: [] })
    });
    try {
      const { handleWorkerRequest, CloudflareNamespaceStore } = await worker();
      const response = await handleWorkerRequest(
        new Request("https://contextmem.test/api/namespace-builds", {
          method: "POST",
          headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
          body: JSON.stringify({ ownerId: "acct_fc", namespace: "ctx:firecrawl", sources: [{ target: "https://firecrawl-source.dev/", label: "Firecrawl Source" }] })
        }),
        env
      );
      expect(response.status).toBe(202);
      const sources = await new CloudflareNamespaceStore(env).readArtifact("ctx:firecrawl", "/context/sources.json");
      expect(sources?.content).toContain("\"engine\": \"firecrawl\"");
    } finally {
      restoreFetch();
    }

    const fallbackEnv = { ...createTestEnv(), FIRECRAWL_API_KEY: "fc-test" };
    const restoreFallbackFetch = mockFetch({
      "https://api.firecrawl.dev/v2/scrape": { body: "firecrawl down", status: 500 },
      "https://fallback-source.dev/": "<html><head><title>Fallback Source</title></head><body>Raw fetch fallback content</body></html>"
    });
    try {
      const { handleWorkerRequest, CloudflareNamespaceStore } = await worker();
      const response = await handleWorkerRequest(
        new Request("https://contextmem.test/api/namespace-builds", {
          method: "POST",
          headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
          body: JSON.stringify({ ownerId: "acct_fc", namespace: "ctx:firecrawl-fallback", sources: [{ target: "https://fallback-source.dev/", label: "Fallback Source" }] })
        }),
        fallbackEnv
      );
      expect(response.status).toBe(202);
      const sources = await new CloudflareNamespaceStore(fallbackEnv).readArtifact("ctx:firecrawl-fallback", "/context/sources.json");
      expect(sources?.content).toContain("\"engine\": \"fetch\"");
    } finally {
      restoreFallbackFetch();
    }
  });

  it("runs private hosted builds with MemWal delegate headers", async () => {
    const env = createTestEnv();
    const restoreFetch = mockFetch({
      "https://demo-product.wal.app/": "<html><head><title>Hosted Product</title><meta name=\"description\" content=\"A hosted prod test\"></head><body><a href=\"/about\">About</a><img src=\"/logo.png\"></body></html>",
      "https://demo-product.wal.app/about": "<html><head><title>About Hosted Product</title></head><body>Private hosted run context</body></html>",
      "https://demo-product.wal.app/robots.txt": "User-agent: *\nAllow: /",
      "https://demo-product.wal.app/sitemap.xml": "<urlset></urlset>"
    });
    try {
      const { handleWorkerRequest } = await worker();
      const hostedHeaders = {
        "x-memwal-account-id": "acct_memwal",
        "x-memwal-bearer": "delegate-token-123456",
        "content-type": "application/json"
      };

      const me = await handleWorkerRequest(new Request("https://contextmem.test/api/me", { headers: hostedHeaders }), env);
      expect(me.status).toBe(200);
      expect(await me.text()).toContain("\"canRun\": true");

      const create = await handleWorkerRequest(
        new Request("https://contextmem.test/api/runs", {
          method: "POST",
          headers: hostedHeaders,
          body: JSON.stringify({ target: "https://demo-product.wal.app/", buildProfile: "balanced", outputs: ["markdown", "images", "sitemap"] })
        }),
        env
      );
      expect(create.status).toBe(202);
      const created = (await create.json()) as { manifest: { runId: string; status: string; mode: string; namespace: string } };
      expect(created.manifest.status).toBe("completed");
      expect(created.manifest.mode).toBe("walrus");

      const manifest = await handleWorkerRequest(new Request(`https://contextmem.test/api/runs/${created.manifest.runId}`, { headers: hostedHeaders }), env);
      expect(manifest.status).toBe(200);
      expect(await manifest.text()).toContain(created.manifest.namespace);

      const artifacts = await handleWorkerRequest(new Request(`https://contextmem.test/api/runs/${created.manifest.runId}/artifacts`, { headers: hostedHeaders }), env);
      expect(artifacts.status).toBe(200);
      const artifactBody = (await artifacts.json()) as { pages: unknown[]; images: unknown[]; walrus?: { resources: unknown[] } };
      expect(artifactBody.pages.length).toBeGreaterThan(0);
      expect(Array.isArray(artifactBody.images)).toBe(true);
      expect(Array.isArray(artifactBody.walrus?.resources)).toBe(true);
      expect(JSON.stringify(artifactBody)).not.toContain("delegate-token");

      const files = await handleWorkerRequest(new Request(`https://contextmem.test/api/runs/${created.manifest.runId}/artifact-files`, { headers: hostedHeaders }), env);
      expect(files.status).toBe(200);
      expect(await files.text()).toContain("/context/manifest.json");

      const history = await handleWorkerRequest(new Request("https://contextmem.test/api/runs?limit=10", { headers: hostedHeaders }), env);
      expect(history.status).toBe(200);
      expect(await history.text()).toContain(created.manifest.runId);
    } finally {
      restoreFetch();
    }
  });

  it("runs public demo extraction with quota, event status, and clear target validation", async () => {
    const env = { ...createTestEnv(), CONTEXTMEM_DEMO_DAILY_LIMIT: "1" };
    const restoreFetch = mockFetch({
      "https://demo-product.wal.app/": "<html><head><title>Demo Site</title></head><body><a href=\"/about\">About</a></body></html>",
      "https://demo-product.wal.app/about": "<html><head><title>About</title></head><body>Demo about page</body></html>",
      "https://demo-product.wal.app/robots.txt": "User-agent: *\nAllow: /",
      "https://demo-product.wal.app/sitemap.xml": "<urlset></urlset>",
      "https://fmsprint.wal.app/": "<html><head><title>Drift Racer</title><meta name=\"description\" content=\"Drift-to-Chain on Sui Testnet\"></head><body><a href=\"/about\">About Drift Racer</a></body></html>",
      "https://fmsprint.wal.app/about": "<html><head><title>About Drift Racer</title></head><body>Drift Racer public Walrus Site context for Sui product testing</body></html>",
      "https://fmsprint.wal.app/robots.txt": "User-agent: *\nAllow: /",
      "https://fmsprint.wal.app/sitemap.xml": "<urlset></urlset>"
    });
    try {
      const { handleWorkerRequest } = await worker();
      const sample = await handleWorkerRequest(
        new Request("https://contextmem.test/api/demo/extractions", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
          body: JSON.stringify({ sample: true })
        }),
        env
      );
      expect(sample.status).toBe(202);
      const sampleBody = (await sample.json()) as { job: { target: string; status: string } };
      expect(sampleBody.job.target).toBe("https://fmsprint.wal.app/");
      expect(sampleBody.job.status).toBe("completed");

      const first = await handleWorkerRequest(
        new Request("https://contextmem.test/api/demo/extractions", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
          body: JSON.stringify({ target: "https://demo-product.wal.app/" })
        }),
        env
      );
      expect(first.status).toBe(202);
      const firstBody = (await first.json()) as { job: { id: string; status: string; result?: { share?: { id: string } } } };
      expect(firstBody.job.status).toBe("completed");
      expect(firstBody.job.result?.share?.id).toMatch(/^shr_/);

      const events = await handleWorkerRequest(new Request(`https://contextmem.test/api/demo/extractions/${firstBody.job.id}/events`), env);
      expect(events.status).toBe(200);
      expect(await events.text()).toContain("event: done");

      const second = await handleWorkerRequest(
        new Request("https://contextmem.test/api/demo/extractions", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
          body: JSON.stringify({ target: "https://demo-product.wal.app/" })
        }),
        env
      );
      expect(second.status).toBe(429);

      const rejected = await handleWorkerRequest(
        new Request("https://contextmem.test/api/demo/extractions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: "http://localhost:5174/" })
        }),
        env
      );
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("localhost");

      const objectId = await handleWorkerRequest(
        new Request("https://contextmem.test/api/demo/extractions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ target: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef" })
        }),
        env
      );
      expect(objectId.status).toBe(400);
      expect(await objectId.text()).toContain("public http(s) URLs");

      const authedRetry = await handleWorkerRequest(
        new Request("https://contextmem.test/api/demo/extractions", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": "203.0.113.10",
            "x-memwal-account-id": "0xabc123def4567890abcdef0123456789abcdef01",
            "x-memwal-authorization": "Bearer delegate-secret-token-1234"
          },
          body: JSON.stringify({ target: "https://demo-product.wal.app/" })
        }),
        env
      );
      expect(authedRetry.status).toBe(202);
      const authedBody = (await authedRetry.json()) as { job: { status: string; result?: { share?: { id: string } } } };
      expect(authedBody.job.status).toBe("completed");
      expect(authedBody.job.result?.share?.id).toMatch(/^shr_/);
    } finally {
      restoreFetch();
    }
  });

  it("disables the anonymous demo cap when CONTEXTMEM_DEMO_DAILY_LIMIT is 0 (showcase mode)", async () => {
    const env = { ...createTestEnv(), CONTEXTMEM_DEMO_DAILY_LIMIT: "0" };
    const restoreFetch = mockFetch({
      "https://demo-product.wal.app/": "<html><head><title>Demo Site</title></head><body><a href=\"/about\">About</a></body></html>",
      "https://demo-product.wal.app/about": "<html><head><title>About</title></head><body>Demo about page</body></html>",
      "https://demo-product.wal.app/robots.txt": "User-agent: *\nAllow: /",
      "https://demo-product.wal.app/sitemap.xml": "<urlset></urlset>"
    });
    try {
      const { handleWorkerRequest } = await worker();
      const build = () => handleWorkerRequest(
        new Request("https://contextmem.test/api/demo/extractions", {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.99" },
          body: JSON.stringify({ target: "https://demo-product.wal.app/" })
        }),
        env
      );
      const first = await build();
      expect(first.status).toBe(202);
      const second = await build();
      expect(second.status).toBe(202); // not 429 — cap disabled
      const third = await build();
      expect(third.status).toBe(202);
    } finally {
      restoreFetch();
    }
  });

  it("stores feedback and creates redacted public share links", async () => {
    const env = createTestEnv();
    const { handleWorkerRequest, CloudflareNamespaceStore } = await worker();
    const feedback = await handleWorkerRequest(
      new Request("https://contextmem.test/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sentiment: "positive", message: "The DEV onboarding path is clear.", pageUrl: "https://contextmem.test/" })
      }),
      env
    );
    expect(feedback.status).toBe(201);
    expect((env.CONTEXTMEM_DB as MemoryD1Database).feedback.size).toBe(1);

    const share = await handleWorkerRequest(
      new Request("https://contextmem.test/api/share-links", {
        method: "POST",
        headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
        body: JSON.stringify({
          ownerId: "acct_share",
          target: "https://demo-product.wal.app/",
          title: "Shareable Example",
          manifest: { target: "https://demo-product.wal.app/", env: "OPENAI_API_KEY=sk-secret-value" },
          files: [
            {
              path: "/context/manifest.json",
              contentType: "application/json; charset=utf-8",
              encoding: "utf8",
              content: JSON.stringify({ target: "https://demo-product.wal.app/", token: "VITE_CONTEXTMEM_DEV_AUTH=true" })
            },
            {
              path: "/llms.txt",
              contentType: "text/plain; charset=utf-8",
              encoding: "utf8",
              content: "PUBLIC_URL=https://example.com\nSECRET_KEY=abc123"
            }
          ]
        })
      }),
      env
    );
    expect(share.status).toBe(201);
    const shareBody = (await share.json()) as { share: { id: string; namespace: string; mcpUrl: string } };
    expect(shareBody.share.mcpUrl).toBe(`https://contextmem.test/mcp?namespace=${encodeURIComponent(shareBody.share.namespace)}`);

    const publicShare = await handleWorkerRequest(new Request(`https://contextmem.test/api/share-links/${shareBody.share.id}`), env);
    expect(publicShare.status).toBe(200);
    const publicShareBody = await publicShare.json();
    expect(JSON.stringify(publicShareBody)).toContain("[REDACTED]");
    expect(JSON.stringify(publicShareBody)).toContain(`/mcp?namespace=${encodeURIComponent(shareBody.share.namespace)}`);

    const storedManifest = await new CloudflareNamespaceStore(env).readArtifact(shareBody.share.namespace, "/context/manifest.json");
    expect(storedManifest?.content).toContain("[REDACTED]");
    expect(storedManifest?.content).not.toContain("VITE_CONTEXTMEM_DEV_AUTH=true");
  });

  it("runs due schedules, stores alerts, and records webhook delivery metadata", async () => {
    const env = createTestEnv();
    const restoreFetch = mockFetch({
      "https://demo-product.wal.app/": "<html><head><title>Scheduled Site</title></head><body>Scheduled run</body></html>",
      "https://demo-product.wal.app/robots.txt": "User-agent: *\nAllow: /",
      "https://demo-product.wal.app/sitemap.xml": "<urlset></urlset>",
      "https://webhook.test/hook": "ok"
    });
    try {
      const { handleWorkerRequest, processDueSchedules } = await worker();
      const create = await handleWorkerRequest(
        new Request("https://contextmem.test/api/schedules", {
          method: "POST",
          headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
          body: JSON.stringify({ ownerId: "acct_sched", target: "https://demo-product.wal.app/", intervalHours: 1, webhookUrl: "https://webhook.test/hook", webhookSecret: "test-secret" })
        }),
        env
      );
      expect(create.status).toBe(201);
      const schedule = [...(env.CONTEXTMEM_DB as MemoryD1Database).schedules.values()][0]!;
      schedule.next_run_at = "2000-01-01T00:00:00.000Z";

      await processDueSchedules(env);
      const run = [...(env.CONTEXTMEM_DB as MemoryD1Database).scheduleRuns.values()][0]!;
      const alert = [...(env.CONTEXTMEM_DB as MemoryD1Database).alerts.values()][0]!;
      const delivery = [...(env.CONTEXTMEM_DB as MemoryD1Database).webhookDeliveries.values()][0]!;
      expect(run.status).toBe("completed");
      expect(alert.title).toBe("Context changed");
      expect(delivery.status).toBe("sent");
      expect(delivery.status_code).toBe(200);
    } finally {
      restoreFetch();
    }
  });

  it("binds a hosted owner to its first delegate secret and blocks a spoofed x-memwal-account-id (#23)", async () => {
    const env = createTestEnv();
    const { handleWorkerRequest, CloudflareNamespaceStore } = await worker();
    const namespace = "web:owned-by-acct-a.com";

    const imported = await handleWorkerRequest(
      new Request("https://contextmem.test/api/namespaces/import", {
        method: "POST",
        headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
        body: JSON.stringify({
          namespace,
          visibility: "private",
          ownerId: "hosted:acct-a",
          target: "https://demo-product.wal.app/",
          sourceRunId: "run_fixture",
          manifest: { target: "https://demo-product.wal.app/", pages: [] },
          files: [
            { path: "/site/page.md", contentType: "text/markdown; charset=utf-8", encoding: "utf8", content: "# original" }
          ]
        })
      }),
      env
    );
    expect(imported.status).toBe(201);

    const editUrl = `https://contextmem.test/api/namespaces/${encodeURIComponent(namespace)}/artifact-edit`;
    const editBody = JSON.stringify({ path: "/site/page.md", content: "# edited by owner" });

    // First sighting of acct-a with its delegate secret binds (trust-on-first-use) and succeeds.
    const ownerEdit = await handleWorkerRequest(
      new Request(editUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-memwal-account-id": "acct-a",
          "x-memwal-authorization": "Bearer delegate-secret-aaaa"
        },
        body: editBody
      }),
      env
    );
    expect(ownerEdit.status).toBe(200);
    const stored = await new CloudflareNamespaceStore(env).readArtifact(namespace, "/site/page.md");
    expect(stored?.content).toContain("edited by owner");

    // An attacker who guesses owner acct-a but presents a DIFFERENT secret is rejected.
    const spoofedEdit = await handleWorkerRequest(
      new Request(editUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-memwal-account-id": "acct-a",
          "x-memwal-authorization": "Bearer attacker-secret-zzzz"
        },
        body: JSON.stringify({ path: "/site/page.md", content: "# hijacked" })
      }),
      env
    );
    expect(spoofedEdit.status).toBe(403);
    const afterSpoof = await new CloudflareNamespaceStore(env).readArtifact(namespace, "/site/page.md");
    expect(afterSpoof?.content).not.toContain("hijacked");
  });

  it("scopes schedules/alerts to a delegated owner and fails closed without one (#23)", async () => {
    const env = createTestEnv();
    const { handleWorkerRequest } = await worker();

    // Seed two owners' schedules via the trusted server-to-server proxy (import token).
    for (const ownerId of ["hosted:acct-a", "hosted:acct-b"]) {
      const created = await handleWorkerRequest(
        new Request("https://contextmem.test/api/schedules", {
          method: "POST",
          headers: { authorization: "Bearer import-secret", "content-type": "application/json" },
          body: JSON.stringify({ ownerId, target: "https://demo-product.wal.app/", intervalHours: 1 })
        }),
        env
      );
      expect(created.status).toBe(201);
    }

    // Trusted proxy delegating an explicit owner sees only that owner's rows.
    const scopedToA = await handleWorkerRequest(
      new Request("https://contextmem.test/api/schedules?ownerId=hosted%3Aacct-a", {
        headers: { authorization: "Bearer import-secret" }
      }),
      env
    );
    const scopedBody = (await scopedToA.json()) as { schedules: Array<{ ownerId?: string }> };
    expect(scopedBody.schedules).toHaveLength(1);

    // Import token but NO owner delegated → fail closed to an empty list (no anonymous dump).
    const noOwner = await handleWorkerRequest(
      new Request("https://contextmem.test/api/schedules", { headers: { authorization: "Bearer import-secret" } }),
      env
    );
    const noOwnerBody = (await noOwner.json()) as { schedules: unknown[] };
    expect(noOwnerBody.schedules).toHaveLength(0);
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
        target: "https://demo-product.wal.app/",
        sourceRunId: "run_fixture",
        manifest: { target: "https://demo-product.wal.app/", pages: [] },
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
            content: JSON.stringify({ target: "https://demo-product.wal.app/" })
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
  return (await response.json()) as { namespace: string; readToken: string; mcpUrl: string };
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
    CONTEXTMEM_DEMO_SAMPLE_TARGET: "https://fmsprint.wal.app/",
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
  feedback = new Map<string, Record<string, unknown>>();
  demoLimits = new Map<string, Record<string, unknown>>();
  shareLinks = new Map<string, Record<string, unknown>>();
  schedules = new Map<string, Record<string, unknown>>();
  scheduleRuns = new Map<string, Record<string, unknown>>();
  alerts = new Map<string, Record<string, unknown>>();
  webhookDeliveries = new Map<string, Record<string, unknown>>();
  hostedDelegates = new Map<string, Record<string, unknown>>();
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
    if (query.includes("from contextmem_demo_limits") && query.includes("where bucket_key = ?")) {
      return (this.db.demoLimits.get(String(this.values[0])) as T | undefined) ?? null;
    }
    if (query.includes("from contextmem_share_links") && query.includes("where id = ?")) {
      return (this.db.shareLinks.get(String(this.values[0])) as T | undefined) ?? null;
    }
    if (query.includes("from contextmem_schedules") && query.includes("where id = ?")) {
      return (this.db.schedules.get(String(this.values[0])) as T | undefined) ?? null;
    }
    if (query.includes("from contextmem_hosted_delegates") && query.includes("where owner_id = ?")) {
      return (this.db.hostedDelegates.get(String(this.values[0])) as T | undefined) ?? null;
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
    if (query.includes("from contextmem_namespace_versions") && query.includes("where namespace = ? and id = ?")) {
      const namespace = String(this.values[0]);
      const id = String(this.values[1]);
      const version = this.db.versions.get(id);
      return version && version.namespace === namespace ? ({ id } as T) : null;
    }
    if (query.includes("from contextmem_namespace_artifacts") && query.includes("a.path = ?")) {
      const namespace = String(this.values[0]);
      const pinned = query.includes("a.version_id = ?");
      const version = pinned ? String(this.values[1]) : this.db.namespaces.get(namespace)?.current_version_id;
      const artifactPath = pinned ? String(this.values[2]) : String(this.values[1]);
      return (this.db.artifacts.find((artifact) => artifact.namespace === namespace && artifact.version_id === version && artifact.path === artifactPath) as T | undefined) ?? null;
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
      const version = query.includes("a.version_id = ?") ? String(this.values[1]) : this.db.namespaces.get(namespace)?.current_version_id;
      const results = this.db.artifacts.filter((artifact) => artifact.namespace === namespace && artifact.version_id === version).sort((a, b) => String(a.path).localeCompare(String(b.path))) as T[];
      return { results };
    }
    if (query.includes("from contextmem_namespace_versions")) {
      const namespace = String(this.values[0]);
      const results = [...this.db.versions.values()]
        .filter((version) => version.namespace === namespace)
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, 2) as T[];
      return { results };
    }
    if (query.includes("from contextmem_extraction_jobs")) {
      let results = [...this.db.extractionJobs.values()];
      if (query.includes("where owner_id = ?")) {
        const ownerId = String(this.values[0]);
        results = results.filter((job) => job.owner_id === ownerId);
      }
      results.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
      return { results: results as T[] };
    }
    if (query.includes("from contextmem_schedules")) {
      let results = [...this.db.schedules.values()];
      if (query.includes("where owner_id = ?")) {
        const ownerId = String(this.values[0]);
        results = results.filter((schedule) => schedule.owner_id === ownerId);
      } else if (query.includes("where active = 1")) {
        const now = String(this.values[0]);
        results = results.filter((schedule) => Boolean(schedule.active) && String(schedule.next_run_at) <= now);
      }
      return { results: results as T[] };
    }
    if (query.includes("from contextmem_alerts")) {
      const ownerId = String(this.values[0]);
      return { results: [...this.db.alerts.values()].filter((alert) => alert.owner_id === ownerId) as T[] };
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
      const [namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, build_kind, sources_json, source_count, manifest_json, artifact_count, byte_length, created_at, updated_at] = this.values;
      const existing = this.db.namespaces.get(String(namespace));
      this.db.namespaces.set(String(namespace), { namespace, target, visibility, owner_id, display_name, description, tags_json, source_type, directory_enabled, current_version_id, source_run_id, build_kind, sources_json, source_count, manifest_json, artifact_count, byte_length, created_at: existing?.created_at ?? created_at, updated_at });
    } else if (query.startsWith("insert into contextmem_namespace_tokens")) {
      const [token_hash, token_id, namespace, label, created_at, scope, expires_at, snapshot_pin] = this.values;
      this.db.tokens.set(String(token_hash), {
        token_hash,
        token_id,
        namespace,
        label,
        created_at,
        revoked_at: null,
        scope: scope ?? "read",
        expires_at: expires_at ?? null,
        snapshot_pin: snapshot_pin ?? null
      });
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
      const [id, owner_id, namespace, target, visibility, display_name, description, tags_json, directory_enabled, build_kind, sources_json, source_count, created_at, updated_at] = this.values;
      this.db.extractionJobs.set(String(id), { id, owner_id, namespace, target, status: "queued", visibility, display_name, description, tags_json, directory_enabled, source_type: "extract", build_kind, sources_json, source_count, created_at, updated_at });
    } else if (query.startsWith("update contextmem_extraction_jobs")) {
      const id = String(this.values[this.values.length - 1]);
      const job = this.db.extractionJobs.get(id);
      if (job) {
        if (query.includes("status = 'running'")) Object.assign(job, { status: "running", updated_at: this.values[0] });
        else if (query.includes("status = 'completed'")) Object.assign(job, { status: "completed", result_json: this.values[0], updated_at: this.values[1], completed_at: this.values[2] });
        else if (query.includes("status = 'failed'")) Object.assign(job, { status: "failed", error: this.values[0], updated_at: this.values[1] });
      }
    } else if (query.startsWith("insert into contextmem_feedback")) {
      const [id, owner_id, page_url, sentiment, message, contact, user_agent, created_at] = this.values;
      this.db.feedback.set(String(id), { id, owner_id, page_url, sentiment, message, contact, user_agent, created_at });
    } else if (query.startsWith("insert into contextmem_demo_limits")) {
      const [bucket_key, ip_hash, day, updated_at] = this.values;
      const existing = this.db.demoLimits.get(String(bucket_key));
      this.db.demoLimits.set(String(bucket_key), { bucket_key, ip_hash, day, count: Number(existing?.count ?? 0) + 1, updated_at });
    } else if (query.startsWith("insert into contextmem_share_links")) {
      const [id, namespace, target, title, description, source_run_id, version_id, artifact_count, byte_length, created_at, updated_at] = this.values;
      this.db.shareLinks.set(String(id), { id, namespace, target, title, description, source_run_id, version_id, artifact_count, byte_length, created_at, updated_at });
    } else if (query.startsWith("insert into contextmem_schedules")) {
      const [id, owner_id, namespace, target, interval_hours, webhook_url, webhook_secret, active, next_run_at, created_at, updated_at] = this.values;
      this.db.schedules.set(String(id), { id, owner_id, namespace, target, interval_hours, webhook_url, webhook_secret, active, last_run_at: null, next_run_at, created_at, updated_at });
    } else if (query.startsWith("update contextmem_schedules")) {
      const id = String(this.values[this.values.length - 1]);
      const schedule = this.db.schedules.get(id);
      if (schedule && query.includes("last_run_at")) {
        const [last_run_at, next_run_at, updated_at] = this.values;
        Object.assign(schedule, { last_run_at, next_run_at, updated_at });
      } else if (schedule) {
        const [interval_hours, webhook_url, webhook_secret, active, next_run_at, updated_at] = this.values;
        Object.assign(schedule, { interval_hours, webhook_url, webhook_secret, active, next_run_at, updated_at });
      }
    } else if (query.startsWith("insert into contextmem_schedule_runs")) {
      const [id, schedule_id, created_at] = this.values;
      this.db.scheduleRuns.set(String(id), { id, schedule_id, status: "running", created_at });
    } else if (query.startsWith("update contextmem_schedule_runs")) {
      const id = String(this.values[this.values.length - 1]);
      const run = this.db.scheduleRuns.get(id);
      if (run && query.includes("status = 'completed'")) {
        const [extraction_job_id, diff_json, completed_at] = this.values;
        Object.assign(run, { extraction_job_id, status: "completed", diff_json, completed_at });
      } else if (run && query.includes("status = 'failed'")) {
        const [error, completed_at] = this.values;
        Object.assign(run, { status: "failed", error, completed_at });
      }
    } else if (query.startsWith("insert into contextmem_alerts")) {
      const [id, owner_id, schedule_id, namespace, target, title, message, diff_json, created_at] = this.values;
      this.db.alerts.set(String(id), { id, owner_id, schedule_id, namespace, target, title, message, diff_json, read_at: null, created_at });
    } else if (query.startsWith("insert into contextmem_hosted_delegates")) {
      const [owner_id, secret_hash, created_at, last_seen_at] = this.values;
      // ON CONFLICT(owner_id) DO NOTHING — keep the first binding.
      if (!this.db.hostedDelegates.has(String(owner_id))) {
        this.db.hostedDelegates.set(String(owner_id), { owner_id, secret_hash, created_at, last_seen_at });
      }
    } else if (query.startsWith("update contextmem_hosted_delegates")) {
      const [last_seen_at, owner_id] = this.values;
      const row = this.db.hostedDelegates.get(String(owner_id));
      if (row) row.last_seen_at = last_seen_at;
    } else if (query.startsWith("insert into contextmem_webhook_deliveries")) {
      const [id, alert_id, webhook_url, created_at, updated_at] = this.values;
      this.db.webhookDeliveries.set(String(id), { id, alert_id, webhook_url, status: "queued", attempts: 0, created_at, updated_at });
    } else if (query.startsWith("update contextmem_webhook_deliveries")) {
      const id = String(this.values[this.values.length - 1]);
      const delivery = this.db.webhookDeliveries.get(id);
      if (delivery && query.includes("status_code")) {
        const [status, status_code, updated_at] = this.values;
        Object.assign(delivery, { status, status_code, attempts: 1, updated_at });
      } else if (delivery) {
        const [error, updated_at] = this.values;
        Object.assign(delivery, { status: "failed", error, attempts: 1, updated_at });
      }
    }
    return { success: true };
  }
}

function normalizeSql(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

function mockFetch(routes: Record<string, string | { body: string; status?: number; headers?: Record<string, string> }>) {
  const original = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const route = routes[url];
      if (route === undefined) return new Response("Not found", { status: 404 });
      const body = typeof route === "string" ? route : route.body;
      const status = typeof route === "string" ? 200 : route.status ?? 200;
      const headers = typeof route === "string" ? undefined : route.headers;
      return new Response(body, {
        status,
        headers: {
          "content-type": url.endsWith(".xml") ? "application/xml; charset=utf-8" : url.endsWith(".txt") ? "text/plain; charset=utf-8" : "text/html; charset=utf-8",
          ...(headers ?? {})
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
