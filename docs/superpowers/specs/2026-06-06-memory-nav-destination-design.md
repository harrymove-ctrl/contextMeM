# Memory nav destination — design spec

**Status:** revised draft (post-review) · **Date:** 2026-06-06
**Surface:** `apps/web` only (`apps/web/src/main.tsx` + the `components/namespace-memory/` files). No backend change.

Move the namespace memory constellation from a buried full-screen route (`/showcase/:namespace`, reached via a card link) to a **first-class sidebar destination** — a **new "Visualizers" item** at `/app/visualizers` — rendered **in-shell**, with an **inline-or-picker** flow.

> **Revision note.** The original draft assumed `/app/memory` was an empty placeholder to fill. It is not: `/app/memory` already hosts the **MemWal recall/remember** tools (`MemoryAppPage` → `MemWalPanel`, `main.tsx:1278–1285` / `2780`). Per product decision, the constellation gets its **own new route + sidebar item** (`/app/visualizers`, "Visualizers"); the existing **"Memory"** item and its MemWal page are **left untouched**. The canvas-embedding section (§4.4) is also corrected — `react-force-graph-3d` defaults to window dimensions and has no internal resize handling, so embedding requires a real component change, not host-CSS alone.

---

## 1. Goal & success criteria

Selecting **"Visualizers"** in the app sidebar opens the memory constellation inside the app shell (sidebar stays), choosing a namespace via an inline picker when none is active.

**Done when:**

