// Local mirror of `@contextmem/core`'s `ContextChunk` — the web is a separate
// deployable that reads this shape from `chunks.ndjson` over HTTP, and the web
// tsconfig's `rootDir: "src"` forbids importing core's source types directly
// (TS6059). Keep in sync with packages/core/src/types.ts.
export interface ContextChunk {
  chunkId: string;
  routePath: string;
  url?: string;
  heading?: string;
  headingPath: string[];
  text: string;
  contentHash: string;
  byteLength: number;
  order: number;
}

export type MemoryLinkKind = "hierarchy" | "page" | "spine";

export interface MemoryNode {
  id: string; // = chunkId
  label: string; // heading ?? first line of text
  routePath: string; // page — colour + clustering key
  headingPath: string[];
  url?: string;
  textPreview: string;
  byteLength: number;
  order: number;
  val: number; // force-graph node size
  // force-graph mutates nodes in place (x/y/z/vx/…); keep the shape open for it.
  [key: string]: unknown;
}

export interface MemoryLink {
  source: string; // chunkId; force-graph later swaps this for a node ref
  target: string;
  kind: MemoryLinkKind;
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  links: MemoryLink[];
}
