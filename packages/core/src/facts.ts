// ============================================================================
// SiteFacts — grounded, viz-ready structured facts + auto context questions.
//
// Sits NEXT TO markdown/chunks; every fact-bearing node carries sources[]
// {chunkId|routePath|url + verbatim quote} for clickable "why" provenance.
//
// HARD INVARIANT (no-hallucination gate): every entity/claim/stat/question
// source carries a verbatim <=240-char quote that MUST be a real substring of
// its cited chunk (normalized via chunks.ts normalizeText). Quotes that fail
// the substring check are dropped and counted in coverage.ungroundedDropped.
//
// Always degrades to a deterministic HEURISTIC fallback so a run NEVER fails
// when no model key is set; all LLM calls are wrapped in try/catch.
// ============================================================================

import type { ContextChunk, PageArtifact } from "./types.js";
import { normalizeText } from "./chunks.js";
import { firstReadableSentence, rankedContextSentences } from "./web.js";
import { sha256Hex } from "./utils.js";

// ----------------------------------------------------------------------------
// Type tree (re-exported from types.ts).
// ----------------------------------------------------------------------------

export type FactSourceRef = {
  chunkId?: string; // stable id from buildChunks() (chunks.ts) — primary grounding anchor
  routePath?: string; // PageArtifact.routePath / manifest page routePath
  url?: string; // PageArtifact.url
  resourcePath?: string; // walrus provenance (reuse PageArtifact.source.resourcePath / page.artifactPath)
  blobId?: string; // walrus provenance (reuse PageArtifact.source.blobId)
  quote: string; // verbatim substring that supports the fact (<=240 chars). VALIDATED.
};

export type EntityType =
  | "organization"
  | "product"
  | "feature"
  | "person"
  | "technology"
  | "integration"
  | "platform"
  | "pricing_plan"
  | "use_case"
  | "metric"
  | "customer"
  | "competitor"
  | "location"
  | "event"
  | "concept"
  | "other";

export type SiteEntity = {
  id: string; // stable: sha256Hex(type + "\n" + normalizedName).slice(0,12)
  name: string;
  type: EntityType;
  aliases: string[];
  description?: string; // 1 sentence, must be supported by sources
  url?: string; // canonical/external link if the page links one out
  salience: number; // 0..1 — centrality (drives node size in viz) = mentions/maxMentions
  mentions: number; // # of chunks mentioning it
  sources: FactSourceRef[]; // REQUIRED non-empty
};

export type ClaimKind =
  | "value_prop"
  | "capability"
  | "differentiator"
  | "limitation"
  | "guarantee"
  | "positioning"
  | "fact";

export type Sentiment = "positive" | "neutral" | "negative";

export type SiteClaim = {
  id: string; // sha256Hex(normalizedText).slice(0,12)
  text: string; // normalized to one sentence
  kind: ClaimKind;
  subjectEntityId?: string; // FK -> SiteEntity.id
  sentiment: Sentiment;
  confidence: number; // 0..1 extraction confidence
  isMarketing: boolean; // promotional ("the best", "#1") — lets viz dim hype
  sources: FactSourceRef[]; // REQUIRED non-empty
};

export type StatUnit = "count" | "percent" | "currency" | "time" | "data_size" | "ratio" | "rate" | "other";

export type SiteStat = {
  id: string; // sha256Hex(label + "\n" + valueRaw).slice(0,12)
  label: string; // "uptime", "customers", "blob storage cost"
  valueRaw: string; // "99.99%", "$0.01/GB", "10,000+"
  valueNumber?: number; // parsed numeric (99.99, 0.01, 10000) for charts
  unit: StatUnit;
  currency?: string; // ISO code when unit=currency
  approximate: boolean; // "10,000+" / "~5M" => true
  subjectEntityId?: string; // FK -> SiteEntity.id
  sources: FactSourceRef[]; // REQUIRED non-empty
};

export type SiteTopic = {
  id: string; // sha256Hex(label).slice(0,12)
  label: string;
  weight: number; // 0..1 — share of content (drives treemap). Derived from chunk headingPath clustering.
  keywords: string[];
  routePaths: string[]; // pages where the topic dominates
  entityIds: string[]; // FK -> SiteEntity.id appearing under this topic
};

export type RelationKind =
  | "offers"
  | "part_of"
  | "integrates_with"
  | "competes_with"
  | "built_with"
  | "used_by"
  | "priced_at"
  | "depends_on"
  | "alternative_to"
  | "owned_by"
  | "mentions";

export type SiteRelationship = {
  id: string; // sha256Hex(sourceEntityId + kind + targetEntityId).slice(0,12)
  sourceEntityId: string; // FK -> SiteEntity.id (graph edge tail)
  targetEntityId: string; // FK -> SiteEntity.id (graph edge head)
  kind: RelationKind;
  label?: string; // human edge label override
  confidence: number; // 0..1
  sources: FactSourceRef[];
};

// "What the site IS" — one-screen executive summary, fully grounded.
export type SiteIdentity = {
  name: string;
  oneLiner: string; // <=140 chars, supported by sources
  category: string; // "decentralized storage", "design tool", "API gateway"
  audience: string[]; // ["developers", "enterprises"]
  primaryEntityId?: string; // FK -> the org/product entity that IS the site
  sources: FactSourceRef[];
};

export type ContextQuestionCategory =
  | "what_is_it"
  | "who_is_it_for"
  | "how_it_works"
  | "pricing"
  | "differentiators"
  | "integrations"
  | "getting_started"
  | "limitations"
  | "trust_security";

export type ContextQuestion = {
  id: string; // sha256Hex(question).slice(0,12) — stable across reruns
  question: string; // grounded, answerable from the crawled corpus only
  answer: string; // 1-3 sentences, source-backed (empty when unanswerable)
  category: ContextQuestionCategory;
  importance: number; // 0..1 — order for "understand this site fast"
  entityIds: string[]; // FK -> SiteEntity.id the Q/A touches (viz cross-link)
  sources: FactSourceRef[]; // REQUIRED non-empty unless unanswerable
  unanswerable?: boolean; // true => corpus lacks the answer; keep Q to surface coverage gaps
};

export type FactsProvider = "openai-compatible" | "workers-ai" | "heuristic";

