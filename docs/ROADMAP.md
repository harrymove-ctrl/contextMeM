# ContextMEM Roadmap

> A Walrus-native web context-extraction + agent-memory product. This roadmap aligns the next 0-12 months to the **Talus/acc grant**: publishing the three core capabilities — **`contextmem.extract` / `.recall` / `.remember`** — as Talus Tools (Nexus DAG nodes) with **on-chain attribution receipts**, and adopting **Harbor** (Walrus encrypted storage + SEAL) to give ContextMEM a real on-chain provenance + private-memory layer.

## Executive summary

ContextMEM today is a feature-wide product with a solid extraction core, a live freshness/diff/webhook pipeline, a 3D "memory constellation" UI, and grounded RAG chat — but it has **no custom on-chain layer**. Storage goes to Walrus via the **Tatum gateway** (plaintext, mainnet, Node-only, never in the Worker); "private" namespaces are enforced only by a Cloudflare D1 token check, not encryption; memory indexing rides the MemWal relayer; and there is **zero Move code, zero attribution receipts, and zero Talus/Nexus wiring**. The strategic move is to adopt **Harbor** for private/encrypted storage (which gives us Bucket + SEAL-policy objects on Sui for free, via Enoki-sponsored txs — no SUI balance needed) while **keeping Tatum for public/mainnet**, and to author **one minimal Move package** (`registry` + `receipt`) that does the single thing nothing else does: anchor typed, composable attribution receipts for the Talus DAG. The rest of the roadmap (token-aware chunking + local hybrid retrieval, killing the delegate-key signup wall, wiring the already-built-but-orphaned namespace console, a usage/event ledger, and basic abuse/observability plumbing) is the product hardening required to ship the grant demo and go public.

---

## Current architecture snapshot (honest)

**Monorepo (bun).** `packages/`: `core` (web extraction/crawl + facts + chunks + screenshots), `walrus` (Tatum storage + Sui reads), `memwal` (Memory-on-Walrus via `@mysten-incubation/memwal`, Ed25519 delegate-signed relayer), `mcp`, `cli`. `apps/`: `api` (Cloudflare Worker + D1 + R2 + Queues; `wrangler.jsonc`) and `web` (React 19 + Vite + three.js).

- **No smart contract.** `find` for `Move.toml`/`*.move` returns nothing. Every "on-chain" touch is either a **read-only Sui query** (`SuiGrpcClient.getObject` in `proof.ts`/`history.ts`/`resolve.ts`/`bcs.ts`, all reading *Mysten's* Walrus Sites package) or a **write mediated by a third party** (Tatum signs the Walrus tx; MemWal's relayer holds memory). ContextMEM never signs a Sui tx today.
- **Storage = Tatum, plaintext, Node-only.** `packages/walrus/src/storage.ts` `packProofBundle()` shells out to `tar` (`child_process`) — **cannot run in the Worker** — and `uploadToWalrusStorage()` POSTs to `api.tatum.io/v4/data/storage/upload`, polling to `CERTIFIED`. Returns a `WalrusStorageReceipt` (`core/types.ts:655`) with `provider: "tatum"`. **No encryption anywhere** (no `@mysten/seal`, no `@mysten/walrus`). Call sites are **only** the CLI (`cli/src/index.ts:347`) and MCP (`mcp/src/index.ts:200`). Hosted/web extractions live only in **R2 + D1, never on Walrus**.
- **Memory = MemWal relayer.** `memwal/src/index.ts` signs with `MEMWAL_PRIVATE_KEY` against `relayer.memwal.ai`; `rememberStorageIndex()` writes pointers only (blobId/jobId/digest), not bytes. Worker uses it for **recall/restore only** (`worker.ts:3422/3525/3619`). `memwal/src/sdk.ts` is dead scaffolding (`loadSdk()` throws).
- **Namespaces are app-layer.** `namespaceForTarget()` (`core/utils.ts:123`) → `walrus:<net>:<id>` | `web:<domain>` | `target:<hash>`. Visibility/owner/read-tokens (`ctxm_*`) live in D1 (`CloudflareNamespaceStore`, `worker.ts`) — **"private" is a Bearer-token check, not encryption.**
- **What works well:** heading-aware deterministic chunking + diff (`chunks.ts` `buildChunks`/`planMemoryWrite`/`chunkGraphDigest`); LLM map-reduce facts with a real no-hallucination gate (`facts.ts` `validateQuote`); live freshness via `*/30` cron → `processDueSchedules` → alerts + HMAC webhooks; grounded multi-turn chat (`memwalChat`).
- **What's thin:** no hosted accounts (identity = MemWal delegate in browser `localStorage`); no billing/metering; no observability; rate-limiting only on the demo IP quota; CI is typecheck+test only; **a fully-built namespace management console (`NamespacesAppPage`, `main.tsx:5943`) is never routed.**

**Hosted:** `contextmem-backend.petlofi.workers.dev` (Worker) + `contextmem.pages.dev` (Pages), plus a staging env. `TATUM_API_KEY` / `MEMWAL_*` / future `HARBOR_*` are wrangler secrets.

---

## Harbor + on-chain decision (cross-cutting — read this first)

This decision cuts across storage, privacy, and "where is the smart contract," so it frames every section below.

### Recommendation

1. **Coexist, don't replace.** Keep **Tatum (mainnet, proven, plaintext)** for **public** content. Add **Harbor (Sui testnet alpha, SEAL-encrypted)** for **private** namespaces + the on-chain grant demo. Full migration to Harbor is not viable until Harbor reaches mainnet — and the network split (Tatum=mainnet, Harbor+any Move package=testnet) must be reconciled before launch by picking **one network for the launch surface** so receipts and the blobs they cite are co-located.
2. **Adopt the hybrid (Option C): compose primitives + author ONE minimal Move package.** Reuse **Walrus** (bytes) + **Harbor/SEAL** (private/encrypted storage + on-chain access control) + **MemWal** (recall). Do **not** rebuild storage/encryption/memory in Move. Author a small `contextmem` Move package (`registry` + `receipt`) for the one thing none of them provide: **typed, composable on-chain attribution receipts** for the Talus DAG.
3. **Harbor is the high-leverage shortcut and should land BEFORE any Move authoring.** Its `RESERVE → SIGN → FINALIZE` bucket handshake is the **first time ContextMEM signs a real Sui tx** (with the `suiprivkey1...` service key), and it yields two on-chain object types for free:
   - **Bucket objects** — per-namespace file containers (Enoki **sponsors** the gas, so no SUI balance needed; sponsor sigs expire fast → finalize must immediately follow reserve as one tight sequence).
   - **SEAL policy objects** — genuine on-chain access control: decryption is gated by an on-chain `seal_approve` Move call + a `SessionKey`, far stronger than today's D1 token check. **Private namespace → owned Seal policy; granting a read token → granting SEAL decrypt.**

   That alone is a legitimate **partial answer to "where is the smart contract"** (storage + access control now on-chain) with **zero custom Move**. The remaining gap — op-type, source/artifact digest, model, parent-receipt lineage — is exactly what the minimal `receipt` module fills.

