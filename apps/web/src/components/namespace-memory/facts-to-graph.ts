import type { MemoryGraph, MemoryNode, MemoryLink } from "../../lib/memory-graph-types.js";

// Minimal structural inputs — SiteEntity / SiteRelationship (defined in main.tsx)
// are assignable to these, so we avoid coupling this module to the app entry.
export type FactsEntityInput = { id: string; name: string; type: string; salience: number; description?: string; url?: string };
export type FactsRelationInput = { sourceEntityId: string; targetEntityId: string };

const MAX_NODES = 40; // keep the constellation legible for dense namespaces

// Adapt extracted facts (entities + relationships) into the MemoryGraph the
// constellation renders: routePath = entity type (drives the neon colour + the
// legend grouping), val = salience-scaled node size. Relationships become links
// between kept nodes; "spine" gives them the brighter/thicker edge style.
export function factsToMemoryGraph(
  entities: FactsEntityInput[],
  relationships: FactsRelationInput[],
): MemoryGraph {
  const ranked = entities
    .slice()
    .sort((a, b) => (b.salience || 0) - (a.salience || 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_NODES);
  const maxSalience = Math.max(...ranked.map((e) => e.salience || 0), 0.0001);
  const keptIds = new Set(ranked.map((e) => e.id));

  const nodes: MemoryNode[] = ranked.map((entity, index) => ({
    id: entity.id,
    label: entity.name,
    routePath: entity.type,
    headingPath: [entity.type],
    url: entity.url,
    text: entity.description ?? entity.name,
    byteLength: (entity.description ?? "").length,
    order: index,
    val: 1 + ((entity.salience || 0) / maxSalience) * 4,
  }));

  const links: MemoryLink[] = relationships
    .filter((r) => keptIds.has(r.sourceEntityId) && keptIds.has(r.targetEntityId) && r.sourceEntityId !== r.targetEntityId)
    .map((r) => ({ source: r.sourceEntityId, target: r.targetEntityId, kind: "spine" as const }));

  return { nodes, links };
}