export type SiteFacts = {
  schemaVersion: 2;
  generatedAt: string;
  target: string;
  identity: SiteIdentity;
  entities: SiteEntity[];
  claims: SiteClaim[];
  stats: SiteStat[];
  topics: SiteTopic[];
  relationships: SiteRelationship[]; // edges -> entities (viz: force graph)
  questions: ContextQuestion[]; // co-located so the viz has ONE artifact
  coverage: {
    pagesAnalyzed: number;
    chunksAnalyzed: number;
    entitiesWithSources: number; // == entities.length when fully grounded
    ungroundedDropped: number; // facts discarded for failing the quote-substring check
  };
  usedProvider: FactsProvider;
  confidence: number; // overall 0..1
};

// ----------------------------------------------------------------------------
// Stable id helpers — all sha256Hex(...).slice(0, 12) (reuse utils.sha256Hex).
// ----------------------------------------------------------------------------

export function entityId(type: EntityType, name: string): string {
  return sha256Hex(`${type}\n${normalizeName(name)}`).slice(0, 12);
}

export function claimId(text: string): string {
  return sha256Hex(normalizeText(text)).slice(0, 12);
}

export function statId(label: string, valueRaw: string): string {
  return sha256Hex(`${normalizeText(label)}\n${normalizeText(valueRaw)}`).slice(0, 12);
}

export function topicId(label: string): string {
  return sha256Hex(normalizeText(label).toLowerCase()).slice(0, 12);
}

export function relationshipId(sourceEntityId: string, kind: RelationKind, targetEntityId: string): string {
  return sha256Hex(`${sourceEntityId}${kind}${targetEntityId}`).slice(0, 12);
}

export function questionId(question: string): string {
  return sha256Hex(normalizeText(question)).slice(0, 12);
}

function normalizeName(name: string): string {
  return normalizeText(name).toLowerCase();
}

// ----------------------------------------------------------------------------
// Quote validation — the no-hallucination gate.
// ----------------------------------------------------------------------------

const MAX_QUOTE_CHARS = 240;

/**
 * A quote is GROUNDED iff its whitespace-normalized form is a real substring of
 * the whitespace-normalized chunk text (using the SAME normalizeText as the
 * chunker). Empty quotes and over-length quotes (>240 raw chars) are rejected.
 */
export function validateQuote(quote: string, chunkText: string): boolean {
  if (!quote || quote.length > MAX_QUOTE_CHARS) return false;
  const normalizedQuote = normalizeText(quote);
  if (!normalizedQuote) return false;
  return normalizeText(chunkText).includes(normalizedQuote);
}

/** Clamp + trim a quote to the <=240-char grounding budget. */
function clampQuote(quote: string): string {
  return quote.length > MAX_QUOTE_CHARS ? quote.slice(0, MAX_QUOTE_CHARS) : quote;
}

// ----------------------------------------------------------------------------
// buildSiteFacts() — map (LLM, optional) -> deterministic reduce -> validate.
// ----------------------------------------------------------------------------

export type FactsModelProvider = "openai-compatible" | "workers-ai";

/**
 * Pluggable single-shot JSON model call. The caller injects the concrete model
 * (core: OPENAI_API_KEY /chat/completions; worker: env.AI Workers-AI). It MUST
 * return a parsed JSON object or null on any failure — buildSiteFacts/
 * generateContextQuestions never throw because of a model error.
 */
export type FactsModel = {
  provider: FactsModelProvider;
  // Returns parsed JSON (object) for a system+user prompt, or null on failure.
  complete: (system: string, user: string) => Promise<Record<string, unknown> | null>;
};

export type BuildSiteFactsOptions = {
  model?: FactsModel; // omit -> heuristic path
  maxBatchChars?: number; // per-window context budget (default 12000)
  pagesAnalyzed?: number; // override (defaults to distinct routePaths in chunks)
};

type RawEntity = {
  name?: unknown;
  type?: unknown;
  aliases?: unknown;
  description?: unknown;
  url?: unknown;
  chunkIds?: unknown;
  quote?: unknown;
};

type RawClaim = {
  text?: unknown;
  kind?: unknown;
  subject?: unknown;
  sentiment?: unknown;
  confidence?: unknown;
  isMarketing?: unknown;
  chunkIds?: unknown;
  quote?: unknown;
};

type RawStat = {
  label?: unknown;
  valueRaw?: unknown;
  unit?: unknown;
  currency?: unknown;
  approximate?: unknown;
  subject?: unknown;
  chunkIds?: unknown;
  quote?: unknown;
};

type RawRelationship = {
  source?: unknown;
  target?: unknown;
  kind?: unknown;
  chunkIds?: unknown;
};

const ENTITY_TYPES: ReadonlySet<EntityType> = new Set<EntityType>([
  "organization",
  "product",
  "feature",
  "person",
  "technology",
  "integration",
  "platform",
  "pricing_plan",
  "use_case",
  "metric",
  "customer",
  "competitor",
  "location",
  "event",
  "concept",
  "other"
]);

const CLAIM_KINDS: ReadonlySet<ClaimKind> = new Set<ClaimKind>([
  "value_prop",
  "capability",
  "differentiator",
  "limitation",
  "guarantee",
  "positioning",
  "fact"
]);

const STAT_UNITS: ReadonlySet<StatUnit> = new Set<StatUnit>(["count", "percent", "currency", "time", "data_size", "ratio", "rate", "other"]);

const RELATION_KINDS: ReadonlySet<RelationKind> = new Set<RelationKind>([
  "offers",
  "part_of",
  "integrates_with",
  "competes_with",
  "built_with",
  "used_by",
  "priced_at",
  "depends_on",
  "alternative_to",
  "owned_by",
  "mentions"
]);

const MAP_SYSTEM_PROMPT = [
  "You extract grounded structured facts from website context chunks.",
  "Each chunk is given as `[chunkId] (routePath) text`.",
  "Return ONLY strict JSON: {\"entities\":[],\"claims\":[],\"stats\":[],\"relationships\":[]}.",
  "Every entity/claim/stat MUST include chunkIds (the [chunkId]s that support it) and a verbatim quote copied EXACTLY from one of those chunks (<=240 chars).",
  "Do NOT invent quotes — copy real substrings. entity.type is one of: " + [...ENTITY_TYPES].join(", ") + ".",
  "claim.kind is one of: " + [...CLAIM_KINDS].join(", ") + ". stat.unit is one of: " + [...STAT_UNITS].join(", ") + ".",
  "relationship has {source,target,kind} where source/target are entity names and kind is one of: " + [...RELATION_KINDS].join(", ") + "."
].join(" ");

