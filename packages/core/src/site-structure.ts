import path from "node:path";
import type { BrandProfile, ImageAsset, PageArtifact, SitemapResult, SiteStructure, SiteStructureNode, WalrusResourceRecord } from "./types.js";
import { comparePageRoutes, detectContentType, isUtilityPageRoute } from "./utils.js";

export type SiteStructureInput = {
  target: string;
  pages?: PageArtifact[];
  sitemap?: SitemapResult;
  images?: ImageAsset[];
  brand?: BrandProfile;
  walrus?: {
    resources: WalrusResourceRecord[];
  };
};

export function buildSiteStructure(input: SiteStructureInput): SiteStructure {
  const pages = input.pages ?? [];
  const resources = input.walrus?.resources ?? [];
  const resourceByPath = buildResourcePathIndex(resources);
  const sitemapPaths = (input.sitemap?.urls ?? [])
    .map((url) => normalizeSitePath(url, input.target))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const allPaths = unique([...resources.map((resource) => normalizeRoute(resource.path)), ...sitemapPaths]);
  const extractedPageRoutes = pages.map((page) => normalizeSitePath(page.routePath ?? page.url, input.target)).filter(Boolean);
  const fallbackPageRoutes = extractedPageRoutes.length ? [] : allPaths.filter(isHtmlPath);
  const pageRoutes = unique([...extractedPageRoutes, ...fallbackPageRoutes])
    .filter((route) => !isUtilityPageRoute(route))
    .sort(comparePageRoutes);
  const pageNodes: SiteStructureNode[] = pageRoutes.map((route, index) => {
    const page = pages.find((candidate) => normalizeSitePath(candidate.routePath ?? candidate.url, input.target) === route);
    const resource = resourceForPath(resourceByPath, route, page?.source?.resourcePath);
    const markdownPath = markdownForHtml(route);
    const markdownResource = markdownPath ? resourceForPath(resourceByPath, markdownPath) : undefined;

    const children: SiteStructureNode[] = [
      resourceNode(resource, {
        id: `page:${route}:html`,
        label: path.basename(route) || "index.html",
        kind: "html",
        path: route,
        route
      })
    ];

    if (markdownPath && markdownResource) {
      children.push(
        resourceNode(markdownResource, {
          id: `page:${route}:markdown-source`,
          label: path.basename(markdownPath),
          kind: "markdown",
          path: markdownPath,
          route
        })
      );
    }

    if (page) {
      const basename = pageArtifactBasename(page, pages.indexOf(page));
      children.push({
        id: `page:${route}:extracted-md`,
        label: "extracted markdown",
        kind: "markdown",
        path: `/context/pages/${basename}.md`,
        route,
        artifactPath: `/context/pages/${basename}.md`,
        sourcePath: page.source?.resourcePath
      });
      children.push({
        id: `page:${route}:rendered-html`,
        label: "rendered html",
        kind: "html",
        path: `/context/html/${basename}.html`,
        route,
        artifactPath: `/context/html/${basename}.html`,
        sourcePath: page.source?.resourcePath
      });
    }

    return {
      id: `page:${route}:${index}`,
      label: routeLabel(route),
      kind: "page",
      path: route,
      route,
      contentType: page?.contentType ?? resource?.contentType ?? detectContentType(route),
      sourcePath: resource?.localPath,
      artifactPath: resource?.localPath ? `/${resource.localPath}` : undefined,
      blobId: resource?.blobId ?? page?.source?.blobId,
      blobHash: resource?.blobHash ?? page?.source?.blobHash,
      resourcePath: resource?.path ?? page?.source?.resourcePath,
      byteLength: resource?.byteLength,
      children
    };
  });

  const docNodes = allPaths
    .filter((pathName) => isMarkdownPath(pathName))
    .map((pathName) => resourceNode(resourceByPath.get(pathName), { id: `doc:${pathName}`, label: pathName, kind: "markdown", path: pathName }));

  const brandPaths = new Set<string>();
  for (const image of [...(input.images ?? []), ...(input.brand?.logos ?? [])]) {
    const pathName = normalizeSitePath(image.src ?? image.absoluteUrl, input.target);
    if (pathName && (image.role === "logo" || image.role === "icon" || /logo|favicon|icon|og-image|apple-touch/i.test(pathName))) brandPaths.add(pathName);
  }
  for (const pathName of allPaths) {
    if (/\/(?:logo|favicon|icon|og-image|apple-touch)[^/]*\.(?:svg|png|jpe?g|webp|ico)$/i.test(pathName)) brandPaths.add(pathName);
  }

  const brandNodes = [...brandPaths].sort().map((pathName) =>
    resourceNode(resourceByPath.get(pathName), {
      id: `brand:${pathName}`,
      label: pathName,
      kind: "brand",
      path: pathName
    })
  );

  const agentPaths = allPaths.filter((pathName) => /^\/(?:llms\.txt|sitemap\.xml|robots\.txt)$/i.test(pathName));
  const agentNodes = [
    ...agentPaths.map((pathName) => resourceNode(resourceByPath.get(pathName), { id: `agent:${pathName}`, label: pathName, kind: "agent", path: pathName })),
    contextNode("/context/manifest.json"),
    contextNode("/context/sitemap.json"),
    contextNode("/context/site-structure.json"),
    contextNode("/context/resources.json"),
    contextNode("/context/design-system.json")
  ];

  const assetNodes = allPaths
    .filter((pathName) => !isHtmlPath(pathName) && !isMarkdownPath(pathName) && !brandPaths.has(pathName) && !agentPaths.includes(pathName))
    .map((pathName) => resourceNode(resourceByPath.get(pathName), { id: `asset:${pathName}`, label: pathName, kind: "asset", path: pathName }));

  const walrusNodes = resources.map((resource) =>
    resourceNode(resource, {
      id: `walrus:${resource.path}`,
      label: resource.path,
      kind: "walrus-resource",
      path: resource.path
    })
  );

  const nodes = [
    groupNode("pages", "Pages", pageNodes),
    groupNode("docs-source", "Docs Source", docNodes),
    groupNode("assets", "Assets", assetNodes),
    groupNode("brand-assets", "Brand Assets", brandNodes),
    groupNode("agent-files", "Agent Files", agentNodes),
    groupNode("walrus-provenance", "Walrus Provenance", walrusNodes)
  ];

  return {
    target: input.target,
    generatedAt: new Date().toISOString(),
    summary: {
      pages: pageNodes.length,
      docs: docNodes.length,
      assets: assetNodes.length,
      brandAssets: brandNodes.length,
      agentFiles: agentNodes.length,
      walrusResources: walrusNodes.length
    },
    nodes
  };
}

