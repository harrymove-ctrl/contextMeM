# Namespace Memory Constellation — design spec

**Status:** revised after review · **Date:** 2026-06-05
**Surface:** `apps/web` (Vite 7 + React 19 SPA) + a small `apps/api` change

A 3D, glowing, interactive graph of a **single namespace's memory**. Each node
is a `ContextChunk` — a remembered slice of text the agent reads — and the
edges are the document structure that produced them. Visually in the spirit of
the ark-hive hero ("the topic & similarity graph your agents build"), but every
dot is a real, clickable memory.

---

## 1. Goal & success criteria

Render one namespace's chunks as a force-directed 3D graph with the neon,
bloom-lit ark-hive aesthetic, where:

- nodes = `ContextChunk` memory nodes (size = `byteLength`, colour = page),
- edges = document structure (section hierarchy + page spine),
- hover highlights a node and its neighbours, click opens a panel with the
  chunk's heading path + full text, search flies the camera to a chunk.

**Done when:**

1. Given a namespace, the view fetches its `chunks.ndjson` and renders the
   memory graph (and renders from bundled mock chunks with the API offline).
2. The graph is **one connected component** (no floating per-page islands).
3. Hover dims the rest and highlights the node + its structural neighbours.
4. Click opens a panel: heading-path breadcrumb, page route, full chunk text,
   and a link to the source URL.
5. Search focuses/zooms the camera onto the matched chunk.
6. Bloom emphasises the nodes; overlay UI and DOM hover-labels stay crisp.
   (Selective nodes-only bloom is the target; whole-scene bloom with thin/dim
   edges is an accepted fallback — see §9.)
7. `prefers-reduced-motion` disables auto-rotation and camera fly animations.
8. `bun run --filter @contextmem/web typecheck` is clean; the
   `derive-memory-graph` unit test passes; `vite build` succeeds.

---

## 2. Research findings

### 2.1 Where the ark-hive chart comes from

Inspected `https://ark-hive-network.vercel.app/` live (Chrome DevTools):

- Hero canvas reports `data-engine="three.js r184"`, context **WebGL2**.
- No `window.VANTA`, no `window.THREE`, no react-three-fiber (`__r3f` absent).
- It is **hand-rolled three.js** (Next.js + Tailwind): points on a sphere,
  near-neighbours joined by line segments, additive-blended glowing dots, slow
  auto-rotation. **Decorative** — the dots carry no data.

No off-the-shelf widget to copy; the look is reproducible with any three.js
graph renderer plus a bloom pass.

### 2.2 Best-practice landscape (2026) for "nodes = data"

| Option | Engine | Fit |
| --- | --- | --- |
| **react-force-graph-3d** (vasturiano) | three.js + d3-force-3d | ★ 3D glow + built-in hover/click/drag/zoom + custom node objects + an official bloom example; npm active (Apr 2026); MIT |
| Sigma.js v3 + graphology | WebGL 2D | Best label readability + scales to thousands; loses the 3D wow |
| Reagraph (reaviz) | WebGL React | 2D+3D, React-first; smaller ecosystem |
| Cosmograph / cosmos.gl | GPU WebGL | 100k+ nodes; **CC BY-NC** licence; overkill |

### 2.3 Decision

**react-force-graph-3d.** Reproduces the ark-hive aesthetic *and* gives real
graph semantics + interaction with minimal custom code, on the best-practice
2026 React library. The interaction API is verified against the docs:
`nodeThreeObject`, `nodeVal`, `nodeColor`, `linkColor/linkWidth/linkOpacity`,
`onNodeHover`, `onNodeClick`, and the imperative ref methods `cameraPosition`,
`zoomToFit`, `d3Force`, and `postProcessingComposer()` for bloom.

**Tradeoff acknowledged:** 3D is less label-readable than 2D (Sigma.js). We
choose 3D because the brief anchors on the ark-hive look and a single
namespace's chunk count keeps hover-labels + search usable. If
readability-at-scale dominates later, Sigma.js is the swap — but we do **not**
build a swappable-engine abstraction now (YAGNI); the `{ nodes, links }` shape
is the only seam needed.

---

## 3. The memory-node model (the resolved fork)

The graph visualises **one namespace** and each node is a **`ContextChunk`** —
the chunk is literally the unit ContextMeM writes to MemWal
(`MemoryWritePlan` / `RememberDeltaInput.chunks` in `packages/core` +
`packages/memwal`), so "node = a remembered slice of text" is the truest
reading of "memory node."

