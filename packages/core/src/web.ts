import fs from "node:fs/promises";
import path from "node:path";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import type {
  AiDatapoint,
  AiQueryResult,
  BrandProfile,
  CrawlOptions,
  DesignSystem,
  ImageAsset,
  PageArtifact,
  SitemapResult,
  Styleguide
} from "./types.js";
import { buildDesignSystemFromPages, buildStyleguideFromStyleSources, inlineStyleSourcesFromPage, type StyleSource } from "./design-system.js";
import { extractHtmlMetadata, extractImages, extractLinks, htmlToMarkdown } from "./html.js";
import { clamp, comparePageRoutes, detectContentType, domainFromTarget, isUtilityPageRoute, normalizeCssColor, normalizeInputTarget, normalizeUrl, sha256Hex, unique } from "./utils.js";

export type WebScrapeOptions = CrawlOptions & {
  url: string;
};

export async function fetchHtml(url: string, timeoutMs = 20000): Promise<{ html: string; statusCode: number; contentType?: string; finalUrl: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "ContextMeM/0.1 (+https://github.com/contextmem/contextmem)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    const html = await response.text();
    return {
      html,
      statusCode: response.status,
      contentType: response.headers.get("content-type") ?? undefined,
      finalUrl: response.url
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function scrapeWebPage(options: WebScrapeOptions): Promise<PageArtifact> {
  const url = normalizeInputTarget(options.url);
  if (!url.startsWith("http")) throw new Error(`Expected URL target, received ${options.url}`);
  const response = await fetchHtml(url, options.timeoutMs);
  const metadata = extractHtmlMetadata(response.finalUrl, response.html);
  const markdownResult = htmlToMarkdown(response.finalUrl, response.html, options.useMainContentOnly ?? true);
  const links = options.includeLinks === false ? [] : extractLinks(response.finalUrl, response.html);
  const images = options.includeImages === false ? [] : extractImages(response.finalUrl, response.html);
  return {
    url: response.finalUrl,
    title: markdownResult.title ?? metadata.title,
    statusCode: response.statusCode,
    contentType: response.contentType,
    markdown: markdownResult.markdown,
    html: response.html,
    text: markdownResult.text,
    metadata,
    links,
    images,
    contentHash: sha256Hex(response.html),
    source: { kind: "web" }
  };
}

export async function crawlWebSite(target: string, options: CrawlOptions = {}): Promise<PageArtifact[]> {
  const start = normalizeInputTarget(target);
  if (!start.startsWith("http")) throw new Error(`Expected URL or domain target, received ${target}`);
  const startUrl = new URL(start);
  const maxPages = clamp(options.maxPages ?? 25, 1, 500);
  const maxDepth = clamp(options.maxDepth ?? 2, 0, 25);
  const concurrency = clamp(options.concurrency ?? 4, 1, 24);
  const includeSubdomains = options.followSubdomains ?? false;
  const urlRegex = options.urlRegex ? new RegExp(options.urlRegex) : null;
  const discovery = {
    strategy: "web" as const,
    totalCandidates: 0,
    pagesEmitted: 0,
    skippedUtilityOrRedirect: 0,
    sitemapSources: options.seedUrls?.length ? ["sitemap"] : [],
    markdownFallbacks: 0,
    fetchErrors: 0
  };
  const seen = new Set<string>();
  const enqueued = new Set<string>();
  const queued: Array<{ url: string; depth: number }> = [];
  const results: PageArtifact[] = [];

  const enqueue = (value: string, depth: number) => {
    let url: string;
    try {
      url = normalizeCrawlUrl(value);
    } catch {
      return;
    }
    if (enqueued.has(url) || seen.has(url)) return;
    const parsed = new URL(url);
    if (!isInWebScope(startUrl, parsed, includeSubdomains)) return;
    if (isUtilityPageRoute(parsed.pathname)) {
      discovery.skippedUtilityOrRedirect++;
      return;
    }
    if (urlRegex && !urlRegex.test(url)) return;
    enqueued.add(url);
    discovery.totalCandidates++;
    queued.push({ url, depth });
  };

  enqueue(start, 0);
  for (const seedUrl of [...(options.seedUrls ?? [])].sort()) {
    enqueue(seedUrl, 0);
  }

  while (queued.length && results.length < maxPages) {
    const batch = queued.splice(0, Math.min(concurrency, maxPages - results.length, queued.length));
    const fetched = await Promise.all(
      batch.map(async (next) => {
        if (seen.has(next.url) || next.depth > maxDepth) return undefined;
        seen.add(next.url);
        try {
          const page = await scrapeWebPage({ ...options, url: next.url });
          page.routePath = new URL(page.url).pathname || "/";
          return { page, depth: next.depth };
        } catch {
          discovery.fetchErrors++;
          return undefined;
        }
      })
    );

    for (const item of fetched) {
      if (!item) continue;
      if (results.length >= maxPages) break;
      results.push(item.page);
      if (item.depth < maxDepth) {
        for (const link of [...item.page.links].sort()) {
          enqueue(link, item.depth + 1);
        }
      }
    }
  }

  const ordered = results.sort((a, b) => comparePageRoutes(a.routePath ?? a.url, b.routePath ?? b.url));
  discovery.pagesEmitted = ordered.length;
  options.onDiscovery?.(discovery);
  return ordered;
}

function normalizeCrawlUrl(value: string): string {
  const normalized = normalizeUrl(value);
  const parsed = new URL(normalized);
  parsed.hash = "";
  parsed.search = "";
  return normalizeUrl(parsed.toString());
}

function isInWebScope(startUrl: URL, parsed: URL, includeSubdomains: boolean): boolean {
  const startHost = startUrl.hostname.replace(/^www\./, "");
  const host = parsed.hostname.replace(/^www\./, "");
  return host === startHost || (includeSubdomains && host.endsWith(`.${startHost}`));
}

export async function crawlSitemap(target: string, maxLinks = 10000, urlRegex?: string): Promise<SitemapResult> {
  const domain = domainFromTarget(target);
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: true });
  const discovered = new Set<string>([`https://${domain}/sitemap.xml`, `https://www.${domain}/sitemap.xml`]);
  const fetched = new Set<string>();
  const urls = new Set<string>();
  let errors = 0;

  try {
    const robots = await fetch(`https://${domain}/robots.txt`).then((r) => (r.ok ? r.text() : ""));
    for (const match of robots.matchAll(/^sitemap:\s*(.+)$/gim)) {
      if (match[1]) discovered.add(match[1].trim());
    }
  } catch {
    errors++;
  }

  const regex = urlRegex ? new RegExp(urlRegex) : null;
  const queue = [...discovered];
  while (queue.length && urls.size < maxLinks) {
    const sitemapUrl = queue.shift()!;
    if (fetched.has(sitemapUrl)) continue;
    fetched.add(sitemapUrl);
    try {
      const response = await fetch(sitemapUrl);
      if (!response.ok) continue;
      const body = await response.text();
      const parsed = parser.parse(body);
      const childSitemaps = asArray(parsed?.sitemapindex?.sitemap)
        .map((entry) => entry?.loc)
        .filter(Boolean);
      for (const child of childSitemaps) queue.push(child);
      const pageUrls = asArray(parsed?.urlset?.url)
        .map((entry) => entry?.loc)
        .filter(Boolean);
      for (const loc of pageUrls) {
        const normalized = normalizeUrl(loc);
        if (!regex || regex.test(normalized)) urls.add(normalized);
        if (urls.size >= maxLinks) break;
      }
    } catch {
      errors++;
    }
  }

  return {
    target: domain,
    urls: [...urls],
    meta: {
      sitemapsDiscovered: discovered.size,
      sitemapsFetched: fetched.size,
      sitemapsSkipped: Math.max(0, discovered.size - fetched.size),
      errors
    }
  };
}