1. A **new** sidebar **"Visualizers"** item (`/app/visualizers`, an already-imported icon — e.g. `Sparkles`) opens a real in-shell page, with the sidebar still visible — the same chrome as "Namespaces". It is a **sibling** of the existing items, added to `appNavItems`.
2. The existing **"Memory"** item (`/app/memory` → MemWal recall/remember) is **unchanged** — same route, component, title, behavior.
3. With no namespace selected, the page shows a **namespace picker** (the list the showcase already fetches). Selecting one renders that namespace's constellation inline.
4. The selected namespace **persists across reloads** (localStorage); a **"Change namespace"** control returns to the picker.
5. The constellation renders **embedded** in the content area — the WebGL canvas is **sized to the content region and tracks window resize** (not `position: fixed` to the viewport, and not the library's default window-sized canvas) — and hover/click/search/bloom still work.
6. Loading / empty / error states render inside the shell (carried over from today's full-screen page).
7. The old full-screen entry is **removed**: no `/showcase/:namespace` route, no `NamespaceMemoryPage`, no "Visualize memory" card link. (`MemoryAppPage`/`MemWalPanel` are **not** touched.)
8. `bun run --filter @contextmem/web typecheck` is clean, `vite build` succeeds, and the existing `vitest` suite stays green (the pure `derive`/`parse`/`theme` tests are untouched).

---

## 2. Current state (verified anchors)

- **Sidebar items:** `appNavItems` (`main.tsx:1326–1335`) is the array to extend; its items render as `NavLink`s in the app sidebar (~`main.tsx:1956–1963`). The icon import block is at `main.tsx:6` — **`Sparkles` is imported and unused as a nav icon** (a fit for a star-map). `Network` is **not** imported (it appears only as a string elsewhere).
- **Shell wrapper:** `renderShell(pageTitle, pageDescription, child)` (`main.tsx:1204`) wraps a child in the sidebar layout; content area is `.appContent` (`main.tsx:1995`), inside `.appMain` (1977) / `.appShell` (1943).
- **`/app/memory` is NOT a placeholder.** The route (`main.tsx:1278–1285`) renders `renderShell("MemWal memory", "Recall and remember verified context namespaces from the active package.", <MemoryAppPage …/>)`; `MemoryAppPage` (`main.tsx:2780`) hosts `MemWalPanel` (`main.tsx:5588`) — a **live** feature. The `{ to: "/app/memory", label: "Memory", icon: Brain }` sidebar item (line 1330) points here. (`MemWalPanel` is also reachable via the build-console "MemWal Memory" tab, `main.tsx:3126`.) **All of this is left untouched.**
- **Namespace listing:** `ShowcasePage` (`main.tsx:1768`) fetches the namespace list from `${API_BASE}/api/directory` (`main.tsx:1778`) into `items` via `setItems(body.namespaces ?? [])` (line 1781); `ShowcaseItem` has `.namespace`, `.displayName`, `.description`, `.target`, `.tags`, etc. This fetch is the reusable source for the picker (extract it; no new endpoint).
- **To remove:** `/showcase/:namespace` route (`main.tsx:1260`), `NamespaceMemoryPage` (`main.tsx:1860`), and the "Visualize memory" card link (`main.tsx:1849`).
- **Constellation host:** `.nmc-root { position: fixed; inset: 0 }` in `components/namespace-memory/namespace-memory.css` — full-viewport today. `NamespaceMemoryConstellation.tsx:91` renders `<ForceGraph3D>` with **no `width`/`height` props** (see §4.4 for why that matters when embedded).
- **Active namespace hint (optional seed):** the build console has the current run's namespace at `run?.manifest.namespace` (`main.tsx:623`).

---

## 3. Read/write model (unchanged)

- **Reader (graph):** one client fetch of the selected namespace's `chunks.ndjson` per selection (the existing `useNamespaceChunks` hook), parsed + derived client-side. One round-trip, then instant — same as today.
- **Reader (picker):** the namespaces list, already fetched by `ShowcasePage` from its listing endpoint. No new aggregation, no new endpoint.
- **Writer:** none. No backend or data change. The packager still produces `chunks.ndjson`; the artifact-file route still serves it.

The change is purely **where the existing reads are triggered from** (a sidebar page instead of a route), so no access-pattern shift.

---

## 4. Design

### 4.1 Routing & entry

- **Add** a new route `<Route path="/app/visualizers" element={renderShell("Visualizers", "Explore a namespace's remembered context as a constellation.", <MemoryConsolePage />)} />` (peer of the other `/app/*` routes) so it renders in-shell like them.
- **Add** a new sidebar entry to `appNavItems`: `{ to: "/app/visualizers", label: "Visualizers", icon: Sparkles }` (or another already-imported, nav-unused icon — pick in the plan).
- **Do not touch** `/app/memory`, `MemoryAppPage`, or `MemWalPanel`.
- Delete the `/showcase/:namespace` route, the `NamespaceMemoryPage` component, and the card-footer `<Link to={`/showcase/${item.namespace}`}>Visualize memory</Link>`.

### 4.2 `MemoryConsolePage` (new component — see §5 for location)

Responsibilities (thin orchestration):

- Hold `selectedNamespace: string` in state, initialised from `localStorage["cm.memory.namespace"]`, optionally seeded from `run?.manifest.namespace` when present and published. Persist on change.
- **If `selectedNamespace` is empty →** render `<MemoryNamespacePicker onSelect={…} />`.
- **Else →** run `useNamespaceChunks(selectedNamespace)` and render by state:
  - `loading` / `error` / `empty` → the in-shell message states (reuse today's copy, incl. the "re-publish to enable" empty text).
  - `ready` → `deriveMemoryGraph(state.chunks)` → `<NamespaceMemoryConstellation graph={graph} />`, with a small header showing the namespace name + a **"Change namespace"** button that clears `selectedNamespace` (back to picker).

> Hooks rule: `useNamespaceChunks` must be called unconditionally. Structure so the picker branch and the loaded branch don't conditionally call hooks — e.g. split the loaded view into a child component `<MemoryView namespace=… onChange=… />` that always calls the hook, and render the picker vs that child from the parent.

### 4.3 `MemoryNamespacePicker` (new, small)

- Fetches the namespace list the same way `ShowcasePage` does (extract/reuse the fetch; return `{ namespace, displayName?, description? }[]`).
- Renders a compact selectable list/grid in `.appContent`; clicking an item calls `onSelect(namespace)`.
- Loading / empty ("no namespaces yet") states.
- Reuse existing `.panel`/card styles for visual consistency with the rest of the console.

### 4.4 Embeddable constellation (CSS **+ a real component change**)

> ⚠️ **This is not host-CSS-only.** `react-force-graph-3d@1.29.1` defaults `width`/`height` to `window.innerWidth`/`window.innerHeight` and ships **no internal `ResizeObserver`** (verified in `dist/`). Today `NamespaceMemoryConstellation` passes **no** `width`/`height` (`…Constellation.tsx:91`), so the `<canvas>` is sized to the **window**, not its parent. Full-screen that happens to be correct; **embedded it overflows** the content region (oversized, anchored top-left, clipped by `overflow:hidden`) — it does **not** collapse to 0. CSS on `.nmc-canvas` cannot fix this because the canvas pixel size is driven by the JS props.

Two changes, both required:

1. **CSS (host positioning).**
   - Change `.nmc-root` from `position: fixed; inset: 0` to `position: absolute; inset: 0` (the absolutely-positioned children — `.nmc-overlay-msg`, `.nmc-panel`, `.nmc-search`, `.nmc-legend` — stay correct because `.nmc-root` remains their positioning context).
   - `MemoryConsolePage` wraps the constellation/states in a **height-defined relative container** (`.nmc-host`: `position: relative`, `flex: 1` in the shell column or explicit `height: calc(100vh - <shell header>)`) so the host has real dimensions inside `.appContent`.

2. **Component (measured dimensions) — `NamespaceMemoryConstellation`.**
   - Measure the host (a `ref` on `.nmc-root`/`.nmc-canvas` + a `ResizeObserver`, stored as `{ width, height }` state) and pass `width={…} height={…}` into `<ForceGraph3D>`.
   - This keeps the canvas filling the content region and re-fitting on shell/window resize. It is a small, contained addition — the graph data, theme, bloom, and interaction handlers are unchanged.

---

## 5. File layout

```
apps/web/src/
  main.tsx
    - ADD /app/visualizers route → renderShell("Visualizers", ..., <MemoryConsolePage/>)
    - ADD appNavItems entry { to: "/app/visualizers", label: "Visualizers", icon: Sparkles }
    - remove: /showcase/:namespace route, NamespaceMemoryPage, "Visualize memory" card link
    - UNCHANGED: /app/memory, MemoryAppPage, MemWalPanel
  components/namespace-memory/
    MemoryConsolePage.tsx / MemoryView.tsx / MemoryNamespacePicker.tsx   - NEW (see below)
    NamespaceMemoryConstellation.tsx   - add ref + ResizeObserver; pass width/height to ForceGraph3D (§4.4)
    namespace-memory.css   - .nmc-root: fixed → absolute; add .nmc-host (relative, height-defined) + picker styles
    (hooks, lib — unchanged)
```

**Recommendation: put the new page components in `components/namespace-memory/`, not `main.tsx`.** `main.tsx` is already ~5,600+ lines (`MemWalPanel` at 5588). The constellation feature already owns a folder with 7 extracted modules, so the page/view/picker belong there too — that is *more* consistent with this feature's structure, not less. (The "page components live in `main.tsx`" convention applies to the build-console pages; this feature has already broken from it deliberately.)

---

## 6. Testing & verification

- **No new unit tests** — the pure `derive`/`parse`/`theme` functions are unchanged (their tests must stay green). The new code is React glue + CSS + the ResizeObserver sizing wiring (§4.4), verified by typecheck + build + manual, consistent with the original feature's verification stance.
- **Gates:** `bun run --filter @contextmem/web typecheck` (exit 0); `bun run --filter @contextmem/web build` (success); `bunx vitest run` (still green).
- **Manual:**
  - sidebar **Visualizers** → picker → pick a namespace → constellation renders **inside the shell** (sidebar visible); hover/click/search/bloom work; reload keeps the selection; "Change namespace" returns to the picker; offline (no API) still renders the mock scene.
  - **Canvas sizing (the §4.4 risk):** the canvas **fills `.nmc-host`** with no overflow/clipping, is **not** window-sized, and **re-fits when the window/sidebar resizes**.
  - **Regression check:** existing sidebar **Memory** still opens the MemWal recall/remember page unchanged.

---

## 7. Out of scope (YAGNI)

- No backend/API change; no new listing endpoint (reuse the existing one).
- No multi-namespace / split-screen comparison.
- No deep-link/shareable URL for a specific namespace's graph. **Accepted regression:** `/showcase/:namespace` was the only shareable link to a specific graph; it is removed and not replaced (no redirect). Revisit only if requested.
- No change to the graph itself (edges, bloom, interaction) beyond host positioning and the canvas-sizing wiring in §4.4.

---

## 8. Risks

1. **Conditional hooks.** The picker-vs-loaded split must not call `useNamespaceChunks` conditionally — enforced by the `MemoryView` child component (§4.2). Watch for this in review.
2. **Canvas sizing in-shell (highest-risk).** `react-force-graph-3d` defaults to **window** dimensions and has no internal `ResizeObserver`, so a sized parent alone is **not** enough — without measured `width`/`height` props the embedded canvas renders window-sized and **overflows** the content region. Mitigation in §4.4: give `.nmc-host` a definite height **and** wire a `ResizeObserver` that feeds `width`/`height` into `<ForceGraph3D>`. Verify per §6.
3. **Active-namespace seed.** Seeding from `run?.manifest.namespace` can point at an unpublished/local namespace with no `chunks.ndjson` → `empty` state. Mitigation: treat the seed as a convenience only; the picker is always reachable via "Change namespace". (Could drop the seed entirely if it causes confusion.)
4. **Nav naming (largely resolved).** "Visualizers" is intentionally distinct from the existing "Memory" (MemWal recall/remember) item, so the earlier read-alike concern is mostly moot. Keep the icons distinct too (existing "Memory" uses `Brain`; use a different one for "Visualizers").
```
