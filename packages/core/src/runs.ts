import fs from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactFileRecord,
  ContextChunk,
  DiffCounter,
  DesignSystem,
  ImageAsset,
  PageArtifact,
  PublishReadiness,
  RunHistoryItem,
  RunManifest,
  SiteSnapshotDiff,
  SiteSnapshotDiffEntry,
  SnapshotManifest,
  WalrusPackageManifest,
  WalrusResourceRecord
} from "./types.js";
import { parseChunksNdjson } from "./chunks.js";
import { detectContentType, safeJoin } from "./utils.js";

export async function readRunManifest(runsDir: string, runId: string): Promise<RunManifest> {
  const runDir = resolveRunDir(runsDir, runId);
  return readJson(path.join(runDir, "manifest.json")) as Promise<RunManifest>;
}

export async function readContextManifest(runsDir: string, runId: string): Promise<WalrusPackageManifest> {
  const runDir = resolveRunDir(runsDir, runId);
  return readJson(path.join(runDir, "context", "manifest.json")) as Promise<WalrusPackageManifest>;
}

export async function readRunChunks(runsDir: string, runId: string): Promise<ContextChunk[]> {
  const runDir = resolveRunDir(runsDir, runId);
  const text = await fs.readFile(path.join(runDir, "context", "chunks.ndjson"), "utf8").catch(() => "");
  return text ? parseChunksNdjson(text) : [];
}

export async function readRunSnapshot(runsDir: string, runId: string): Promise<SnapshotManifest | undefined> {
  const runDir = resolveRunDir(runsDir, runId);
  return (await readJson(path.join(runDir, "context", "snapshot.json")).catch(() => undefined)) as SnapshotManifest | undefined;
}

export async function findPriorRunForNamespace(runsDir: string, runId: string, namespace: string): Promise<string | undefined> {
  const history = await listRuns(runsDir, 500);
  const current = history.find((item) => item.runId === runId);
  const currentUpdatedAt = Date.parse(current?.updatedAt ?? new Date().toISOString());
  return history.find(
    (item) => item.runId !== runId && item.namespace === namespace && item.status === "completed" && Date.parse(item.updatedAt) < currentUpdatedAt
  )?.runId;
}

export async function listRuns(runsDir: string, limit = 100): Promise<RunHistoryItem[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(runsDir);
  } catch {
    return [];
  }

  const items: RunHistoryItem[] = [];
  for (const entry of entries) {
    try {
      const runDir = resolveRunDir(runsDir, entry);
      const manifest = (await readJson(path.join(runDir, "manifest.json"))) as RunManifest;
      const context = (await readJson(path.join(runDir, "context", "manifest.json")).catch(() => undefined)) as WalrusPackageManifest | undefined;
      items.push({
        runId: manifest.runId,
        target: manifest.target,
        normalizedTarget: manifest.normalizedTarget,
        mode: manifest.mode,
        status: manifest.status,
        namespace: manifest.namespace,
        outputs: manifest.outputs,
        artifactDir: manifest.artifactDir,
        createdAt: manifest.createdAt,
        updatedAt: manifest.updatedAt,
        pages: context?.pages?.length ?? 0,
        images: context?.images?.length ?? 0,
        resources: context?.walrus?.resources?.length ?? 0,
        hasDesignSystem: Boolean(context?.designSystem),
        hasScreenshots: Boolean(context?.screenshots?.some((screenshot) => screenshot.status === "captured")),
        errors: manifest.errors
      });
    } catch {
      continue;
    }
  }

  return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, limit);
}

export async function listArtifactFiles(runDir: string): Promise<ArtifactFileRecord[]> {
  const root = path.resolve(runDir);
  const records: ArtifactFileRecord[] = [];
  await visit(root);
  return records.sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path));

  async function visit(dir: string): Promise<void> {
    let entries: Array<import("node:fs").Dirent> = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute);
      if (entry.isDirectory()) {
        if (relative === "site") continue;
        await visit(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolute);
      const artifactPath = `/${relative.split(path.sep).join("/")}`;
      const contentType = detectContentType(artifactPath);
      const kind = classifyArtifactKind(artifactPath, contentType);
      records.push({
        path: artifactPath,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
        contentType,
        kind,
        group: classifyArtifactGroup(artifactPath),
        previewable: isPreviewable(kind, stat.size),
        downloadable: true
      });
    }
  }
}