export async function extractBrandProfile(target: string): Promise<BrandProfile> {
  const domain = domainFromTarget(target);
  const page = await scrapeWebPage({ url: `https://${domain}`, includeImages: true });
  const colors = extractColorPalette([page.html]);
  const fonts = extractFontFamilies(page.html);
  return buildBrandProfileFromPages(`https://${domain}`, [page], { colors, fonts });
}

export function buildBrandProfileFromPages(
  target: string,
  pages: PageArtifact[],
  options: { images?: ImageAsset[]; colors?: string[]; fonts?: string[] } = {}
): BrandProfile {
  const primaryPage = pickPrimaryPage(pages);
  const metadata = primaryPage?.metadata ?? {};
  const pageImages = pages.flatMap((page) => page.images);
  const images = uniqueImages([...(options.images ?? []), ...pageImages]);
  const logoCandidates = images.filter(isBrandImage);
  const colors = options.colors?.length ? options.colors : extractColorPalette(pages.map((page) => page.html));
  const fonts = options.fonts?.length ? options.fonts : extractFontFamilies(pages.map((page) => page.html).join("\n"));
  const socials = unique(pages.flatMap((page) => page.links).filter((link) => /linkedin\.com|x\.com|twitter\.com|github\.com|discord\.gg|youtube\.com|instagram\.com/i.test(link))).slice(
    0,
    20
  );
  const domain = safeDomainFromTarget(target);
  const name = metadata.openGraph?.site_name ?? siteNameFromTitle(primaryPage?.title ?? metadata.title) ?? humanizeIdentifier(domain ?? target);
  const confidence = Math.min(0.98, 0.35 + logoCandidates.length * 0.08 + colors.length * 0.02 + fonts.length * 0.03 + (metadata.description ? 0.12 : 0));

  return {
    name,
    domain,
    description: metadata.description,
    logos: logoCandidates.slice(0, 12),
    colors,
    fonts,
    socials,
    metadata,
    confidence
  };
}

