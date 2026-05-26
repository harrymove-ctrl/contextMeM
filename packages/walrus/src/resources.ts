import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import pLimit from "p-limit";
import { XMLParser } from "fast-xml-parser";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import type { BuildProfile, DiscoveryStats, ImageAsset, PageArtifact, RunCacheStats, RunProgress, WalrusResourceRecord, WalrusSiteContext } from "@contextmem/core";
import {
  buildAgentReadableSite,
  buildBrandProfileFromPages,
  buildDesignSystemFromPages,
  buildStyleguideFromStyleSources,
  captureScreenshots,
  comparePageRoutes,
  detectContentType,
  extractHtmlMetadata,
  extractImages,
  extractLinks,
  htmlToMarkdown,
  imageAssetsFromResourcePaths,
  inlineStyleSourcesFromPage,
  isUtilityPageRoute,
  pathToRoute,
  safeJoin,
  sha256Base64,
  sha256Hex,
  type StyleSource
} from "@contextmem/core";
import { DynamicFieldStruct, ResourcePathStruct, ResourceStruct } from "./bcs.js";
import { blobAggregatorEndpoint, deriveQuiltPatchId, quiltAggregatorEndpoint } from "./quilt.js";

export type WalrusProgressCallback = (progress: Omit<RunProgress, "updatedAt">) => void | Promise<void>;

export type WalrusResourceListOptions = {
  concurrency?: number;
  onProgress?: WalrusProgressCallback;
};

export type WalrusResourceFetchOptions = {
  cacheDir?: string;
  cacheStats?: RunCacheStats;
};

export type MaterializeWalrusOptions = {
  outputs?: string[];
  concurrency?: number;
  discoveryMode?: BuildProfile;
  cacheDir?: string;
  captureScreenshots?: boolean;
  resources?: WalrusResourceRecord[];
  onProgress?: WalrusProgressCallback;
};

const DEFAULT_WALRUS_CONCURRENCY = 6;

export function emptyWalrusCacheStats(): RunCacheStats {
  return {
    hits: 0,
    misses: 0,
    writes: 0,
    bytesRead: 0,
    bytesWritten: 0
  };
}

export async function listWalrusResources(site: WalrusSiteContext, options: WalrusResourceListOptions = {}): Promise<WalrusResourceRecord[]> {
  const client = new SuiGrpcClient({ network: site.network, baseUrl: site.rpcUrl });
  const dynamicFields = await getAllDynamicFields(client, site.siteObjectId);
  const limit = pLimit(normalizeConcurrency(options.concurrency));
  let completed = 0;
  await options.onProgress?.({
    phase: "listing_resources",
    label: "Reading Walrus resource metadata",
    itemsDone: 0,
    itemsTotal: dynamicFields.length
  });

  const resources: Array<WalrusResourceRecord | undefined> = await Promise.all(
    dynamicFields.map((field) =>
      limit(async () => {
        try {
          const objectId = field.objectId;
          const response = await client.getObject({ objectId, include: { content: true, display: true } });
          const data = response.object;
          if (!data?.content) return undefined;
          const parsed = DynamicFieldStruct(ResourcePathStruct, ResourceStruct).parse(data.content);
          const value = parsed.value as {
            path: string;
            headers: Map<string, string> | Record<string, string>;
            blob_id: string;
            blob_hash: string;
            range: { start: number | null; end: number | null } | null;
          };
          const headers = normalizeHeaders(value.headers);
          const quiltPatchInternalId = headers["x-wal-quilt-patch-internal-id"];
          const quiltPatchId = quiltPatchInternalId ? deriveQuiltPatchId(value.blob_id, quiltPatchInternalId) : undefined;
          const resourceRecord: WalrusResourceRecord = {
            path: pathToRoute(value.path),
            dynamicFieldObjectId: objectId,
            version: data.version,
            headers,
            blobId: value.blob_id,
            blobHash: value.blob_hash,
            range: value.range,
            quiltPatchInternalId,
            quiltPatchId,
            contentType: headers["content-type"] ?? detectContentType(value.path),
            aggregatorUrl: site.aggregatorUrl
          };
          return resourceRecord;
        } catch {
          return undefined;
        } finally {
          completed++;
          await options.onProgress?.({
            phase: "listing_resources",
            label: "Reading Walrus resource metadata",
            itemsDone: completed,
            itemsTotal: dynamicFields.length
          });
        }
      })
    )
  );

  return resources.filter((resource): resource is WalrusResourceRecord => Boolean(resource)).sort((a, b) => a.path.localeCompare(b.path));
}