/**
 * Build grounded, viz-ready SiteFacts from crawled pages + their chunks.
 *
 * PASS A (map, optional LLM): window chunks into ~12k-char batches, ask the
 * model for entities/claims/stats/relationships each citing the chunkId(s) that
 * support them. When no model is supplied, the heuristic path runs instead.
 *
 * REDUCE (deterministic, no LLM): dedupe entities by normalized name+type, sum
 * mentions, salience = mentions/maxMentions; cluster topics from headingPath;
 * infer relationships from co-occurrence + LLM FKs.
 *
 * VALIDATION (no-hallucination gate): every source quote is checked as a real
 * substring of its cited chunk; failing facts are dropped + counted.
 */
export async function buildSiteFacts(target: string, pages: PageArtifact[], chunks: ContextChunk[], opts: BuildSiteFactsOptions = {}): Promise<SiteFacts> {
  const chunkById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const pagesAnalyzed = opts.pagesAnalyzed ?? (new Set(chunks.map((chunk) => chunk.routePath)).size || pages.length);
  const dropped = { count: 0 };

  let raw: { entities: RawEntity[]; claims: RawClaim[]; stats: RawStat[]; relationships: RawRelationship[] } | null = null;
  if (opts.model && chunks.length) {
    raw = await runMapPass(chunks, opts.model, opts.maxBatchChars ?? 12000).catch(() => null);
  }

  let entities: SiteEntity[] = [];
  let claims: SiteClaim[] = [];
  let stats: SiteStat[] = [];
  let llmRelationships: SiteRelationship[] = [];
  let usedProvider: FactsProvider = "heuristic";

  // The model "wins" only if its grounded output is non-empty; an empty/failed
  // map pass degrades to the deterministic heuristic so a run is never barren.
  let usedModel = false;
  if (raw) {
    const reduced = reduceEntities(raw.entities, chunkById, dropped);
    const llmClaims = reduceClaims(raw.claims, chunkById, reduced.idByName, dropped);
    const llmStats = reduceStats(raw.stats, chunkById, reduced.idByName, dropped);
    if (reduced.entities.length || llmClaims.length || llmStats.length) {
      entities = reduced.entities;
      claims = llmClaims;
      stats = llmStats;
      llmRelationships = relationshipsFromRaw(raw.relationships, reduced.idByName, chunkById);
      usedProvider = opts.model!.provider;
      usedModel = true;
    }
  }
  if (!usedModel) {
    const heuristic = heuristicFacts(pages, chunks, chunkById, dropped);
    entities = heuristic.entities;
    claims = heuristic.claims;
    stats = heuristic.stats;
    usedProvider = "heuristic";
  }

  const idSet = new Set(entities.map((entity) => entity.id));
  // Drop FKs that point at entities we dropped during validation.
  for (const claim of claims) if (claim.subjectEntityId && !idSet.has(claim.subjectEntityId)) claim.subjectEntityId = undefined;
  for (const stat of stats) if (stat.subjectEntityId && !idSet.has(stat.subjectEntityId)) stat.subjectEntityId = undefined;

  const topics = buildTopics(chunks, entities, chunkById);
  const relationships = mergeRelationships(llmRelationships, inferCoOccurrenceRelationships(entities, chunks), idSet);
  const identity = buildIdentity(target, pages, entities, chunks);

  const confidence = computeConfidence(entities, claims, stats, dropped.count, usedProvider);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    target,
    identity,
    entities,
    claims,
    stats,
    topics,
    relationships,
    questions: [],
    coverage: {
      pagesAnalyzed,
      chunksAnalyzed: chunks.length,
      entitiesWithSources: entities.filter((entity) => entity.sources.length > 0).length,
      ungroundedDropped: dropped.count
    },
    usedProvider,
    confidence
  };
}

// ----------------------------------------------------------------------------
// PASS A — windowed map step over chunks.
// ----------------------------------------------------------------------------

async function runMapPass(
  chunks: ContextChunk[],
  model: FactsModel,
  maxBatchChars: number
): Promise<{ entities: RawEntity[]; claims: RawClaim[]; stats: RawStat[]; relationships: RawRelationship[] }> {
  const batches = windowChunks(chunks, maxBatchChars);
  const entities: RawEntity[] = [];
  const claims: RawClaim[] = [];
  const stats: RawStat[] = [];
  const relationships: RawRelationship[] = [];
  for (const batch of batches) {
    const user = batch.map((chunk) => `[${chunk.chunkId}] (${chunk.routePath}) ${chunk.text}`).join("\n\n");
    const json = await model.complete(MAP_SYSTEM_PROMPT, user).catch(() => null);
    if (!json) continue;
    if (Array.isArray(json.entities)) entities.push(...(json.entities as RawEntity[]));
    if (Array.isArray(json.claims)) claims.push(...(json.claims as RawClaim[]));
    if (Array.isArray(json.stats)) stats.push(...(json.stats as RawStat[]));
    if (Array.isArray(json.relationships)) relationships.push(...(json.relationships as RawRelationship[]));
  }
  return { entities, claims, stats, relationships };
}