### The key runtime unknown (must spike early)
The Harbor HTTP API is plain `fetch` + multipart (Worker-friendly). The hard part is **`@mysten/seal` in the Cloudflare Worker**: it leans on WebCrypto + `@noble` curves + CPU-intensive BLS, works *in principle* under `nodejs_compat`, but Workers have a compressed-bundle cap and CPU limits. **Spike a minimal Worker that imports `@mysten/seal` and runs one encrypt+decrypt before committing to Worker-side encryption.** If it busts limits, move encryption/upload to the **queue consumer** or the **Node CLI/MCP** path and keep the Worker for fetch+decrypt only. `tar`-based packaging stays Node-only; the hosted path needs an **in-memory zip from R2** in the queue consumer.

---

## 1. Walrus memory + Harbor integration

### Current state
Storage = Tatum (Node-only, plaintext, mainnet). On-chain = read-only Sui queries. Memory index = MemWal pointers. `quilt.ts` builds public aggregator read URLs only. See snapshot above.

### Gaps
- **No encryption at the storage layer** — every Walrus blob is uploaded plaintext via Tatum; "private" is D1 visibility + read tokens, but the bytes are public to anyone with the blobId/aggregator URL. This is the core gap Harbor+SEAL closes.
- **No Harbor client at all** — no `@mysten/seal`, no `@mysten/walrus`, no SPACE/BUCKET/FILE concept, no reserve→sign→finalize, no SessionKey/`seal_approve` decrypt.
- **Receipt type is hard-wired** — `WalrusStorageReceipt.provider` is the literal `'tatum'` (`core/types.ts:656`); needs widening + new fields (`bucketId`, `fileId`, `sealPolicyId`, `sealIdentity`, `spaceId`).
- **Single provider, no fallback**; **network split** (Tatum mainnet vs Harbor testnet) with no per-namespace provider abstraction.
- **Worker can't pack/upload** — `packProofBundle` uses `tar`/`child_process` + fs; hosted/R2 extractions never reach Walrus. Worker-side upload must repack from R2 in-memory (zip).
- **No recall-time fetch+decrypt** — recall returns text/pointers; nothing turns a ref into actual (decrypted) artifact bytes.
- **No on-chain attribution receipt**; **no SUI service key** wired for signing.

### Plan

| Task | Priority | Effort | Notes |
|---|---|---|---|
| StorageProvider abstraction + widen receipt union | P0 | M | Interface `{ upload, status, fetch }` in `packages/walrus`; refactor Tatum behind `TatumStorageProvider`; widen `provider` to `'tatum'\|'harbor'` + add Harbor fields. The seam every later item plugs into. |
| Build `HarborClient` (`packages/walrus/src/harbor.ts`) | P0 | L | Pure-fetch, Bearer `hbr_`. createBucket → sign sponsored tx with `Ed25519Keypair`(decodeSuiPrivateKey) → finalize as one tight sequence; uploadFile + poll status; handle ~3s post-finalize 403 `mirror_missing_grant` retry; download ciphertext. Runtime-agnostic (no `node:fs`/`child_process`). |
| Wrap SEAL encrypt/decrypt (`seal.ts`) | P0 | L | `@mysten/seal`: encrypt against `seal_policy_id` w/ per-file identity before upload; decrypt via SessionKey + `seal_approve` after download. Decoupled from HarborClient. **Verify it fits the Worker budget first.** |
| Map namespaces → Harbor spaces/buckets | P0 | M | One Space per env; deterministic Bucket per namespace string; persist `spaceId`/`bucketId`/`sealPolicyId` in D1 (`contextmem_namespaces`) for recall lookup. |
| Key mgmt: SUI service key in Worker secrets | P0 | S | Add `HARBOR_API_KEY`, `HARBOR_SERVICE_PRIVATE_KEY` (`suiprivkey1...`), `HARBOR_SPACE_ID` to `WorkerEnv` + `.env.example`. Decide shared vs per-owner key. Mirror `resolveMemwalCreds` header-or-secret pattern (`worker.ts:3341`). |
| Worker spike: `@mysten/seal` + `@mysten/sui` budget | P0 | S | Minimal Worker importing seal, one encrypt+decrypt. Decides whether encryption runs in Worker, queue consumer, or Node only. |
| Private namespaces via Seal policies | P1 | L | `visibility='private'` → owned Seal policy; granting a read token also grants SEAL decrypt (wire into `CloudflareNamespaceStore.authorize`, `worker.ts:503`). Makes "private" real at the chain layer. |
| Coexistence + provider selection (keep Tatum) | P1 | M | Per-namespace/per-env switch: public+mainnet→Tatum, private→Harbor+SEAL; fall back to Tatum on Harbor failure for non-private. Receipt records actual provider. |
| Recall fetch+decrypt path | P1 | L | New `GET /api/memwal/artifact`: look up provider+refs in D1, fetch ciphertext, SessionKey + `seal_approve`, decrypt, stream (token-gated); public→aggregator. Extend `rememberStorageIndex` (`memwal/index.ts:164`) to carry bucketId/fileId/sealPolicyId/sealIdentity. |
| Worker-side packaging from R2 (unlock hosted→Walrus) | P1 | M | In-memory zip packer reads R2 artifacts → bundle bytes, in the **queue consumer** (CPU/time limits). Keep `packProofBundle` (tar) for CLI/MCP. |
| On-chain attribution receipt (Talus) | P2 | L | After certified Harbor upload, write a minimal receipt object/event tying namespace+digest+bucketId+ts. Whether a tiny Move module is needed is an open decision (see §2). |
| Epochs / certification / cost handling | P2 | M | Confirm who pays ongoing Walrus epochs (Enoki sponsors only bucket creation); status-poll parity with `waitForWalrusStorageCertified`; surface epoch/expiry + renewal policy; cost telemetry. |