```ts
type ContextChunk = {
  chunkId: string; routePath: string; url?: string;
  heading?: string; headingPath: string[];   // document hierarchy
  text: string; contentHash: string; byteLength: number; order: number;
};
```

### 3.1 Reachability constraint → a required backend change

Chunk-level memory is **not** browser-reachable for a hosted/directory
namespace today:

- `chunks.ndjson` is written to disk by the packager (`packages/core/package.ts`)
  but is **never uploaded** with hosted namespaces — the hosted upload file
  lists (`apps/api/src/worker.ts` ≈ lines 2090–2097 and 2423–2430) write
  `site-structure.json`, `toc.json`, `manifest.json`, `sources.json`,
  `code-blocks.json`, … and `grep chunks.ndjson worker.ts` returns nothing.
- The only runtime memory access is the `recall_memory` MCP tool
  (`packages/mcp/src/hosted.ts`), which is **query-only** and **requires MemWal
  credentials** on the request — it cannot enumerate all chunks into a graph.

So this feature includes a **small `apps/api` change** (chosen by the user over
the frontend-only "site-structure nodes" alternative). See §8.

### 3.2 Edges are structural, not semantic (v1)

Edges come from `headingPath` + `order` (document structure), not embeddings.
Semantic/MemWal-similarity edges are explicitly **v2** (§12). This matches the
user's instruction that the node definition changed but "the graph UI is the
same."

---

## 4. Read/write model (data characteristics)

- **Writer:** the packager produces chunks at build time — controlled,
  infrequent. After §8, hosted namespaces also carry `chunks.ndjson`.
- **Reader:** the web client fetches one namespace's `chunks.ndjson` **once on
  mount**, parses and renders client-side; hover/click/zoom are pure client.
  One round-trip, then instant.
- **Payload caveat:** `chunks.ndjson` carries the **full text of every chunk**,
  but the graph only needs `id/routePath/headingPath/byteLength/order` + a short
  label; full `text` is consumed only by the click panel. Worst case ≈ 2k chunks
  × up to `MAX_CHUNK_CHARS` (4000) ≈ ~8–10 MB raw, ~2–3 MB gzipped, downloaded
  just to draw dots. v1 accepts this single download **but must** (a) confirm the
  artifact route is served gzip/brotli-compressed and (b) gate the collapse
  threshold by **transferred bytes, not node count** (see scale bullet + §13).
  Escalation if real namespaces exceed the byte budget: the packager emits a
  structure-only artifact at build time (chunks minus `text`, or a pre-derived
  `{nodes, links}`) and the panel lazy-fetches full text on first click — the
  write-time-maintained, smallest-read option. Deferred until measured (YAGNI).
- **Edges:** derived client-side from the chunks in a single O(n) structural
  pass. No server aggregation; no precompute.
- **Scale:** chunks-per-namespace, not namespace count. With
  `MAX_CHUNK_CHARS = 4000` × crawled pages, expect tens to ~1–2k nodes. Labels
  are hover-only by default; if a namespace exceeds a **transferred-byte budget**
  (measure first; ~2–3 MB gzipped is the rough ceiling, ≈1500 nodes) the legend
  offers collapse-by-page (deferred unless real data needs it).

---

## 5. Architecture & file layout

Files follow the in-repo conventions: **relative imports with explicit `.js`
extensions** (e.g. `./components/namespace-memory/MemoryChunkPanel.js`) — the
repo has **no `@/*` path aliases** (verified: none in `apps/web/tsconfig.json`,
`vite.config.ts`, or `vitest.config.ts`); no shadcn; `--cm-*` CSS tokens +
`lucide-react` + `motion`. Note `components/namespace-memory/` **already exists**
in the tree — confirm whether work has begun there before scaffolding.

