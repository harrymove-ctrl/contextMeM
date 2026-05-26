import fs from "node:fs/promises";
import path from "node:path";
import {
  buildFigmaTokens,
  buildStyleDictionaryTokens,
  buildTailwindTheme,
  buildVideoBrandKit,
  buildWebBrandKit,
  renderDesignSystemMarkdown,
  renderTokensCss
} from "./design-system.js";
import type {
  AiQueryResult,
  BrandProfile,
  ComponentPreviewArtifact,
  DiscoveryStats,
  DesignSystem,
  ImageAsset,
  PageArtifact,
  ScreenshotArtifact,
  SiteStructure,
  SitemapResult,
  Styleguide,
  WalrusPackageManifest,
  WalrusResourceRecord,
  WalrusSiteContext
} from "./types.js";
import { buildSiteStructure } from "./site-structure.js";
import { detectContentType, pathToRoute, safeJoin, unique } from "./utils.js";

export type AgentPackageInput = {
  runId: string;
  target: string;
  outputDir: string;
  pages?: PageArtifact[];
  sitemap?: SitemapResult;
  discovery?: DiscoveryStats;
  siteStructure?: SiteStructure;
  images?: ImageAsset[];
  brand?: BrandProfile;
  styleguide?: Styleguide;
  designSystem?: DesignSystem;
  aiQuery?: AiQueryResult;
  screenshots?: ScreenshotArtifact[];
  componentPreviews?: ComponentPreviewArtifact[];
  walrus?: {
    site: WalrusSiteContext;
    resources: WalrusResourceRecord[];
  };
};