### Harbor / on-chain notes
Harbor is the cleanest answer to "where is the on-chain layer." Bucket objects + Seal policy objects are real Sui objects, created by ContextMEM **signing** a tx (service key), with Enoki sponsoring gas. SEAL policies are genuine on-chain authorization for private namespaces. These map directly to the Talus story; a small Move attribution module would make receipts first-class. Network reality: Harbor **augments** (private + on-chain demo), Tatum **stays** (public mainnet prod) until Harbor hits mainnet.

### Open questions
- Replace Tatum or coexist? → **Coexist** (recommended) until Harbor mainnet.
- Network strategy for the grant demo: move storage to testnet, or dual-network per namespace?
- Where does encrypt+upload run — Worker, queue consumer, or Node? (Gated on the seal spike.)
- Service-key custody: one shared key (simple, decrypts everything) vs per-owner (true isolation, more plumbing)?
- Public share pages can't do SessionKey + `seal_approve` — confirm public namespaces stay plaintext, only private are SEAL-encrypted.
- Does Harbor expose a Walrus blobId/aggregator handle, or only its own `/download`? (Determines if `quilt.ts` reads are reusable.)
- `rememberStorageIndex` schema change OK (it alters the remembered `[ctxm-storage]` metadata format)?

---

## 2. Smart contracts / on-chain architecture