export async function resolveArtifactFile(runDir: string, requestedPath: string): Promise<{ absolutePath: string; record: ArtifactFileRecord }> {
  const normalized = normalizeArtifactPath(requestedPath);
  const absolutePath = safeJoin(runDir, normalized);
  const stat = await fs.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`Artifact is not a file: ${requestedPath}`);
  const contentType = detectContentType(normalized);
  const kind = classifyArtifactKind(normalized, contentType);
  return {
    absolutePath,
    record: {
      path: normalized,
      size: stat.size,
      updatedAt: stat.mtime.toISOString(),
      contentType,
      kind,
      group: classifyArtifactGroup(normalized),
      previewable: isPreviewable(kind, stat.size),
      downloadable: true
    }
  };
}

export async function buildPublishReadiness(runDir: string, runId = path.basename(runDir)): Promise<PublishReadiness> {
  const files = await listArtifactFiles(runDir);
  const requiredPaths = ["/index.html", "/llms.txt", "/ws-resources.json", "/context/manifest.json", "/context/sitemap.json", "/context/site-structure.json", "/context/images.json"];
  const optionalPaths = [
    "/context/brand.json",
    "/context/styleguide.json",
    "/context/design-system.json",
    "/context/figma.tokens.json",
    "/context/tokens.css",
    "/context/resources.json",
    "/context/discovery.json",
    "/context/screenshots.json",
    "/context/component-previews.json"
  ];
  const fileMap = new Map(files.map((file) => [file.path, file]));
  const required = requiredPaths.map((filePath) => ({ path: filePath, exists: fileMap.has(filePath), size: fileMap.get(filePath)?.size }));
  const optional = optionalPaths.map((filePath) => ({ path: filePath, exists: fileMap.has(filePath), size: fileMap.get(filePath)?.size }));
  const warnings = required.filter((file) => !file.exists).map((file) => `Missing required package file: ${file.path}`);
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const routeCount = files.filter((file) => file.path === "/index.html" || file.path.startsWith("/context/")).length;
  const manifest = (await readJson(path.join(runDir, "context", "manifest.json")).catch(() => undefined)) as WalrusPackageManifest | undefined;
  const outputDir = path.resolve(runDir);
  const publish = `cd ${shellQuote(outputDir)} && site-builder publish --epochs 1 .`;
  const update = manifest?.walrus?.site?.siteObjectId ? `cd ${shellQuote(outputDir)} && site-builder update --epochs 1 . ${manifest.walrus.site.siteObjectId}` : undefined;

  if (!optional.some((file) => file.path === "/context/design-system.json" && file.exists)) {
    warnings.push("Design-system export is optional, but absent from this package.");
  }
  if (!optional.some((file) => file.path === "/context/screenshots.json" && file.exists)) {
    warnings.push("Screenshot previews are optional, but absent from this package.");
  }

  return {
    runId,
    outputDir,
    ready: required.every((file) => file.exists),
    routeCount,
    artifactCount: files.length,
    totalBytes,
    required,
    optional,
    warnings,
    commands: { publish, update },
    files
  };
}

export async function diffRunSnapshots(runsDir: string, runId: string, compareToRunId?: string): Promise<SiteSnapshotDiff> {
  const current = await readContextManifest(runsDir, runId);
  const history = await listRuns(runsDir, 500);
  const currentHistory = history.find((item) => item.runId === runId);
  const compareId = compareToRunId ?? history.find((item) => item.runId !== runId && item.namespace === currentHistory?.namespace && Date.parse(item.updatedAt) < Date.parse(currentHistory?.updatedAt ?? new Date().toISOString()))?.runId;
  const previous = compareId ? await readContextManifest(runsDir, compareId).catch(() => undefined) : undefined;

  const pages = diffMaps(mapPages(previous?.pages), mapPages(current.pages));
  const resources = diffMaps(mapResources(previous?.walrus?.resources), mapResources(current.walrus?.resources));
  const images = diffMaps(mapImages(previous?.images), mapImages(current.images));
  const designTokens = diffMaps(mapDesignTokens(previous?.designSystem), mapDesignTokens(current.designSystem));

  return {
    baseRunId: runId,
    compareRunId: compareId,
    namespace: currentHistory?.namespace,
    generatedAt: new Date().toISOString(),
    summary: {
      pages: countDiff(pages),
      resources: countDiff(resources),
      images: countDiff(images),
      designTokens: countDiff(designTokens)
    },
    pages,
    resources,
    images,
    designTokens
  };
}

function normalizeArtifactPath(requestedPath: string): string {
  if (!requestedPath) throw new Error("Artifact path is required");
  const normalized = requestedPath.startsWith("/") ? requestedPath : `/${requestedPath}`;
  if (normalized.includes("\0")) throw new Error("Invalid artifact path");
  return normalized;
}