function windowChunks(chunks: ContextChunk[], maxBatchChars: number): ContextChunk[][] {
  const batches: ContextChunk[][] = [];
  let current: ContextChunk[] = [];
  let size = 0;
  for (const chunk of chunks) {
    const cost = chunk.text.length + chunk.chunkId.length + (chunk.routePath?.length ?? 0) + 8;
    if (size + cost > maxBatchChars && current.length) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(chunk);
    size += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}

// ----------------------------------------------------------------------------
// REDUCE — dedupe + validate.
// ----------------------------------------------------------------------------

function reduceEntities(
  rawEntities: RawEntity[],
  chunkById: Map<string, ContextChunk>,
  dropped: { count: number }
): { entities: SiteEntity[]; idByName: Map<string, string> } {
  const byId = new Map<string, SiteEntity>();
  const mentionChunks = new Map<string, Set<string>>();
  const idByName = new Map<string, string>();

  for (const raw of rawEntities) {
    const name = asString(raw.name);
    if (!name) continue;
    const type = asEntityType(raw.type);
    const sources = collectSources(raw.chunkIds, raw.quote, chunkById, dropped);
    if (!sources.length) continue; // ungrounded -> dropped + counted
    const id = entityId(type, name);
    const aliases = asStringArray(raw.aliases);
    const description = asString(raw.description);
    const url = asString(raw.url);

    let entity = byId.get(id);
    if (!entity) {
      entity = { id, name, type, aliases: [], salience: 0, mentions: 0, sources: [] };
      byId.set(id, entity);
      mentionChunks.set(id, new Set());
    }
    if (description && !entity.description) entity.description = description;
    if (url && !entity.url) entity.url = url;
    for (const alias of aliases) if (alias && !entity.aliases.includes(alias)) entity.aliases.push(alias);
    appendSources(entity.sources, sources);
    const set = mentionChunks.get(id)!;
    for (const source of sources) if (source.chunkId) set.add(source.chunkId);
    idByName.set(normalizeName(name), id);
    for (const alias of aliases) idByName.set(normalizeName(alias), id);
  }

  const entities = [...byId.values()];
  for (const entity of entities) entity.mentions = Math.max(1, mentionChunks.get(entity.id)?.size ?? 0);
  const maxMentions = Math.max(1, ...entities.map((entity) => entity.mentions));
  for (const entity of entities) entity.salience = round2(entity.mentions / maxMentions);
  entities.sort((a, b) => b.salience - a.salience || a.name.localeCompare(b.name));
  return { entities, idByName };
}

function reduceClaims(rawClaims: RawClaim[], chunkById: Map<string, ContextChunk>, idByName: Map<string, string>, dropped: { count: number }): SiteClaim[] {
  const byId = new Map<string, SiteClaim>();
  for (const raw of rawClaims) {
    const text = asString(raw.text);
    if (!text) continue;
    const sources = collectSources(raw.chunkIds, raw.quote, chunkById, dropped);
    if (!sources.length) continue;
    const id = claimId(text);
    const existing = byId.get(id);
    if (existing) {
      appendSources(existing.sources, sources);
      continue;
    }
    byId.set(id, {
      id,
      text: normalizeText(text),
      kind: asClaimKind(raw.kind),
      subjectEntityId: idByName.get(normalizeName(asString(raw.subject) ?? "")),
      sentiment: asSentiment(raw.sentiment),
      confidence: asConfidence(raw.confidence, 0.6),
      isMarketing: asBoolean(raw.isMarketing) || looksMarketing(text),
      sources
    });
  }
  return [...byId.values()];
}

function reduceStats(rawStats: RawStat[], chunkById: Map<string, ContextChunk>, idByName: Map<string, string>, dropped: { count: number }): SiteStat[] {
  const byId = new Map<string, SiteStat>();
  for (const raw of rawStats) {
    const label = asString(raw.label);
    const valueRaw = asString(raw.valueRaw);
    if (!label || !valueRaw) continue;
    const sources = collectSources(raw.chunkIds, raw.quote, chunkById, dropped);
    if (!sources.length) continue;
    const id = statId(label, valueRaw);
    const existing = byId.get(id);
    if (existing) {
      appendSources(existing.sources, sources);
      continue;
    }
    const parsed = parseStatValue(valueRaw);
    byId.set(id, {
      id,
      label: normalizeText(label),
      valueRaw,
      valueNumber: parsed.valueNumber,
      unit: asStatUnit(raw.unit) ?? parsed.unit,
      currency: asString(raw.currency) ?? parsed.currency,
      approximate: asBoolean(raw.approximate) || parsed.approximate,
      subjectEntityId: idByName.get(normalizeName(asString(raw.subject) ?? "")),
      sources
    });
  }
  return [...byId.values()];
}

function collectSources(rawChunkIds: unknown, rawQuote: unknown, chunkById: Map<string, ContextChunk>, dropped: { count: number }): FactSourceRef[] {
  const chunkIds = asStringArray(rawChunkIds);
  const quote = asString(rawQuote);
  if (!quote) {
    if (chunkIds.length) dropped.count++;
    return [];
  }
  const sources: FactSourceRef[] = [];
  let grounded = false;
  for (const chunkId of chunkIds) {
    const chunk = chunkById.get(chunkId);
    if (!chunk) continue;
    if (validateQuote(quote, chunk.text)) {
      grounded = true;
      sources.push(sourceFromChunk(chunk, clampQuote(quote)));
      break; // one grounded source is enough to keep the fact
    }
  }
  if (!grounded) {
    dropped.count++;
    return [];
  }
  return sources;
}

function sourceFromChunk(chunk: ContextChunk, quote: string): FactSourceRef {
  return { chunkId: chunk.chunkId, routePath: chunk.routePath, url: chunk.url, quote };
}

function appendSources(target: FactSourceRef[], extra: FactSourceRef[]): void {
  for (const source of extra) {
    if (!target.some((existing) => existing.chunkId === source.chunkId && existing.quote === source.quote)) target.push(source);
  }
}

// ----------------------------------------------------------------------------
// Topics — deterministic clustering from chunk headingPath (no LLM).
// ----------------------------------------------------------------------------

function buildTopics(chunks: ContextChunk[], entities: SiteEntity[], chunkById: Map<string, ContextChunk>): SiteTopic[] {
  if (!chunks.length) return [];
  const groups = new Map<string, { label: string; chunkIds: string[]; routePaths: Set<string>; keywords: Map<string, number> }>();
  for (const chunk of chunks) {
    const label = (chunk.headingPath[0] ?? chunk.heading ?? routeLabel(chunk.routePath)).trim() || routeLabel(chunk.routePath);
    const key = label.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { label, chunkIds: [], routePaths: new Set(), keywords: new Map() };
      groups.set(key, group);
    }
    group.chunkIds.push(chunk.chunkId);
    group.routePaths.add(chunk.routePath);
    for (const word of keywordsFrom(`${label} ${chunk.headingPath.join(" ")}`)) group.keywords.set(word, (group.keywords.get(word) ?? 0) + 1);
  }
  const total = chunks.length;
  const entityChunkIds = new Map<string, Set<string>>();
  for (const entity of entities) entityChunkIds.set(entity.id, new Set(entity.sources.map((source) => source.chunkId).filter(Boolean) as string[]));

  const topics: SiteTopic[] = [];
  for (const group of groups.values()) {
    const chunkIdSet = new Set(group.chunkIds);
    const entityIds = entities.filter((entity) => [...(entityChunkIds.get(entity.id) ?? [])].some((id) => chunkIdSet.has(id))).map((entity) => entity.id);
    topics.push({
      id: topicId(group.label),
      label: group.label,
      weight: round2(group.chunkIds.length / total),
      keywords: [...group.keywords.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([word]) => word),
      routePaths: [...group.routePaths].sort(),
      entityIds
    });
  }
  void chunkById;
  return topics.sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label)).slice(0, 24);
}

