# Real-traction test: 3 live Walrus sites end-to-end

Date: 2026-05-27 · Worker: `1ab254ef` · Pages: `index-C-QXnUPN.js`

## Methodology

- Triggered fresh demo extractions against 3 live `.wal.app` Walrus sites on production worker
- Pulled `/context/manifest.json` from each + share-page render
- Drove Chrome against the deployed share pages to verify UI render
- Live-probed MCP endpoint (`/mcp?namespace=...`) with JSON-RPC `tools/list`
- Live-probed AI Query endpoint (`POST /api/runs/:id/ai-query`)

3 test targets cover the failure surface:
- `seal-docs.wal.app` — Docusaurus + custom brand font (ABCNormal)
- `docs.wal.app` — Docusaurus 3.9.2 official Walrus docs (high signal)
- `flatland.wal.app` — non-Docusaurus dapp (framework=null path)

## Headline numbers

| Site | Framework | Defaults filtered | Pages | Markdown chars | Brand colors | Brand fonts | DS cssVars | brand.conf | ds.conf |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| seal-docs.wal.app | docusaurus | 51 | 14 | 146,600 | 16 | 1 (ABCNormal) | 28 | 0.80 | 0.88 |
| docs.wal.app | docusaurus | 46 | 16 | 130,581 | 16 | 4 (DM Sans, JetBrains Mono, Inter, Tahoma) | 188 | 1.00 | 1.00 |
| flatland.wal.app | null | 0 | 1 | 8 | 16 | 12 | 49 | 0.70 | 1.00 |

## What each persona actually gets

### AI agent (MCP client — Claude Desktop, Cursor, Codex)

Connects to `https://contextmem-hosted-namespace-mcp.petlofi.workers.dev/mcp?namespace=demo:impact-v2`. Tools/list returns **10 tools**:
- `context_info` / `contextmem_namespace_info` — namespace metadata
- `list_context` / `contextmem_list_artifacts` — file listing (llms.txt, manifest, page-N.md, brand.json, design-system.json, …)
- `read_context` / `contextmem_read_artifact` — read one artifact by path
- `search_context` / `contextmem_search_context` — search across pages, returns source-grounded snippets
- `get_context_bundle` / `contextmem_get_context_bundle` — bundle metadata + top hits + excerpts in one call

**Live AI Query probe** (Workers AI llama-3.1-8b against docs.wal.app, question: "What problem does Walrus solve and what is its erasure coding overhead?"):

> Walrus solves the problem of high-stakes systems requiring provable, programmable, always-available data with no performance tradeoffs. Its erasure coding overhead is approximately 5x the size of stored data.

Both facts correct. **8 source citations returned** (`/`, `/llms.txt`, `/docs/getting-started`, etc.) so the agent can cite + re-fetch.

The 4 minor MCP install JSONs (Claude Desktop, Cursor) are already on the share page tab — copy-paste install, no boilerplate.

### Designer cloning brand

For `docs.wal.app` the Brand tab now shows (verified in screenshot `share-walrus-brand.png`):
- Name: Walrus · Confidence: 90%
- 16 brand colors. Top 4: `#613dff` (Walrus purple primary), `#98efdd` (Walrus mint secondary), `#cab1ff` (light purple accent), `#e8ff75` (yellow accent)
- 4 fonts: **DM Sans, JetBrains Mono, Inter, Tahoma** — actual font stack
- 2 logo assets: favicon + og-image (`walrus-card.jpg`)

Pre-Tier-1 this panel had 14 Docusaurus neutrals + `var(--ifm-font-family-base)` strings. Useless. Now it's the actual Walrus brand kit — directly portable to Figma / Tailwind / CSS vars via the Exports section.

For `flatland.wal.app` (non-Docusaurus dapp): `#0090ff` Sui blue + `#ffe629` yellow + `#e54d2e` Radix orange — a vibrant game palette. Framework detection correctly returned null → no defaults filtered → full raw palette surfaced.

### Developer integrating

Site structure tab gives a tree:
- For docs.wal.app: 16 pages × 2 groups (Pages + Resources). Browseable navigation.
- llms.txt is generated server-side and exposed at `/llms.txt` in the namespace — the agent-context-standard artifact, ready to feed any LLM.
- 11 Walrus resources tracked: SVG logos, stylesheets, JS bundles, og-image — useful for figuring out what the site depends on (kapa-widget, google-tag, clarity analytics, etc).

Socials extracted: `github.com/MystenLabs/walrus`, `discord.gg/walrusprotocol`, `x.com/walrusprotocol` — the actual support channels.

## What works end-to-end (verified live)

