import type { MemoryGraph, MemoryNode, MemoryLink } from "../../lib/memory-graph-types.js";

// Minimal structural inputs — SiteEntity / SiteRelationship (defined in main.tsx)
// are assignable to these, so we avoid coupling this module to the app entry.
export type FactsEntityInput = { id: string; name: string; type: string; salience: number; description?: string; url?: string; mentions?: number };
export type FactsRelationInput = { sourceEntityId: string; targetEntityId: string; kind?: string; label?: string; confidence?: number };

const MAX_NODES = 40; // keep the constellation legible for dense namespaces

// Adapt extracted facts (entities + relationships) into the MemoryGraph the
// constellation renders. routePath = entity type (drives the neon colour via
// entity-colors.ts + the legend grouping); val/salience = node size + glow.
// Relationships keep their kind/label/confidence so the edges can be typed,
// directional, and explained on hover instead of being undifferentiated lines.
export function factsToMemoryGraph(
  entities: FactsEntityInput[],
  relationships: FactsRelationInput[],
  primaryEntityId?: string,
): MemoryGraph {
  const ranked = entities
    .slice()
    .sort((a, b) => (b.salience || 0) - (a.salience || 0) || a.id.localeCompare(b.id))
    .slice(0, MAX_NODES);
  const maxSalience = Math.max(...ranked.map((e) => e.salience || 0), 0.0001);
  const keptIds = new Set(ranked.map((e) => e.id));
  // Fall back to the highest-salience kept entity when no identity is supplied,
  // so there is always a clear focal node in the constellation.
  const primaryId = primaryEntityId && keptIds.has(primaryEntityId) ? primaryEntityId : ranked[0]?.id;

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
    salience: entity.salience || 0,
    primary: entity.id === primaryId,
    mentions: entity.mentions,
  }));

  const links: MemoryLink[] = relationships
    .filter((r) => keptIds.has(r.sourceEntityId) && keptIds.has(r.targetEntityId) && r.sourceEntityId !== r.targetEntityId)
    .map((r) => ({
      source: r.sourceEntityId,
      target: r.targetEntityId,
      kind: "spine" as const,
      relKind: r.kind,
      relLabel: r.label,
      confidence: r.confidence,
    }));

  return { nodes, links };
}