export async function fetchWalrusResource(site: WalrusSiteContext, resource: WalrusResourceRecord, options: WalrusResourceFetchOptions = {}): Promise<{ body: Buffer; record: WalrusResourceRecord }> {
  const cached = await readCachedWalrusResource(site, resource, options);
  if (cached) return cached;

  const endpoint = resource.quiltPatchId
    ? quiltAggregatorEndpoint(resource.quiltPatchId, site.aggregatorUrl)
    : blobAggregatorEndpoint(resource.blobId, site.aggregatorUrl);
  const headers: Record<string, string> = {};
  if (resource.range) {
    const start = resource.range.start ?? "";
    const end = resource.range.end ?? "";
    headers.range = `bytes=${start}-${end}`;
  }
  const response = await fetch(endpoint, { headers });
  if (!response.ok) throw new Error(`Walrus aggregator ${response.status} for ${resource.path}`);
  const body = Buffer.from(await response.arrayBuffer());
  const bodyHash = sha256Base64(body);
  if (bodyHash !== resource.blobHash) {
    throw new Error(`Hash mismatch for ${resource.path}: expected ${resource.blobHash}, got ${bodyHash}`);
  }
  await writeCachedWalrusResource(site, resource, body, options);
  return {
    body,
    record: {
      ...resource,
      byteLength: body.byteLength,
      verified: true,
      cacheStatus: options.cacheDir ? "miss" : "disabled",
      contentType: resource.contentType ?? response.headers.get("content-type") ?? detectContentType(resource.path)
    }
  };
}

export type MaterializedWalrusSite = {
  site: WalrusSiteContext;
  resources: WalrusResourceRecord[];
  siteDir: string;
  contextDir: string;
  pages: PageArtifact[];
  discovery: DiscoveryStats;
  timings: Record<string, number>;
  cacheStats: RunCacheStats;
};

type WalrusRouteDiscovery = {
  sitemapUrls: string[];
  portalUrls: string[];
  linkedUrls: string[];
  markdownResourcePaths: string[];
  sitemapSources: string[];
  fetchErrors: number;
  totalCandidates: number;
};

