#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  aiQueryWebsite,
  buildAgentReadableSite,
  buildChunks,
  buildPublishReadiness,
  captureScreenshots,
  chunkGraphDigest,
  crawlSitemap,
  crawlWebSite,
  createRunId,
  diffRunSnapshots,
  extractBrandProfile,
  extractDesignSystem,
  extractStyleguide,
  findPriorRunForNamespace,
  listArtifactFiles,
  listRuns,
  namespaceForTarget,
  parseChunksNdjson,
  renderChunksNdjson,
  scrapeWebPage,
  verifySnapshot,
  type AiDatapoint,
  type ContextChunk,
  type Network,
  type PageArtifact
} from "@contextmem/core";
import { MemWalMcpClient, MemWalSdkClient, selectMemWalTransport, summarizeSnapshot, type SiteSnapshot } from "@contextmem/memwal";

type MemWalAnyClient = MemWalMcpClient | MemWalSdkClient;
function memwalClient(transport?: string): MemWalAnyClient {
  const choice = selectMemWalTransport(transport === "sdk" || transport === "mcp" ? transport : "auto");
  return choice === "sdk" ? new MemWalSdkClient() : memwalClient(process.env.MEMWAL_TRANSPORT);
}
import { getWalrusSiteHistory, materializeWalrusSite, resolveWalrusTarget, startWalrusPreview } from "@contextmem/walrus";

const program = new Command();
const runsDir = path.resolve(process.env.CONTEXTMEM_RUNS_DIR ?? "runs");

program.name("contextmem").description("Walrus-native context extraction tools for agents").version("0.1.0");

const web = program.command("web").description("Generic website extraction");
web
  .command("scrape")
  .argument("<url>", "URL or domain")
  .option("--json", "Print full JSON")
  .action(async (url, options) => {
    const page = await scrapeWebPage({ url, includeImages: true, includeLinks: true });
    print(options.json ? page : { url: page.url, title: page.title, markdown: page.markdown });
  });

web
  .command("crawl")
  .argument("<url>", "URL or domain")
  .option("--max-pages <n>", "Maximum pages", numberOption, 25)
  .option("--max-depth <n>", "Maximum depth", numberOption, 2)
  .action(async (url, options) => {
    const pages = await crawlWebSite(url, { maxPages: options.maxPages, maxDepth: options.maxDepth, includeImages: true });
    print({ count: pages.length, pages: pages.map((page) => ({ url: page.url, title: page.title, hash: page.contentHash })) });
  });

web
  .command("sitemap")
  .argument("<domain>", "Domain")
  .option("--max-links <n>", "Maximum links", numberOption, 10000)
  .action(async (domain, options) => {
    print(await crawlSitemap(domain, options.maxLinks));
  });

web
  .command("brand")
  .argument("<target>", "Domain, email, name, or ticker")
  .action(async (target) => {
    print(await extractBrandProfile(target));
  });

web
  .command("styleguide")
  .argument("<target>", "URL or domain")
  .action(async (target) => {
    print(await extractStyleguide(target));
  });

web
  .command("design-system")
  .argument("<target>", "URL or domain")
  .action(async (target) => {
    print(await extractDesignSystem(target));
  });

const walrus = program.command("walrus").description("Walrus Site extraction");
walrus
  .command("inspect")
  .argument("<target>", "0x object ID, config JSON, or localhost preview URL")
  .option("--testnet", "Use testnet defaults")
  .option("--mainnet", "Use mainnet defaults")
  .action(async (target, options) => {
    const network = networkFromOptions(options);
    const site = await resolveWalrusTarget(target, { network });
    const outputDir = path.resolve("runs", createRunId("walrus-inspect"));
    const materialized = await materializeWalrusSite(site, outputDir);
    print({
      site,
      outputDir,
      resources: materialized.resources.length,
      pages: materialized.pages.length,
      context: path.join(outputDir, "context", "manifest.json")
    });
  });

walrus
  .command("extract")
  .argument("<target>", "0x object ID, config JSON, or localhost preview URL")
  .option("--testnet", "Use testnet defaults")
  .option("--mainnet", "Use mainnet defaults")
  .option("--out <dir>", "Output directory")
  .action(async (target, options) => {
    const site = await resolveWalrusTarget(target, { network: networkFromOptions(options) });
    const outputDir = path.resolve(options.out ?? "runs", options.out ? "" : createRunId("walrus-extract"));
    const materialized = await materializeWalrusSite(site, outputDir);
    print({
      outputDir,
      resources: materialized.resources.length,
      pages: materialized.pages.map((page) => ({ route: page.routePath, title: page.title, blobId: page.source?.blobId }))
    });
  });