```
apps/web/src/
  components/namespace-memory/
    NamespaceMemoryConstellation.tsx  # wraps ForceGraph3D + bloom + interaction state
    MemoryChunkPanel.tsx              # motion side panel: heading-path, route, full text, URL
    MemorySearchBox.tsx               # input + result list; selecting flies the camera
    MemoryLegend.tsx                  # page colour legend + node/edge counts
    memory-node-objects.ts            # three.js glowing-sprite factory + cached radial glow texture
    memory-bloom.ts                   # selective UnrealBloom (nodes-only, via three.js layers)
    memory-theme.ts                   # routePath→colour (stable hash) + size scale
    namespace-memory.css              # scoped .nmc-* classes on --cm-* + a dark graph surface
  hooks/
    use-namespace-chunks.ts           # fetch chunks.ndjson; parse; loading/empty/error; mock fallback
  lib/
    memory-graph-types.ts             # ContextChunk, MemoryNode, MemoryLink, MemoryGraph
    parse-chunks-ndjson.ts            # tolerant NDJSON → ContextChunk[]
    derive-memory-graph.ts            # ContextChunk[] → { nodes, links } (structural, connected tree)
    derive-memory-graph.test.ts       # vitest: tree invariant + hierarchy correctness
  data/
    mock-chunks.ts                    # ~50 realistic chunks across a few pages → runs with no backend
```

The pure functions (`parse-chunks-ndjson`, `derive-memory-graph`) have no
React/three dependency and are unit-tested; the React components depend only on
the typed graph shape; the three.js helpers are framework-agnostic.

---

## 6. Data flow & types

```
use-namespace-chunks ──text──▶ parse-chunks-ndjson ──ContextChunk[]──▶ derive-memory-graph
                                                                            │
                                                                  { nodes, links } ──▶ <NamespaceMemoryConstellation>
```

```ts
type MemoryLinkKind = "hierarchy" | "page" | "spine";

interface MemoryNode {           // index signature omitted here for brevity
  id: string;                    // = chunkId
  label: string;                 // heading ?? first line of text
  routePath: string;             // page — colour + clustering key
  headingPath: string[];
  url?: string;
  textPreview: string;
  byteLength: number;
  order: number;
  val: number;                   // force-graph node size = sizeScale(byteLength)
}
interface MemoryLink { source: string; target: string; kind: MemoryLinkKind; }
interface MemoryGraph { nodes: MemoryNode[]; links: MemoryLink[]; }
```

---

## 7. Edge derivation (`derive-memory-graph`) — connectivity is the point

Pure function, deterministic:

1. Sort chunks by `order`; build nodes.
2. Group chunks by `routePath` (page). Within a page, for each non-first chunk:
   link to its **section parent** = nearest earlier chunk whose `headingPath` is
   a *proper prefix* (`kind: "hierarchy"`); if none, link to the page's first
   chunk (`kind: "page"`).
3. **Page spine:** sort pages by their first chunk's `order`; link each page's
   first chunk to the previous page's first chunk (`kind: "spine"`).

**Invariant:** this produces exactly `nodes.length - 1` links forming **one
connected, acyclic tree** (every parent has strictly lower `order`, so chains
terminate at the global entry chunk). That is why the layout settles into a
single cohesive globe rather than disjoint per-page islands — the advisor's
connectivity concern. The unit test asserts: `links.length === nodes.length-1`,
a single connected component (union-find), no self-loops, and a known
hierarchy parent (a `['A','B']` chunk links to an earlier `['A']` chunk).

---

## 8. Backend change (`apps/api/src/worker.ts`)

Two minimal, pattern-matching edits so the browser can fetch a namespace's
chunks:

1. **Upload `chunks.ndjson` with hosted namespaces.** In the hosted upload
   `files[]` builders — `buildCombinedNamespaceBundle` (≈ line 2092) and
   `extractTargetContext` (≈ line 2423), wherever `pages` are in scope (verified:
   neither writes `chunks.ndjson` today; `grep chunks.ndjson worker.ts` is
   empty) — add:
   ```ts
   { path: "/context/chunks.ndjson",
     contentType: "application/x-ndjson; charset=utf-8",
     encoding: "utf8",
     content: renderChunksNdjson(buildChunks(pages)) }
   ```
   importing `buildChunks, renderChunksNdjson` from `@contextmem/core/chunks`.
   Existing namespaces gain chunks on their next publish/re-scrape (documented
   limitation — the UI shows an empty/"re-publish to enable" state otherwise).

2. **Public artifact-file read route.** Before the generic
   `GET /api/namespaces/:ns` handler (≈ line 679), add a branch for
   `…/artifact-file?path=…`. Follow the **`GET /api/namespaces/:ns` handler's own
   auth pattern** — `store.authorizeNamespace(namespace, readAccessToken(request))`
   (public namespaces pass without a token, worker.ts:490) — **not**
   `getHostedRunArtifactFile`'s `requireRunReadAccess` (that gate is run-level,
   not namespace-level). Then `store.readArtifact(namespace, path)`, returning
   the content with `cors(...)`. `readArtifact` already calls
   `normalizeHostedArtifactPath` and resolves via an **exact-match DB lookup**
   scoped to `(namespace, version_id)` (worker.ts:436), so `..` traversal cannot
   escape the namespace — but see the disclosure note in §12.5. Frontend:
   `fetch(\`${API_BASE}/api/namespaces/${encodeURIComponent(ns)}/artifact-file?path=context/chunks.ndjson\`)`.

