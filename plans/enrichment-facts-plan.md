# Extraction Enrichment — implementation spec (facts + auto context-questions + crawl tuning)

## Summary
Add a grounded, viz-ready FACTS layer on top of the existing markdown/chunks pipeline plus AUTO-GENERATED CONTEXT QUESTIONS, and tune the crawl to gather more high-signal pages. The work splits into three independent tracks that share one new artifact (context/facts.json):

(1) SCHEMA — a new packages/core/src/facts.ts defining SiteFacts (identity, entities, claims, stats, topics, relationships, questions, coverage) where every fact-bearing node carries sources[] (chunkId/routePath/url + a verbatim <=240char quote). All nodes are flat typed arrays with stable string ids and FK ids, and relationships are an explicit edge array, so the later force-graph/treemap viz maps straight onto nodes[]/links[]. Re-exported from types.ts and added to WalrusPackageManifest.facts and the frontend ArtifactManifest.

(2) PIPELINE — two grounded passes that REUSE the existing LLM-call patterns and helper functions already in the repo (aiQueryWebsite's OpenAI call + rankedContextSentences/firstReadableSentence heuristics in web.ts; aiQueryRun's env.AI Workers-AI call + first-line-JSON parser in worker.ts). buildSiteFacts() does a chunk-windowed map step (entities/claims/stats with cited chunkIds) then a DETERMINISTIC reduce: dedupe entities by normalized name, compute salience from mention frequency, cluster topics from the ContextChunk.headingPath that buildChunks() already produces (no LLM), infer relationships from same-chunk co-occurrence + LLM-stated FKs, and a HARD VALIDATION step that drops any fact whose quote is not a real substring of its cited chunk (counted in coverage.ungroundedDropped) — this is the no-hallucination guarantee. generateContextQuestions() then runs ONE LLM call seeded with the validated facts so questions are about real extracted content; questions without grounded sources are dropped; a 5-canonical-question heuristic fallback runs when no model is available.