walrus
  .command("preview")
  .argument("<targetOrRunDir>", "0x object ID, config JSON, localhost preview URL, or materialized run directory")
  .option("--testnet", "Use testnet defaults")
  .option("--mainnet", "Use mainnet defaults")
  .option("--port <n>", "Port", numberOption, 3000)
  .action(async (targetOrRunDir, options) => {
    let siteDir = path.resolve(targetOrRunDir, "site");
    try {
      await fs.access(siteDir);
    } catch {
      const site = await resolveWalrusTarget(targetOrRunDir, { network: networkFromOptions(options) });
      const outputDir = path.resolve("runs", createRunId("walrus-preview"));
      const materialized = await materializeWalrusSite(site, outputDir);
      siteDir = materialized.siteDir;
    }
    const preview = await startWalrusPreview(siteDir, { port: options.port });
    console.log(`Preview: ${preview.url}`);
    console.log("Press Ctrl+C to stop.");
  });

walrus
  .command("package")
  .argument("<runDir>", "Run directory produced by walrus extract")
  .action(async (runDir) => {
    const manifestPath = path.resolve(runDir, "context", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    print({ package: manifest.outputDir, manifest: manifestPath });
  });

walrus
  .command("history")
  .argument("<target>", "0x object ID or wal.app URL")
  .option("--testnet", "Use testnet defaults")
  .option("--mainnet", "Use mainnet defaults")
  .option("--limit <n>", "Maximum matching updates", numberOption, 30)
  .option("--max-transactions <n>", "Maximum owner transactions to scan", numberOption, 500)
  .action(async (target, options) => {
    const site = await resolveWalrusTarget(target, { network: networkFromOptions(options) });
    print(await getWalrusSiteHistory(site, { limit: options.limit, maxTransactions: options.maxTransactions }));
  });

program
  .command("ask")
  .argument("<target>", "URL/domain/Walrus object ID")
  .requiredOption("--schema <file>", "JSON schema datapoints file")
  .option("--walrus", "Treat target as a Walrus Site")
  .option("--testnet", "Use testnet defaults")
  .option("--mainnet", "Use mainnet defaults")
  .action(async (target, options) => {
    const datapoints = JSON.parse(await fs.readFile(path.resolve(options.schema), "utf8")) as AiDatapoint[];
    let pages: PageArtifact[] | undefined;
    if (options.walrus) {
      const site = await resolveWalrusTarget(target, { network: networkFromOptions(options) });
      const outputDir = path.resolve("runs", createRunId("walrus-ask"));
      const materialized = await materializeWalrusSite(site, outputDir);
      pages = materialized.pages;
    }
    print(await aiQueryWebsite(target, datapoints, pages));
  });

const memwal = program.command("memwal").description("MemWal snapshot memory");
memwal
  .command("remember")
  .argument("<runDir>", "ContextMeM run directory")
  .option("--namespace <namespace>", "Override MemWal namespace")
  .option("--full", "Force a full snapshot write instead of the delta path")
  .option("--prior-run-dir <dir>", "Override the auto-detected prior run for delta comparison")
  .action(async (runDir, options) => {
    const absRunDir = resolveRunDirInput(runDir);
    const runId = path.basename(absRunDir);
    const manifestPath = path.resolve(absRunDir, "context", "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const namespace = options.namespace ?? namespaceForTarget(manifest.target, manifest.walrus ? "walrus" : "web", manifest.walrus?.site?.network, manifest.walrus?.site?.siteObjectId);
    const createdAt = new Date().toISOString();

    // Always build + persist current chunks so the next remember can delta against it.
    const pages = (manifest.pages ?? []) as PageArtifact[];
    const currentChunks = buildChunks(pages);
    const chunksPath = path.resolve(absRunDir, "context", "chunks.ndjson");
    await fs.mkdir(path.dirname(chunksPath), { recursive: true });
    await fs.writeFile(chunksPath, renderChunksNdjson(currentChunks), "utf8");

    if (options.full) {
      const snapshot: SiteSnapshot = {
        namespace,
        target: manifest.target,
        createdAt,
        summary: `ContextMeM snapshot for ${manifest.target}`,
        pages: manifest.pages,
        brand: manifest.brand,
        styleguide: manifest.styleguide,
        designSystem: manifest.designSystem,
        aiQuery: manifest.aiQuery,
        walrus: manifest.walrus
      };
      snapshot.summary = summarizeSnapshot(snapshot);
      const result = await memwalClient(process.env.MEMWAL_TRANSPORT).rememberSnapshot(snapshot);
      print({ namespace, mode: "full", chunkCount: currentChunks.length, result });
      return;
    }

    // Locate prior run: explicit flag wins, else auto-detect by namespace.
    const priorRunDir = options.priorRunDir
      ? resolveRunDirInput(options.priorRunDir)
      : await findPriorRunForNamespace(runsDir, runId, namespace);
    let priorChunks: ContextChunk[] = [];
    if (priorRunDir) {
      try {
        const priorText = await fs.readFile(path.resolve(priorRunDir, "context", "chunks.ndjson"), "utf8");
        priorChunks = parseChunksNdjson(priorText);
      } catch {
        // No persisted chunks for the prior run (older format) — treat as no prior; everything becomes "added".
      }
    }

    const result = await memwalClient(process.env.MEMWAL_TRANSPORT).rememberSnapshotDelta({
      namespace,
      target: manifest.target,
      createdAt,
      chunks: currentChunks,
      priorChunks,
      chunkGraphDigest: chunkGraphDigest(currentChunks)
    });
    print({ mode: "delta", priorRunDir: priorRunDir ?? null, ...result });
  });

memwal
  .command("recall")
  .argument("<namespace>", "MemWal namespace")
  .argument("<query>", "Recall query")
  .action(async (namespace, query) => {
    print(await memwalClient(process.env.MEMWAL_TRANSPORT).recallSiteContext(namespace, query));
  });

memwal
  .command("query")
  .argument("<namespace>", "MemWal namespace")
  .argument("<query>", "Analysis query")
  .action(async (namespace, query) => {
    print(await memwalClient(process.env.MEMWAL_TRANSPORT).analyzeSiteMemory(namespace, query));
  });

memwal
  .command("restore")
  .description("Rebuild MemWal indexed memory for a namespace from Walrus blobs")
  .argument("<namespace>", "MemWal namespace")
  .action(async (namespace) => {
    print(await memwalClient(process.env.MEMWAL_TRANSPORT).restoreSiteMemory(namespace));
  });

const runs = program.command("runs").description("Inspect local ContextMeM runs and artifacts");
runs
  .command("list")
  .option("--limit <n>", "Maximum runs", numberOption, 50)
  .action(async (options) => {
    print(await listRuns(runsDir, options.limit));
  });

runs
  .command("artifacts")
  .argument("<runId>", "Run ID or run directory")
  .option("--readiness", "Include publish readiness")
  .action(async (runId, options) => {
    const runDir = resolveRunDirInput(runId);
    const files = await listArtifactFiles(runDir);
    const readiness = options.readiness ? await buildPublishReadiness(runDir, path.basename(runDir)) : undefined;
    print({ runDir, files, readiness });
  });

runs
  .command("diff")
  .argument("<runId>", "Base run ID")
  .argument("[compareToRunId]", "Run ID to compare against")
  .action(async (runId, compareToRunId) => {
    print(await diffRunSnapshots(runsDir, runId, compareToRunId));
  });

runs
  .command("verify")
  .description("Recompute a run's snapshot digests and signature, and report any drift")
  .argument("<runId>", "Run ID or run directory")
  .action(async (runId) => {
    const result = await verifySnapshot(resolveRunDirInput(runId));
    print(result);
    if (!result.ok) process.exitCode = 1;
  });

program
  .command("package-web")
  .argument("<target>", "URL or domain")
  .option("--max-pages <n>", "Maximum pages", numberOption, 8)
  .option("--out <dir>", "Output directory")
  .action(async (target, options) => {
    const runId = createRunId("web-package");
    const outputDir = path.resolve(options.out ?? "runs", options.out ? "" : runId);
    const pages = await crawlWebSite(target, { maxPages: options.maxPages, maxDepth: 1, includeImages: true });
    const brand = await extractBrandProfile(target).catch(() => undefined);
    const styleguide = await extractStyleguide(target).catch(() => undefined);
    const designSystem = await extractDesignSystem(target, pages, brand).catch(() => undefined);
    const screenshots = await captureScreenshots({ outputDir, pages, designSystem }).catch(() => undefined);
    const manifest = await buildAgentReadableSite({
      runId,
      target,
      outputDir,
      pages,
      brand,
      styleguide,
      designSystem,
      screenshots: screenshots?.screenshots,
      componentPreviews: screenshots?.componentPreviews
    });
    print({ outputDir, manifest: path.join(manifest.contextDir, "manifest.json") });
  });

program
  .command("doctor")
  .description("Run a readiness check against env vars, network, MemWal, and Walrus aggregator")
  .option("--json", "Print full JSON report")
  .action(async (options) => {
    const checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string }> = [];

    if (process.env.MEMWAL_AUTHORIZATION) {
      checks.push({ name: "env:MEMWAL_AUTHORIZATION", status: "ok", detail: "set" });
    } else if (process.env.MEMWAL_BEARER) {
      checks.push({
        name: "env:MEMWAL_AUTHORIZATION",
        status: "warn",
        detail: "MEMWAL_BEARER is deprecated; rename to MEMWAL_AUTHORIZATION (with 'Bearer ' prefix)"
      });
    } else {
      checks.push({ name: "env:MEMWAL_AUTHORIZATION", status: "warn", detail: "missing — MemWal recall/remember disabled" });
    }

    if (process.env.CONTEXTMEM_ACCOUNT_SECRET && process.env.CONTEXTMEM_ACCOUNT_SECRET.length >= 32) {
      checks.push({ name: "env:CONTEXTMEM_ACCOUNT_SECRET", status: "ok", detail: `length=${process.env.CONTEXTMEM_ACCOUNT_SECRET.length}` });
    } else {
      checks.push({ name: "env:CONTEXTMEM_ACCOUNT_SECRET", status: "warn", detail: "missing or shorter than 32 chars — run `Generate secret` in /app/settings" });
    }

    if (process.env.OPENAI_API_KEY) {
      checks.push({ name: "env:OPENAI_API_KEY", status: "ok", detail: "set" });
    } else {
      checks.push({ name: "env:OPENAI_API_KEY", status: "warn", detail: "missing — AI Query disabled" });
    }

    const targets: Array<{ name: string; url: string }> = [
      { name: "net:walrus-aggregator", url: process.env.WALRUS_AGGREGATOR_URL ?? "https://aggregator.walrus-mainnet.walrus.space" },
      { name: "net:sui-rpc", url: process.env.SUI_FULLNODE_URL ?? "https://fullnode.mainnet.sui.io" }
    ];
    if (process.env.MEMWAL_BASE_URL) targets.push({ name: "net:memwal", url: process.env.MEMWAL_BASE_URL });

    await Promise.all(
      targets.map(async ({ name, url }) => {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 4000);
          const response = await fetch(url, { method: "HEAD", signal: controller.signal }).catch(async () =>
            fetch(url, { method: "GET", signal: controller.signal })
          );
          clearTimeout(timeout);
          checks.push({ name, status: response.ok || response.status < 500 ? "ok" : "fail", detail: `${response.status} ${response.statusText}` });
        } catch (error) {
          checks.push({ name, status: "fail", detail: error instanceof Error ? error.message : String(error) });
        }
      })
    );

    if (options.json) {
      print({ checks });
    } else {
      for (const check of checks) {
        const symbol = check.status === "ok" ? "[ ok ]" : check.status === "warn" ? "[warn]" : "[fail]";
        console.log(`${symbol} ${check.name} — ${check.detail}`);
      }
      const failed = checks.filter((check) => check.status === "fail").length;
      if (failed > 0) process.exitCode = 1;
    }
  });

function networkFromOptions(options: { testnet?: boolean; mainnet?: boolean }): Network {
  if (options.testnet) return "testnet";
  return "mainnet";
}

function numberOption(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`Invalid number: ${value}`);
  return n;
}

function resolveRunDirInput(input: string): string {
  if (input.includes("/") || input.includes(path.sep)) return path.resolve(input);
  return path.resolve(runsDir, input);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
}