function resolveRunDir(runsDir: string, runId: string): string {
  const root = path.resolve(runsDir);
  const resolved = path.resolve(root, runId);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Run path escapes runs directory: ${runId}`);
  return resolved;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function classifyArtifactKind(artifactPath: string, contentType: string): ArtifactFileRecord["kind"] {
  if (/json/i.test(contentType)) return "json";
  if (/markdown/i.test(contentType) || /\.md$/i.test(artifactPath)) return "markdown";
  if (/html/i.test(contentType)) return "html";
  if (/^image\//i.test(contentType)) return "image";
  if (/css/i.test(contentType)) return "css";
  if (/text/i.test(contentType) || /\.(txt|log)$/i.test(artifactPath)) return "text";
  if (/octet-stream/i.test(contentType)) return "binary";
  return "other";
}

function classifyArtifactGroup(artifactPath: string): ArtifactFileRecord["group"] {
  if (/^\/context\/(?:design-system|tokens|figma|style-dictionary|tailwind|web-brand-kit|video-brand-kit)/.test(artifactPath)) return "design-system";
  if (/^\/context\/(?:walrus-site|resources|blobs|headers|routes|package)\.json$/.test(artifactPath)) return "walrus";
  if (/^\/context\/(?:screenshots|component-previews)(?:\.json|\/)/.test(artifactPath)) return "screenshots";
  if (/^\/context\/(?:pages|html)\//.test(artifactPath)) return "pages";
  if (/^\/(?:index\.html|llms\.txt|ws-resources\.json|manifest\.json)$/.test(artifactPath)) return "package";
  if (/^\/context\/(?:manifest|sitemap|discovery|site-structure|images|brand|styleguide|ai-query)\.json$/.test(artifactPath)) return "core";
  if (/^\/assets\//.test(artifactPath)) return "assets";
  return "other";
}

function isPreviewable(kind: ArtifactFileRecord["kind"], size: number): boolean {
  if (kind === "image") return true;
  return ["json", "markdown", "html", "css", "text"].includes(kind) && size <= 1024 * 1024;
}

function diffMaps(before: Map<string, unknown>, after: Map<string, unknown>): SiteSnapshotDiffEntry[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  return keys.map((key) => {
    const hasBefore = before.has(key);
    const hasAfter = after.has(key);
    if (!hasBefore) return { key, status: "added", after: after.get(key) };
    if (!hasAfter) return { key, status: "removed", before: before.get(key) };
    const beforeValue = before.get(key);
    const afterValue = after.get(key);
    return stableStringify(beforeValue) === stableStringify(afterValue)
      ? { key, status: "unchanged", before: beforeValue, after: afterValue }
      : { key, status: "changed", before: beforeValue, after: afterValue };
  });
}

function countDiff(entries: SiteSnapshotDiffEntry[]): DiffCounter {
  return entries.reduce<DiffCounter>(
    (acc, entry) => {
      acc[entry.status] += 1;
      return acc;
    },
    { added: 0, removed: 0, changed: 0, unchanged: 0 }
  );
}

function mapPages(pages: PageArtifact[] = []): Map<string, unknown> {
  return new Map(pages.map((page) => [page.routePath ?? page.url, { title: page.title, contentHash: page.contentHash, blobHash: page.source?.blobHash }]));
}

function mapResources(resources: WalrusResourceRecord[] = []): Map<string, unknown> {
  return new Map(resources.map((resource) => [resource.path, { blobId: resource.blobId, blobHash: resource.blobHash, contentType: resource.contentType, byteLength: resource.byteLength }]));
}

function mapImages(images: ImageAsset[] = []): Map<string, unknown> {
  return new Map(images.map((image) => [image.absoluteUrl, { role: image.role, contentType: image.contentType, width: image.width, height: image.height, localPath: image.localPath }]));
}

function mapDesignTokens(designSystem?: DesignSystem): Map<string, unknown> {
  if (!designSystem) return new Map();
  const pairs: Array<[string, unknown]> = [];
  for (const token of designSystem.tokens.colors) pairs.push([token.name, token.value]);
  for (const [index, value] of designSystem.tokens.spacing.entries()) pairs.push([`spacing.${index + 1}`, value]);
  for (const [index, value] of designSystem.tokens.radii.entries()) pairs.push([`radius.${index + 1}`, value]);
  for (const [index, value] of designSystem.tokens.shadows.entries()) pairs.push([`shadow.${index + 1}`, value]);
  for (const token of designSystem.tokens.typography.scale) pairs.push([token.name, { fontFamily: token.fontFamily, fontSize: token.fontSize, lineHeight: token.lineHeight, fontWeight: token.fontWeight }]);
  return new Map(pairs);
}

function stableStringify(value: unknown): string {
  if (!value || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
    .join(",")}}`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
