import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readContextManifest, sha256Base64, type WalrusResourceRecord, type WalrusSiteContext } from "@contextmem/core";
import { materializeWalrusSite } from "./resources.js";

let tmp: string;
const originalFetch = globalThis.fetch;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "contextmem-walrus-"));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("Walrus materialization performance controls", () => {
  it("skips screenshot artifacts in fast mode and keeps deterministic resource order", async () => {
    const html = Buffer.from("<!doctype html><title>Fast</title><main>Fast context</main>");
    const css = Buffer.from("body { color: #111827; }");
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      calls.push(url);
      return new Response(url.includes("css") ? css : html, { status: 200 });
    }) as typeof fetch;

    const result = await materializeWalrusSite(site(), path.join(tmp, "run-fast"), {
      outputs: ["markdown", "sitemap"],
      concurrency: 2,
      cacheDir: path.join(tmp, "cache"),
      resources: [resource("/style.css", "css", css), resource("/index.html", "html", html)]
    });
    const manifest = await readContextManifest(tmp, "run-fast");

    expect(result.resources.map((item) => item.path)).toEqual(["/index.html", "/style.css"]);
    expect(manifest.screenshots).toBeUndefined();
    expect(manifest.designSystem).toBeUndefined();
    expect(calls.filter((url) => url.includes("/v1/blobs/")).length).toBe(2);
  });

  it("reuses cached verified blobs on repeated builds", async () => {
    const html = Buffer.from("<!doctype html><title>Cached</title><main>Cached context</main>");
    const fetchMock = vi.fn(async (_input: URL | RequestInfo) => new Response(html, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const cacheDir = path.join(tmp, "cache");
    const resources = [resource("/index.html", "html", html)];

    const first = await materializeWalrusSite(site(), path.join(tmp, "run-first"), {
      outputs: ["markdown", "sitemap"],
      cacheDir,
      resources
    });
    const second = await materializeWalrusSite(site(), path.join(tmp, "run-second"), {
      outputs: ["markdown", "sitemap"],
      cacheDir,
      resources
    });

    const blobFetches = fetchMock.mock.calls.filter(([input]) => String(input).includes("/v1/blobs/"));
    expect(blobFetches).toHaveLength(1);
    expect(first.cacheStats.misses).toBe(1);
    expect(first.cacheStats.writes).toBe(1);
    expect(second.cacheStats.hits).toBe(1);
    expect(second.resources[0]?.cacheStatus).toBe("hit");
  });

  it("discovers hidden portal routes from recursive sitemaps, robots, llms, and markdown resources", async () => {
    const index = Buffer.from('<!doctype html><title>Home</title><main>Home page <a href="/Linked">Linked</a></main>');
    const sitemap = Buffer.from(`<?xml version="1.0" ?><sitemapindex><sitemap><loc>https://example.wal.app/nested-sitemap.xml</loc></sitemap></sitemapindex>`);
    const llms = Buffer.from(`# LLMs\n\n- [LLMs Route](/FromLlms)`);
    const markdown = Buffer.from("# Only Markdown\n\nMarkdown-only docs page.");
    const bodies = new Map([
      ["index", index],
      ["sitemap", sitemap],
      ["llms", llms],
      ["markdown", markdown]
    ]);
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      if (url.includes("aggregator.test")) {
        const blobId = [...bodies.keys()].find((id) => url.includes(id));
        return new Response(bodies.get(blobId ?? "") ?? index, { status: 200 });
      }
      if (url.endsWith("/robots.txt")) {
        return responseWithUrl("Sitemap: https://example.wal.app/robots-sitemap.xml", url, { status: 200 });
      }
      if (url.endsWith("/sitemap.xml") || url.endsWith("/nested-sitemap.xml")) {
        return responseWithUrl(`<urlset><url><loc>https://example.wal.app/FromSitemap</loc></url></urlset>`, url, { status: 200, headers: { "content-type": "application/xml" } });
      }
      if (url.endsWith("/robots-sitemap.xml")) {
        return responseWithUrl(`<urlset><url><loc>https://example.wal.app/FromRobots</loc></url></urlset>`, url, { status: 200, headers: { "content-type": "application/xml" } });
      }
      const route = new URL(url).pathname.replace(/^\//, "") || "Home";
      return responseWithUrl(`<!doctype html><title>${route}</title><main>${route} docs content</main>`, url, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    }) as typeof fetch;

    const result = await materializeWalrusSite(site(), path.join(tmp, "run-discovery"), {
      outputs: ["markdown", "sitemap"],
      discoveryMode: "full",
      resources: [
        resource("/index.html", "index", index),
        resource("/sitemap.xml", "sitemap", sitemap, "application/xml"),
        resource("/llms.txt", "llms", llms, "text/plain; charset=utf-8"),
        resource("/OnlyMarkdown.md", "markdown", markdown, "text/markdown; charset=utf-8")
      ]
    });

    expect(result.pages.map((page) => page.routePath)).toEqual(expect.arrayContaining(["/", "/FromLlms", "/FromRobots", "/FromSitemap", "/Linked", "/OnlyMarkdown"]));
    expect(result.discovery.markdownFallbacks).toBe(1);
    expect(result.discovery.sitemapSources).toEqual(expect.arrayContaining(["local:/sitemap.xml", "robots.txt"]));
  });

  it("dedupes html and markdown resources by canonical route", async () => {
    const html = Buffer.from("<!doctype html><title>Dup</title><main>HTML wins</main>");
    const markdown = Buffer.from("# Dup\n\nMarkdown duplicate.");
    globalThis.fetch = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);
      return new Response(url.includes("dup-md") ? markdown : html, { status: 200 });
    }) as typeof fetch;

    const result = await materializeWalrusSite(site(), path.join(tmp, "run-dedupe"), {
      outputs: ["markdown", "sitemap"],
      discoveryMode: "fast",
      resources: [resource("/Dup/index.html", "dup-html", html), resource("/Dup.md", "dup-md", markdown, "text/markdown; charset=utf-8")]
    });

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.source?.resourcePath).toBe("/Dup/index.html");
    expect(result.discovery.markdownFallbacks).toBe(0);
  });
});

function site(): WalrusSiteContext {
  return {
    network: "mainnet",
    siteObjectId: `0x${"1".repeat(64)}`,
    sitePackage: `0x${"2".repeat(64)}`,
    rpcUrl: "https://fullnode.mainnet.sui.io",
    aggregatorUrl: "https://aggregator.test",
    portalUrl: "https://example.wal.app/"
  };
}

function resource(route: string, blobId: string, body: Buffer, contentType?: string): WalrusResourceRecord {
  const resolvedType = contentType ?? (route.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8");
  return {
    path: route,
    headers: { "content-type": resolvedType },
    blobId,
    blobHash: sha256Base64(body),
    range: null,
    contentType: resolvedType,
    aggregatorUrl: "https://aggregator.test"
  };
}

function responseWithUrl(body: BodyInit, url: string, init?: ResponseInit): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: url });
  return response;
}