(3) CRAWL TUNING — make buildProfile real (it's currently a ghost input: accepted in schema, stored as a tag, never read), raise PAGE_LIMIT and firecrawlMap limit, and add SIGNAL RANKING so high-context pages (pricing/docs/product/about) win the page budget instead of footer/utility links.

It surfaces as a new "Facts" build tab + share tab (identity hero, stat cards, entity list with salience bars + source popovers, claims grouped by kind, FAQ accordion with source chips and explicit coverage-gap rows), plus seeding the AI Query quick-prompts from facts.questions so the auto-generated grounded questions become one-click prompts. llms.txt / llms-full.txt gain "## What this site is", "## Key Facts", and "## FAQ" sections so the most-consumed agent file becomes self-describing. Everything degrades gracefully (try/catch around the LLM; heuristic fallback) so facts never fail a run.

## Final facts+questions schema (add to packages/core/src/types.ts via new facts.ts)
```ts
// ============================================================================
// SiteFacts — grounded, viz-ready structured facts + auto context questions.
// Add to packages/core/src/types.ts (or a new packages/core/src/facts.ts that
// types.ts re-exports). Sits NEXT TO markdown/chunks; every fact-bearing node
// carries sources[] {chunkId|routePath|url + verbatim quote} for clickable
// "why" provenance, reusing AiQueryResult.sources rendering already in main.tsx.
// ============================================================================

export type FactSourceRef = {
  chunkId?: string;        // stable id from buildChunks() (chunks.ts) — primary grounding anchor
  routePath?: string;      // PageArtifact.routePath / manifest page routePath
  url?: string;            // PageArtifact.url
  resourcePath?: string;   // walrus provenance (reuse PageArtifact.source.resourcePath / page.artifactPath)
  blobId?: string;         // walrus provenance (reuse PageArtifact.source.blobId)
  quote: string;           // verbatim substring that supports the fact (<=240 chars). VALIDATED: must be a real substring of the cited chunk text.
};

export type EntityType =
  | "organization" | "product" | "feature" | "person" | "technology"
  | "integration" | "platform" | "pricing_plan" | "use_case" | "metric"
  | "customer" | "competitor" | "location" | "event" | "concept" | "other";

export type SiteEntity = {
  id: string;                 // stable: sha256Hex(type + "\n" + normalizedName).slice(0,12)
  name: string;
  type: EntityType;
  aliases: string[];
  description?: string;       // 1 sentence, must be supported by sources
  url?: string;               // canonical/external link if the page links one out
  salience: number;          // 0..1 — centrality (drives node size in viz) = mentions/maxMentions
  mentions: number;          // # of chunks mentioning it
  sources: FactSourceRef[];  // REQUIRED non-empty
};

export type ClaimKind =
  | "value_prop" | "capability" | "differentiator" | "limitation"
  | "guarantee" | "positioning" | "fact";
export type Sentiment = "positive" | "neutral" | "negative";

export type SiteClaim = {
  id: string;                 // sha256Hex(normalizedText).slice(0,12)
  text: string;               // normalized to one sentence
  kind: ClaimKind;
  subjectEntityId?: string;   // FK -> SiteEntity.id
  sentiment: Sentiment;
  confidence: number;         // 0..1 extraction confidence
  isMarketing: boolean;       // promotional ("the best", "#1") — lets viz dim hype
  sources: FactSourceRef[];   // REQUIRED non-empty
};

export type StatUnit =
  | "count" | "percent" | "currency" | "time" | "data_size"
  | "ratio" | "rate" | "other";

export type SiteStat = {
  id: string;                 // sha256Hex(label + "\n" + valueRaw).slice(0,12)
  label: string;              // "uptime", "customers", "blob storage cost"
  valueRaw: string;           // "99.99%", "$0.01/GB", "10,000+"
  valueNumber?: number;       // parsed numeric (99.99, 0.01, 10000) for charts
  unit: StatUnit;
  currency?: string;          // ISO code when unit=currency
  approximate: boolean;       // "10,000+" / "~5M" => true
  subjectEntityId?: string;   // FK -> SiteEntity.id
  sources: FactSourceRef[];   // REQUIRED non-empty
};

export type SiteTopic = {
  id: string;                 // sha256Hex(label).slice(0,12)
  label: string;
  weight: number;             // 0..1 — share of content (drives treemap). Derived from chunk headingPath clustering.
  keywords: string[];
  routePaths: string[];       // pages where the topic dominates
  entityIds: string[];        // FK -> SiteEntity.id appearing under this topic
};

export type RelationKind =
  | "offers" | "part_of" | "integrates_with" | "competes_with" | "built_with"
  | "used_by" | "priced_at" | "depends_on" | "alternative_to" | "owned_by" | "mentions";

export type SiteRelationship = {
  id: string;                 // sha256Hex(sourceEntityId + kind + targetEntityId).slice(0,12)
  sourceEntityId: string;     // FK -> SiteEntity.id (graph edge tail)
  targetEntityId: string;     // FK -> SiteEntity.id (graph edge head)
  kind: RelationKind;
  label?: string;             // human edge label override
  confidence: number;         // 0..1
  sources: FactSourceRef[];
};

// "What the site IS" — one-screen executive summary, fully grounded.
export type SiteIdentity = {
  name: string;
  oneLiner: string;           // <=140 chars, supported by sources
  category: string;           // "decentralized storage", "design tool", "API gateway"
  audience: string[];         // ["developers", "enterprises"]
  primaryEntityId?: string;   // FK -> the org/product entity that IS the site
  sources: FactSourceRef[];
};

export type ContextQuestionCategory =
  | "what_is_it" | "who_is_it_for" | "how_it_works" | "pricing"
  | "differentiators" | "integrations" | "getting_started"
  | "limitations" | "trust_security";

export type ContextQuestion = {
  id: string;                 // sha256Hex(question).slice(0,12) — stable across reruns
  question: string;           // grounded, answerable from the crawled corpus only
  answer: string;             // 1-3 sentences, source-backed (empty when unanswerable)
  category: ContextQuestionCategory;
  importance: number;         // 0..1 — order for "understand this site fast"
  entityIds: string[];        // FK -> SiteEntity.id the Q/A touches (viz cross-link)
  sources: FactSourceRef[];   // REQUIRED non-empty unless unanswerable
  unanswerable?: boolean;     // true => corpus lacks the answer; keep Q to surface coverage gaps
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
  relationships: SiteRelationship[];   // edges -> entities (viz: force graph)
  questions: ContextQuestion[];        // co-located so the viz has ONE artifact
  coverage: {                          // honesty metrics so viz can show grounding density
    pagesAnalyzed: number;
    chunksAnalyzed: number;
    entitiesWithSources: number;       // == entities.length when fully grounded
    ungroundedDropped: number;         // facts discarded for failing the quote-substring check
  };
  usedProvider: FactsProvider;
  confidence: number;                  // overall 0..1
};

// VIZ-READY GUARANTEES:
// 1. Flat arrays of typed nodes (entities/claims/stats/topics) + explicit edge
//    array (relationships) => maps to nodes[]/links[] of d3-force/cytoscape/react-flow.
// 2. Every node has a stable string id; every FK is a string id (no nested dupes).
// 3. salience/weight/confidence/valueNumber are 0..1 or numeric => size/opacity/bar encodings.
// 4. EntityType/ClaimKind/RelationKind/StatUnit/ContextQuestionCategory are CLOSED enums
//    => stable color/legend mapping.
// 5. Every fact-bearing node carries sources[] with a VALIDATED quote => clickable provenance.
```

## Implementation steps (ordered)

1. packages/core/src/facts.ts (NEW): define the SiteFacts type-tree above + `buildSiteFacts(target, pages, chunks, opts)` and `generateContextQuestions(target, chunks, facts, opts)`. Export id helpers: entityId/claimId/statId/relationshipId/questionId all = sha256Hex(...).slice(0,12) (reuse utils.sha256Hex). Add `validateQuote(quote, chunkText)` using the SAME whitespace-normalization as chunks.ts normalizeText (export normalizeText from chunks.ts) so the substring check is consistent.
2. packages/core/src/facts.ts buildSiteFacts() PASS A (map): window the chunks into ~12k-char batches (mirror aiQueryWebsite's 24k cap at web.ts:360-363), send each batch as `[chunkId] (routePath) text` and ask the model (OpenAI via the EXACT fetch+OPENAI_API_KEY+response_format json_object block at web.ts:366-388) for entities/claims/stats each citing the chunkId(s) that support them. If no OPENAI_API_KEY, skip to the heuristic path (below).
3. packages/core/src/facts.ts buildSiteFacts() REDUCE (deterministic, no LLM): (a) dedupe entities by normalized name+type, sum mentions across chunks, salience = mentions/maxMentions; (b) build topics from ContextChunk.headingPath clustering (group chunks by top headingPath segment, weight = chunkCount/total, routePaths from members) — no model needed since buildChunks() already emits headingPath; (c) infer relationships from entity co-occurrence in the same chunk PLUS any FKs the model returned; (d) VALIDATION: for every entity/claim/stat source, run validateQuote against the cited chunk's text — drop the fact if the quote is not a real substring; increment coverage.ungroundedDropped. This is the no-hallucination gate.
4. packages/core/src/facts.ts buildSiteFacts() HEURISTIC FALLBACK (no model): synthesize identity.oneLiner from the home page's first useful sentence (reuse firstReadableSentence, export it from web.ts), derive entities from capitalized proper-noun frequency + the brand name, derive stats by regex over chunk text (/(\d[\d,.]*\s*%|\$\s?\d[\d,.]*|\d[\d,.]*\+|\d+(?:,\d{3})+)/), each with the chunk it came from as the source. usedProvider='heuristic'.
5. packages/core/src/facts.ts generateContextQuestions() PASS B (one LLM call): system prompt = the QUESTION_SYSTEM_PROMPT (JSON-only, use ONLY context, every answer must cite >=1 chunkId, 8-14 items ordered by importance, emit unanswerable:true for important gaps). user payload = JSON.stringify({identity, entities.slice(0,40) {id,name,type,salience}, claims.slice(0,40) {text,kind}, stats {label,valueRaw}, context: chunks.slice(0,N) mapped to `[chunkId] (routePath) text.slice(0,1500)`}).slice(0,24000). POST via the same provider used in Pass A. POST-PROCESS: map each returned sourceChunkId -> FactSourceRef (chunkId/routePath/url + quote=firstReadableSentence(chunk.text)); DROP any question with unanswerable=false AND empty sources; id=sha256Hex(question).slice(0,12).
6. packages/core/src/facts.ts generateContextQuestions() HEURISTIC FALLBACK: synthesize the 5 canonical questions (what_is_it, who_is_it_for, how_it_works, pricing, getting_started) and answer each with rankedContextSentences(corpus, keywords) (export rankedContextSentences from web.ts) so questions exist with zero LLM budget.
7. packages/core/src/types.ts: re-export everything from facts.ts (or paste the type-tree here) and add `facts?: SiteFacts` to WalrusPackageManifest (after aiQuery, line 692). Optionally export normalizeText from chunks.ts and firstReadableSentence/rankedContextSentences from web.ts (currently file-private) so facts.ts can reuse them without duplication.
8. packages/core/src/package.ts: add `facts?: SiteFacts` to AgentPackageInput (after aiQuery, line 47). In buildAgentReadableSite: build chunks ONCE earlier (move the `const chunks = buildChunks(pages)` up from line 134 so facts can reuse it — or accept facts via input and skip), set `manifest.facts = input.facts` (mirror line 102), write context/facts.json (mirror the ai-query.json write at line 116), and add '/context/facts.json' to the `known` routes array in buildWsResources (line 201) and to renderLlmsTxt's Core Artifacts list (line 352).
9. packages/core/src/package.ts renderLlmsTxt (line 345): when manifest.facts present, append '## What this site is' (identity.oneLiner + category + audience), '## Key Facts' (top ~8 claims+stats as bullets each with their source routePath), and '## FAQ' (questions[] as Q then A) so the single most-consumed agent file is self-describing and grounded.
10. packages/core/local run orchestration (the caller of buildAgentReadableSite — find via grep for buildAgentReadableSite usage, likely runs.ts or the CLI): after crawlWebSite()->pages and buildChunks(), call `const facts = await buildSiteFacts(target, pages, chunks); facts.questions = await generateContextQuestions(target, chunks, facts);` then pass `facts` into AgentPackageInput. Wrap in try/catch so a model failure degrades to heuristic facts, never failing the run.
11. apps/api/src/worker.ts extractTargetContext (line 2206): after `fetchedPages` is built (line 2274) and before the manifest object (line 2275), build chunks from manifest.pages markdown (import buildChunks from @contextmem/core) and call buildSiteFacts + generateContextQuestions using env.AI (mirror aiQueryRun's @cf/meta/llama-3.1-8b-instruct call + first-line-JSON / fenced-JSON parser at lines 1296-1346). Gate the whole block in try/catch -> heuristic facts on any failure. Set `(manifest as Record<string,unknown>).facts = facts`.
12. apps/api/src/worker.ts files[] (line 2428): push `{ path: '/context/facts.json', contentType: 'application/json; charset=utf-8', encoding: 'utf8', content: JSON.stringify(facts, null, 2) }` (mirror resources.json at line 2440). Inject the FAQ + key-facts sections into llmsFullContent (line 2384) and llms (line 2406) so hosted runs ship the same self-describing bundle as core.
13. apps/web/src/main.tsx: add the SiteFacts/ContextQuestion/SiteEntity/SiteClaim/SiteStat/SiteTopic/SiteRelationship/SiteIdentity TS types (copy from facts.ts) and add `facts?: SiteFacts` to the ArtifactManifest type (line 125 block, near designSystem line 155). Add ['Facts', Brain] (or Boxes/Network — Boxes already imported) to buildTabs (line 1370).
14. apps/web/src/main.tsx: add a `tab === 'Facts'` branch in the tab renderer next to the 'AI Query' branch (line 3209) -> `<FactsPanel artifact={artifact} />`. Implement FactsPanel (no new deps, reuse existing panel/card CSS): (1) IDENTITY hero (oneLiner + category chip + audience chips + confidence); (2) stats[] as a row of stat cards (valueRaw big, label small, source route tooltip); (3) entities grouped by EntityType with salience bars and a 'why' source-quote popover (reuse the AiResultData sources rendering); (4) claims grouped by kind, isMarketing dimmed; (5) questions[] FAQ accordion with source chips, unanswerable rendered as 'Gap: not covered on this site'.
15. apps/web/src/main.tsx ShareContentTabs (line 1495): `if (manifest.facts) tabs.push({ key: 'facts', label: 'Facts' })` and add the matching render branch (reuse FactsPanel or a read-only variant) so public shares expose the grounded facts + FAQ.
16. apps/web/src/main.tsx buildNamespaceAiPrompts (line 4155): when artifact.facts?.questions present, seed the quick-prompts from facts.questions[] (top ~5 by importance) so the auto-generated grounded questions become one-click AI Query prompts — the generator output is both a static FAQ artifact AND the interactive Q&A seed.
17. TESTS: add packages/core/src/facts.test.ts mirroring chunks.test.ts — assert (a) every emitted entity/claim/stat/question.source.quote IS a substring of its cited chunk (no-hallucination invariant), (b) ids are stable across reruns on identical input, (c) heuristic fallback produces the 5 canonical questions with sources when no model key is set, (d) ungroundedDropped increments when a fabricated quote is injected.

## Crawl tuning

- MAKE buildProfile REAL (worker.ts): it is currently a ghost input — accepted in the schema (line 336), stored as a `profile:` tag (line 1165), read back by hostedRunBuildProfile (line 3115), but NEVER used to size the crawl. In extractTargetContext (line 2206) read the profile via the same hostedRunBuildProfile(job) helper and drive a PAGE_LIMIT map: fast=10, balanced=25, full=50 (replace the hardcoded `const PAGE_LIMIT = 15` at line 2259).
- RAISE firecrawlMap limit (worker.ts line 2256): currently 40 — make it profile-driven (fast=40, balanced=100, full=150) so the candidate pool is broad BEFORE ranking. More candidates in, signal-ranked subset out.
- ADD SIGNAL RANKING before the slice (worker.ts line 2260): today candidateUrls is insertion-order then `.slice(0, PAGE_LIMIT)` (first-come-first-served). Replace with a score per candidate: +3 if pathname matches /docs|guide|product|features?|pricing|about|how|api|use-cases?/, +2 if anchor label is content-y (>2 words and not login/cookie/privacy/terms), -5 for utility routes (reuse the isUtilityPageRoute idea from core/utils.ts), -2 for deep query-heavy URLs. Sort desc, then slice. Pulls pricing/docs/product pages into the budget instead of footer links.
- SITEMAP-FIRST ordering (worker.ts): sitemap URLs (parseSitemapUrls, line 2241) are ground-truth structure — give them a ranking bonus and, if <priority>/<lastmod> are present, sort by those before the keyword score so high-value listed pages are guaranteed in-budget rather than competing flat with HTML anchors.
- NEAR-DUPLICATE GUARD (worker.ts): keep normalizeCrawlKey (strips #hash/?query, line 2545) so tracking/pagination variants don't eat the budget; additionally drop a fetched page whose content hash matches an already-emitted page (catches /index vs / and printer-friendly mirrors) before it consumes a slot.
- PER-PAGE BUDGET tuning (worker.ts line 2267): raise the 25000-char markdown cap only for the top ~5 ranked pages (keep 25k for the long tail) so the highest-signal pages feed the facts/question LLM with full content while staying within Worker memory.
- CORE crawlWebSite (web.ts line 73): expose a BuildProfile->CrawlOptions mapping (fast: maxPages 10/maxDepth 1; balanced: 25/2; full: 60/3) and pass it through so 'full' goes deeper. crawlWebSite already discovers per-page links (line 143) and already skips isUtilityPageRoute (line 106) — add the same path-keyword scoring to its enqueue ranking so the depth budget is spent on docs/product, not utility pages.
- CORE aiQueryWebsite internal crawl (web.ts line 359): it currently crawls maxPages:8/maxDepth:1 — when this corpus also feeds buildSiteFacts, bump to maxPages:15/maxDepth:2 so entity/claim/stat extraction sees pricing/docs pages, not just the homepage. Keep includeImages:false (correct for text facts).
- CORE crawlSitemap (web.ts line 170) already merges robots.txt Sitemap: directives — feed its urls[] as CrawlOptions.seedUrls (already supported, line 117) into crawlWebSite so sitemap-listed high-value pages are guaranteed in-budget, not just homepage-reachable ones.
- SURFACE the tuning: write the chosen profile + final ranked page list + per-page scores into discovery.json (DiscoveryStats already carries profile/sitemapSources/markdownFallbacks/fetchErrors — extend it with `rankedPages: Array<{url, score, reason}>`) so the Facts/Structure UI can show WHY each page was chosen and which candidates were skipped due to the budget (lets the user request a 'full' re-run).

## App surfacing
NEW "Facts" build tab (apps/web/src/main.tsx): add ['Facts', Brain] to buildTabs (line 1370) and a `tab === 'Facts'` branch next to the AI Query branch (line 3209) rendering <FactsPanel artifact={artifact} />. FactsPanel (no new deps, reuse existing panel/card CSS): (1) IDENTITY hero — identity.oneLiner + category chip + audience chips + overall confidence; (2) FACTS-AT-A-GLANCE — stats[] as a row of stat cards (valueRaw big, label small, source routePath in a tooltip) = the viz-ready numbers the user asked for; (3) ENTITIES + RELATIONSHIPS — entities grouped by EntityType (color per type) with a salience bar per row and a 'why' popover listing sources[].quote (reuse the AiResultData sources rendering already in main.tsx); expose the nodes[]/links[] shape inline so the later force-graph viz drops straight in; (4) CLAIMS — grouped by kind (value_prop/differentiator/limitation), isMarketing claims visually dimmed; (5) FAQ — questions[] as an accordion (question -> answer -> source chips linking routePath), unanswerable questions rendered as 'Gap: not covered on this site' so the panel doubles as a coverage report.

SHARE PAGE (ShareContentTabs, line 1495): `if (manifest.facts) tabs.push({ key:'facts', label:'Facts' })` + matching render branch so public shares expose grounded facts + FAQ.

AI QUERY SEED (buildNamespaceAiPrompts, line 4155): seed quick-prompts from facts.questions[] (top by importance) so the auto-generated grounded questions become one-click prompts — the generator output is both a static FAQ artifact AND the interactive Q&A seed.

AGENT FILES: llms.txt (package.ts renderLlmsTxt line 345) and worker's llms.txt/llms-full.txt (worker.ts lines 2384/2406) gain '## What this site is' + '## Key Facts' + '## FAQ' sections so the most-consumed agent file is self-describing and grounded.


## New files/types

- NEW FILE packages/core/src/facts.ts — SiteFacts type-tree + buildSiteFacts() + generateContextQuestions() + id/quote-validation helpers
- NEW FILE packages/core/src/facts.test.ts — invariants: quote-substring grounding, stable ids, heuristic fallback, ungroundedDropped counting
- NEW TYPES in types.ts (re-exported from facts.ts): FactSourceRef, EntityType, SiteEntity, ClaimKind, Sentiment, SiteClaim, StatUnit, SiteStat, SiteTopic, RelationKind, SiteRelationship, SiteIdentity, ContextQuestionCategory, ContextQuestion, FactsProvider, SiteFacts
- types.ts CHANGE: add `facts?: SiteFacts` to WalrusPackageManifest; extend DiscoveryStats with `rankedPages?: Array<{url; score; reason}>`
- package.ts CHANGE: add `facts?: SiteFacts` to AgentPackageInput; write context/facts.json; set manifest.facts; '/context/facts.json' in buildWsResources known[]; '## What this site is'/'## Key Facts'/'## FAQ' in renderLlmsTxt
- chunks.ts CHANGE: export normalizeText (so facts.ts validateQuote uses the identical normalization)
- web.ts CHANGE: export firstReadableSentence and rankedContextSentences (reused by the heuristic facts/question fallback)
- worker.ts CHANGE: extractTargetContext builds chunks + facts via env.AI, pushes /context/facts.json, injects FAQ into llms/llms-full; profile-driven PAGE_LIMIT + firecrawlMap limit + candidate signal-ranking
- main.tsx NEW COMPONENT FactsPanel + CHANGES: SiteFacts types, ArtifactManifest.facts, buildTabs Facts entry + renderer branch, ShareContentTabs Facts tab, buildNamespaceAiPrompts seeded from facts.questions

## Risks / invariants

- Hallucinated grounding is the headline risk and is mitigated DETERMINISTICALLY: every entity/claim/stat/question source quote is checked as a real substring of its cited chunk (using chunks.ts normalizeText) and dropped + counted in coverage.ungroundedDropped if it fails. Do NOT trust the model's self-reported chunkIds without this check.
- TWO different LLM stacks: core uses OPENAI_API_KEY /chat/completions (gpt-5-mini default) while the worker uses env.AI Workers-AI (@cf/meta/llama-3.1-8b-instruct). The 8b model produces weaker JSON and often wraps it in ```json fences — reuse aiQueryRun's existing fence+first-line parser (worker.ts:1316-1346) and ALWAYS fall back to heuristic facts on parse failure so a run never fails.
- Cost/latency/Firecrawl quota: profile=full raises PAGE_LIMIT to 50 and firecrawlMap to 150 and adds 2 extra LLM passes per run — gate the heavy crawl behind 'full' only, keep balanced near today's footprint, and window/cap the facts context at the existing 24k budget so token spend stays bounded.
- Worker memory/subrequest limits: Workers cap subrequests and memory; 50 concurrent Firecrawl scrapes + LLM calls can hit limits. Keep concurrency batched (the current Promise.allSettled fans out all at once) and keep per-page caps; raise the markdown budget only for the top ~5 pages, not all.
- Entity dedupe quality: naive normalized-name dedupe will merge distinct entities sharing a name or fail to merge aliases ('Walrus' vs 'Walrus Protocol'). Use the model's aliases[] plus conservative casefold/trim matching; over-merging is worse than under-merging for a viz, so bias toward keeping separate.
- Relationship inference from same-chunk co-occurrence is noisy (two entities in one paragraph aren't necessarily related). Require either an LLM-stated FK OR co-occurrence in >=2 chunks before emitting an edge, and keep confidence low so the viz can threshold.
- Frontend type drift: SiteFacts is hand-copied into main.tsx (the app already duplicates manifest types rather than importing from core). Keep the copy in sync or risk runtime shape mismatches; consider a shared d.ts to reduce drift.
- Schema versioning: facts.schemaVersion=2 while existing snapshot/manifest schemas are version 1 — make FactsPanel and llms.txt injection defensive (optional chaining, empty-array guards) so old runs without facts.json don't crash the new tab.
- Quote provenance for worker pages: worker manifest pages use page.artifactPath ('/site/page-N.md') not PageArtifact.source — map FactSourceRef.resourcePath to artifactPath in the worker path so the 'why' popover links resolve.