// ----------------------------------------------------------------------------
// Relationships.
// ----------------------------------------------------------------------------

function relationshipsFromRaw(rawRelationships: RawRelationship[], idByName: Map<string, string>, chunkById: Map<string, ContextChunk>): SiteRelationship[] {
  const out: SiteRelationship[] = [];
  const seen = new Set<string>();
  for (const raw of rawRelationships) {
    const sourceId = idByName.get(normalizeName(asString(raw.source) ?? ""));
    const targetId = idByName.get(normalizeName(asString(raw.target) ?? ""));
    if (!sourceId || !targetId || sourceId === targetId) continue;
    const kind = asRelationKind(raw.kind);
    const id = relationshipId(sourceId, kind, targetId);
    if (seen.has(id)) continue;
    seen.add(id);
    const sources: FactSourceRef[] = [];
    for (const chunkId of asStringArray(raw.chunkIds)) {
      const chunk = chunkById.get(chunkId);
      if (chunk) sources.push(sourceFromChunk(chunk, clampQuote(firstReadableSentence(chunk.text) ?? normalizeText(chunk.text).slice(0, MAX_QUOTE_CHARS))));
    }
    out.push({ id, sourceEntityId: sourceId, targetEntityId: targetId, kind, confidence: 0.55, sources });
  }
  return out;
}

/**
 * Co-occurrence relationships are noisy, so we require an entity pair to appear
 * together in >=2 chunks before emitting a low-confidence "mentions" edge.
 */
function inferCoOccurrenceRelationships(entities: SiteEntity[], chunks: ContextChunk[]): SiteRelationship[] {
  if (entities.length < 2) return [];
  const chunkEntityIds = new Map<string, Set<string>>();
  for (const entity of entities) {
    for (const source of entity.sources) {
      if (!source.chunkId) continue;
      let set = chunkEntityIds.get(source.chunkId);
      if (!set) {
        set = new Set();
        chunkEntityIds.set(source.chunkId, set);
      }
      set.add(entity.id);
    }
  }
  const pairCounts = new Map<string, { a: string; b: string; count: number }>();
  for (const set of chunkEntityIds.values()) {
    const ids = [...set].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        const key = `${a}|${b}`;
        const entry = pairCounts.get(key);
        if (entry) entry.count++;
        else pairCounts.set(key, { a, b, count: 1 });
      }
    }
  }
  void chunks;
  const out: SiteRelationship[] = [];
  for (const { a, b, count } of pairCounts.values()) {
    if (count < 2) continue;
    out.push({ id: relationshipId(a, "mentions", b), sourceEntityId: a, targetEntityId: b, kind: "mentions", confidence: round2(Math.min(0.5, 0.2 + count * 0.05)), sources: [] });
  }
  return out;
}

function mergeRelationships(llm: SiteRelationship[], cooccurrence: SiteRelationship[], idSet: Set<string>): SiteRelationship[] {
  const byId = new Map<string, SiteRelationship>();
  for (const rel of [...llm, ...cooccurrence]) {
    if (!idSet.has(rel.sourceEntityId) || !idSet.has(rel.targetEntityId)) continue;
    if (!byId.has(rel.id)) byId.set(rel.id, rel);
  }
  return [...byId.values()].sort((a, b) => b.confidence - a.confidence).slice(0, 200);
}

// ----------------------------------------------------------------------------
// Identity.
// ----------------------------------------------------------------------------

function buildIdentity(target: string, pages: PageArtifact[], entities: SiteEntity[], chunks: ContextChunk[]): SiteIdentity {
  const home = pickHomePage(pages);
  const homeChunks = chunks.filter((chunk) => chunk.routePath === (home?.routePath ?? "/"));
  const corpus = (homeChunks.length ? homeChunks : chunks.slice(0, 8)).map((chunk) => chunk.text).join("\n\n");
  const oneLinerSentence = firstReadableSentence(corpus) ?? firstReadableSentence(chunks.map((chunk) => chunk.text).join("\n\n")) ?? "";
  const primary = entities.find((entity) => entity.type === "organization") ?? entities.find((entity) => entity.type === "product") ?? entities[0];
  const name = primary?.name ?? siteNameFromTarget(target);
  const sources: FactSourceRef[] = [];
  const oneLinerChunk = (homeChunks.length ? homeChunks : chunks).find((chunk) => oneLinerSentence && normalizeText(chunk.text).includes(normalizeText(oneLinerSentence)));
  if (oneLinerChunk && oneLinerSentence) sources.push(sourceFromChunk(oneLinerChunk, clampQuote(oneLinerSentence)));
  return {
    name,
    oneLiner: oneLinerSentence.slice(0, 140),
    category: inferCategory(corpus, entities),
    audience: inferAudience(corpus),
    primaryEntityId: primary?.id,
    sources
  };
}

function inferCategory(corpus: string, entities: SiteEntity[]): string {
  const lower = corpus.toLowerCase();
  const candidates: Array<[RegExp, string]> = [
    [/decentrali[sz]ed storage|blob storage/, "decentralized storage"],
    [/design (?:tool|system)/, "design tool"],
    [/api (?:gateway|platform)/, "API platform"],
    [/payment|checkout|billing/, "payments"],
    [/analytics|dashboard|metrics platform/, "analytics platform"],
    [/database|data (?:warehouse|platform)/, "data platform"],
    [/developer (?:platform|tools?)|sdk/, "developer platform"],
    [/e-?commerce|online store/, "e-commerce"]
  ];
  for (const [pattern, label] of candidates) if (pattern.test(lower)) return label;
  const productType = entities.find((entity) => entity.type === "product" || entity.type === "platform");
  return productType ? "product" : "website";
}

function inferAudience(corpus: string): string[] {
  const lower = corpus.toLowerCase();
  const audience: string[] = [];
  const map: Array<[RegExp, string]> = [
    [/\bdevelopers?\b|\bsdk\b|\bapi\b/, "developers"],
    [/\benterprises?\b|\bbusinesses?\b/, "enterprises"],
    [/\bstartups?\b/, "startups"],
    [/\bdesigners?\b/, "designers"],
    [/\bmarketers?\b/, "marketers"],
    [/\bteams?\b/, "teams"]
  ];
  for (const [pattern, label] of map) if (pattern.test(lower)) audience.push(label);
  return [...new Set(audience)].slice(0, 4);
}