export async function buildAgentReadableSite(input: AgentPackageInput): Promise<WalrusPackageManifest> {
  const root = input.outputDir;
  const contextDir = path.join(root, "context");
  await fs.mkdir(contextDir, { recursive: true });
  await fs.mkdir(path.join(contextDir, "pages"), { recursive: true });
  await fs.mkdir(path.join(contextDir, "html"), { recursive: true });

  const pages = input.pages ?? [];
  const images = input.images ?? unique(pages.flatMap((page) => page.images));
  const sitemap = input.sitemap ?? { target: input.target, urls: pages.map((p) => p.url), meta: { sitemapsDiscovered: 0, sitemapsFetched: 0, sitemapsSkipped: 0, errors: 0 } };
  const siteStructure =
    input.siteStructure ??
    buildSiteStructure({
      target: input.target,
      pages,
      sitemap,
      images,
      brand: input.brand,
      walrus: input.walrus ? { resources: input.walrus.resources } : undefined
    });
  const generatedRoutes: string[] = [];

  for (const [index, page] of pages.entries()) {
    const basename = `${String(index + 1).padStart(3, "0")}-${slug(page.routePath ?? page.url)}`;
    await fs.writeFile(path.join(contextDir, "pages", `${basename}.md`), page.markdown);
    await fs.writeFile(path.join(contextDir, "html", `${basename}.html`), page.html);
    generatedRoutes.push(`/context/pages/${basename}.md`, `/context/html/${basename}.html`);
  }

  const manifest: WalrusPackageManifest = {
    runId: input.runId,
    target: input.target,
    outputDir: root,
    contextDir,
    generatedAt: new Date().toISOString(),
    pages,
    sitemap,
    discovery: input.discovery,
    siteStructure,
    images,
    brand: input.brand,
    styleguide: input.styleguide,
    designSystem: input.designSystem,
    aiQuery: input.aiQuery,
    screenshots: input.screenshots,
    componentPreviews: input.componentPreviews,
    walrus: input.walrus
  };

  await writeJson(path.join(contextDir, "manifest.json"), manifest);
  await writeJson(path.join(contextDir, "sitemap.json"), sitemap);
  if (input.discovery) await writeJson(path.join(contextDir, "discovery.json"), input.discovery);
  await writeJson(path.join(contextDir, "site-structure.json"), siteStructure);
  await writeJson(path.join(contextDir, "images.json"), images);
  if (input.brand) await writeJson(path.join(contextDir, "brand.json"), input.brand);
  if (input.styleguide) await writeJson(path.join(contextDir, "styleguide.json"), input.styleguide);
  if (input.designSystem) await writeDesignSystemArtifacts(contextDir, input.designSystem);
  if (input.aiQuery) await writeJson(path.join(contextDir, "ai-query.json"), input.aiQuery);
  if (input.screenshots) await writeJson(path.join(contextDir, "screenshots.json"), input.screenshots);
  if (input.componentPreviews) await writeJson(path.join(contextDir, "component-previews.json"), input.componentPreviews);
  if (input.walrus) {
    await writeJson(path.join(contextDir, "walrus-site.json"), input.walrus.site);
    await writeJson(path.join(contextDir, "resources.json"), input.walrus.resources);
    await writeJson(path.join(contextDir, "blobs.json"), summarizeBlobs(input.walrus.resources));
    await writeJson(path.join(contextDir, "headers.json"), Object.fromEntries(input.walrus.resources.map((resource) => [resource.path, resource.headers])));
    await writeJson(path.join(contextDir, "routes.json"), buildRouteMap(input.walrus.resources));
    await writeJson(path.join(contextDir, "package.json"), {
      name: "contextmem-walrus-context",
      target: input.target,
      generatedAt: manifest.generatedAt,
      files: input.walrus.resources.length
    });
  }

  await fs.writeFile(path.join(root, "index.html"), renderIndexHtml(manifest));
  await fs.writeFile(path.join(root, "llms.txt"), renderLlmsTxt(manifest));
  const wsResources = buildWsResources(root);
  const headers = wsResources.headers as Record<string, Record<string, string>>;
  for (const route of generatedRoutes) {
    headers[route] = {
      "Content-Disposition": "inline",
      "content-type": route.endsWith(".md") ? "text/markdown; charset=utf-8" : detectContentType(route)
    };
  }
  await writeJson(path.join(root, "ws-resources.json"), wsResources);
  return manifest;
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function buildWsResources(root: string): Record<string, unknown> {
  const headers: Record<string, Record<string, string>> = {};
  const routes: Record<string, string> = {};
  const visit = async (_dir: string) => undefined;
  void visit;
  // This function is synchronous from the caller's point of view; it builds the
  // known ContextMeM routes. Extra files still deploy normally.
  const known = [
    "/llms.txt",
    "/context/manifest.json",
    "/context/sitemap.json",
    "/context/discovery.json",
    "/context/site-structure.json",
    "/context/images.json",
    "/context/brand.json",
    "/context/styleguide.json",
    "/context/design-system.json",
    "/context/tokens.json",
    "/context/figma.tokens.json",
    "/context/style-dictionary.json",
    "/context/tailwind.theme.json",
    "/context/tokens.css",
    "/context/web-brand-kit.json",
    "/context/video-brand-kit.json",
    "/context/design-system.md",
    "/context/screenshots.json",
    "/context/component-previews.json",
    "/context/ai-query.json",
    "/context/walrus-site.json",
    "/context/resources.json",
    "/context/blobs.json",
    "/context/headers.json",
    "/context/routes.json",
    "/context/package.json"
  ];
  for (const route of known) {
    const type = detectContentType(route);
    headers[route] = route.endsWith(".md")
      ? { "Content-Disposition": "inline", "content-type": "text/markdown; charset=utf-8" }
      : { "Content-Disposition": "inline", "content-type": type };
  }
  headers["/llms.txt"] = { "Content-Disposition": "inline", "content-type": "text/plain; charset=utf-8" };
  routes["/context"] = "/context/manifest.json";
  routes["/sitemap.json"] = "/context/sitemap.json";
  routes["/site-structure.json"] = "/context/site-structure.json";
  routes["/resources.json"] = "/context/resources.json";
  routes["/styleguide.json"] = "/context/styleguide.json";
  routes["/design-system.json"] = "/context/design-system.json";
  routes["/tokens.css"] = "/context/tokens.css";
  routes["/brand.json"] = "/context/brand.json";
  return {
    headers,
    routes,
    metadata: {
      site_name: "ContextMeM Agent Context",
      description: "Agent-readable website context generated by ContextMeM.",
      link: ""
    },
    ignore: []
  };
}

async function writeDesignSystemArtifacts(contextDir: string, designSystem: DesignSystem): Promise<void> {
  await writeJson(path.join(contextDir, "design-system.json"), designSystem);
  await writeJson(path.join(contextDir, "tokens.json"), designSystem.tokens);
  await writeJson(path.join(contextDir, "figma.tokens.json"), buildFigmaTokens(designSystem));
  await writeJson(path.join(contextDir, "style-dictionary.json"), buildStyleDictionaryTokens(designSystem));
  await writeJson(path.join(contextDir, "tailwind.theme.json"), buildTailwindTheme(designSystem));
  await writeJson(path.join(contextDir, "web-brand-kit.json"), buildWebBrandKit(designSystem));
  await writeJson(path.join(contextDir, "video-brand-kit.json"), buildVideoBrandKit(designSystem));
  await fs.writeFile(path.join(contextDir, "tokens.css"), renderTokensCss(designSystem));
  await fs.writeFile(path.join(contextDir, "design-system.md"), renderDesignSystemMarkdown(designSystem));
}

export async function copyIntoPackage(sourceFile: string, root: string, routePath: string): Promise<string> {
  const output = safeJoin(root, pathToRoute(routePath));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.copyFile(sourceFile, output);
  return output;
}

function summarizeBlobs(resources: WalrusResourceRecord[]): Array<Record<string, unknown>> {
  return resources.map((resource) => ({
    path: resource.path,
    blobId: resource.blobId,
    blobHash: resource.blobHash,
    quiltPatchId: resource.quiltPatchId,
    byteLength: resource.byteLength,
    verified: resource.verified
  }));
}

function buildRouteMap(resources: WalrusResourceRecord[]): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const resource of resources) {
    routes[resource.path] = resource.localPath ?? resource.path;
  }
  return routes;
}

