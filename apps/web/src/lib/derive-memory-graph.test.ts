import { describe, expect, it } from "vitest";
import { deriveMemoryGraph, sizeScale } from "./derive-memory-graph.js";
import type { ContextChunk, MemoryGraph } from "./memory-graph-types.js";

describe("sizeScale", () => {
  it("is monotonic non-decreasing in byteLength", () => {
    expect(sizeScale(4000)).toBeGreaterThanOrEqual(sizeScale(100));
  });
  it("never returns below 1 (zero-byte chunk still visible)", () => {
    expect(sizeScale(0)).toBeGreaterThanOrEqual(1);
  });
});

function chunk(p: {
  id: string;
  route: string;
  headingPath: string[];
  order: number;
  text?: string;
}): ContextChunk {
  const text = p.text ?? `Body of ${p.id}`;
  return {
    chunkId: p.id,
    routePath: p.route,
    headingPath: p.headingPath,
    heading: p.headingPath[p.headingPath.length - 1],
    text,
    contentHash: `hash-${p.id}`,
    byteLength: text.length,
    order: p.order,
  };
}

// Deliberately shuffled so the function must sort by `order`, not input order.
// Two pages: "/a" is a heading tree A > B > C and A > D; "/b" is two flat headings.
function fixture(): ContextChunk[] {
  return [
    chunk({ id: "c4", route: "/a", headingPath: ["A", "D"], order: 3 }),
    chunk({ id: "c1", route: "/a", headingPath: ["A"], order: 0 }),
    chunk({ id: "c6", route: "/b", headingPath: ["Y"], order: 5 }),
    chunk({ id: "c3", route: "/a", headingPath: ["A", "B", "C"], order: 2 }),
    chunk({ id: "c2", route: "/a", headingPath: ["A", "B"], order: 1 }),
    chunk({ id: "c5", route: "/b", headingPath: ["X"], order: 4 }),
  ];
}

function linkFrom(graph: MemoryGraph, source: string) {
  return graph.links.find((l) => l.source === source);
}

// Union-find: do all nodes collapse to a single root once links are unioned?
function componentCount(graph: MemoryGraph): number {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    return r;
  };
  for (const n of graph.nodes) parent.set(n.id, n.id);
  for (const l of graph.links) {
    const a = find(l.source);
    const b = find(l.target);
    if (a !== b) parent.set(a, b);
  }
  return new Set(graph.nodes.map((n) => find(n.id))).size;
}

describe("deriveMemoryGraph", () => {
  it("builds one node per chunk, ordered by `order`", () => {
    const g = deriveMemoryGraph(fixture());
    expect(g.nodes).toHaveLength(6);
    expect(g.nodes.map((n) => n.id)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
  });

  // This is the whole point of the spec (§7): the layout must settle into one
  // cohesive globe, never disjoint per-page islands. If this invariant breaks,
  // the visual breaks — so it is asserted structurally, not by eyeballing.
  it("forms a single connected, acyclic tree with exactly n-1 links", () => {
    const g = deriveMemoryGraph(fixture());
    expect(g.links).toHaveLength(g.nodes.length - 1);
    expect(componentCount(g)).toBe(1);
    expect(g.links.every((l) => l.source !== l.target)).toBe(true);
  });

  it("links a child heading to its nearest proper-prefix ancestor", () => {
    const g = deriveMemoryGraph(fixture());
    // ['A','B'] -> ['A'] and ['A','B','C'] -> ['A','B'] (nearest, not the root).
    expect(linkFrom(g, "c2")).toMatchObject({ target: "c1", kind: "hierarchy" });
    expect(linkFrom(g, "c3")).toMatchObject({ target: "c2", kind: "hierarchy" });
    // ['A','D'] shares only the ['A'] prefix, so it attaches to c1, not c2/c3.
    expect(linkFrom(g, "c4")).toMatchObject({ target: "c1", kind: "hierarchy" });
  });

  it("links each page's first chunk to the previous page's first chunk (spine)", () => {
    const g = deriveMemoryGraph(fixture());
    // "/b" first chunk (c5) attaches to "/a" first chunk (c1).
    expect(linkFrom(g, "c5")).toMatchObject({ target: "c1", kind: "spine" });
  });

  it("links a chunk with no prefix ancestor to its page's first chunk", () => {
    const g = deriveMemoryGraph(fixture());
    // c6 ['Y'] has no proper-prefix ancestor in "/b"; falls back to page first (c5).
    expect(linkFrom(g, "c6")).toMatchObject({ target: "c5", kind: "page" });
  });

  it("returns an empty graph for no chunks", () => {
    expect(deriveMemoryGraph([])).toEqual({ nodes: [], links: [] });
  });

  it("produces a lone node and no links for a single chunk", () => {
    const g = deriveMemoryGraph([chunk({ id: "only", route: "/", headingPath: ["H"], order: 0 })]);
    expect(g.nodes).toHaveLength(1);
    expect(g.links).toHaveLength(0);
  });
});