export async function extractStyleguide(target: string): Promise<Styleguide> {
  const url = normalizeInputTarget(target);
  const page = await scrapeWebPage({ url, includeImages: true });
  const styleSources = await collectStyleSourcesForPages([page]);
  return buildStyleguideFromStyleSources(styleSources);
}

export async function extractDesignSystem(target: string, pages?: PageArtifact[], brand?: BrandProfile): Promise<DesignSystem> {
  const sourcePages = pages?.length ? pages : [await scrapeWebPage({ url: target, includeImages: true, includeLinks: true })];
  const styleSources = await collectStyleSourcesForPages(sourcePages);
  const resolvedBrand = brand ?? buildBrandProfileFromPages(target, sourcePages, {
    colors: buildStyleguideFromStyleSources(styleSources).colors.palette,
    fonts: buildStyleguideFromStyleSources(styleSources).typography.fontFamilies
  });
  return buildDesignSystemFromPages({
    target,
    pages: sourcePages,
    brand: resolvedBrand,
    styleSources
  });
}

export async function collectStyleSourcesForPages(pages: PageArtifact[], maxRemoteStylesheets = 16): Promise<StyleSource[]> {
  const sources = pages.flatMap((page) => inlineStyleSourcesFromPage(page));
  const cssLinks = unique(
    pages.flatMap((page) => {
      const $ = cheerio.load(page.html);
      return $("link[rel='stylesheet'][href]")
        .map((_, el) => {
          try {
            return new URL($(el).attr("href")!, page.url.startsWith("walrus://") ? `http://localhost${page.routePath ?? "/"}` : page.url).toString();
          } catch {
            return "";
          }
        })
        .get()
        .filter(Boolean)
        .map((href) => ({ href, routePath: page.routePath ?? page.url, url: page.url }));
    })
  ).slice(0, maxRemoteStylesheets);
  const limit = pLimit(3);
  const remoteSources: Array<StyleSource | undefined> = await Promise.all(
    cssLinks.map(({ href, routePath, url: pageUrl }) =>
      limit(async () => {
        try {
          const response = await fetch(href);
          return response.ok
            ? {
                text: await response.text(),
                url: href,
                routePath,
                resourcePath: href.startsWith("http://localhost") ? new URL(href).pathname : undefined
              } satisfies StyleSource
            : undefined;
        } catch {
          return undefined;
        }
      })
    )
  );
  sources.push(...remoteSources.filter((source): source is StyleSource => Boolean(source)));
  return sources.length ? sources : pages.map((page) => ({ text: page.html, url: page.url, routePath: page.routePath ?? page.url }));
}

