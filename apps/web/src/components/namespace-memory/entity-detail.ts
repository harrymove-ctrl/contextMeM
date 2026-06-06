import type { EntityDetail } from "../../lib/memory-graph-types.js";

// Minimal structural inputs — SiteEntity / SiteClaim / SiteStat / SiteTopic
// (main.tsx) are assignable to these, so this stays decoupled from the app entry
// (mirrors facts-to-graph.ts's input types).
export type DetailEntityInput = { id: string; aliases?: string[] };
export type DetailClaimInput = { subjectEntityId?: string; text: string; kind: string; sentiment: "positive" | "neutral" | "negative"; confidence?: number };
export type DetailStatInput = { subjectEntityId?: string; label: string; valueRaw: string };
export type DetailTopicInput = { label: string; entityIds: string[] };

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

// Join the flat fact collections into a per-entity detail map the panel reads by id.
// claims/stats are keyed by subjectEntityId; topics carry their members in entityIds
// (inverted here). Only entities with at least one populated field get an entry, so
// the panel renders an extra section only when there is real data behind it.
export function buildEntityDetail(
  entities: DetailEntityInput[],
  claims: DetailClaimInput[],
  stats: DetailStatInput[],
  topics: DetailTopicInput[],
): Map<string, EntityDetail> {
  const claimsBy = new Map<string, DetailClaimInput[]>();
  for (const c of claims) if (c.subjectEntityId) push(claimsBy, c.subjectEntityId, c);
  const statsBy = new Map<string, DetailStatInput[]>();
  for (const s of stats) if (s.subjectEntityId) push(statsBy, s.subjectEntityId, s);
  const topicsBy = new Map<string, string[]>();
  for (const t of topics) for (const id of t.entityIds) push(topicsBy, id, t.label);

  const detail = new Map<string, EntityDetail>();
  for (const e of entities) {
    const aliases = e.aliases ?? [];
    const entityTopics = topicsBy.get(e.id) ?? [];
    // Show everything the entity has (the panel scrolls); just order claims so the
    // most-trusted read first.
    const entityClaims = (claimsBy.get(e.id) ?? [])
      .slice()
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .map((c) => ({ text: c.text, kind: c.kind, sentiment: c.sentiment }));
    const entityStats = (statsBy.get(e.id) ?? []).map((s) => ({ value: s.valueRaw, label: s.label }));
    if (aliases.length || entityTopics.length || entityClaims.length || entityStats.length) {
      detail.set(e.id, { aliases, topics: entityTopics, claims: entityClaims, stats: entityStats });
    }
  }
  return detail;
}
