import type { MemoryGraph, RelatedNeighbor } from "../../lib/memory-graph-types.js";

// force-graph swaps link.source/target from an id string to the node ref after it
// runs, so accept either shape.
function linkEndId(end: unknown): string {
  return typeof end === "object" && end !== null ? (end as { id: string }).id : (end as string);
}

const MAX_RELATED = 8; // a hub entity can have many edges; keep the panel list scannable

// The selected node's neighbours + the connecting relationship, highest-confidence
// first, for the panel's clickable "Related" list. Deduped to one entry per neighbour:
// a pair can be joined by two edges (e.g. A offers B + B depends_on A) — keep the
// strongest, which also keeps the React keys unique. `direction` is "out" when the
// selected node is the relationship's source, "in" when it's the target.
export function relatedNeighbors(graph: MemoryGraph, selectedId: string): RelatedNeighbor[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const best = new Map<string, RelatedNeighbor>();
  for (const l of graph.links) {
    const sid = linkEndId(l.source), tid = linkEndId(l.target);
    const otherId = sid === selectedId ? tid : tid === selectedId ? sid : null;
    if (!otherId) continue;
    const other = nodeById.get(otherId);
    if (!other) continue;
    const existing = best.get(otherId);
    if (!existing || (l.confidence ?? 0) > (existing.confidence ?? 0)) {
      best.set(otherId, { node: other, relLabel: l.relLabel, relKind: l.relKind, confidence: l.confidence, direction: sid === selectedId ? "out" : "in" });
    }
  }
  return [...best.values()].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)).slice(0, MAX_RELATED);
}