1. Build extraction (`POST /api/demo/extractions`) — 5-15 sec for 14-16 page Docusaurus site
2. Job polling (`GET /api/demo/extractions/:id`) — status transitions queued → running → completed
3. Public auto-share (share row created automatically on demo extraction completion)
4. Share page render (`/share/:shareId`) — all tabs present, all data populated where extractor produced it
5. MCP endpoint live JSON-RPC — initialize + tools/list working, returns the contextmem toolset
6. AI Query endpoint — Workers AI llama answered docs.wal.app questions accurately with source citations
7. Artifact file fetch (`/api/runs/:id/artifact-file?path=...`) — public for demo runs (was blocked before)

## What's still broken (observed during test)

1. **Share title still leaks "Public ContextMeM demo extraction"** — even though we fixed the manifest description, the share row stores its own description set at share-creation time. Fix: change `createDemoExtraction` to skip the placeholder description so the share inherits nothing instead of garbage.
2. **`walrus.site.siteObjectId === "unknown"`** for all 3 sites — `extractWalrusHeaders` only reads response headers, but the .wal.app gateway doesn't always set `x-walrus-site-object-id`. Real fix needs SuiNS lookup or HTML meta parsing.
3. **All Walrus resources marked `unverified`** — we record the URL but not the actual blob ID. This is Tier 3 work (Walrus blob-ID verification = the moat).
4. **Share-page Design System renderer is simpler than /app DesignSystemPanel** — no framework badge, no Layout Primitives section. Tier 1 honesty improvements only land on the authenticated `/app` view, not the public share. Should propagate.
5. **AI Query parser drops confidence to 0.5** when the model wraps its JSON in markdown code-fence (` ```json `). Llama-3.1-8b does this often. Easy regex fix.
6. **`flatland.wal.app` only extracted 1 page with 8 chars** — SPA serves empty `<div id="root"></div>` shell. Static-fetch extractor sees nothing. Render-then-sample (headless) is the fix.

## Impact summary

| Capability | Before this work | After |
|---|---|---|
| Markdown context for agents | 14 pages but stacked, hard to navigate | Docs-style sidebar + body, 130-146 KB ready for ingestion |
| Brand colors | Docusaurus neutrals (`#fbffea`, `#e0e2e6`, white, black) | Real brand purples / blues + filtered fingerprint |
| Brand fonts | `var(--ifm-font-family-base)`, system fallbacks | Resolved values: ABCNormal, DM Sans, JetBrains Mono, Inter |
| Design System confidence | Always 100% (lie) | 88-100% gradient based on actual signal count |
| Design System cssVars | Garbage (`"--primary": "active{..."`) | Real `:root` custom properties (28-188 per site) |
| MCP endpoint | Existed but broken on AI Query | 10 tools live, AI Query answers with citations |
| Demo run access from `/api/runs/:id/*` | 404 "Hosted run not found" for all read endpoints | Public read for demo:* runs; share/<id> + artifact-file/?path= work without auth |
| Runs page after demo build | "No run history yet" | Demo runs from same IP now show up next to hosted runs |
| Pages frontend build | Bundled `localhost:8791` API_BASE → "Failed to fetch" | Bundled production worker URL via `VITE_CONTEXTMEM_API_BASE` |
| Images tab on Docusaurus site | 0 images (preload-as-image lost to dedupe) | logo.svg + favicon classified correctly as image |

## Screenshots (live, on contextmem.pages.dev)

- `screenshots/share-walrus-brand.png` — Brand tab for docs.wal.app showing the real Walrus palette + DM Sans/Inter/etc.
- `screenshots/share-walrus-designsystem.png` — Design System tab with 8 named tokens + 4 brand fonts
- `screenshots/share-walrus-resources.png` — 11 Walrus resources cataloged
- `screenshots/share-walrus-mcp-install.png` — MCP install snippets ready for Claude Desktop and Cursor

## Open questions

- Should the share-page Design System renderer get the same framework-badge + honest-confidence treatment as the /app view? Currently divergent.
- Tier 2 llms.txt + per-page outline + code-block index: which one delivers the most agent value for the next ship? llms.txt has the most ecosystem adoption (Mintlify, Fern, Nuxt UI) so probably first.
- Render-then-sample (browser) for SPAs (`flatland.wal.app` case) — Workers can call browser-rendering binding, but adds cost and time. Worth the budget if SPAs are >30% of Walrus sites?
- The "unverified" Walrus blob IDs are the actual differentiation. Tier 3 work (compute blob IDs from URLs via the Walrus aggregator API) — how reliable is the lookup, what's the latency?
