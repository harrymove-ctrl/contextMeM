import type { ContextChunk } from "./memory-graph-types.js";

function isContextChunk(v: unknown): v is ContextChunk {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.chunkId === "string" &&
    typeof o.routePath === "string" &&
    Array.isArray(o.headingPath) &&
    typeof o.text === "string" &&
    typeof o.byteLength === "number" &&
    typeof o.order === "number"
  );
}

// Tolerant: one JSON object per line; blank/corrupt/invalid lines are dropped.
export function parseChunksNdjson(text: string): ContextChunk[] {
  const out: ContextChunk[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isContextChunk(parsed)) out.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