export async function materializeWalrusSite(site: WalrusSiteContext, outputDir: string, options: MaterializeWalrusOptions = {}): Promise<MaterializedWalrusSite> {
  const siteDir = path.join(outputDir, "site");
  const contextDir = path.join(outputDir, "context");
  await fs.mkdir(siteDir, { recursive: true });
  await fs.mkdir(contextDir, { recursive: true });

  const outputs = new Set(options.outputs ?? ["markdown", "images", "brand", "styleguide", "sitemap", "screenshots"]);
  const includeImages = outputs.has("images") || outputs.has("brand") || outputs.has("styleguide");
  const includeBrand = outputs.has("brand") || outputs.has("styleguide");
  const includeStyleguide = outputs.has("styleguide");
  const includeDesignSystem = outputs.has("styleguide");
  const includeScreenshots = options.captureScreenshots ?? outputs.has("screenshots");
  const timings: Record<string, number> = {};
  const cacheStats = emptyWalrusCacheStats();
  const concurrency = normalizeConcurrency(options.concurrency);
  const discoveryMode = options.discoveryMode ?? inferWalrusDiscoveryMode(outputs, includeScreenshots);

  const listed = [...(await measure(timings, "listResources", () => (options.resources ? Promise.resolve(options.resources) : listWalrusResources(site, { concurrency, onProgress: options.onProgress }))))].sort((a, b) => a.path.localeCompare(b.path));
  const limit = pLimit(concurrency);
  let downloaded = 0;
  await options.onProgress?.({
    phase: "downloading_resources",
    label: "Downloading verified Walrus resources",
    itemsDone: 0,
    itemsTotal: listed.length
  });
  const fetched = await measure(
    timings,
    "downloadResources",
    () =>
      Promise.all(
        listed.map((resource) =>
          limit(async () => {
            try {
              const { body, record } = await fetchWalrusResource(site, resource, { cacheDir: options.cacheDir, cacheStats });
              const filePath = safeJoin(siteDir, resource.path);
              await fs.mkdir(path.dirname(filePath), { recursive: true });
              await fs.writeFile(filePath, body);
              return { ...record, localPath: path.relative(outputDir, filePath) };
            } catch (error) {
              return {
                ...resource,
                verified: false,
                cacheStatus: options.cacheDir ? "miss" : "disabled",
                error: error instanceof Error ? error.message : String(error)
              } satisfies WalrusResourceRecord;
            } finally {
              downloaded++;
              await options.onProgress?.({
                phase: "downloading_resources",
                label: "Downloading verified Walrus resources",
                itemsDone: downloaded,
                itemsTotal: listed.length
              });
            }
          })
        )
      )
  );

  await options.onProgress?.({ phase: "extracting_pages", label: "Discovering routes and extracting markdown pages" });
  const routeDiscovery = await measure(timings, "discoverRoutes", () => discoverWalrusRouteCandidates(site, siteDir, fetched, discoveryMode));
  const pageResult = await measure(timings, "extractPages", () => pagesFromMaterializedSite(site, siteDir, fetched, routeDiscovery, concurrency));
  const pages = pageResult.pages;
  const discovery: DiscoveryStats = {
    strategy: "walrus",
    profile: discoveryMode,
    totalCandidates: routeDiscovery.totalCandidates,
    pagesEmitted: pages.length,
    skippedUtilityOrRedirect: pageResult.skippedUtilityOrRedirect,
    sitemapSources: routeDiscovery.sitemapSources,
    markdownFallbacks: pageResult.markdownFallbacks,
    fetchErrors: routeDiscovery.fetchErrors + pageResult.fetchErrors
  };
  let styleSources: StyleSource[] = [];
  let styleguide: ReturnType<typeof buildStyleguideFromStyleSources> | undefined;
  let brand: ReturnType<typeof buildBrandProfileFromPages> | undefined;
  let designSystem: ReturnType<typeof buildDesignSystemFromPages> | undefined;
  let images: ImageAsset[] = [];

  if (includeStyleguide || includeBrand || includeDesignSystem) {
    await options.onProgress?.({ phase: "extracting_metadata", label: "Building brand and design metadata" });
    styleSources = await measure(timings, "extractStyles", () => styleSourcesFromMaterializedSite(siteDir, pages, fetched));
    const metadataStyleguide = buildStyleguideFromStyleSources(styleSources);
    styleguide = includeStyleguide ? metadataStyleguide : undefined;
    const resourceImages = includeImages ? imageAssetsFromResourcePaths(fetched.map((resource) => resource.path), site.portalUrl ?? "http://localhost/") : [];
    images = includeImages ? uniqueImages([...resourceImages, ...pages.flatMap((page) => page.images)]) : [];
    brand = includeBrand
      ? buildBrandProfileFromPages(site.portalUrl ?? site.suinsName ?? site.siteObjectId, pages, {
          images,
          colors: metadataStyleguide.colors.palette,
          fonts: metadataStyleguide.typography.fontFamilies
        })
      : undefined;
    designSystem = includeDesignSystem
      ? buildDesignSystemFromPages({
          target: site.portalUrl ?? site.suinsName ?? site.siteObjectId,
          pages,
          brand,
          styleSources,
          resources: fetched
        })
      : undefined;
  }
  let screenshots: Awaited<ReturnType<typeof captureScreenshots>>["screenshots"] | undefined;
  let componentPreviews: Awaited<ReturnType<typeof captureScreenshots>>["componentPreviews"] | undefined;
  let preview: Awaited<ReturnType<typeof startWalrusPreview>> | undefined;

  if (includeScreenshots) {
    await options.onProgress?.({ phase: "capturing_screenshots", label: "Capturing full-page screenshots and component previews" });
    try {
      await measure(timings, "captureScreenshots", async () => {
        preview = await startWalrusPreview(siteDir, { port: 0 });
        const captured = await captureScreenshots({
          outputDir,
          baseUrl: preview.url,
          pages,
          designSystem
        });
        screenshots = captured.screenshots;
        componentPreviews = captured.componentPreviews;
      });
    } catch {
      screenshots = undefined;
      componentPreviews = undefined;
    } finally {
      await preview?.close().catch(() => undefined);
    }
  }

  await options.onProgress?.({ phase: "building_artifacts", label: "Writing agent-readable context artifacts" });
  await measure(timings, "buildArtifacts", () => buildAgentReadableSite({
    runId: path.basename(outputDir),
    target: site.siteObjectId,
    outputDir,
    pages,
    sitemap: {
      target: site.siteObjectId,
      urls: uniqueStrings([
        ...routeDiscovery.sitemapUrls.map((url) => pathFromUrl(url)),
        ...routeDiscovery.linkedUrls.map((url) => pathFromUrl(url)),
        ...routeDiscovery.markdownResourcePaths,
        ...fetched.map((resource) => resource.path)
      ]),
      meta: {
        sitemapsDiscovered: routeDiscovery.sitemapSources.length,
        sitemapsFetched: routeDiscovery.sitemapSources.length,
        sitemapsSkipped: 0,
        errors: routeDiscovery.fetchErrors
      }
    },
    discovery,
    images: includeImages ? images : [],
    brand,
    styleguide,
    designSystem,
    screenshots,
    componentPreviews,
    walrus: { site, resources: fetched }
  }));

  return {
    site,
    resources: fetched,
    siteDir,
    contextDir,
    pages,
    discovery,
    timings,
    cacheStats
  };
}

