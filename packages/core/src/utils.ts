import { createHash } from "node:crypto";
import path from "node:path";
import { nanoid } from "nanoid";
import type { Network, TargetKind, TargetMode } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

export function createRunId(prefix = "run"): string {
  return `${prefix}_${new Date().toISOString().replaceAll(/[:.]/g, "-")}_${nanoid(8)}`;
}

export function sha256Hex(input: string | Uint8Array | ArrayBuffer): string {
  return createHash("sha256").update(toBuffer(input)).digest("hex");
}

export function sha256Base64(input: string | Uint8Array | ArrayBuffer): string {
  return createHash("sha256").update(toBuffer(input)).digest("base64");
}

export function toBuffer(input: string | Uint8Array | ArrayBuffer): Buffer {
  if (typeof input === "string") return Buffer.from(input);
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  return Buffer.from(input);
}

export function base64UrlSafeEncode(bytes: Uint8Array | Buffer): string {
  return Buffer.from(bytes).toString("base64").replaceAll("/", "_").replaceAll("+", "-").replaceAll("=", "");
}

export function base64UrlToBase64(value: string): string {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  return padded.replaceAll("-", "+").replaceAll("_", "/");
}

export function normalizeInputTarget(target: string): string {
  const trimmed = target.trim();
  if (!trimmed) throw new Error("Target is required");
  if (isWalrusObjectId(trimmed)) return trimmed.toLowerCase();
  if (looksLikeEmail(trimmed) || looksLikeTicker(trimmed)) return trimmed;
  if (looksLikeUrl(trimmed)) return normalizeUrl(trimmed);
  if (looksLikeDomain(trimmed)) return normalizeUrl(`https://${trimmed}`);
  return trimmed;
}

export function normalizeUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  if ((parsed.protocol === "https:" && parsed.port === "443") || (parsed.protocol === "http:" && parsed.port === "80")) {
    parsed.port = "";
  }
  if (parsed.pathname !== "/" && parsed.pathname.endsWith("/")) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }
  return parsed.toString();
}

export function inferTargetKind(target: string): TargetKind {
  const trimmed = target.trim();
  if (isWalrusObjectId(trimmed)) return "walrus-object";
  if (looksLikeUrl(trimmed)) {
    const host = new URL(trimmed).hostname;
    if (host.endsWith(".wal.app") || host === "wal.app" || host === "localhost" || host === "127.0.0.1") return "walrus-url";
    return "url";
  }
  if (trimmed.endsWith(".json")) return "preview-config";
  if (looksLikeEmail(trimmed)) return "email";
  if (looksLikeTicker(trimmed)) return "ticker";
  if (looksLikeDomain(trimmed)) return "domain";
  return "name";
}

export function inferMode(target: string, requested: TargetMode = "auto"): TargetMode {
  if (requested !== "auto") return requested;
  const kind = inferTargetKind(target);
  if (kind === "walrus-object" || kind === "preview-config") return "walrus";
  if (kind === "walrus-url" && isLocalPreviewUrl(target)) return "walrus";
  if (kind === "walrus-url" && isWalrusPortalSubdomain(target)) return "walrus";
  return "web";
}

export function isWalrusObjectId(value: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(value.trim());
}

export function looksLikeUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

export function isLocalPreviewUrl(value: string): boolean {
  if (!looksLikeUrl(value)) return false;
  const host = new URL(value).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

export function isWalrusPortalSubdomain(value: string): boolean {
  if (!looksLikeUrl(value)) return false;
  const host = new URL(value).hostname;
  return host.endsWith(".wal.app");
}

export function looksLikeEmail(value: string): boolean {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());
}

export function looksLikeDomain(value: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim());
}

export function looksLikeTicker(value: string): boolean {
  return /^[A-Z]{1,6}(:[A-Z]{2,5})?$/.test(value.trim());
}

export function domainFromTarget(target: string): string {
  if (looksLikeEmail(target)) return target.split("@")[1]!.toLowerCase();
  const normalized = normalizeInputTarget(target);
  if (looksLikeUrl(normalized)) return new URL(normalized).hostname.replace(/^www\./, "");
  if (looksLikeDomain(normalized)) return normalized.replace(/^www\./, "");
  throw new Error(`Cannot derive domain from target: ${target}`);
}

export function namespaceForTarget(target: string, mode: TargetMode, network?: Network, siteObjectId?: string): string {
  if (mode === "walrus" && siteObjectId) return `walrus:${network ?? "mainnet"}:${siteObjectId.toLowerCase()}`;
  if (mode === "web") return `web:${domainFromTarget(target)}`;
  return `target:${sha256Hex(target).slice(0, 16)}`;
}

export function safeJoin(root: string, unsafePath: string): string {
  const relative = unsafePath.replace(/^\/+/, "");
  const resolved = path.resolve(root, relative || "index.html");
  const normalizedRoot = path.resolve(root) + path.sep;
  const normalizedResolved = resolved.endsWith(path.sep) ? resolved : resolved + path.sep;
  if (!normalizedResolved.startsWith(normalizedRoot) && resolved !== path.resolve(root)) {
    throw new Error(`Path escapes output root: ${unsafePath}`);
  }
  return resolved;
}

export function pathToRoute(filePath: string): string {
  if (filePath === "/" || filePath === "") return "/index.html";
  if (filePath.endsWith("/")) return `${filePath}index.html`;
  return filePath.startsWith("/") ? filePath : `/${filePath}`;
}

export function isUtilityPageRoute(routePath: string): boolean {
  const route = pathToRoute(routePath.split(/[?#]/)[0] ?? routePath).toLowerCase();
  return (
    route === "/404.html" ||
    route === "/404/index.html" ||
    route === "/search" ||
    route === "/search.html" ||
    route === "/search/index.html" ||
    route.endsWith(".html.html") ||
    route.endsWith(".htm/index.html")
  );
}

export function comparePageRoutes(left: string, right: string): number {
  const leftRoute = pathToRoute(left);
  const rightRoute = pathToRoute(right);
  const leftRank = pageRouteRank(leftRoute);
  const rightRank = pageRouteRank(rightRoute);
  return leftRank === rightRank ? leftRoute.localeCompare(rightRoute) : leftRank - rightRank;
}

export function detectContentType(filePath: string, fallback = "application/octet-stream"): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf"
  };
  return map[ext] ?? fallback;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function normalizeCssColor(color: string): string {
  return color.trim().replaceAll(/\s+/g, " ");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function pageRouteRank(routePath: string): number {
  const route = pathToRoute(routePath).toLowerCase();
  if (route === "/index.html") return 0;
  if (route.endsWith("/index.html")) return 1;
  return 2;
}