// ----------------------------------------------------------------------------
// HEURISTIC fallback (no model).
// ----------------------------------------------------------------------------

const STAT_REGEX = /(\d[\d,.]*\s*%|\$\s?\d[\d,.]*(?:\/\w+)?|\d[\d,.]*\+|\d+(?:,\d{3})+)/g;

function heuristicFacts(
  pages: PageArtifact[],
  chunks: ContextChunk[],
  chunkById: Map<string, ContextChunk>,
  dropped: { count: number }
): { entities: SiteEntity[]; claims: SiteClaim[]; stats: SiteStat[] } {
  const brandName = siteNameFromPages(pages);
  const entityFreq = new Map<string, { name: string; chunkIds: Set<string> }>();

  // Brand entity seeded from the home page / target.
  if (brandName) {
    const homeChunk = chunks.find((chunk) => chunk.routePath === "/" || chunk.routePath === "/index.html") ?? chunks[0];
    if (homeChunk) {
      const key = normalizeName(brandName);
      entityFreq.set(key, { name: brandName, chunkIds: new Set([homeChunk.chunkId]) });
    }
  }

  // Capitalized proper-noun frequency.
  for (const chunk of chunks) {
    for (const match of chunk.text.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+)?)\b/g)) {
      const candidate = match[1]!.trim();
      if (candidate.length < 3 || STOPWORD_CAPS.has(candidate.toLowerCase())) continue;
      const key = normalizeName(candidate);
      let entry = entityFreq.get(key);
      if (!entry) {
        entry = { name: candidate, chunkIds: new Set() };
        entityFreq.set(key, entry);
      }
      entry.chunkIds.add(chunk.chunkId);
    }
  }

  const ranked = [...entityFreq.values()].sort((a, b) => b.chunkIds.size - a.chunkIds.size).slice(0, 24);
  const maxMentions = Math.max(1, ...ranked.map((entry) => entry.chunkIds.size));
  const entities: SiteEntity[] = [];
  for (const entry of ranked) {
    const type: EntityType = brandName && normalizeName(entry.name) === normalizeName(brandName) ? "organization" : "concept";
    const sources: FactSourceRef[] = [];
    for (const chunkId of entry.chunkIds) {
      const chunk = chunkById.get(chunkId);
      if (!chunk) continue;
      const quote = quoteContaining(chunk.text, entry.name) ?? firstReadableSentence(chunk.text);
      if (quote && validateQuote(quote, chunk.text)) {
        sources.push(sourceFromChunk(chunk, clampQuote(quote)));
        break;
      }
    }
    if (!sources.length) continue;
    entities.push({
      id: entityId(type, entry.name),
      name: entry.name,
      type,
      aliases: [],
      salience: round2(entry.chunkIds.size / maxMentions),
      mentions: entry.chunkIds.size,
      sources
    });
  }

  // Stats via regex over chunk text.
  const statById = new Map<string, SiteStat>();
  for (const chunk of chunks) {
    for (const match of chunk.text.matchAll(STAT_REGEX)) {
      const valueRaw = match[0]!.trim();
      const quote = quoteContaining(chunk.text, valueRaw) ?? valueRaw;
      if (!validateQuote(quote, chunk.text)) {
        continue;
      }
      const label = statLabelFrom(quote, valueRaw);
      const id = statId(label, valueRaw);
      if (statById.has(id)) continue;
      const parsed = parseStatValue(valueRaw);
      statById.set(id, {
        id,
        label,
        valueRaw,
        valueNumber: parsed.valueNumber,
        unit: parsed.unit,
        currency: parsed.currency,
        approximate: parsed.approximate,
        sources: [sourceFromChunk(chunk, clampQuote(quote))]
      });
      if (statById.size >= 24) break;
    }
    if (statById.size >= 24) break;
  }

  // Claims = the most readable home/top sentences.
  const claims: SiteClaim[] = [];
  const claimSeen = new Set<string>();
  const home = pickHomePage(pages);
  const homeChunks = chunks.filter((chunk) => chunk.routePath === (home?.routePath ?? "/"));
  for (const chunk of homeChunks.length ? homeChunks : chunks.slice(0, 6)) {
    for (const sentence of rankedContextSentences(chunk.text, []).slice(0, 3)) {
      if (!validateQuote(sentence, chunk.text)) continue;
      const id = claimId(sentence);
      if (claimSeen.has(id)) continue;
      claimSeen.add(id);
      claims.push({
        id,
        text: normalizeText(sentence),
        kind: looksMarketing(sentence) ? "value_prop" : "fact",
        sentiment: "neutral",
        confidence: 0.4,
        isMarketing: looksMarketing(sentence),
        sources: [sourceFromChunk(chunk, clampQuote(sentence))]
      });
      if (claims.length >= 12) break;
    }
    if (claims.length >= 12) break;
  }

  void dropped;
  return { entities, claims, stats: [...statById.values()] };
}

function quoteContaining(text: string, needle: string): string | undefined {
  const normalized = normalizeText(text);
  const idx = normalized.indexOf(normalizeText(needle));
  if (idx < 0) return undefined;
  const start = Math.max(0, idx - 60);
  const slice = normalized.slice(start, Math.min(normalized.length, idx + needle.length + 120));
  return slice.length > MAX_QUOTE_CHARS ? slice.slice(0, MAX_QUOTE_CHARS) : slice;
}

function statLabelFrom(quote: string, valueRaw: string): string {
  const words = normalizeText(quote.replace(valueRaw, " ")).split(" ").filter((word) => /[a-z]/i.test(word) && word.length > 2);
  const label = words.slice(0, 4).join(" ").trim();
  return label || "metric";
}

// ----------------------------------------------------------------------------
// generateContextQuestions() — one LLM call seeded with validated facts,
// plus a 5-canonical-question heuristic fallback.
// ----------------------------------------------------------------------------

export type GenerateQuestionsOptions = {
  model?: FactsModel;
  maxContextChars?: number; // default 24000
  contextChunkLimit?: number; // chunks to include (default 60)
};