### Current state
**No custom Move package.** All on-chain touch is read-only Sui queries (Mysten's Walrus Sites package) or third-party-signed writes (Tatum, MemWal). The closest thing to an on-chain artifact is the Tatum-signed Walrus blob (durable but **weak attribution** — Tatum's key signs, not ours, so it can't prove *who* produced it). Namespace ownership/visibility/access-control is **100% off-chain** in D1 — exactly the "where's my smart contract?" gap.

### Gaps
- **No typed, queryable, composable attribution receipt** that Nexus DAG nodes can reference by object ref and verify.
- **Weak provenance / no producer identity on-chain** — `artifactDigest` (sha256) is computed in `packProofBundle` but never anchored to an identity-bound object.
- **No on-chain namespace registry / ownership object**; **no encryption** (no SEAL); **no DAG lineage primitive** (recall→remember→extract links unrecorded).
- **Network mismatch risk** — mainnet Tatum blobs vs testnet Harbor + any new Move package.

### Plan

| Task | Priority | Effort | Notes |
|---|---|---|---|
| DECISION: adopt Option C (hybrid) | P0 | S | Keep Walrus + Harbor/SEAL + MemWal; author ONE small `contextmem` Move package for attribution receipts + thin namespace registry. Not pure-Move (wasteful) nor no-Move (leaves receipts unverifiable). |
| Integrate Harbor for storage FIRST | P0 | L | Bucket + Seal policy objects = real on-chain layer with **zero Move authoring**. Map private→`seal_policy_id`, public→unencrypted. Reuse Harbor/SEAL for crypto — never author our own access control. (Shared with §1.) |
| Author Move module `receipt` (AttributionReceipt) | P0 | M | The Talus Nexus payload. Object: `op`(Extract/Recall/Remember), `namespace`, `producer`, `tool_caller?`, `source_digest`, `artifact_digest`(from `packProofBundle`), `walrus_blob_id`, `quilt_patch_id?`, `memwal_ref?`, `parents: vector<ID>`(DAG lineage), `model?`, `created_at`, `epoch`. `mint_receipt(...)` updates `Namespace.head_receipt` + emits `ReceiptMinted` event. `parents` is what makes receipts compose into a DAG. |
| Author Move module `registry` (Namespace) | P1 | M | Object: `owner`, `visibility`, `seal_policy_id: Option<ID>`, display/desc, `created_at`, `head_receipt: Option<ID>`. Owner-gated fns. On-chain source of truth for today's D1 owner_id/visibility; D1 becomes a read cache. |
| Wire receipt minting into extract/remember | P1 | M | After Walrus certify and/or MemWal write, mint a receipt via **(a) Enoki-sponsored tx (preferred, reuses Harbor pattern)** or (b) a Node/Bun relayer off a Cloudflare Queue. Feed `artifactDigest`/`blobId`/`jobId` from `WalrusStorageReceipt`. |
| Publish the three Talus Tools referencing receipts | P1 | M | `contextmem.extract/.recall/.remember` as Nexus nodes whose outputs include the minted receipt object id; chain via `parents`. Confirm Nexus's exact schema/ABI before freezing the struct. |
| Author optional `cap` module (WriterCap) | P2 | S | On-chain mirror of the Ed25519 delegate model; only authorized relayers mint receipts. Defer if sponsored owner-signed txs suffice. |
| Backfill + reconcile D1 ↔ chain; resolve network | P2 | M | Backfill Namespace objects from D1; decide D1-mirrors-chain vs chain-attests-D1; pick ONE network for launch. |

### Harbor / on-chain notes
Harbor lands **before** Move authoring and gives Bucket + Seal policy objects for free (Enoki-sponsored, no SUI balance) — a legitimate partial answer to "where's the contract." Harbor does **not** carry op-type/digest/model/lineage; that single gap is what the minimal `receipt` module fills. Harbor's sponsored-tx pattern is the **template** for how `mint_receipt` should be sponsored, letting the Worker/relayer write receipts without holding SUI. Net: **Harbor (storage+encryption+access) + `registry`+`receipt` (provenance) = the complete on-chain story.** Watch the mainnet/testnet split.

### Open questions
- Who signs/pays the mint tx: Enoki sponsorship (recommended), backend relayer off a Queue, or user wallet? (Affects whether "the user owns" the receipt.)
- Source of truth: on-chain Namespace authoritative (D1 mirrors) vs D1 authoritative (chain attests)? — biggest architectural call.
- Receipt granularity vs cost: one object per op (precise lineage, gas each) vs one per run carrying a Merkle root (cheaper)? Depends on Nexus.
- Does Talus Nexus mandate a specific receipt schema/event ABI? Get the spec before freezing the struct.
- Reuse Harbor's Seal policy as the namespace ACL object (visibility=private ⇔ has `seal_policy_id`)? Recommended — confirm Harbor exposes the policy id.
- Keep Tatum once Harbor is in, or fully migrate?

---

## 3. Better crawling / context extraction

### Current state
**Two parallel pipelines.** (A) `packages/core` (Node, used by CLI/MCP/Fastify): `fetchHtml()` raw fetch (no JS) → Readability + Turndown → `crawlWebSite()` BFS (maxPages 25/depth 2) + `crawlSitemap()` → `buildChunks` → `buildSiteFacts` → Playwright screenshots (local). (B) `apps/api/src/worker.ts` (the **production** path, reimplemented because cheerio/JSDOM break in Workers): `firecrawlScrape()` when `FIRECRAWL_API_KEY` set else raw fetch + regex `htmlToText()`; sitemap-first candidate discovery + `scoreCandidateUrl()` ranking; near-dup guard via `crawlContentHash()` (djb2 over first 4KB). Shared, solid building blocks: heading-aware deterministic chunking + diff; LLM map-reduce facts with verbatim `validateQuote()` gate + heuristic fallback; live `*/30` cron diff → alerts + webhooks. Retrieval delegates semantic recall to the **MemWal relayer's embedding service** + keyword grounding — **no local vector index.**

### Gaps
- **JS/SPA**: core is raw-fetch only; Worker only renders with Firecrawl; **no Cloudflare Browser Rendering fallback** → SPA shells extract empty without the Firecrawl key.
- **robots.txt fetched but not obeyed** (only `Sitemap:` lines parsed; Disallow/Crawl-delay ignored) → compliance risk. **No rate-limiting/backoff** (no 429/Retry-After, no per-host throttle).
- **HTML-only** content coverage — no PDF/.docx/RSS/JSON/OpenAPI; `.text()` on binaries → garbage.
- **Char-count chunking, no overlap** — `splitLong()` cuts mid-sentence/code/table; hurts RAG + facts grounding.
- **Opaque/fragile retrieval** — no Vectorize, fully delegated to a flaky relayer (already retried in `memwal/index.ts`); keyword-only fallback; no hybrid BM25+vector/rerank/MMR; fixed topK=6.
- **Weak dedup** (djb2 over first 4KB only; no SimHash/MinHash, no cross-page boilerplate stripping). **Pipeline drift** (Worker regex < core Readability). **Shallow production crawl** (~1-hop). **No structured extraction** (JSON-LD/microdata/OG/tables unused). **Noisy diff** (hashes full html incl. nav/ads).

### Plan

| Task | Priority | Effort | Notes |
|---|---|---|---|
| Token-aware chunking with overlap + structure-safe splits | P0 | M | `chunks.ts`: ~512-800 token budget + ~10-15% overlap; respect sentence/code-fence/table boundaries; keep deterministic chunkIds (stable sub-index) so `planMemoryWrite` diffing holds. Lifts both pipelines at once. |
| Local hybrid retrieval index (Vectorize + BM25) | P0 | L | Add Vectorize binding; embed chunks at build (Workers AI bge) keyed by namespace+chunkId; hybrid retrieval + rerank/MMR + configurable topK in `memwalChat`; fall back to MemWal recall only when empty. Removes the flaky-relayer dependency. |
| Cloudflare Browser Rendering fallback for JS/SPA | P0 | M | Bind Browser Rendering; order firecrawl → browser-rendering → raw fetch (detect empty shell via main-content length). Closes the SPA gap without making Firecrawl mandatory; parity with local Playwright. |
| Respect robots.txt + per-host rate-limiting/backoff | P1 | M | Parse Disallow/Allow/Crawl-delay before enqueue; 429/Retry-After handling + per-host token bucket; cap per-origin concurrency. |
| PDF + document content-type coverage | P1 | M | Branch on content-type; PDF→text (unpdf/pdf.js on Workers)→markdown→chunks; add RSS/Atom + JSON-LD/OpenAPI. Unlocks whitepapers/docs. |
| High-precision structured extraction (model-free) | P1 | M | Pre-LLM extractor for JSON-LD/schema.org/microdata/OG product+price/tables → seed entities/stats into `buildSiteFacts` (already carry exact text for `validateQuote`). Boosts precision, cuts LLM cost. |
| Stronger near-dup dedup (SimHash/MinHash) + boilerplate stripping | P1 | M | Replace `crawlContentHash` with shingle/SimHash over full normalized text + Hamming threshold; strip shared cross-page nav/footer before chunking. |
| Converge the two pipelines on one clean→markdown core | P1 | L | Runtime-agnostic `htmlToMarkdown` (e.g. linkedom/htmlparser2) so the Worker drops regex `htmlToText()` and matches core fidelity. One quality bar regardless of entry point. |
| Semantic / section-level freshness diff | P2 | M | Hash cleaned main-content (not full html); `diffSummaryForNamespace` reports section/chunk adds/changes/removes + optional LLM "what changed". Removes boilerplate-churn false positives in `*/30` alerts. |
| Walrus Sites on-chain resource enumeration | P2 | L | Read the Sui Site object to enumerate resource paths + blobIds directly vs gateway HTTP. Complete coverage + verifiable provenance; aligns with on-chain direction. |
| Pagination / infinite-scroll + deeper discovery | P2 | M | With Browser Rendering, follow rel=next/paginated/scroll loads; raise effective depth beyond ~1-hop. |
| Per-page language detection + content-quality scoring | P2 | S | Tag language + main-content/boilerplate ratio; route/down-weight low-quality pages. |

### Harbor / on-chain notes
Harbor/SEAL is the natural home for **auth/paywalled + private-namespace** crawls: store SEAL-encrypted ciphertext in a Harbor bucket (plaintext never leaves the client; access via on-chain Seal policy). Keep Tatum for public context. Two provenance hooks: (1) Walrus Sites crawling reads the Site object on Sui for enumeration = verifiable source-of-truth; (2) the **extract** capability should emit an on-chain receipt keyed by the existing **`chunkGraphDigest()`** — the perfect verifiable "what was extracted" anchor for `contextmem.extract`. Note: the Vectorize work is off-chain edge infra; verifiability = receipt + digest + Harbor ciphertext, not the index.

### Open questions
- Consolidate onto ONE pipeline (Workers-compatible core) or keep core for CLI parity?
- Is Firecrawl permanent or a stopgap until Browser Rendering is default?
- Commit to Vectorize (binding/cost) or keep delegating recall to MemWal?
- Privacy boundary for auth/paywalled crawls — only via Harbor/SEAL, or refuse logins for legal reasons?
- Re-scrape diff: section-level semantic (LLM cost per `*/30` run) vs cheap hash-level?
- robots.txt: hard-enforce vs advisory with override?

---

## 4. UI/UX

### Current state
React 19 + Vite + react-router + three.js; **no Tailwind/shadcn** — one hand-written 10,241-line `styles.css` with `--cm-*` tokens (light theme, brand green `#a8d946`, dark graph `#0f1115`). **Almost the entire app is in one 8,203-line `main.tsx`** (~70 components); only the 3D constellation is split out. Routes: landing (parallax hero + live demo extraction), `/share/:shareId`, `/showcase`, and gated `/app/*` (Build, Artifacts, Runs, Memory, Compare, Publish, Namespaces, Settings). 3D "memory constellation" (OrbitControls autorotate, bloom, fibonacci-sphere, DOM labels, search, detail panel). Grounded chat panel (multi-turn, per-turn sources/confidence). Non-delegate users are hard-gated behind `LockedPreview`/`HostedCredentialGate`.

### Gaps
- **DEAD MANAGEMENT UI** — the full `NamespacesAppPage` (`main.tsx:5943`: token create/revoke, public/private + directory, multi-source builder, schedules, alerts, webhooks) is **never routed**; `/app/namespaces` uses the lightweight `NamespacesSimplePage`. All namespace/memory CRUD is built but unreachable.
- **Monolith** — 8,203-line `main.tsx` / 10,241-line `styles.css`; no route-level code splitting (landing + three.js + app pages all load together).
- **3D constellation a11y/perf** — ignores `prefers-reduced-motion` (always-on autorotate + bloom + RAF); no keyboard nav, no WebGL/low-power fallback, no Esc-to-deselect; crowded on mobile.
- **No skeleton/loading system** (plain "Loading..." text); **design-system drift** (two `:root` blocks, off-palette hex in `namespace-memory.css`, no dark mode); **info overload** (8 result tabs, duplicated `resultsBody`, double `MemWalPanel` mount); **onboarding friction** (hard delegate gate on all `/app/*`); **thin a11y** (~41 aria across 8k lines); **inconsistent empty states**; **shallow provenance UI** (`WalrusProofPanel` shows blobId + certified only — no explorer links, no attribution/encryption indicators).

### Plan

| Task | Priority | Effort | Notes |
|---|---|---|---|
| Wire up the orphaned `NamespacesAppPage` as the real `/app/namespaces` | P0 | M | Replace `NamespacesSimplePage` at the route (`main.tsx:1575`) with `NamespacesAppPage` (`:5943`); audit each `/api/hosted/*` is live first. Unlocks tokens, visibility, schedules, alerts, webhooks. Single biggest UX win — core management is currently invisible. |
| Reduced-motion + WebGL/low-power fallback for the constellation | P0 | M | Gate autorotate/bloom/RAF on `prefers-reduced-motion`; cap pixelRatio + reduce bloom on mobile; 2D/list fallback (reuse `factsToMemoryGraph`) when WebGL fails; Esc-to-deselect. |
| Reusable skeleton/loading + consistent empty/error states | P1 | M | Tokenized Skeleton + shimmer applied to hosted extraction, facts/graph, chat "thinking", namespaces list, share page. One empty-state component; structured recoverable error cards (retry) vs raw red text. |
| Split `main.tsx` into route modules + lazy loading | P1 | L | Carve ~70 components into per-route files; `React.lazy` + Suspense heavy routes (three.js facts/constellation, app shell) so landing/share don't ship WebGL + Sui bundles. Co-split `styles.css`. |
| First-run onboarding / progressive disclosure | P1 | M | Guided "Connect → Build → Remember → Recall" checklist; let users explore seeded public namespaces before the hard delegate gate; "Use this in your agent" card on share pages. |
| Simplify the Build console hierarchy | P2 | M | Group 8 tabs into Content/Knowledge/Brand+Design/Walrus; dedupe `resultsBody` (inline vs modal); remove duplicate `MemWalPanel` mount; clarify Build vs Runs vs Artifacts vs Namespaces. |
| Consolidate design system + dark mode | P2 | M | Merge `:root` blocks; move hardcoded hex onto `--cm-*`; cover light app + dark graph; add `prefers-color-scheme` + toggle; re-introduce entity-type color legend (`lib/entity-colors.ts`). |
| Constellation + chat usability details | P2 | M | Keyboard nav + `aria-activedescendant` in search; focus trap on detail aside; mobile bottom-sheet; chat streaming/typing skeleton + copy button + "grounded in N sources". |

### Harbor / on-chain notes
The orphaned `NamespacesAppPage` already has a private/public visibility toggle + directory flag (`metadataDraft.visibility`, ~`L5950`) — surfacing it (P0) is the prerequisite for any encryption UI. Then add: (1) per-namespace **"Encrypted (SEAL)" badge** + a privacy toggle that routes private storage through Harbor; (2) **access-control management** backed by the Seal policy object (list/add grantees, show `seal_policy_id` + Bucket); (3) a **bucket-creation status** affordance for RESERVE→SIGN→FINALIZE + the ~3s `mirror_missing_grant` delay (needs the new skeleton/structured-error system). For provenance: add **Sui explorer deep-links** (blob, Bucket object, Seal policy, tx digests) to `WalrusProofPanel`, and a dedicated **"Provenance / attribution receipts"** surface (new share-page tab + Facts view) for the Talus Tools. Since there's no Move contract, the Bucket + Seal policy objects are the on-chain layer to visualize.

### Open questions
- Is `NamespacesAppPage` parked (backend not ready) or just unwired? If endpoints are live, exposing it is P0.
- Is the hard delegate gate on all `/app/*` deliberate, or can users explore seeded public namespaces first?
- Private/encrypted namespaces: replace Tatum entirely (storage becomes a user-facing choice) or opt-in per namespace?
- Dark mode for the whole app, or keep light-app/dark-graph as brand identity?
- Are attribution receipts a first-class UI surface now (grant demo) or backend-only this milestone?
- Are Brand/Design System/Visual Diff/Compare tabs still core, or de-emphasize to cut Build overload?

---

## 5. Onboarding (user + developer)

### Current state
**Two tracks, neither end-to-end guided.** End-user: solid landing first-touch — anonymous "public demo preview" (1/day/IP via `contextmem_demo_limits`), `QuickStartCard` 3-step, result → `/share/:id` + MCP URL. But **"sign up" doesn't exist** — the account surrogate is pasting a **64-char hex Ed25519 delegate key** + MemWal account ID via `SdkCredentialImportForm`/`Auth1` (`importDelegate` → `/api/memwal/import-delegate`; hosted stores in `localStorage`). README explicitly says "no wallet connect." Developer: strong text quickstart (README, CONTRIBUTING, `.env.example`, `contextmem doctor`), but full-toolset MCP is **clone-based** (point `bun` at a TS path); only the hosted **read** MCP is npx/mcp-remote friendly.

### Gaps
- **Signup wall (highest friction)** — becoming a user who can remember/recall requires pasting a raw Ed25519 seed from an external dashboard. No email/passkey/wallet, no managed-delegate.
- **Demo→account handoff unguided**; **share install snippet OMITS the read token** (`ShareMcpInstall`, `main.tsx:2028`) → silent 401 on private namespaces — a real trap.
- **No forkable templates / `examples/`**; **full-toolset MCP not npx-installable**; **no Nexus/Talus agent-call onboarding** (no manifests, no sample DAG, no "first Nexus call" doc); **no demo.gif**; **no in-app onboarding progress**; **`contextmem doctor` not surfaced as a verify gate**; **Harbor/SEAL/wallet onboarding entirely absent.**

### Plan

| Task | Priority | Effort | Notes |
|---|---|---|---|
| Kill the delegate-key signup wall for first write | P0 | L | Managed-delegate/one-click path so a first-timer can build AND remember without pasting an Ed25519 seed: (a) Worker mints/holds a per-account delegate behind email/passkey, or (b) "try with a managed namespace" deferring import. Keep `Auth1` import as the BYO-MemWal power path. Decide with team first. |
| Add the read token to the share install snippet | P0 | S | `ShareMcpInstall` must emit `--header Authorization: Bearer <read-token>` for private namespaces; reuse PublishPanel's snippet shape (`main.tsx:449-456`). One-line note: public needs no token. |
| Record demo.gif + visual first-touch | P0 | S | Capture 90s happy path → `docs/demo.gif` (≤6MB, 1280×720) → embed at README top. Shot list already in DEMO_SCRIPT.md. |
| One-command MCP install for the read (hosted) toolset | P0 | M | Canonical `npx mcp-remote <hosted-url>` + Smithery entry; wire `marketplace-listings.md` into in-app Publish/Namespaces copy + `hosted.ts` install page. |
| Forkable agent starter (`examples/`) | P1 | M | 2-3 runnable templates: Claude/Cursor config; a minimal TS/LangGraph agent doing extract→remember→recall against hosted MCP; combined Tatum + ContextMEM `mcpServers` JSON. |
| In-app guided onboarding checklist | P1 | M | Replace static `QuickStartCard`/`SettingsUsageGuide` with progress-tracked demo→connect→publish→install→first-recall; surface `contextmem doctor` as the verify step. |
| Publish `@contextmem/mcp` for the WRITE toolset | P1 | M | `npx @contextmem/mcp` instead of cloning + pointing bun at a TS path; document env (`MEMWAL_*`, `TATUM_API_KEY`, `CONTEXTMEM_RUNS_DIR`). Removes the biggest dev cliff. |
| Nexus/Talus "first agent call" onboarding | P1 | L | Dev doc + scaffold exposing the three capabilities as Talus Tools/Nexus nodes: tool manifests, a sample DAG that calls one tool + emits an on-chain receipt, MCP-tool→Nexus-node quickstart. Reuse existing MCP schemas as the contract. |
| Harbor/SEAL/wallet onboarding for PRIVATE namespaces | P2 | L | Separate "private namespace" wing (don't raise the floor for the zero-key public demo): Harbor `hbr_` + `suiprivkey1...`, Space/Bucket handshake, bind `seal_policy_id`, SessionKey/`seal_approve` decrypt. Gate on the Harbor-vs-Tatum decision. |
| Per-share OG cards + dev quickstart consolidation | P2 | S | Server-side OG injection for `/share/*`; merge README + CONTRIBUTING into one Dev Quickstart with `contextmem doctor` as the verify gate. |

### Harbor / on-chain notes
Onboarding has **no wallet step today by design**; "private" is a `ctxm_` Bearer token, no encryption. Harbor introduces two new key types (`hbr_`, `suiprivkey1...`) + a SessionKey/`seal_approve` flow + the Space>Bucket handshake — but Enoki sponsors the tx, so **users don't need to fund a wallet** (a genuine onboarding win). Keep this in a **dedicated private-namespace wing** separate from the zero-key public demo so casual users never see a wallet step; watch the ~3s `mirror_missing_grant` window and fast-expiring sponsor sig in the UX. The "first Nexus/agent call" onboarding is where on-chain attribution receipts get introduced to agent builders; existing MCP schemas are the natural contract.

### Open questions
- Account model: keep delegate-key import as primary signup, or move to email/passkey/wallet + managed server-side delegate? (Gates the whole P0 redesign.)
- Harbor vs Tatum: replace or coexist? (Determines whether the Harbor onboarding wing is near-term or deferred.)
- Publish `@contextmem/mcp` to npm, or keep write-MCP install clone-based?
- Nexus/Talus runtime: hosted ContextMEM Talus Tool endpoint, or a forkable self-host node template?
- For private namespaces, is SEAL client-side encryption needed near-term, or is the `ctxm_` token sufficient for target users?

---

## 6. Missing features / product completeness

### Current state
Feature-wide but thin on cross-cutting SaaS plumbing. **Auth**: two divergent models — local Fastify (`LocalAccountStore`, hashed `ctx_` sessions, AES-256-GCM delegate) vs hosted Worker (**no real signup/login**; identity = MemWal delegate header from `localStorage`; `owner_id` defaults to `'anonymous'`). No OAuth/email/wallet/org/RBAC/multi-tenancy. **Billing/metering: entirely absent** (no Stripe/Polar, authed users hardcoded `unlimited:true` ~`worker.ts:1503`; only the demo IP quota + local free limit). **Schedules/diff/webhooks: real and shipped** (cron, alerts, HMAC webhooks). **Observability: absent** (no usage/audit/recall trace, no `/api/usage|stats|admin`, no Sentry). **Talus/Nexus: zero code.** **Harbor/SEAL: zero** (Tatum-only; private = token-gated). **Marketplace**: copy ready, submissions all pending. **CI**: typecheck+test only. **Security**: has import redaction + token hashing + webhook HMAC; risks include delegate key in `localStorage` and `VITE_CONTEXTMEM_DEV_AUTH`.

### Gaps
- No first-class hosted account/identity, no org/RBAC, no `tenantId`; **delegate signing key in browser `localStorage`** (XSS-exposable).
- **Zero billing/metering**; **no usage/observability layer**; **rate-limiting only on demo IP** (public MCP reads + LLM chat/ai-query uncapped — cost/abuse vector).
- **Webhook delivery is fire-once** (`attempts=1`, no retry/backoff/DLQ/redelivery); **queue lacks idempotency/typed errors/DLQ**.
- **Talus Tools not packaged**; **no on-chain attribution receipts**; **Harbor+SEAL not integrated**.
- **Marketplace pending** (no `server.json`/`smithery.yaml`, repo not public, no demo.gif); **docs gaps** (no versioned API ref, no SECURITY.md/privacy/ToS, no Harbor/Talus design doc); **CI gaps** (no lint/coverage/dep-audit/CodeQL/e2e/migration test).

### Plan

| Task | Priority | Effort | Notes |
|---|---|---|---|
| Rate-limit + abuse-protect public MCP reads + LLM endpoints | P0 | M | Per-IP/per-token limits on token-less public reads, `/api/memwal/chat`, ai-query (CF Rate Limiting or D1 token-bucket). Open cost vector before going public. |
| Harden delegate-key handling + SECURITY.md + dev-auth lockdown | P0 | M | Move delegate out of plaintext `localStorage` (session-scoped/encrypted or server-held); make `VITE_CONTEXTMEM_DEV_AUTH` explicit-opt-in + banner; SECURITY.md + disclosure; add secret-scan/dep-audit to CI. |
| Add a usage/event ledger (metering + audit foundation) | P0 | M | `contextmem_usage_events` (owner, namespace, action extract\|recall\|remember\|mcp_read\|ai_query, units, ts); emit from Worker handlers + MCP tools. **One ledger underpins billing, observability, AND Nexus attribution — build it once.** |
| Package the three capabilities as Talus Tools (Nexus nodes) | P1 | L | Wrap `contextmem.extract/.recall/.remember` (core fns + MCP tools) as Nexus tool defs with typed I/O + manifest. Grant centerpiece. |
| Emit on-chain attribution receipts (Nexus provenance) | P1 | L | On each tool run, write a verifiable receipt (caller, tool, target, artifactDigest, walrusBlobId, ts). Depends on the usage ledger + Harbor/on-chain layer. |
| Webhook reliability: retry/backoff + DLQ + delivery UI | P1 | M | `attempts` hardcoded =1 (`worker.ts ~4010/4018`). Add exponential backoff (Queue/cron sweep), dead-letter status, GET deliveries + manual redelivery, surface health in UI. |
| Observability/usage dashboard | P1 | M | `/api/usage` over the ledger + authed dashboard (extractions, recall counts, storage bytes, schedule/webhook health, alert volume); error monitoring (Sentry/Logpush) + structured logging. |
| Real hosted accounts + org/multi-tenant scaffolding | P1 | L | Promote `contextmem_accounts` to canonical hosted identity; login/session distinct from the delegate; org/team + `tenantId`. Prereq for billing/team plans. |
| Launch-checklist closeout: repo public, demo.gif, MCP registry manifests | P1 | S | Record `docs/demo.gif`; flip repo public after secret audit; submit Smithery/Claude/Cursor; add `server.json` + `smithery.yaml` so listings are reproducible. |
| CI maturity: lint, coverage, e2e, migration + secret scan | P1 | M | Extend `bun-check.yml` with lint, coverage thresholds, dep audit/CodeQL, a D1 migration apply test, a smoke e2e against staging. |
| Public/versioned API + MCP tool reference docs | P2 | M | `/v1` versioning; OpenAPI/endpoint ref + MCP tool ref (23 local + 7 hosted); Harbor/Talus design doc. |
| Billing + SaaS tiers (Stripe/Polar) on the metering ledger | P2 | L | Plan/subscription tables, tier quotas (free/pro), metered overage, billing portal. Defer until first paying-user demand. |
| Idempotency + typed errors on the extraction queue | P2 | M | Idempotency keys + typed error envelope in `processExtractionJob`; map known failures (aggregator down, MemWal 401, LLM rate limit) to fixes. |
| Legal/compliance pages for public + billing | P2 | S | Privacy policy, ToS, data-retention/purge statement. Required before public launch + charging. |

### Harbor / on-chain notes
Two distinct on-chain workstreams answer "where is the smart contract": (1) **Harbor + SEAL** (storage + privacy) — replaces/augments Tatum, turns token-gated "private" into truly private (ciphertext + on-chain Seal policy + Bucket); deep design lives in §1, cross-cutting impact here = private namespaces + encrypted memory + on-chain access control. (2) **Talus/Nexus** (attribution) — greenfield; sequence on top of the **P0 usage/event ledger** (so each invocation is metered AND receipted) and the Harbor Bucket/Seal objects (so the receipt references a real on-chain object). **The usage ledger is the shared spine feeding billing, observability, AND on-chain attribution — build it first.**

### Open questions
- Grant timeline: are Talus Tools + receipts P0 (demo now) or P1 (post-application)? Flips the top of the sequence.
- Wedge vs SaaS: hold billing at P2 and ship metering/observability first (recommended), or want a paid tier sooner?
- Hosted identity: keep MemWal-delegate-as-identity (harden storage) or stand up real accounts (email/OAuth)? Wallet-connect stays excluded — confirm.
- Harbor adoption scope: replace Tatum, or Harbor only for private blobs?
- Is SEAL-encrypted private memory a near-term grant differentiator (pull to P1) or later?
- Ready to flip the repo public (unblocks marketplace, demo.gif, growth loop)?
- Webhook SLA: is fire-once OK for alpha, or is retry/DLQ required before promoting schedules as a paid feature?

---

## Phased timeline (mapped to Talus milestones)

Pulls the P0/P1 items into the grant's three milestones. **M1 = foundations + grant-demo critical path; M2 = the on-chain + Talus payload + product hardening; M3 = scale, polish, monetization.**

### M1 — 0-3 months (foundations + storage/on-chain seam + grant-demo prerequisites)
**Theme: make the seam, prove the runtime, ship the demo, stop the bleeding.**
- **Storage/Harbor seam (P0):** StorageProvider abstraction + widen `WalrusStorageReceipt`; `HarborClient` (reserve→sign→finalize + upload); `seal.ts` wrapper; namespace→Space/Bucket mapping; SUI service key in Worker secrets.
- **Critical spike (P0):** `@mysten/seal` Worker bundle/CPU test — decides where encryption runs (Worker vs queue vs Node).
- **On-chain decision (P0):** lock **Option C** (compose + minimal Move) and **Harbor-first, Tatum-coexist**; integrate Harbor for private-namespace storage (Bucket + Seal objects = the first on-chain layer, zero Move).
- **Extraction quality (P0):** token-aware chunking + overlap; Cloudflare Browser Rendering fallback; local hybrid retrieval (Vectorize + BM25) to replace opaque relayer recall.
- **Platform safety (P0):** rate-limit public MCP reads + LLM endpoints; harden delegate key + SECURITY.md + dev-auth lockdown; **usage/event ledger** (the shared spine).
- **Onboarding/UX unblocks (P0):** kill the delegate signup wall (managed delegate); wire the orphaned `NamespacesAppPage`; reduced-motion + WebGL fallback for the constellation; add the read token to the share snippet; record demo.gif; one-command hosted (read) MCP install.

### M2 — 3-6 months (the on-chain + Talus payload + product hardening)
**Theme: ship the grant centerpiece and harden for public.**
- **On-chain / Talus (P0-P1):** author Move `receipt` (AttributionReceipt) + `registry` (Namespace); wire receipt minting (Enoki-sponsored or relayer off a Queue); **publish the three Talus Tools** referencing receipts (`parents` lineage); emit on-chain attribution receipts on each run.
- **Harbor private memory (P1):** private namespaces via Seal policies (read-token → SEAL decrypt grant); provider selection + Tatum fallback; recall fetch+decrypt path; Worker-side R2 zip packaging (unlocks hosted→Walrus).
- **Extraction (P1):** robots.txt + per-host rate-limiting; PDF/doc coverage; structured (JSON-LD/microdata/tables) extraction; SimHash dedup + boilerplate stripping; converge the two pipelines on one clean→markdown core.
- **Product completeness (P1):** webhook retry/backoff + DLQ + delivery UI; observability dashboard (`/api/usage`); real hosted accounts + org/`tenantId`; CI maturity; launch-checklist closeout (repo public, marketplace manifests).
- **UX + onboarding (P1):** skeleton/empty/error system; split `main.tsx` + lazy routes; first-run onboarding checklist; `examples/` starter; publish `@contextmem/mcp` (write); Nexus "first agent call" onboarding.

### M3 — 6-12 months (scale, polish, monetization)
**Theme: durability, encryption UX, and revenue once traction exists.**
- **On-chain depth (P2):** optional `cap` WriterCap module; D1 ↔ chain reconciliation + network consolidation; storage epochs/cost/renewal model; full attribution-receipt surface.
- **Extraction (P2):** semantic/section-level freshness diff; Walrus Sites on-chain resource enumeration; pagination/infinite-scroll; language detection + content-quality scoring.
- **UX (P2):** design-system consolidation + dark mode; Build console hierarchy simplification; constellation + chat usability; Harbor/SEAL/wallet onboarding wing; provenance/explorer-link UI.
- **Business (P2):** versioned `/v1` API + MCP tool reference docs; billing + SaaS tiers on the metering ledger; queue idempotency + typed errors; legal/compliance pages.

---

## Decisions needed from the team

1. **Harbor vs Tatum scope.** Confirm **coexist** (Tatum=public/mainnet, Harbor=private/encrypted/testnet) vs full replacement. This gates almost every storage, privacy, and onboarding item. *(Recommended: coexist until Harbor mainnet.)*
2. **On-chain architecture (Option C).** Confirm we author **one minimal Move package** (`registry` + `receipt`) on top of Harbor's Bucket/Seal objects, rather than no-Move (receipts unverifiable) or all-Move (wasteful). *(Recommended: yes.)*
3. **Where encryption + upload run.** Worker vs queue consumer vs Node CLI/MCP — **blocked on the `@mysten/seal` Worker spike** (do this first in M1).
4. **Network for the launch surface.** Move ContextMEM storage to **testnet** for the grant demo, or run **dual-network** with provider chosen per namespace? Cross-network references between receipts and blobs must be avoided.
5. **Receipt signer + ownership.** Enoki-sponsored (recommended) vs backend relayer off a Queue vs user wallet — determines gas custody and whether the user "owns" the receipt. Also confirm the **Nexus receipt schema/ABI** before freezing the Move struct.
6. **Service-key custody.** One shared `HARBOR_SERVICE_PRIVATE_KEY` (simple, can decrypt everything) vs per-owner keys (true isolation, more plumbing). Sets the SEAL access-control granularity.
7. **Account model / signup wall.** Keep MemWal-delegate-as-identity (and just harden storage) vs stand up real accounts (email/passkey/OAuth) + a managed server-side delegate. Wallet-connect stays excluded — confirm. *(This is the single biggest onboarding-friction decision.)*
8. **Grant-demo priority of Talus Tools + receipts.** P0 (must demo for the application now) or P1 (post-application)? Flips the top of the M1/M2 sequence.
9. **Source of truth: D1 vs chain.** Does the on-chain Namespace object become authoritative (D1 mirrors it) or does D1 stay authoritative with the Move object as an attestation?
10. **Expose `NamespacesAppPage` now?** Confirm the `/api/hosted/*` endpoints are live so the already-built management console can be routed (P0 UX unlock).
11. **Repo public + billing posture.** Ready to flip the repo public (unblocks marketplace/demo.gif/growth)? And hold billing at P2 behind first paying-user demand (recommended) vs sooner?
12. **Pipeline + retrieval commitments.** Consolidate onto one Workers-compatible extraction pipeline (vs keep `core` for CLI)? Commit to Cloudflare Vectorize (vs keep delegating recall to MemWal)? Firecrawl permanent vs stopgap?