function groupNode(id: string, label: string, children: SiteStructureNode[]): SiteStructureNode {
  return { id, label, kind: "group", children };
}

function resourceNode(resource: WalrusResourceRecord | undefined, base: SiteStructureNode): SiteStructureNode {
  return {
    ...base,
    contentType: resource?.contentType ?? (base.path ? detectContentType(base.path) : undefined),
    sourcePath: resource?.localPath,
    artifactPath: resource?.localPath ? `/${resource.localPath}` : base.artifactPath,
    blobId: resource?.blobId ?? base.blobId,
    blobHash: resource?.blobHash ?? base.blobHash,
    resourcePath: resource?.path ?? base.resourcePath ?? base.path,
    byteLength: resource?.byteLength ?? base.byteLength
  };
}

function contextNode(artifactPath: string): SiteStructureNode {
  return {
    id: `context:${artifactPath}`,
    label: artifactPath,
    kind: "context",
    path: artifactPath,
    artifactPath,
    contentType: detectContentType(artifactPath)
  };
}

function buildResourcePathIndex(resources: WalrusResourceRecord[]): Map<string, WalrusResourceRecord> {
  const byPath = new Map<string, WalrusResourceRecord>();
  for (const resource of resources) {
    for (const alias of resourcePathAliases(resource.path)) {
      if (!byPath.has(alias)) byPath.set(alias, resource);
    }
  }
  return byPath;
}

function resourceForPath(resourceByPath: Map<string, WalrusResourceRecord>, ...paths: Array<string | undefined>): WalrusResourceRecord | undefined {
  for (const pathName of paths) {
    if (!pathName) continue;
    for (const alias of resourcePathAliases(pathName)) {
      const resource = resourceByPath.get(alias);
      if (resource) return resource;
    }
  }
  return undefined;
}

function resourcePathAliases(value: string): string[] {
  const normalized = normalizeRoute(value);
  const aliases = new Set<string>([normalized]);
  if (/\/index\.html?$/i.test(normalized)) {
    aliases.add(normalized.replace(/\/index\.html?$/i, "") || "/");
  }
  if (/\.html?$/i.test(normalized)) {
    aliases.add(normalized.replace(/\.html?$/i, ""));
  }
  return [...aliases];
}

function normalizeSitePath(value: string | undefined, target: string): string {
  if (!value) return "";
  if (value.startsWith("walrus://")) {
    const marker = value.indexOf("/", "walrus://".length);
    return marker >= 0 ? normalizeRoute(value.slice(marker)) : "/index.html";
  }
  try {
    if (/^https?:\/\//i.test(value)) return normalizeRoute(new URL(value).pathname || "/");
    if (/^\/\//.test(value)) return normalizeRoute(new URL(`https:${value}`).pathname || "/");
    if (!value.startsWith("/") && /^https?:\/\//i.test(target)) return normalizeRoute(new URL(value, target).pathname || "/");
  } catch {
    return normalizeRoute(value);
  }
  return normalizeRoute(value);
}

function normalizeRoute(value: string): string {
  if (!value || value === "/") return "/index.html";
  const pathOnly = value.split(/[?#]/)[0] || value;
  if (pathOnly.endsWith("/")) return `${pathOnly}index.html`;
  return pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
}

function isHtmlPath(pathName: string): boolean {
  return /\.html?$/i.test(pathName);
}

function isMarkdownPath(pathName: string): boolean {
  return /\.md$/i.test(pathName);
}

function markdownForHtml(route: string): string | undefined {
  const normalized = normalizeRoute(route);
  if (normalized === "/index.html") return "/index.md";
  const match = normalized.match(/^(.+)\/index\.html?$/i);
  if (match?.[1]) return `${match[1]}.md`;
  if (/\.html?$/i.test(normalized)) return normalized.replace(/\.html?$/i, ".md");
  if (!path.extname(normalized)) return `${normalized}.md`;
  return undefined;
}

function routeLabel(route: string): string {
  if (route === "/index.html") return "/";
  return route.replace(/\/index\.html?$/i, "/");
}

function pageArtifactBasename(page: PageArtifact, index: number): string {
  return `${String(index + 1).padStart(3, "0")}-${slug(page.routePath ?? page.url)}`;
}

function slug(input: string): string {
  return input.replace(/^https?:\/\//, "").replaceAll(/[^a-z0-9]+/gi, "-").replaceAll(/^-|-$/g, "").toLowerCase() || "index";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
