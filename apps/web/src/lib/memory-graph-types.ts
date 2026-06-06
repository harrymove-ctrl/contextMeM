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
  id: string; // = chunkId / entityId
  label: string; // heading ?? entity name
  routePath: string; // entity type — drives colour (entity-colors.ts) + legend grouping
  headingPath: string[];
  url?: string;
  text: string; // full chunk text / entity description — panel body + search haystack
  byteLength: number;
  order: number;
  val: number; // force-graph node size (salience-scaled)
  salience?: number; // 0..1 importance — node size + glow brightness
  primary?: boolean; // the namespace's identity entity — gets a highlight ring
  mentions?: number; // raw mention count (panel context)
  // force-graph mutates nodes in place (x/y/z/vx/…); keep the shape open for it.
  [key: string]: unknown;
}

export interface MemoryLink {
  source: string; // entityId; force-graph later swaps this for a node ref
  target: string;
  kind: MemoryLinkKind;
  relKind?: string; // relationship type (built_with, owned_by, …) — edge styling + label
  relLabel?: string; // human edge label shown on hover
  confidence?: number; // 0..1 — edge width + particle speed
}

export interface MemoryGraph {
  nodes: MemoryNode[];
  links: MemoryLink[];
}

// Per-entity detail surfaced in the side panel, joined from SiteFacts (entity-detail.ts):
// claims/stats are keyed by subjectEntityId, topics inverted from topic.entityIds,
// aliases off the entity. Looked up by entity id; absent when the entity has none.
export interface EntityClaim {
  text: string;
  kind: string; // raw claim kind (value_prop, differentiator, …) — prettified for display
  sentiment: "positive" | "neutral" | "negative"; // drives the sentiment dot colour
}
export interface EntityStat {
  value: string; // valueRaw, e.g. "99.9%"
  label: string;
}
export interface EntityDetail {
  aliases: string[];
  topics: string[];
  claims: EntityClaim[];
  stats: EntityStat[];
}

// A selected node's graph neighbour, with the connecting relationship — rendered as
// the panel's clickable "Related" list (click flies the camera + swaps the sheet).
export interface RelatedNeighbor {
  node: MemoryNode;
  relLabel?: string;
  relKind?: string;
  confidence?: number;
  direction: "out" | "in";
}
