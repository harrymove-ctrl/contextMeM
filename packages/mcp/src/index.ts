import path from "node:path";
import fs from "node:fs/promises";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  aiQueryWebsite,
  buildAgentReadableSite,
  crawlSitemap,
  crawlWebSite,
  createRunId,
  diffRunSnapshots,
  extractBrandProfile,
  extractDesignSystem,
  extractStyleguide,
  listRuns,
  namespaceForTarget,
  resolveArtifactFile,
  scrapeWebPage,
  type AiDatapoint,
  type Network
} from "@contextmem/core";
import { MemWalMcpClient, summarizeSnapshot, type SiteSnapshot } from "@contextmem/memwal";
import { getWalrusSiteHistory, materializeWalrusSite, resolveWalrusTarget } from "@contextmem/walrus";

export type LocalContextMemMcpServerOptions = {
  runsDir?: string;
};

export function createLocalContextMemMcpServer(options: LocalContextMemMcpServerOptions = {}): McpServer {
const server = new McpServer({
  name: "contextmem",
  version: "0.1.0"
});
const runsDir = path.resolve(options.runsDir ?? process.env.CONTEXTMEM_RUNS_DIR ?? "runs");

server.tool(
  "scrape_markdown",
  {
    url: z.string().describe("URL or domain to scrape")
  },
  async ({ url }) => {
    const page = await scrapeWebPage({ url, includeImages: true, includeLinks: true });
    return text({ url: page.url, title: page.title, markdown: page.markdown, images: page.images });
  }
);

server.tool(
  "crawl_site",
  {
    url: z.string(),
    maxPages: z.number().int().min(1).max(500).default(25),
    maxDepth: z.number().int().min(0).max(25).default(2)
  },
  async ({ url, maxPages, maxDepth }) => {
    const pages = await crawlWebSite(url, { maxPages, maxDepth, includeImages: true });
    return text({ count: pages.length, pages: pages.map((page) => ({ url: page.url, title: page.title, markdown: page.markdown.slice(0, 1200) })) });
  }
);

server.tool(
  "crawl_sitemap",
  {
    domain: z.string(),
    maxLinks: z.number().int().min(1).max(100000).default(10000),
    urlRegex: z.string().optional()
  },
  async ({ domain, maxLinks, urlRegex }) => text(await crawlSitemap(domain, maxLinks, urlRegex))
);

server.tool(
  "extract_brand",
  {
    target: z.string()
  },
  async ({ target }) => text(await extractBrandProfile(target))
);

server.tool(
  "extract_styleguide",
  {
    target: z.string()
  },
  async ({ target }) => text(await extractStyleguide(target))
);

server.tool(
  "extract_design_system",
  {
    target: z.string()
  },
  async ({ target }) => text(await extractDesignSystem(target))
);

server.tool(
  "inspect_walrus_site",
  {
    target: z.string().describe("0x object ID, preview config JSON, or localhost preview URL"),
    network: z.enum(["testnet", "mainnet"]).default("mainnet")
  },
  async ({ target, network }) => {
    const site = await resolveWalrusTarget(target, { network: network as Network });
    const outputDir = path.resolve("runs", createRunId("mcp-walrus-inspect"));
    const materialized = await materializeWalrusSite(site, outputDir);
    return text({
      site,
      outputDir,
      resources: materialized.resources,
      pages: materialized.pages.map((page) => ({ routePath: page.routePath, title: page.title, blobId: page.source?.blobId }))
    });
  }
);

server.tool(
  "extract_walrus_context",
  {
    target: z.string(),
    network: z.enum(["testnet", "mainnet"]).default("mainnet")
  },
  async ({ target, network }) => {
    const site = await resolveWalrusTarget(target, { network: network as Network });
    const outputDir = path.resolve("runs", createRunId("mcp-walrus-context"));
    const materialized = await materializeWalrusSite(site, outputDir);
    return text({
      outputDir,
      manifest: path.join(outputDir, "context", "manifest.json"),
      pageCount: materialized.pages.length,
      resourceCount: materialized.resources.length
    });
  }
);

server.tool(
  "build_walrus_context_site",
  {
    runDir: z.string().describe("Existing run directory with context artifacts")
  },
  async ({ runDir }) => {
    const manifestPath = path.resolve(runDir, "context", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    return text({ outputDir: manifest.outputDir, manifest: manifestPath, llms: path.join(manifest.outputDir, "llms.txt") });
  }
);

server.tool(
  "ai_query_website",
  {
    target: z.string(),
    datapoints: z.array(
      z.object({
        name: z.string(),
        description: z.string(),
        type: z.enum(["text", "number", "boolean", "list", "object"]),
        example: z.unknown().optional()
      })
    )
  },
  async ({ target, datapoints }) => text(await aiQueryWebsite(target, datapoints as AiDatapoint[]))
);

server.tool(
  "remember_site_snapshot",
  {
    runDir: z.string(),
    namespace: z.string().optional()
  },
  async ({ runDir, namespace }) => {
    const manifest = JSON.parse(await fs.readFile(path.resolve(runDir, "context", "manifest.json"), "utf8"));
    const resolvedNamespace = namespace ?? namespaceForTarget(manifest.target, manifest.walrus ? "walrus" : "web", manifest.walrus?.site?.network, manifest.walrus?.site?.siteObjectId);
    const snapshot: SiteSnapshot = {
      namespace: resolvedNamespace,
      target: manifest.target,
      createdAt: new Date().toISOString(),
      summary: "",
      pages: manifest.pages,
      brand: manifest.brand,
      styleguide: manifest.styleguide,
      designSystem: manifest.designSystem,
      aiQuery: manifest.aiQuery,
      walrus: manifest.walrus
    };
    snapshot.summary = summarizeSnapshot(snapshot);
    const result = await new MemWalMcpClient().rememberSnapshot(snapshot);
    return text({ namespace: resolvedNamespace, result });
  }
);

server.tool(
  "recall_site_context",
  {
    namespace: z.string(),
    query: z.string()
  },
  async ({ namespace, query }) => text(await new MemWalMcpClient().recallSiteContext(namespace, query))
);

server.tool(
  "query_site_memory",
  {
    namespace: z.string(),
    query: z.string()
  },
  async ({ namespace, query }) => text(await new MemWalMcpClient().analyzeSiteMemory(namespace, query))
);

server.tool(
  "list_contextmem_runs",
  {
    limit: z.number().int().min(1).max(500).default(50)
  },
  async ({ limit }) => text(await listRuns(runsDir, limit))
);

server.tool(
  "view_contextmem_artifact",
  {
    runId: z.string(),
    path: z.string().describe("Artifact path such as /context/manifest.json")
  },
  async ({ runId, path: artifactPath }) => {
    const runDir = path.resolve(runsDir, runId);
    const { absolutePath, record } = await resolveArtifactFile(runDir, artifactPath);
    const body = await fs.readFile(absolutePath);
    const textLike = ["json", "markdown", "html", "css", "text"].includes(record.kind);
    return text({
      record,
      content: textLike ? body.toString("utf8") : body.toString("base64"),
      encoding: textLike ? "utf8" : "base64"
    });
  }
);

server.tool(
  "diff_site_snapshots",
  {
    runId: z.string(),
    compareToRunId: z.string().optional()
  },
  async ({ runId, compareToRunId }) => text(await diffRunSnapshots(runsDir, runId, compareToRunId))
);

server.tool(
  "inspect_walrus_history",
  {
    target: z.string(),
    network: z.enum(["testnet", "mainnet"]).default("mainnet"),
    limit: z.number().int().min(1).max(100).default(30),
    maxTransactions: z.number().int().min(1).max(2000).default(500)
  },
  async ({ target, network, limit, maxTransactions }) => {
    const site = await resolveWalrusTarget(target, { network: network as Network });
    return text(await getWalrusSiteHistory(site, { limit, maxTransactions }));
  }
);

return server;
}

function text(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createLocalContextMemMcpServer();
  await server.connect(new StdioServerTransport());
}