function inferWalrusDiscoveryMode(outputs: Set<string>, includeScreenshots: boolean): BuildProfile {
  if (includeScreenshots || outputs.has("screenshots")) return "full";
  if (outputs.has("images") || outputs.has("brand") || outputs.has("styleguide")) return "balanced";
  return "fast";
}

export function startWalrusPreview(siteDir: string, options: { host?: string; port?: number } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const host = options.host ?? "localhost";
  const requestedPort = options.port ?? 3000;
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
      const route = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
      let filePath: string;
      try {
        filePath = safeJoin(siteDir, route);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Bad request");
        return;
      }
      let body: Buffer;
      try {
        body = await fs.readFile(filePath);
      } catch {
        body = await fs.readFile(path.join(siteDir, "index.html"));
        filePath = path.join(siteDir, "index.html");
      }
      res.writeHead(200, {
        "content-type": detectContentType(filePath),
        "cache-control": "no-cache"
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(error instanceof Error ? error.message : "Internal server error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : requestedPort;
      resolve({
        url: `http://${host}:${port}`,
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          })
      });
    });
  });
}

async function pagesFromMaterializedSite(
  site: WalrusSiteContext,
  siteDir: string,
  resources: WalrusResourceRecord[],
  routeDiscovery: WalrusRouteDiscovery,
  concurrency = DEFAULT_WALRUS_CONCURRENCY
): Promise<{ pages: PageArtifact[]; skippedUtilityOrRedirect: number; markdownFallbacks: number; fetchErrors: number }> {
  const htmlResources = resources
    .filter((resource) => /html/i.test(resource.contentType ?? "") || /\.html?$/i.test(resource.path))
    .sort((a, b) => comparePageRoutes(a.path, b.path));
  const candidates: PageArtifact[] = [];
  let skippedUtilityOrRedirect = 0;
  let markdownFallbacks = 0;
  let fetchErrors = 0;
  for (const resource of htmlResources) {
    if (isUtilityPageRoute(resource.path)) {
      skippedUtilityOrRedirect++;
      continue;
    }
    if (!resource.localPath || resource.error) continue;
    const filePath = safeJoin(siteDir, resource.path);
    let html: string;
    try {
      html = await fs.readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const url = `walrus://${site.network}/${site.siteObjectId}${resource.path}`;
    const publicUrl = publicResourceUrl(site, resource.path);
    const metadata = extractHtmlMetadata(publicUrl, html);
    const markdown = htmlToMarkdown(publicUrl, html, true);
    if (isRedirectOnlyHtml(html, markdown.text)) {
      skippedUtilityOrRedirect++;
      continue;
    }
    const routePath = normalizeCanonicalRoute(canonicalRouteFromMetadata(site, metadata) ?? resource.path);
    if (!isInPortalScope(site, routePath)) {
      skippedUtilityOrRedirect++;
      continue;
    }
    candidates.push({
      url,
      routePath,
      title: markdown.title ?? metadata.title,
      statusCode: 200,
      contentType: resource.contentType,
      markdown: markdown.markdown,
      html,
      text: markdown.text,
      metadata,
      links: extractLinks(publicUrl, html),
      images: extractImages(publicUrl, html),
      contentHash: sha256Hex(html),
      source: {
        kind: "walrus",
        resourcePath: resource.path,
        blobId: resource.blobId,
        blobHash: resource.blobHash,
        quiltPatchId: resource.quiltPatchId
      }
    });
  }

  const portalUrls = routeDiscovery.portalUrls.filter((url) => shouldFetchPortalPage(site, url));
  const existingKeys = new Set(candidates.map((page) => pageCanonicalKey(site, page)));
  const limit = pLimit(Math.min(8, normalizeConcurrency(concurrency)));
  const portalPages = await Promise.all(
    portalUrls.map((url) =>
      limit(async () => {
        if (existingKeys.has(canonicalKeyFromUrl(site, url))) return undefined;
        try {
          const page = await fetchPortalPage(site, url);
          if (page) existingKeys.add(pageCanonicalKey(site, page));
          return page;
        } catch {
          fetchErrors++;
          return undefined;
        }
      })
    )
  );
  candidates.push(...portalPages.filter((page): page is PageArtifact => Boolean(page)));

  for (const resource of resources.filter((item) => isMarkdownResource(item)).sort((a, b) => comparePageRoutes(a.path, b.path))) {
    if (!resource.localPath || resource.error) continue;
    const routePath = canonicalRouteFromMarkdownPath(resource.path);
    if (isUtilityPageRoute(routePath) || existingKeys.has(canonicalKeyFromUrl(site, routePath))) continue;
    let markdown: string;
    try {
      markdown = await fs.readFile(safeJoin(siteDir, resource.path), "utf8");
    } catch {
      continue;
    }
    if (!markdown.trim()) continue;
    const page = pageFromMarkdownResource(site, resource, markdown, routePath);
    candidates.push(page);
    existingKeys.add(pageCanonicalKey(site, page));
    markdownFallbacks++;
  }

  const pages = dedupePages(site, candidates);
  return { pages, skippedUtilityOrRedirect, markdownFallbacks, fetchErrors };
}

function publicResourceUrl(site: WalrusSiteContext, resourcePath: string): string {
  try {
    return new URL(resourcePath, site.portalUrl ?? "http://localhost/").toString();
  } catch {
    return `http://localhost${resourcePath}`;
  }
}

async function discoverWalrusRouteCandidates(site: WalrusSiteContext, siteDir: string, resources: WalrusResourceRecord[], mode: BuildProfile): Promise<WalrusRouteDiscovery> {
  const sitemap = await discoverSitemapUrls(site, siteDir, mode);
  const linkedUrls = mode === "full" ? await discoverLinkedPortalUrls(site, siteDir, resources) : [];
  const markdownResourcePaths = resources.filter((resource) => isMarkdownResource(resource)).map((resource) => canonicalRouteFromMarkdownPath(resource.path));
  const portalUrls = mode === "fast" ? [] : uniqueStrings([...sitemap.urls, ...linkedUrls]).filter((url) => shouldFetchPortalPage(site, url));
  const totalCandidates = uniqueStrings([...resources.map((resource) => resource.path), ...portalUrls.map((url) => pathFromUrl(url)), ...markdownResourcePaths]).length;

  return {
    sitemapUrls: sitemap.urls,
    portalUrls,
    linkedUrls,
    markdownResourcePaths,
    sitemapSources: sitemap.sources,
    fetchErrors: sitemap.errors,
    totalCandidates
  };
}

async function discoverSitemapUrls(site: WalrusSiteContext, siteDir: string, mode: BuildProfile): Promise<{ urls: string[]; sources: string[]; errors: number }> {
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const queue: Array<{ url: string; body?: string; source: string }> = [];
  const urls = new Set<string>();
  const sources: string[] = [];
  const fetched = new Set<string>();
  let errors = 0;

  const localSitemap = await readLocalText(siteDir, "/sitemap.xml").catch(() => "");
  if (localSitemap.trim()) queue.push({ url: site.portalUrl ? new URL("/sitemap.xml", site.portalUrl).toString() : "local:/sitemap.xml", body: localSitemap, source: "local:/sitemap.xml" });

  if (mode !== "fast" && site.portalUrl) {
    const rootSitemap = new URL("/sitemap.xml", site.portalUrl).toString();
    queue.push({ url: rootSitemap, source: rootSitemap });
  }

  if (mode === "full" && site.portalUrl) {
    try {
      const robots = await fetch(new URL("/robots.txt", site.portalUrl));
      if (robots.ok) {
        const body = await robots.text();
        for (const match of body.matchAll(/^sitemap:\s*(.+)$/gim)) {
          if (match[1]) queue.push({ url: match[1].trim(), source: "robots.txt" });
        }
      }
    } catch {
      errors++;
    }
  }

  while (queue.length && fetched.size < 100) {
    const next = queue.shift()!;
    if (fetched.has(next.url)) continue;
    fetched.add(next.url);
    let body = next.body;
    if (!body) {
      try {
        body = await readSitemapText(site, siteDir, next.url);
      } catch {
        errors++;
        continue;
      }
    }
    if (!body.trim()) continue;
    sources.push(next.source);
    const parsed = parser.parse(body);
    const childSitemaps = asArray(parsed?.sitemapindex?.sitemap)
      .map((entry) => sitemapLoc(entry))
      .filter(Boolean);
    for (const child of childSitemaps) {
      queue.push({ url: child, source: child });
    }
    const pageUrls = asArray(parsed?.urlset?.url)
      .map((entry) => sitemapLoc(entry))
      .filter(Boolean);
    for (const loc of pageUrls) {
      if (site.portalUrl && !shouldFetchPortalPage(site, loc)) continue;
      urls.add(loc);
    }
  }

  return { urls: uniqueStrings([...urls]), sources: uniqueStrings(sources), errors };
}

async function readSitemapText(site: WalrusSiteContext, siteDir: string, sitemapUrl: string): Promise<string> {
  if (site.portalUrl) {
    try {
      const portal = new URL(site.portalUrl);
      const parsed = new URL(sitemapUrl, site.portalUrl);
      if (parsed.origin === portal.origin) {
        const local = await readLocalText(siteDir, parsed.pathname).catch(() => "");
        if (local.trim()) return local;
      }
    } catch {
      // Fall back to remote fetch below.
    }
  }
  const response = await fetch(sitemapUrl);
  if (!response.ok) throw new Error(`Sitemap ${response.status}: ${sitemapUrl}`);
  return response.text();
}

async function readLocalText(siteDir: string, routePath: string): Promise<string> {
  return fs.readFile(safeJoin(siteDir, routePath), "utf8");
}

function sitemapLoc(entry: unknown): string {
  if (typeof entry !== "object" || !entry) return "";
  const loc = (entry as { loc?: unknown }).loc;
  if (typeof loc === "string") return loc;
  if (typeof loc === "object" && loc && typeof (loc as { "#text"?: unknown })["#text"] === "string") return (loc as { "#text": string })["#text"];
  return "";
}

async function discoverLinkedPortalUrls(site: WalrusSiteContext, siteDir: string, resources: WalrusResourceRecord[]): Promise<string[]> {
  const urls: string[] = [];
  const htmlResources = resources.filter((resource) => !resource.error && resource.localPath && (/html/i.test(resource.contentType ?? "") || /\.html?$/i.test(resource.path)));
  for (const resource of htmlResources) {
    try {
      const html = await readLocalText(siteDir, resource.path);
      urls.push(...extractLinks(publicResourceUrl(site, resource.path), html));
    } catch {
      continue;
    }
  }

  const llms = await readLocalText(siteDir, "/llms.txt").catch(() => "");
  if (llms.trim()) urls.push(...portalCandidateUrlsFromText(site, llms));

  return uniqueStrings(urls.filter((url) => shouldFetchPortalPage(site, url)));
}

function portalCandidateUrlsFromText(site: WalrusSiteContext, text: string): string[] {
  if (!site.portalUrl) return [];
  const values = [
    ...[...text.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((match) => match[1] ?? ""),
    ...[...text.matchAll(/\bhttps?:\/\/[^\s)]+/g)].map((match) => match[0] ?? ""),
    ...[...text.matchAll(/(^|\s)(\/[A-Za-z0-9._~!$&'()*+,;=:@/-]+)/g)].map((match) => match[2] ?? "")
  ];
  return values
    .map((value) => value.trim().replace(/[),.]+$/g, ""))
    .map((value) => portalUrlFromValue(site, value))
    .filter((url): url is string => Boolean(url));
}

function portalUrlFromValue(site: WalrusSiteContext, value: string): string | undefined {
  if (!site.portalUrl || !value || value.startsWith("#") || /^mailto:|^tel:/i.test(value)) return undefined;
  try {
    const parsed = new URL(value, site.portalUrl);
    const portal = new URL(site.portalUrl);
    if (parsed.origin !== portal.origin) return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function isMarkdownResource(resource: WalrusResourceRecord): boolean {
  return /markdown/i.test(resource.contentType ?? "") || /\.mdx?$/i.test(resource.path);
}

function canonicalRouteFromMarkdownPath(routePath: string): string {
  return normalizeCanonicalRoute(routePath.replace(/\.mdx?$/i, ""));
}

function pageFromMarkdownResource(site: WalrusSiteContext, resource: WalrusResourceRecord, markdown: string, routePath: string): PageArtifact {
  const text = markdownToPlainText(markdown);
  const publicUrl = publicResourceUrl(site, resource.path);
  return {
    url: `walrus://${site.network}/${site.siteObjectId}${resource.path}`,
    routePath,
    title: markdownTitle(markdown) ?? humanTitleFromRoute(routePath),
    statusCode: 200,
    contentType: resource.contentType,
    markdown: markdown.trim(),
    html: `<main><pre>${escapeHtml(markdown.trim())}</pre></main>`,
    text,
    metadata: { title: markdownTitle(markdown), canonicalUrl: publicUrl },
    links: portalCandidateUrlsFromText(site, markdown),
    images: [],
    contentHash: sha256Hex(markdown),
    source: {
      kind: "walrus",
      resourcePath: resource.path,
      blobId: resource.blobId,
      blobHash: resource.blobHash,
      quiltPatchId: resource.quiltPatchId
    }
  };
}

function markdownTitle(markdown: string): string | undefined {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
}

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~>`-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function humanTitleFromRoute(routePath: string): string {
  const leaf = routePath.split("/").filter(Boolean).at(-1) ?? "Index";
  return leaf.replaceAll(/[-_]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

async function fetchPortalPage(site: WalrusSiteContext, url: string): Promise<PageArtifact | undefined> {
  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "user-agent": "ContextMeM/0.1 (+https://github.com/contextmem/contextmem)",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
    }
  });
  const contentType = response.headers.get("content-type") ?? undefined;
  if (!response.ok || !/html/i.test(contentType ?? "")) return undefined;
  const html = await response.text();
  const metadata = extractHtmlMetadata(response.url, html);
  const markdown = htmlToMarkdown(response.url, html, true);
  if (isUtilityPageRoute(new URL(response.url).pathname) || isRedirectOnlyHtml(html, markdown.text)) return undefined;
  const routePath = canonicalRouteFromMetadata(site, metadata) ?? pathFromUrl(response.url);
  if (!isInPortalScope(site, routePath)) return undefined;
  return {
    url: `walrus://${site.network}/${site.siteObjectId}${routePath}`,
    routePath,
    title: markdown.title ?? metadata.title,
    statusCode: response.status,
    contentType,
    markdown: markdown.markdown,
    html,
    text: markdown.text,
    metadata,
    links: extractLinks(response.url, html),
    images: extractImages(response.url, html),
    contentHash: sha256Hex(html),
    source: {
      kind: "walrus",
      resourcePath: routePath
    }
  };
}

function dedupePages(site: WalrusSiteContext, pages: PageArtifact[]): PageArtifact[] {
  const byKey = new Map<string, PageArtifact>();
  for (const page of pages) {
    const key = pageCanonicalKey(site, page);
    const existing = byKey.get(key);
    if (!existing || pageScore(page) > pageScore(existing)) byKey.set(key, page);
  }
  return [...byKey.values()].sort((a, b) => comparePageRoutes(a.routePath ?? a.url, b.routePath ?? b.url));
}

function pageScore(page: PageArtifact): number {
  let score = 0;
  if (page.title) score += 20;
  if (page.source?.blobId) score += 30;
  if (page.markdown.trim().length) score += Math.min(30, Math.floor(page.markdown.length / 1000));
  if (isRedirectOnlyHtml(page.html, page.text)) score -= 100;
  if (page.routePath && isUtilityPageRoute(page.routePath)) score -= 80;
  return score;
}

function pageCanonicalKey(site: WalrusSiteContext, page: PageArtifact): string {
  return canonicalKeyFromUrl(site, page.metadata.canonicalUrl ?? page.routePath ?? page.url);
}

function canonicalKeyFromUrl(site: WalrusSiteContext, value: string): string {
  return normalizeCanonicalRoute(canonicalRouteFromValue(site, value) || pathFromUrl(value));
}

function canonicalRouteFromMetadata(site: WalrusSiteContext, metadata: { canonicalUrl?: string }): string | undefined {
  return metadata.canonicalUrl ? canonicalRouteFromValue(site, metadata.canonicalUrl) : undefined;
}

function canonicalRouteFromValue(site: WalrusSiteContext, value: string): string | undefined {
  try {
    const base = site.portalUrl ?? "http://localhost/";
    const url = /^https?:\/\//i.test(value) ? new URL(value) : new URL(value, base);
    if (site.portalUrl && url.origin !== new URL(site.portalUrl).origin) return undefined;
    return pathFromUrl(url.toString());
  } catch {
    return undefined;
  }
}

function normalizeCanonicalRoute(routePath: string): string {
  const clean = pathFromUrl(routePath)
    .replace(/\/index\.(?:html?|mdx?)$/i, "")
    .replace(/\.(?:html?|mdx?)$/i, "")
    .replace(/\/+$/g, "");
  return clean || "/";
}

function pathFromUrl(value: string): string {
  try {
    return new URL(value, "http://localhost").pathname || "/";
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}

function shouldFetchPortalPage(site: WalrusSiteContext, url: string): boolean {
  if (!site.portalUrl) return false;
  try {
    const portal = new URL(site.portalUrl);
    const parsed = new URL(url);
    if (parsed.origin !== portal.origin) return false;
    if (isUtilityPageRoute(parsed.pathname)) return false;
    return isInPortalScope(site, parsed.pathname);
  } catch {
    return false;
  }
}

function isInPortalScope(site: WalrusSiteContext, routePath: string): boolean {
  if (!site.portalUrl) return true;
  try {
    const scope = new URL(site.portalUrl).pathname.replace(/\/+$/g, "");
    const route = pathFromUrl(routePath).replace(/\/+$/g, "");
    return !scope || scope === "/" || route === scope || route.startsWith(`${scope}/`);
  } catch {
    return true;
  }
}

function isRedirectOnlyHtml(html: string, text: string): boolean {
  const compactText = text.replace(/\s+/g, " ").trim();
  if (/^window\.location\.href\s*=/.test(compactText)) return true;
  if (/^redirecting(?:\u2026|\.\.\.)?\s+to\s+/i.test(compactText)) return true;
  return /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["']0\s*;\s*url=/i.test(html) && /window\.location\.href\s*=/i.test(html) && compactText.length < 300;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

async function styleSourcesFromMaterializedSite(siteDir: string, pages: PageArtifact[], resources: WalrusResourceRecord[]): Promise<StyleSource[]> {
  const sources = pages.flatMap((page) => inlineStyleSourcesFromPage(page));
  const cssResources = resources.filter((resource) => !resource.error && resource.localPath && (/css/i.test(resource.contentType ?? "") || /\.css$/i.test(resource.path)));

  for (const resource of cssResources) {
    try {
      sources.push({
        text: await fs.readFile(safeJoin(siteDir, resource.path), "utf8"),
        resourcePath: resource.path,
        blobId: resource.blobId,
        blobHash: resource.blobHash,
        quiltPatchId: resource.quiltPatchId
      });
    } catch {
      continue;
    }
  }

  return sources.length ? sources : pages.map((page) => ({ text: page.html, url: page.url, routePath: page.routePath ?? page.url }));
}

async function readCachedWalrusResource(site: WalrusSiteContext, resource: WalrusResourceRecord, options: WalrusResourceFetchOptions): Promise<{ body: Buffer; record: WalrusResourceRecord } | undefined> {
  if (!options.cacheDir) return undefined;
  const filePath = walrusResourceCachePath(options.cacheDir, site, resource);
  try {
    const body = await fs.readFile(filePath);
    const bodyHash = sha256Base64(body);
    if (bodyHash !== resource.blobHash) {
      await fs.rm(filePath, { force: true }).catch(() => undefined);
      options.cacheStats && (options.cacheStats.misses += 1);
      return undefined;
    }
    options.cacheStats && (options.cacheStats.hits += 1);
    options.cacheStats && (options.cacheStats.bytesRead += body.byteLength);
    return {
      body,
      record: {
        ...resource,
        byteLength: body.byteLength,
        verified: true,
        cacheStatus: "hit",
        contentType: resource.contentType ?? detectContentType(resource.path)
      }
    };
  } catch {
    options.cacheStats && (options.cacheStats.misses += 1);
    return undefined;
  }
}

async function writeCachedWalrusResource(site: WalrusSiteContext, resource: WalrusResourceRecord, body: Buffer, options: WalrusResourceFetchOptions): Promise<void> {
  if (!options.cacheDir) return;
  const filePath = walrusResourceCachePath(options.cacheDir, site, resource);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    options.cacheStats && (options.cacheStats.writes += 1);
    options.cacheStats && (options.cacheStats.bytesWritten += body.byteLength);
  } catch {
    // Cache writes are an optimization only; the verified resource still gets materialized.
  }
}

function walrusResourceCachePath(cacheDir: string, site: WalrusSiteContext, resource: WalrusResourceRecord): string {
  const rangeKey = resource.range ? `${resource.range.start ?? ""}-${resource.range.end ?? ""}` : "full";
  return path.join(cacheDir, "walrus", site.network, sha256Hex(`${resource.blobHash}:${resource.blobId}:${rangeKey}`));
}

function normalizeConcurrency(value?: number): number {
  const requested = Number.isFinite(value) ? Number(value) : DEFAULT_WALRUS_CONCURRENCY;
  return Math.max(1, Math.min(24, Math.floor(requested || DEFAULT_WALRUS_CONCURRENCY)));
}

async function measure<T>(timings: Record<string, number>, key: string, fn: () => T | Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    return await fn();
  } finally {
    timings[key] = (timings[key] ?? 0) + Date.now() - started;
  }
}

function uniqueImages(images: ImageAsset[]): ImageAsset[] {
  const seen = new Set<string>();
  return images.filter((image) => {
    const key = `${image.absoluteUrl}:${image.role ?? ""}:${image.contentType ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function getAllDynamicFields(client: SuiGrpcClient, parentId: string): Promise<Array<{ objectId: string }>> {
  const fields: Array<{ objectId: string }> = [];
  let cursor: string | null | undefined;
  do {
    const page = await client.listDynamicFields({ parentId, cursor });
    fields.push(...page.dynamicFields.map((field) => ({ objectId: field.fieldId })));
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return fields;
}

function normalizeHeaders(headers: Map<string, string> | Record<string, string>): Record<string, string> {
  if (headers instanceof Map) return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
}
