import type { ContextChunk, PageArtifact } from "./types.js";
import { sha256Hex } from "./utils.js";

const MAX_CHUNK_CHARS = 4000;

type Section = { heading?: string; headingPath: string[]; text: string };

/**
 * Deterministic chunker: same page markdown always yields the same chunkIds.
 * chunkId is derived from routePath + heading path + normalized content, so it
 * is stable across reruns and lets MemWal writes diff against a prior snapshot.
 */
export function buildChunks(pages: PageArtifact[]): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  const partCounters = new Map<string, number>();
  let order = 0;
  for (const page of pages) {
    const routePath = page.routePath ?? safeRoute(page.url);
    for (const section of splitMarkdownByHeadings(page.markdown ?? "")) {
      for (const part of splitLong(section.text, MAX_CHUNK_CHARS)) {
        const normalized = normalizeText(part);
        if (!normalized) continue;
        // chunkId is location-based (route + heading path + position) so it stays
        // stable when content is edited; contentHash captures the content change.
        const locationKey = `${routePath}\n${section.headingPath.join(" > ")}`;
        const partIndex = partCounters.get(locationKey) ?? 0;
        partCounters.set(locationKey, partIndex + 1);
        chunks.push({
          chunkId: sha256Hex(`${locationKey}\n#${partIndex}`).slice(0, 16),
          routePath,
          url: page.url,
          heading: section.heading,
          headingPath: section.headingPath,
          text: part,
          contentHash: sha256Hex(normalized),
          byteLength: Buffer.byteLength(part, "utf8"),
          order: order++
        });
      }
    }
  }
  return chunks;
}

export function renderChunksNdjson(chunks: ContextChunk[]): string {
  if (!chunks.length) return "";
  return `${chunks.map((chunk) => JSON.stringify(chunk)).join("\n")}\n`;
}

export function parseChunksNdjson(text: string): ContextChunk[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ContextChunk);
}

/** Deterministic, source-derived digest: same content => same value (no timestamps). */
export function chunkGraphDigest(chunks: ContextChunk[]): string {
  const lines = chunks.map((chunk) => `${chunk.chunkId}:${chunk.contentHash}`).sort();
  return sha256Hex(lines.join("\n"));
}

export type MemoryWritePlan = {
  added: ContextChunk[];
  changed: ContextChunk[];
  unchanged: ContextChunk[];
  removed: string[];
};

/** Diff current chunks against a prior snapshot so MemWal only writes what changed. */
export function planMemoryWrite(current: ContextChunk[], prior: ContextChunk[]): MemoryWritePlan {
  const priorById = new Map(prior.map((chunk) => [chunk.chunkId, chunk]));
  const currentIds = new Set(current.map((chunk) => chunk.chunkId));
  const added: ContextChunk[] = [];
  const changed: ContextChunk[] = [];
  const unchanged: ContextChunk[] = [];
  for (const chunk of current) {
    const before = priorById.get(chunk.chunkId);
    if (!before) added.push(chunk);
    else if (before.contentHash !== chunk.contentHash) changed.push(chunk);
    else unchanged.push(chunk);
  }
  const removed = prior.filter((chunk) => !currentIds.has(chunk.chunkId)).map((chunk) => chunk.chunkId);
  return { added, changed, unchanged, removed };
}

function splitMarkdownByHeadings(markdown: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: Section = { headingPath: [], text: "" };
  const flush = () => {
    if (current.text.trim()) sections.push({ heading: current.heading, headingPath: current.headingPath, text: current.text.trim() });
  };
  for (const line of markdown.split("\n")) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (match) {
      flush();
      const level = (match[1] ?? "").length;
      const title = (match[2] ?? "").trim();
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (!top || top.level < level) break;
        stack.pop();
      }
      stack.push({ level, title });
      current = { heading: title, headingPath: stack.map((entry) => entry.title), text: "" };
    } else {
      current.text += `${line}\n`;
    }
  }
  flush();
  if (sections.length) return sections;
  return markdown.trim() ? [{ headingPath: [], text: markdown.trim() }] : [];
}

/**
 * Whitespace-normalize text for stable hashing and substring grounding checks.
 * Exported so facts.ts validateQuote() uses the IDENTICAL normalization as the
 * chunker, guaranteeing the quote-substring check is consistent with chunk text.
 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitLong(text: string, maxChars: number): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed ? [trimmed] : [];
  const parts: string[] = [];
  let buffer = "";
  for (const paragraph of trimmed.split(/\n{2,}/)) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length > maxChars && buffer) {
      parts.push(buffer);
      buffer = paragraph;
    } else {
      buffer = candidate;
    }
    while (buffer.length > maxChars) {
      parts.push(buffer.slice(0, maxChars));
      buffer = buffer.slice(maxChars);
    }
  }
  if (buffer.trim()) parts.push(buffer.trim());
  return parts;
}

function safeRoute(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