const QUESTION_SYSTEM_PROMPT = [
  "You generate the most useful onboarding questions about a website, answerable ONLY from the provided context.",
  "Return ONLY strict JSON: {\"questions\":[{\"question\":\"\",\"answer\":\"\",\"category\":\"\",\"importance\":0.9,\"sourceChunkIds\":[],\"unanswerable\":false}]}.",
  "Categories: what_is_it, who_is_it_for, how_it_works, pricing, differentiators, integrations, getting_started, limitations, trust_security.",
  "Emit 8-14 questions ordered by importance (1 = most essential). Every answerable question's answer MUST cite >=1 sourceChunkId from the context.",
  "If an important question is NOT answerable from the context, include it with unanswerable:true and an empty answer to surface the coverage gap.",
  "Do NOT use outside knowledge. Quote/paraphrase only what the context supports."
].join(" ");

const CANONICAL_QUESTIONS: Array<{ question: string; category: ContextQuestionCategory; keywords: string[]; importance: number }> = [
  { question: "What is this site?", category: "what_is_it", keywords: ["is", "platform", "product", "provides", "offers"], importance: 1 },
  { question: "Who is it for?", category: "who_is_it_for", keywords: ["developers", "teams", "businesses", "users", "customers"], importance: 0.9 },
  { question: "How does it work?", category: "how_it_works", keywords: ["how", "works", "steps", "process", "using"], importance: 0.8 },
  { question: "How much does it cost?", category: "pricing", keywords: ["price", "pricing", "cost", "free", "plan"], importance: 0.7 },
  { question: "How do I get started?", category: "getting_started", keywords: ["start", "sign up", "install", "begin", "create"], importance: 0.6 }
];

/**
 * Generate grounded context questions. ONE LLM call seeded with validated facts
 * + chunk context; questions without grounded sources are dropped (unless
 * explicitly unanswerable). Falls back to 5 canonical questions answered via
 * rankedContextSentences when no model is available.
 */
export async function generateContextQuestions(
  target: string,
  chunks: ContextChunk[],
  facts: SiteFacts,
  opts: GenerateQuestionsOptions = {}
): Promise<ContextQuestion[]> {
  void target;
  const chunkById = new Map(chunks.map((chunk) => [chunk.chunkId, chunk]));
  const entityIdByName = new Map<string, string>();
  for (const entity of facts.entities) {
    entityIdByName.set(normalizeName(entity.name), entity.id);
    for (const alias of entity.aliases) entityIdByName.set(normalizeName(alias), entity.id);
  }

  if (opts.model && chunks.length) {
    try {
      const questions = await runQuestionPass(chunks, facts, opts, chunkById, entityIdByName);
      if (questions.length) return questions;
    } catch {
      // fall through to heuristic
    }
  }
  return heuristicQuestions(chunks, facts, chunkById, entityIdByName);
}

async function runQuestionPass(
  chunks: ContextChunk[],
  facts: SiteFacts,
  opts: GenerateQuestionsOptions,
  chunkById: Map<string, ContextChunk>,
  entityIdByName: Map<string, string>
): Promise<ContextQuestion[]> {
  const contextChunkLimit = opts.contextChunkLimit ?? 60;
  const payload = JSON.stringify({
    identity: facts.identity,
    entities: facts.entities.slice(0, 40).map((entity) => ({ id: entity.id, name: entity.name, type: entity.type, salience: entity.salience })),
    claims: facts.claims.slice(0, 40).map((claim) => ({ text: claim.text, kind: claim.kind })),
    stats: facts.stats.slice(0, 40).map((stat) => ({ label: stat.label, valueRaw: stat.valueRaw })),
    context: chunks.slice(0, contextChunkLimit).map((chunk) => `[${chunk.chunkId}] (${chunk.routePath}) ${chunk.text.slice(0, 1500)}`)
  }).slice(0, opts.maxContextChars ?? 24000);

  const json = await opts.model!.complete(QUESTION_SYSTEM_PROMPT, payload);
  if (!json || !Array.isArray(json.questions)) return [];
  return postProcessQuestions(json.questions as Array<Record<string, unknown>>, chunkById, entityIdByName);
}

function postProcessQuestions(rawQuestions: Array<Record<string, unknown>>, chunkById: Map<string, ContextChunk>, entityIdByName: Map<string, string>): ContextQuestion[] {
  const byId = new Map<string, ContextQuestion>();
  for (const raw of rawQuestions) {
    const question = asString(raw.question);
    if (!question) continue;
    const unanswerable = asBoolean(raw.unanswerable);
    const sources: FactSourceRef[] = [];
    for (const chunkId of asStringArray(raw.sourceChunkIds)) {
      const chunk = chunkById.get(chunkId);
      if (!chunk) continue;
      const quote = firstReadableSentence(chunk.text) ?? normalizeText(chunk.text).slice(0, MAX_QUOTE_CHARS);
      if (quote && validateQuote(quote, chunk.text)) sources.push(sourceFromChunk(chunk, clampQuote(quote)));
    }
    // Drop answerable questions with no grounded source.
    if (!unanswerable && !sources.length) continue;
    const id = questionId(question);
    if (byId.has(id)) continue;
    const answer = unanswerable ? "" : asString(raw.answer) ?? "";
    byId.set(id, {
      id,
      question: normalizeText(question),
      answer: normalizeText(answer),
      category: asQuestionCategory(raw.category),
      importance: asConfidence(raw.importance, 0.5),
      entityIds: entityIdsForText(`${question} ${answer}`, entityIdByName),
      sources,
      ...(unanswerable ? { unanswerable: true } : {})
    });
  }
  return [...byId.values()].sort((a, b) => b.importance - a.importance);
}

function heuristicQuestions(chunks: ContextChunk[], facts: SiteFacts, chunkById: Map<string, ContextChunk>, entityIdByName: Map<string, string>): ContextQuestion[] {
  const corpus = chunks.map((chunk) => `[${chunk.chunkId}] ${chunk.text}`).join("\n\n");
  const plainCorpus = chunks.map((chunk) => chunk.text).join("\n\n");
  const out: ContextQuestion[] = [];
  for (const canonical of CANONICAL_QUESTIONS) {
    const sentences = rankedContextSentences(plainCorpus, canonical.keywords);
    let answer = "";
    const sources: FactSourceRef[] = [];
    for (const sentence of sentences) {
      const chunk = chunks.find((candidate) => validateQuote(sentence, candidate.text));
      if (!chunk) continue;
      answer = answer ? `${answer} ${sentence}` : sentence;
      sources.push(sourceFromChunk(chunk, clampQuote(sentence)));
      if (sources.length >= 2) break;
    }
    const unanswerable = sources.length === 0;
    out.push({
      id: questionId(canonical.question),
      question: canonical.question,
      answer: normalizeText(answer).slice(0, 480),
      category: canonical.category,
      importance: canonical.importance,
      entityIds: entityIdsForText(`${canonical.question} ${answer}`, entityIdByName),
      sources,
      ...(unanswerable ? { unanswerable: true } : {})
    });
  }
  void corpus;
  void chunkById;
  void facts;
  return out;
}