> Both edits are additive and mirror existing handlers; no existing route or
> upload field changes.

---

## 9. Rendering & visual design

- **Surface:** dark graph panel — define a **new** `--cm-graph-bg: #0f1115`
  token (the value `#0f1115` is currently only hardcoded in `styles.css`, not a
  token) even though the app is light — bloom needs a dark backdrop, and a dark
  constellation inside the light page is a deliberate contrast. Scoped to the
  component.
- **Nodes:** `THREE.Sprite` with a cached radial-gradient glow texture (one
  shared texture, tinted per node), size = `sizeScale(byteLength)`.
- **Colour by `routePath`:** a stable string-hash → hue, so each page is a
  distinct colour family and pages read as sub-constellations. Accent anchored
  to `--cm-accent (#a8d946)`.
- **Edges:** thin, low-opacity lines; `spine` links slightly brighter than
  `hierarchy`/`page` so the page backbone is legible.
- **Bloom** (`memory-bloom.ts`): **target** = selective nodes-only bloom — node
  sprites on `BLOOM_LAYER`; a second `EffectComposer` renders only that layer
  through `UnrealBloomPass`, composited over the base render via
  `fgRef.current.postProcessingComposer()`. **Reality check:** the official
  react-force-graph bloom example does **whole-scene** bloom (one
  `postProcessingComposer().addPass(UnrealBloomPass)` — verified via Context7),
  *not* the selective two-composer technique — so selective bloom is a genuine
  three.js spike, not a copy-paste (see §12.2). **Accepted fallback:** hover
  labels are DOM tooltips (never in-canvas) and the panel is React DOM, so the
  only in-canvas non-node geometry is edges; keeping edges thin/dim makes plain
  whole-scene bloom visually adequate. Spike whole-scene first; build
  layer-selective bloom only if edges wash out.

---

## 10. Interaction & UX

- **Hover:** highlight the node + its structural neighbours + connecting links;
  dim the rest. Show the node label near the cursor.
- **Click:** select → open `MemoryChunkPanel` (right). Camera eases to frame the
  node.
- **Panel contents:** heading-path breadcrumb (`Home › Guide › Auth`), page
  route, full chunk text (scrollable, markdown-rendered via the existing
  `react-markdown`), source-URL link, byte size.
- **Search (`MemorySearchBox`):** filter by heading/text/route; selecting a
  result flies the camera to that chunk and selects it.
- **Idle auto-rotation:** slow orbit when not interacting; stops on drag/hover;
  disabled under `prefers-reduced-motion` (jump-cut camera instead of fly).
- **Empty / loading / error:** reuse the `.panel` patterns from `ShowcasePage`;
  empty state explains "this namespace has no chunks yet — re-publish to enable
  the memory map."

---

## 11. Integration into contextMeM

- **Dependencies to add (to `apps/web/package.json`):** `react-force-graph-3d`
  and `three` (+ `@types/three` dev). `react`, `motion`, `lucide-react`,
  `react-markdown` are already present.
- **Home / entry point:** a full-screen route **`/showcase/:namespace`** with a
  "Visualize memory" action on each `ShowcasePage` card. The page reads
  `:namespace`, runs `use-namespace-chunks`, and renders the constellation.
  (Verified: React Router v7 is already wired in `main.tsx` with parameterized
  routes like `/share/:shareId`; `/showcase` exists today as a non-parameterized
  route — add the `:namespace` variant alongside it.)
- **Env / `API_BASE`:** the `API_BASE` constant exists (`main.tsx:512`,
  `import.meta.env.VITE_CONTEXTMEM_API_BASE ?? "http://localhost:8791"`) but is
  **module-local, not exported** — `export` it (or lift it to a shared relative
  `lib/api-base.ts`) so the new feature reuses it instead of duplicating the
  fallback.
