import type { ContextChunk, MemoryGraph, MemoryLink, MemoryNode } from "./memory-graph-types.js";

// `prefix` is a strictly-shorter ancestor of `full` in the heading hierarchy.
function isProperPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length >= full.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== full[i]) return false;
  }
  return true;
}

function toNode(c: ContextChunk): MemoryNode {
  const firstLine = c.text.split("\n")[0] ?? "";
  return {
    id: c.chunkId,
    label: c.heading ?? firstLine,
    routePath: c.routePath,
    headingPath: c.headingPath,
    url: c.url,
    textPreview: c.text.slice(0, 200),
    byteLength: c.byteLength,
    order: c.order,
    val: Math.max(1, Math.sqrt(c.byteLength)), // node area ∝ bytes
  };
}

/**
 * Turn a namespace's chunks into a connected, acyclic memory tree (§7).
 *
 * Every non-root node gets exactly one parent of strictly lower `order`, so the
 * graph is always one component — `nodes.length - 1` links, no per-page islands.
 * Parents come from document structure: a chunk attaches to its nearest
 * proper-prefix heading ancestor on the same page; chunks with no such ancestor
 * attach to their page's first chunk; and each page's first chunk attaches to
 * the previous page's first chunk (the page spine). Deterministic.
 */
export function deriveMemoryGraph(chunks: ContextChunk[]): MemoryGraph {
  const sorted = [...chunks].sort((a, b) => a.order - b.order);
  const nodes = sorted.map(toNode);
  const links: MemoryLink[] = [];

  // Group by page, preserving global `order` within each group. Insertion order
  // of the Map is therefore page order (by each page's first chunk).
  const pages = new Map<string, ContextChunk[]>();
  for (const c of sorted) {
    const list = pages.get(c.routePath);
    if (list) list.push(c);
    else pages.set(c.routePath, [c]);
  }

  // Intra-page: hierarchy link to nearest prefix ancestor, else to page first.
  for (const pageChunks of pages.values()) {
    const first = pageChunks[0];
    if (!first) continue;
    for (let i = 1; i < pageChunks.length; i++) {
      const c = pageChunks[i]!;
      let parent: ContextChunk | undefined;
      for (let j = i - 1; j >= 0; j--) {
        if (isProperPrefix(pageChunks[j]!.headingPath, c.headingPath)) {
          parent = pageChunks[j]!;
          break;
        }
      }
      links.push(
        parent
          ? { source: c.chunkId, target: parent.chunkId, kind: "hierarchy" }
          : { source: c.chunkId, target: first.chunkId, kind: "page" },
      );
    }
  }

  // Page spine: each page's first chunk -> previous page's first chunk.
  const pageFirsts = [...pages.values()].map((list) => list[0]!);
  for (let i = 1; i < pageFirsts.length; i++) {
    links.push({ source: pageFirsts[i]!.chunkId, target: pageFirsts[i - 1]!.chunkId, kind: "spine" });
  }

  return { nodes, links };
}