function entityIdsForText(text: string, entityIdByName: Map<string, string>): string[] {
  const lower = ` ${normalizeText(text).toLowerCase()} `;
  const ids = new Set<string>();
  for (const [name, id] of entityIdByName) {
    if (name.length < 3) continue;
    if (lower.includes(` ${name} `) || lower.includes(`${name} `) || lower.includes(` ${name}`)) ids.add(id);
  }
  return [...ids].slice(0, 8);
}

// ----------------------------------------------------------------------------
// Coercion + parsing helpers.
// ----------------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function asStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function asBoolean(value: unknown): boolean {
  return value === true || value === "true";
}

function asConfidence(value: unknown, fallback: number): number {
  const num = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(num)) return fallback;
  return clamp01(num > 1 ? num / 100 : num);
}

function asEntityType(value: unknown): EntityType {
  const str = asString(value);
  return str && ENTITY_TYPES.has(str as EntityType) ? (str as EntityType) : "concept";
}

function asClaimKind(value: unknown): ClaimKind {
  const str = asString(value);
  return str && CLAIM_KINDS.has(str as ClaimKind) ? (str as ClaimKind) : "fact";
}

function asStatUnit(value: unknown): StatUnit | undefined {
  const str = asString(value);
  return str && STAT_UNITS.has(str as StatUnit) ? (str as StatUnit) : undefined;
}

function asRelationKind(value: unknown): RelationKind {
  const str = asString(value);
  return str && RELATION_KINDS.has(str as RelationKind) ? (str as RelationKind) : "mentions";
}

function asSentiment(value: unknown): Sentiment {
  const str = asString(value);
  return str === "positive" || str === "negative" ? str : "neutral";
}

function asQuestionCategory(value: unknown): ContextQuestionCategory {
  const valid: ReadonlySet<string> = new Set([
    "what_is_it",
    "who_is_it_for",
    "how_it_works",
    "pricing",
    "differentiators",
    "integrations",
    "getting_started",
    "limitations",
    "trust_security"
  ]);
  const str = asString(value);
  return str && valid.has(str) ? (str as ContextQuestionCategory) : "what_is_it";
}

function parseStatValue(valueRaw: string): { valueNumber?: number; unit: StatUnit; currency?: string; approximate: boolean } {
  const approximate = /[+~]|over|about|up to|\bplus\b/i.test(valueRaw);
  const numericMatch = valueRaw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  const valueNumber = numericMatch ? Number(numericMatch[0]) : undefined;
  if (/%/.test(valueRaw)) return { valueNumber, unit: "percent", approximate };
  if (/\$|usd|eur|gbp|€|£/i.test(valueRaw)) {
    const currency = /€/.test(valueRaw) ? "EUR" : /£/.test(valueRaw) ? "GBP" : "USD";
    return { valueNumber, unit: "currency", currency, approximate };
  }
  if (/\b(ms|sec|seconds?|min|minutes?|hours?|days?)\b/i.test(valueRaw)) return { valueNumber, unit: "time", approximate };
  if (/\b([kmgt]b|bytes?)\b/i.test(valueRaw)) return { valueNumber, unit: "data_size", approximate };
  if (/\//.test(valueRaw)) return { valueNumber, unit: "rate", approximate };
  if (valueNumber !== undefined) return { valueNumber, unit: "count", approximate };
  return { unit: "other", approximate };
}

const MARKETING_REGEX = /\b(best|#1|number one|leading|world['’]?s|fastest|easiest|most|ultimate|revolutionary|game[- ]chang|unmatched|seamless|effortless|powerful|trusted by)\b/i;

function looksMarketing(text: string): boolean {
  return MARKETING_REGEX.test(text);
}

const STOPWORD_CAPS = new Set([
  "the",
  "this",
  "that",
  "these",
  "those",
  "and",
  "for",
  "with",
  "from",
  "your",
  "you",
  "our",
  "we",
  "all",
  "get",
  "how",
  "what",
  "why",
  "when",
  "learn",
  "more",
  "home",
  "about",
  "contact",
  "page",
  "menu",
  "next",
  "previous",
  "read",
  "see",
  "view",
  "click"
]);

function keywordsFrom(text: string): string[] {
  return [
    ...new Set(
      normalizeText(text)
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length >= 4 && !STOPWORD_CAPS.has(word))
    )
  ];
}

function routeLabel(routePath: string): string {
  const segment = routePath.split("/").filter(Boolean).pop() ?? "Home";
  return segment.replace(/[-_]+/g, " ").replace(/\.\w+$/, "").replace(/\b\w/g, (char) => char.toUpperCase()) || "Home";
}

function pickHomePage(pages: PageArtifact[]): PageArtifact | undefined {
  return pages.find((page) => page.routePath === "/" || page.routePath === "/index.html") ?? pages[0];
}

function siteNameFromPages(pages: PageArtifact[]): string | undefined {
  const home = pickHomePage(pages);
  const title = home?.title ?? home?.metadata?.title;
  if (!title) return undefined;
  const parts = title.split(/\s+(?:\||·|-|—)\s+/g).map((part) => part.trim()).filter(Boolean);
  const name = (parts.length > 1 ? parts[parts.length - 1]! : title).trim();
  return name || undefined;
}

function siteNameFromTarget(target: string): string {
  try {
    return new URL(target).hostname.replace(/^www\./, "");
  } catch {
    return target;
  }
}

function computeConfidence(entities: SiteEntity[], claims: SiteClaim[], stats: SiteStat[], dropped: number, provider: FactsProvider): number {
  const grounded = entities.length + claims.length + stats.length;
  if (!grounded) return 0;
  const groundedRatio = grounded / (grounded + dropped);
  const base = provider === "heuristic" ? 0.45 : 0.8;
  return round2(clamp01(base * groundedRatio));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