export function buildStyleguideFromTexts(texts: string[]): Styleguide {
  return buildStyleguideFromStyleSources(styleSourcesFromTexts(texts));
}

function styleSourcesFromTexts(texts: string[]): StyleSource[] {
  return texts.flatMap((text, index) => {
    if (!/<(?:html|head|body|style|link|div|main|section)\b/i.test(text)) return [{ text }];
    const $ = cheerio.load(text);
    const sources: StyleSource[] = [];
    $("style").each((styleIndex, element) => {
      const css = $(element).html()?.trim();
      if (css) sources.push({ text: css, routePath: `inline-html-${index + 1}-${styleIndex + 1}` });
    });
    $("[style]").each((styleIndex, element) => {
      const css = $(element).attr("style")?.trim();
      if (!css) return;
      const tag = element.tagName || "element";
      const id = $(element).attr("id");
      const klass = ($(element).attr("class") ?? "").split(/\s+/).filter(Boolean)[0];
      const selector = id ? `#${id}` : klass ? `.${klass}` : tag;
      sources.push({ text: `${selector}{${css}}`, routePath: `inline-html-${index + 1}-${styleIndex + 1}` });
    });
    return sources;
  });
}

export async function aiQueryWebsite(target: string, datapoints: AiDatapoint[], pages?: PageArtifact[]): Promise<AiQueryResult> {
  const sourcePages = pages?.length ? pages : await crawlWebSite(target, { maxPages: 8, maxDepth: 1, includeImages: false });
  const context = sourcePages
    .map((page) => [`URL: ${page.url}`, page.markdown.slice(0, 6000)].join("\n"))
    .join("\n\n---\n\n")
    .slice(0, 24000);

  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch(`${process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.OPENAI_MODEL ?? "gpt-5-mini",
          messages: [
            { role: "system", content: "Extract the requested data from website context. Return only strict JSON." },
            {
              role: "user",
              content: JSON.stringify({
                datapoints,
                context
              })
            }
          ],
          response_format: { type: "json_object" }
        })
      });
      if (response.ok) {
        const json = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const content = json.choices?.[0]?.message?.content ?? "{}";
        return {
          target,
          schema: datapoints,
          data: JSON.parse(content) as Record<string, unknown>,
          sources: sourcePages.slice(0, 8).map((page) => ({
            url: page.url,
            routePath: page.routePath,
            resourcePath: page.source?.resourcePath,
            blobId: page.source?.blobId,
            quote: firstReadableSentence(page.markdown)
          })),
          confidence: 0.8,
          usedProvider: "openai-compatible"
        };
      }
    } catch {
      // Fall through to deterministic extraction.
    }
  }

  const data: Record<string, unknown> = {};
  for (const point of datapoints) {
    data[point.name] = heuristicExtract(point, context);
  }
  return {
    target,
    schema: datapoints,
    data,
    sources: sourcePages.slice(0, 8).map((page) => ({
      url: page.url,
      routePath: page.routePath,
      resourcePath: page.source?.resourcePath,
      blobId: page.source?.blobId,
      quote: firstReadableSentence(page.markdown)
    })),
    confidence: 0.45,
    usedProvider: "heuristic"
  };
}

export async function writePageArtifacts(rootDir: string, pages: PageArtifact[]): Promise<void> {
  await fs.mkdir(path.join(rootDir, "pages"), { recursive: true });
  await fs.mkdir(path.join(rootDir, "html"), { recursive: true });
  for (const [index, page] of pages.entries()) {
    const route = page.routePath ?? (new URL(page.url).pathname || "index");
    const slug = `${String(index + 1).padStart(3, "0")}-${slugifyPath(route)}`;
    await fs.writeFile(path.join(rootDir, "pages", `${slug}.md`), page.markdown);
    await fs.writeFile(path.join(rootDir, "html", `${slug}.html`), page.html);
  }
}

export function extractColorPalette(texts: string[]): string[] {
  const raw = texts
    .flatMap((text) => [
      ...text.matchAll(/#[0-9a-f]{3,8}\b/gi),
      ...text.matchAll(/\b(?:rgb|rgba|hsl|hsla)\([^)]+\)/gi)
    ])
    .map((match) => normalizeCssColor(match[0]));
  return unique(raw).slice(0, 48);
}

export function extractFontFamilies(text: string): string[] {
  const matches = [...text.matchAll(/font-family\s*:\s*([^;}{]+)/gi)]
    .map((match) => match[1]!.split(",")[0]!.trim().replaceAll(/['"]/g, ""))
    .filter(Boolean);
  return unique(matches).slice(0, 20);
}

function extractCssVariables(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const match of text.matchAll(/(--[a-z0-9-_]+)\s*:\s*([^;}{]+)/gi)) {
    vars[match[1]!] = match[2]!.trim();
  }
  return Object.fromEntries(Object.entries(vars).slice(0, 80));
}

function pickComponentTokens(css: string, keyword: string): Record<string, string> {
  const block = new RegExp(`[^{}]*${keyword}[^{}]*\\{([^{}]+)\\}`, "i").exec(css)?.[1] ?? "";
  const tokens: Record<string, string> = {};
  for (const prop of ["background", "background-color", "color", "border", "border-radius", "box-shadow", "padding", "font-family", "font-size", "font-weight"]) {
    const value = new RegExp(`${prop}\\s*:\\s*([^;]+)`, "i").exec(block)?.[1]?.trim();
    if (value) tokens[prop] = value;
  }
  return tokens;
}

function inferColorMode(colors: string[]): Styleguide["mode"] {
  const hasDark = colors.some((color) => /#0[0-9a-f]{2,5}|#111|#000|rgb\(\s*(0|1[0-9]|2[0-9])\s*,/i.test(color));
  const hasLight = colors.some((color) => /#fff|#ffffff|rgb\(\s*255\s*,/i.test(color));
  if (hasDark && hasLight) return "mixed";
  if (hasDark) return "dark";
  if (hasLight) return "light";
  return "unknown";
}

function pickPrimaryPage(pages: PageArtifact[]): PageArtifact | undefined {
  return (
    pages.find((page) => page.routePath === "/" || page.routePath === "/index.html") ??
    pages.find((page) => /\/index\.html$/i.test(page.routePath ?? "")) ??
    pages[0]
  );
}

function isBrandImage(image: ImageAsset): boolean {
  const haystack = `${image.src} ${image.absoluteUrl} ${image.alt ?? ""} ${image.role ?? ""} ${image.contentType ?? ""}`.toLowerCase();
  return haystack.includes("logo") || haystack.includes("favicon") || haystack.includes("icon") || image.type === "favicon" || image.role === "brand-asset";
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

function siteNameFromTitle(title?: string): string | undefined {
  if (!title) return undefined;
  const parts = title
    .split(/\s+(?:\||·|-)\s+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : title.trim();
}

function safeDomainFromTarget(target: string): string | undefined {
  try {
    return domainFromTarget(target);
  } catch {
    try {
      return new URL(target).hostname;
    } catch {
      return target.includes(".") ? target.replace(/^https?:\/\//, "").replace(/\/.*$/, "") : undefined;
    }
  }
}

function humanizeIdentifier(value: string): string {
  return value
    .replace(/^https?:\/\//, "")
    .replace(/\.wal\.app$/i, "")
    .replace(/\.sui$/i, "")
    .replace(/\.[a-z]{2,}$/i, "")
    .replaceAll(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function heuristicExtract(point: AiDatapoint, context: string): unknown {
  const lower = context.toLowerCase();
  const keywords = meaningfulKeywords(`${point.name} ${point.description}`);
  const needle = point.name.toLowerCase().replaceAll(/[_-]/g, " ");
  const candidates = rankedContextSentences(context, [needle, ...keywords]);
  const sample = candidates[0] ?? cleanMarkdownText(context.slice(0, 500));
  if (point.type === "boolean") return keywords.some((term) => lower.includes(term));
  if (point.type === "number") {
    const num = sample.match(/[-+]?\d+(?:\.\d+)?/)?.[0];
    return num ? Number(num) : null;
  }
  if (point.type === "list") return candidates.slice(0, 5);
  if (point.type === "object") return { summary: sample.trim() };
  if (/\bsummar(?:y|ize|ise|ization)|overview|important|facts?\b/i.test(point.description)) {
    return candidates.slice(0, 4).join(" ");
  }
  return sample.trim();
}

function rankedContextSentences(context: string, terms: string[]): string[] {
  const keywords = unique(terms.map((term) => term.trim().toLowerCase()).filter((term) => term.length >= 4));
  const seen = new Set<string>();
  const scored = context
    .split(/(?:\n{2,}|(?<=[.!?])\s+)/g)
    .map(cleanMarkdownText)
    .filter((sentence) => isUsefulContextSentence(sentence))
    .filter((sentence) => {
      const key = sentence.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((sentence, index) => {
      const lower = sentence.toLowerCase();
      const score = keywords.reduce((sum, keyword) => sum + (lower.includes(keyword) ? 2 : 0), 0) + domainTermScore(lower) - Math.min(index, 80) * 0.01;
      return { sentence, score };
    })
    .sort((a, b) => b.score - a.score);

  const selected = scored.filter((item) => item.score > 0).map((item) => item.sentence);
  return (selected.length ? selected : scored.map((item) => item.sentence)).slice(0, 8);
}

function firstReadableSentence(markdown: string): string | undefined {
  return rankedContextSentences(markdown, [])[0];
}

function cleanMarkdownText(value: string): string {
  return value
    .replace(/^URL:\s*\S+\s*/i, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/[*_~>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isUsefulContextSentence(sentence: string): boolean {
  if (sentence.length < 32 || sentence.length > 520) return false;
  if (/^https?:\/\//i.test(sentence)) return false;
  if (/^\/[\w./-]+(?:\s+\/[\w./-]+)*$/.test(sentence)) return false;
  if (/^(info|table of contents|direct link|previous|next)$/i.test(sentence)) return false;
  return /[a-z]/i.test(sentence);
}

function domainTermScore(lower: string): number {
  return ["walrus", "sui", "developer", "api", "sdk", "storage", "encryption", "seal", "site", "user"].reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
}

function meaningfulKeywords(text: string): string[] {
  const stopwords = new Set([
    "about",
    "answer",
    "context",
    "data",
    "does",
    "extract",
    "from",
    "have",
    "mentions",
    "this",
    "what",
    "when",
    "where",
    "whether",
    "with"
  ]);
  return unique(
    text
      .toLowerCase()
      .replaceAll(/[_-]/g, " ")
      .split(/[^a-z0-9]+/g)
      .filter((term) => term.length >= 4 && !stopwords.has(term))
  );
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function slugifyPath(routePath: string): string {
  return routePath.replace(/^\/+/, "").replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "") || "index";
}

export function imageAssetsFromResourcePaths(paths: string[], baseUrl: string): ImageAsset[] {
  return paths
    .filter((resourcePath) => /^.+\.(png|jpe?g|gif|webp|svg|ico)$/i.test(resourcePath))
    .map((resourcePath) => ({
      src: resourcePath,
      absoluteUrl: new URL(resourcePath, baseUrl).toString(),
      previewUrl: new URL(resourcePath, baseUrl).toString(),
      element: "walrus-resource",
      type: resourcePath.endsWith(".svg") ? "inline-svg" : "url",
      contentType: detectContentType(resourcePath),
      role: /logo|icon|favicon/i.test(resourcePath) ? "brand-asset" : undefined
    }));
}
