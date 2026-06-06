# Memory nav destination — design spec

**Status:** draft for review · **Date:** 2026-06-06
**Surface:** `apps/web` only (`apps/web/src/main.tsx` + the `components/namespace-memory/` files). No backend change.

Move the namespace memory constellation from a buried full-screen route (`/showcase/:namespace`, reached via a card link) to a **first-class sidebar destination** under the existing **"Memory"** item — rendered **in-shell**, with an **inline-or-picker** flow.

---

## 1. Goal & success criteria

Selecting **"Memory"** in the app sidebar opens the memory constellation inside the app shell (sidebar stays), choosing a namespace via an inline picker when none is active.

**Done when:**

1. The existing sidebar **"Memory"** item (`/app/memory`, Brain icon) opens a real in-shell page (not the placeholder shell), with the sidebar still visible — the same chrome as "Namespaces".
2. With no namespace selected, the page shows a **namespace picker** (the list the showcase already fetches). Selecting one renders that namespace's constellation inline.
3. The selected namespace **persists across reloads** (localStorage); a **"Change namespace"** control returns to the picker.
4. The constellation renders **embedded** in the content area (the WebGL canvas fills the region; not `position: fixed` to the viewport), and hover/click/search/bloom still work.
5. Loading / empty / error states render inside the shell (carried over from today's full-screen page).
6. The old full-screen entry is **removed**: no `/showcase/:namespace` route, no `NamespaceMemoryPage`, no "Visualize memory" card link.
7. `bun run --filter @contextmem/web typecheck` is clean, `vite build` succeeds, and the existing `vitest` suite stays green (the pure `derive`/`parse`/`theme` tests are untouched).

---

## 2. Current state (verified anchors)

- **Sidebar items:** `appNavItems` (`main.tsx:1326–1335`) already includes `{ to: "/app/memory", label: "Memory", icon: Brain }` (line 1330) and `{ to: "/app/namespaces", ... }`. Rendered as `NavLink`s in the app sidebar (~`main.tsx:1956–1963`).
- **Shell wrapper:** `renderShell(pageTitle, pageDescription, child)` (`main.tsx:1204`) wraps a child in the sidebar layout; content area is `.appContent` (`main.tsx:1995`), inside `.appMain` (1977) / `.appShell` (1943).
- **`/app/memory` route** (`main.tsx:1279`) is currently a placeholder `renderShell("Memory", …)`.
- **Namespace listing:** `ShowcasePage` (`main.tsx:1768`) fetches the namespace list into `items` via `setItems(body.namespaces ?? [])` (line 1781); `ShowcaseItem` has `.namespace`, `.displayName`, `.description`, etc. This fetch is the reusable source for the picker.
- **To remove:** `/showcase/:namespace` route (`main.tsx:1260`), `NamespaceMemoryPage` (`main.tsx:1860`), and the "Visualize memory" card link (`main.tsx:1849`).
- **Constellation host:** `.nmc-root { position: fixed; inset: 0 }` in `components/namespace-memory/namespace-memory.css` — full-viewport today.
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

- Replace the placeholder `/app/memory` route element with `renderShell("Memory", "Explore a namespace's remembered context as a constellation.", <MemoryConsolePage />)` so it renders in-shell like the other `/app/*` pages.
- Delete the `/showcase/:namespace` route, the `NamespaceMemoryPage` component, and the card-footer `<Link to={`/showcase/${item.namespace}`}>Visualize memory</Link>`.

### 4.2 `MemoryConsolePage` (new component in `main.tsx`, peer of the other page components)

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

### 4.4 Embeddable constellation (CSS)

- Change `.nmc-root` from `position: fixed; inset: 0` to **fill its parent**: `position: absolute; inset: 0` (overlay states `.nmc-overlay-msg` already absolute within it stay correct).
- `MemoryConsolePage` wraps the constellation/states in a **height-defined relative container** (e.g. a `.nmc-host` that is `position: relative` and stretches to the available content height — `flex: 1` in the shell's column, or an explicit `height: calc(100vh - <shell header>)`), so the WebGL canvas gets real dimensions inside `.appContent`.
- No change to `NamespaceMemoryConstellation`'s logic; only its host's positioning.

---

## 5. File layout

```
apps/web/src/
  main.tsx
    - /app/memory route → renderShell(..., <MemoryConsolePage/>)
    - new: MemoryConsolePage, MemoryView, MemoryNamespacePicker (peers of existing page components)
    - remove: /showcase/:namespace route, NamespaceMemoryPage, "Visualize memory" card link
  components/namespace-memory/
    namespace-memory.css   - .nmc-root: fixed → absolute; add .nmc-host (relative, height-defined) + picker styles
    (NamespaceMemoryConstellation.tsx, hooks, lib — unchanged)
```

(If `main.tsx` growth is a concern, `MemoryConsolePage`/`MemoryView`/`MemoryNamespacePicker` may live in `components/namespace-memory/` and be imported — but follow the repo's current convention of page components inside `main.tsx`. Decide in the plan.)

---

## 6. Testing & verification

- **No new unit tests** — the pure `derive`/`parse`/`theme` functions are unchanged (their tests must stay green). The new code is React glue + CSS, verified by typecheck + build + manual, consistent with the original feature's verification stance.
- **Gates:** `bun run --filter @contextmem/web typecheck` (exit 0); `bun run --filter @contextmem/web build` (success); `bunx vitest run` (still green).
- **Manual:** sidebar **Memory** → picker → pick a namespace → constellation renders **inside the shell** (sidebar visible), canvas sized correctly; hover/click/search/bloom work; reload keeps the selection; "Change namespace" returns to the picker; offline (no API) still renders the mock scene.

---

## 7. Out of scope (YAGNI)

- No backend/API change; no new listing endpoint (reuse the existing one).
- No multi-namespace / split-screen comparison.
- No deep-link/shareable URL for a specific namespace's graph (removed with the full-screen route; revisit only if requested).
- No change to the graph itself (edges, bloom, interaction) beyond its host positioning.

---

## 8. Risks

1. **Conditional hooks.** The picker-vs-loaded split must not call `useNamespaceChunks` conditionally — enforced by the `MemoryView` child component (§4.2). Watch for this in review.
2. **Canvas sizing in-shell.** react-force-graph needs a sized parent; if `.appContent`/`.nmc-host` lacks a definite height the canvas can collapse to 0. The plan must give the host an explicit/flex height and verify the canvas fills it.
3. **Active-namespace seed.** Seeding from `run?.manifest.namespace` can point at an unpublished/local namespace with no `chunks.ndjson` → `empty` state. Mitigation: treat the seed as a convenience only; the picker is always reachable via "Change namespace". (Could drop the seed entirely if it causes confusion.)
```