- **Conventions (Rule 7/11):** the repo has **no shadcn primitives**
  (`components/ui/` does not exist); `main.tsx` is hand-built on `--cm-*` tokens
  + `lucide-react` + `motion`. Match that — do not introduce shadcn or Tailwind
  utilities.

---

## 12. Risks & open questions

1. **React 19 compatibility of react-force-graph-3d — LOW (downgraded).**
   v1.29.1 declares `peerDependencies: { "react": "*" }` (verified on npm), so
   there is **no install-time React 19 conflict**; the wrapper is thin
   (`react-kapsule` + legacy `prop-types`). *Consider making the fallback the
   primary:* since selective bloom (§9) already requires reaching into
   `scene()/renderer()` imperatively, driving the vanilla `3d-force-graph`
   package in a `useEffect` buys robustness for little extra code and sidesteps
   the wrapper entirely. Decide at the bloom spike.
2. **Bloom recipe — TOP technical risk.** The official react-force-graph bloom
   example does whole-scene bloom, **not** the selective nodes-only technique
   success-criterion #6 wants — so layer-selective bloom via
   `postProcessingComposer()` is an unproven three.js spike, not a copy. Spike
   whole-scene first against mock data; accept it (thin/dim edges + DOM labels)
   if selective proves fiddly (§9).
3. **Chunk availability.** Namespaces published before §8.1 have no
   `chunks.ndjson` until re-published; the empty state must say so. (A local CLI
   package already has `chunks.ndjson` and works immediately.)
4. **Scale.** A large crawl can reach ~1–2k chunk nodes; if real data exceeds
   the readable threshold, add collapse-by-page (a legend toggle), kept out of
   v1 until measured.
5. **Public artifact-file route widens the public read surface.** The new route
   serves **any** artifact path of a *public* namespace tokenless. Traversal is
   contained (exact-match DB lookup, §8), so this is a disclosure question, not
   an escape: confirm no namespace artifact is sensitive (the existing bundle —
   `manifest.json`, `sources.json`, … — is already public, so chunks fit that
   tier) and keep the `authorizeNamespace` gate so private namespaces still
   require a token. State this invariant in the handler.
6. **Mount payload.** Full-text `chunks.ndjson` can be multi-MB (§4); v1 must
   confirm compression and gate by transferred bytes. The structure-only
   artifact is the escalation if measured payloads exceed budget.

---

## 13. Out of scope (YAGNI)

- Semantic / MemWal-recall similarity edges (v2 — needs embeddings + an
  enumerable recall path).
- Cross-page link edges from `PageArtifact.links` / `site-structure.json`
  (structural hierarchy + spine already gives cohesion).
- Editing chunks from the graph (read-only view).
- A swappable 2D/3D engine abstraction.
- Directional link particles / animated "traffic" (future hook only).
- Build-time structure-only graph artifact + lazy full-text-on-click (the
  smaller-payload escalation — deferred until measured payloads demand it, §4).

---

## 14. Review revisions (2026-06-05)

Applied after an evidence-based review (every claim verified against the code):

- **§1 / §9 / §12.2 — bloom re-scoped.** The cited "official example" does
  whole-scene bloom, not selective; selective nodes-only bloom is now flagged as
  the top spike, with whole-scene + DOM-labels + dim-edges as the accepted
  fallback.
- **§4 — payload modelled.** Quantified the full-text mount download (~2–3 MB
  gzipped worst case); threshold is now byte-based; structure-only build-time
  artifact documented as the escalation (§13).
- **§5 — alias claim corrected.** Repo has **no `@/*` aliases** — switched to
  relative `.js` imports. Noted `components/namespace-memory/` already exists.
- **§8 — backend plan tightened.** Use the `/api/namespaces/:ns` handler's
  `authorizeNamespace` pattern (not `getHostedRunArtifactFile`'s run-level gate);
  traversal contained by exact-match lookup; builders named precisely.
- **§11 — API_BASE / router verified.** `API_BASE` must be exported (currently
  module-local); React Router v7 + parameterized routes confirmed present.
- **§12.1 — React 19 risk downgraded to LOW** (`peerDependencies: react:"*"`);
  vanilla `3d-force-graph` offered as the possible primary, not just fallback.
- **§12.5 — new risk:** public artifact-file route widens the public read
  surface (disclosure, not traversal).

Verified accurate and unchanged: the `ContextChunk` shape, `@contextmem/core/chunks`
exports, `MAX_CHUNK_CHARS = 4000`, the §7 connectivity invariant, and the
read-once-derive-client-side access pattern.