function renderIndexHtml(manifest: WalrusPackageManifest): string {
  const pageRows = manifest.pages
    .map(
      (page) => `<tr><td>${escapeHtml(page.routePath ?? new URL(page.url).pathname)}</td><td>${escapeHtml(page.title ?? "")}</td><td>${escapeHtml(page.source?.blobId ?? "")}</td></tr>`
    )
    .join("");
  const resources = manifest.walrus?.resources.length ?? 0;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ContextMeM Context Package</title>
  <style>
    body{font-family:Inter,ui-sans-serif,system-ui,sans-serif;margin:0;background:#f7f8fb;color:#17202a}
    main{max-width:1120px;margin:0 auto;padding:32px 20px 56px}
    h1{font-size:28px;line-height:1.2;margin:0 0 8px}
    .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:24px 0}
    .cell{background:white;border:1px solid #d9dee8;border-radius:8px;padding:14px}
    .label{font-size:12px;color:#667085;text-transform:uppercase;letter-spacing:.04em}
    .value{font-size:20px;font-weight:650;margin-top:6px}
    table{width:100%;border-collapse:collapse;background:white;border:1px solid #d9dee8;border-radius:8px;overflow:hidden}
    th,td{text-align:left;border-bottom:1px solid #edf0f5;padding:10px 12px;font-size:14px}
    th{background:#f0f3f8;color:#475467}
    a{color:#0b6bcb}
  </style>
</head>
<body>
<main>
  <h1>ContextMeM Context Package</h1>
  <p>${escapeHtml(manifest.target)}</p>
  <section class="meta">
    <div class="cell"><div class="label">Pages</div><div class="value">${manifest.pages.length}</div></div>
    <div class="cell"><div class="label">Images</div><div class="value">${manifest.images.length}</div></div>
    <div class="cell"><div class="label">Walrus Resources</div><div class="value">${resources}</div></div>
    <div class="cell"><div class="label">Generated</div><div class="value">${escapeHtml(new Date(manifest.generatedAt).toLocaleString())}</div></div>
  </section>
  <p><a href="/llms.txt">llms.txt</a> · <a href="/context/manifest.json">manifest</a> · <a href="/context/site-structure.json">structure</a> · <a href="/context/resources.json">resources</a> · <a href="/context/styleguide.json">styleguide</a> · <a href="/context/design-system.json">design system</a></p>
  <table>
    <thead><tr><th>Route</th><th>Title</th><th>Blob</th></tr></thead>
    <tbody>${pageRows}</tbody>
  </table>
</main>
</body>
</html>`;
}

function renderLlmsTxt(manifest: WalrusPackageManifest): string {
  const lines = [
    "# ContextMeM Agent Context",
    "",
    `Target: ${manifest.target}`,
    `Generated: ${manifest.generatedAt}`,
    "",
    "## Core Artifacts",
    "- /context/manifest.json",
    "- /context/sitemap.json",
    "- /context/site-structure.json",
    "- /context/images.json",
    "- /context/brand.json",
    "- /context/styleguide.json",
    "- /context/design-system.json",
    "- /context/figma.tokens.json",
    "- /context/tokens.css",
    "- /context/web-brand-kit.json",
    "- /context/video-brand-kit.json",
    "- /context/resources.json",
    "",
    "## Pages",
    ...manifest.pages.map((page, index) => `- ${page.title ?? page.routePath ?? page.url}: /context/pages/${String(index + 1).padStart(3, "0")}-${slug(page.routePath ?? page.url)}.md`)
  ];
  return `${lines.join("\n")}\n`;
}

function slug(input: string): string {
  return input.replace(/^https?:\/\//, "").replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "").toLowerCase() || "index";
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
