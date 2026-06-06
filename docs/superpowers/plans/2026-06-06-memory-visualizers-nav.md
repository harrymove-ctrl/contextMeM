# Memory Visualizers Nav Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the namespace memory constellation out of the buried `/showcase/:namespace` full-screen route into a first-class in-shell sidebar destination — a new **"Visualizers"** item at `/app/visualizers` with a namespace picker — embedded so the WebGL canvas fills (and resizes with) the content area.

**Architecture:** Add a new `/app/visualizers` route + `appNavItems` entry rendered through the existing `renderShell` wrapper (sidebar stays). A new `MemoryConsolePage` holds the selected namespace in `localStorage` and renders either `MemoryNamespacePicker` (no selection) or `MemoryView` (always calls `useNamespaceChunks` → `deriveMemoryGraph` → `NamespaceMemoryConstellation`). The constellation is made embeddable: `.nmc-root` switches `fixed → absolute`, lives inside a height-defined `.nmc-host`, and the component measures that host with a `ResizeObserver` and passes explicit `width`/`height` to `<ForceGraph3D>` (the library defaults to *window* size and has no internal resize handling, so host-CSS alone is insufficient). The existing `/app/memory` MemWal recall/remember page is **left untouched**.

**Tech Stack:** React + TypeScript (Vite), react-router (`Routes`/`Route`/`NavLink`), `react-force-graph-3d@1.29.1`, lucide-react icons, plain CSS (`styles.css` + `namespace-memory.css`). Package: `@contextmem/web` (Bun workspace).

---

## Verification stance (read before starting)

This plan deliberately **does not use TDD / failing unit tests** for the new code, and that is a conscious deviation from the writing-plans default. Reasons, in priority order:

1. **Spec decision (§6):** "No new unit tests — the new code is React glue + CSS + ResizeObserver wiring, verified by typecheck + build + manual."
2. **Repo convention:** the namespace-memory feature only unit-tests its *pure* functions (`derive`/`parse`/`theme`). The WebGL React component has no tests.
3. **Technical:** `react-force-graph-3d` renders to WebGL via Three.js and cannot mount in jsdom/vitest, so a "test" of `MemoryView`/the constellation would assert nothing meaningful.

So every task's verification = **typecheck (exit 0) + build (success) + the existing vitest suite stays green**, plus a **manual checklist** (Task 6). The pure-function tests (`derive`/`parse`/`theme`) are untouched and MUST stay green throughout.

Gate commands (run from repo root):
- Typecheck: `bun run --filter @contextmem/web typecheck`
- Build: `bun run --filter @contextmem/web build`
- Unit tests: `bunx vitest run` (run inside `apps/web`, or `cd apps/web && bunx vitest run`)

---

## Decisions baked into this plan

- **No active-namespace seed.** Spec §4.2 floated optionally seeding the selection from `run?.manifest.namespace`; Risk 3 flagged it as droppable (it can point at an unpublished namespace → confusing `empty` state) and notes it adds coupling (threading `run` into a `components/` file). This plan **drops the seed**. `localStorage` persistence already gives "return to your last namespace." Re-add later if requested.
- **Components live in `components/namespace-memory/`, not `main.tsx`.** `main.tsx` is ~5,600+ lines; the feature already owns a folder with extracted modules. Picker defines its own minimal namespace type (no import from `main.tsx`).
- **`.appContent` is shared by every page** (`styles.css:5086`, only `min-width: 0`). Do **not** modify it. The constellation host gets its own explicit height.

---

## File structure

```
apps/web/src/
  main.tsx
    - REMOVE: /showcase/:namespace route (1260), NamespaceMemoryPage (1860–1871),
      "Visualize memory" Link (1849), now-unused imports (10–12)
    - ADD: import MemoryConsolePage; /app/visualizers route; appNavItems entry
    - UNCHANGED: /app/memory, MemoryAppPage, MemWalPanel
  components/namespace-memory/
    NamespaceMemoryConstellation.tsx   - MODIFY: ref + ResizeObserver → width/height props
    namespace-memory.css               - MODIFY: .nmc-root fixed→absolute; ADD .nmc-host, .nmc-view-head, .nmc-picker*
    MemoryConsolePage.tsx              - NEW: localStorage selection; picker vs view
    MemoryView.tsx                     - NEW: always calls useNamespaceChunks; state branches + host
    MemoryNamespacePicker.tsx          - NEW: fetch /api/directory; selectable grid
    (hooks/use-namespace-chunks.ts, lib/derive-memory-graph.ts, other components — unchanged)
```

Build order keeps the app compiling and runnable after every task.

---

### Task 1: Remove the old full-screen entry

Removing `NamespaceMemoryPage` frees three imports that were used **only** there (verified: `useNamespaceChunks` @1862, `deriveMemoryGraph` @1864, `NamespaceMemoryConstellation` @1870). The new code imports them directly in `components/`, so `main.tsx` no longer needs them.

**Files:**
- Modify: `apps/web/src/main.tsx` (lines 10–12, 1260, 1849, 1860–1871)

- [ ] **Step 1: Delete the `/showcase/:namespace` route**

In `apps/web/src/main.tsx`, remove the line (1260):
```tsx
      <Route path="/showcase/:namespace" element={<NamespaceMemoryPage />} />
```
(Keep `<Route path="/showcase" element={<ShowcasePage />} />` on 1259 — only the `:namespace` route goes.)

- [ ] **Step 2: Delete the "Visualize memory" card link**

In `ShowcasePage`'s card footer (1849), remove:
```tsx
                <Link to={`/showcase/${item.namespace}`}>Visualize memory</Link>
```
The footer keeps "Open MCP URL" (`<a>`) and "Copy" (`<button>`).

- [ ] **Step 3: Delete the `NamespaceMemoryPage` component**

Remove the whole function (1860–1871):
```tsx
function NamespaceMemoryPage() {
  const { namespace = "" } = useParams();
  const state = useNamespaceChunks(namespace);
  const graph = useMemo(
    () => (state.status === "ready" ? deriveMemoryGraph(state.chunks) : null),
    [state],
  );
  if (state.status === "loading") return <div className="nmc-root"><div className="nmc-overlay-msg">Loading memory…</div></div>;
  if (state.status === "error") return <div className="nmc-root"><div className="nmc-overlay-msg">{state.message}</div></div>;
  if (state.status === "empty" || !graph) return <div className="nmc-root"><div className="nmc-overlay-msg">This namespace has no chunks yet — re-publish to enable the memory map.</div></div>;
  return <NamespaceMemoryConstellation graph={graph} />;
}
```

- [ ] **Step 4: Remove the now-unused imports**

Delete lines 10–12:
```tsx
import { useNamespaceChunks } from "./hooks/use-namespace-chunks.js";
import { deriveMemoryGraph } from "./lib/derive-memory-graph.js";
import { NamespaceMemoryConstellation } from "./components/namespace-memory/NamespaceMemoryConstellation.js";
```
> Note: `useParams` and `useMemo` are still used elsewhere in `main.tsx` — do NOT remove those imports. Only the three above are now orphaned.

- [ ] **Step 5: Typecheck**

Run: `bun run --filter @contextmem/web typecheck`
Expected: exit 0, no errors. (If it reports `useParams`/`useMemo`/`Link` as unused, something else relied on them — re-check; they should still be used.)

- [ ] **Step 6: Build + tests**

Run: `bun run --filter @contextmem/web build` → success.
Run: `cd apps/web && bunx vitest run` → all green (derive/parse/theme unchanged).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/main.tsx
git commit -m "refactor(web): remove /showcase/:namespace full-screen memory route"
```

---

### Task 2: Make the constellation embeddable (sizing + host CSS)

`react-force-graph-3d@1.29.1` defaults `width`/`height` to `window.innerWidth`/`window.innerHeight` and ships **no** `ResizeObserver` (verified in its `dist/`). Today `<ForceGraph3D>` is rendered with no size props (`NamespaceMemoryConstellation.tsx:91`), so embedded it would render window-sized and overflow. Fix: measure the host and pass explicit `width`/`height`.

**Files:**
- Modify: `apps/web/src/components/namespace-memory/NamespaceMemoryConstellation.tsx`
- Modify: `apps/web/src/components/namespace-memory/namespace-memory.css`

- [ ] **Step 1: Add `useLayoutEffect` to the React import**

Change line 1:
```tsx
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
```

- [ ] **Step 2: Add the host ref + measured size state**

Inside `NamespaceMemoryConstellation`, right after `const fgRef = useRef<any>(null);` (line 25), add:
```tsx
  const hostRef = useRef<HTMLDivElement>(null);
  // Seed with non-zero dims, NOT {0,0}. The mount-frame canvas computes camera
  // aspect = width/height; 0/0 = NaN poisons the Three.js view matrix and the
  // scene can come up blank even after the observer corrects the size.
  const [size, setSize] = useState({ width: 800, height: 600 });

  // react-force-graph-3d defaults to window size and never observes its parent,
  // so measure the host ourselves and feed explicit width/height to the canvas.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const measure = () => setSize({ width: el.clientWidth, height: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
```
> `useLayoutEffect` measures before paint, so the first painted frame already has real dimensions (no window-sized flash).
>
> **Do NOT "fix" the mount frame by gating `<ForceGraph3D>` on `size.width > 0`.** That defers the graph's mount by a frame, but the `attachBloom` effect (line 51, dep `[reducedMotion]`) runs on the constellation's mount and won't re-run — so a late-mounting graph never gets bloom attached. The non-zero seed above gives a valid aspect on the mount frame without changing mount timing, which is why it's the correct fix.

- [ ] **Step 3: Attach the ref and pass measured dimensions**

Change the root div (line 88) to attach the ref:
```tsx
    <div className="nmc-root" ref={hostRef}>
```
And add `width`/`height` to `<ForceGraph3D>` (just after `ref={fgRef}`, line 92):
```tsx
        <ForceGraph3D
          ref={fgRef}
          width={size.width}
          height={size.height}
          graphData={graph}
```
Leave every other `<ForceGraph3D>` prop and all other logic unchanged.

- [ ] **Step 4: `.nmc-root` from fixed to absolute + add `.nmc-host`**

In `namespace-memory.css`, change line 1:
```css
.nmc-root { position: absolute; inset: 0; background: var(--cm-graph-bg); overflow: hidden; }
```
Then append a host rule (anywhere after `.nmc-root`):
```css
/* In-shell embed host: gives the absolutely-positioned .nmc-root a sized,
   positioned parent inside .appContent. The 220px ≈ shell chrome (topbar +
   paddings); the component's ResizeObserver fits the canvas to whatever this
   resolves to, so the value is a tunable cosmetic, not load-bearing. */
.nmc-host {
  position: relative;
  width: 100%;
  height: calc(100vh - 220px);
  min-height: 460px;
  border-radius: 12px;
  overflow: hidden;
}
```
> The absolutely-positioned children (`.nmc-overlay-msg`, `.nmc-panel`, `.nmc-search`, `.nmc-legend`) stay correct because `.nmc-root` remains their positioning context.

- [ ] **Step 5: Typecheck + build**

Run: `bun run --filter @contextmem/web typecheck` → exit 0.
Run: `bun run --filter @contextmem/web build` → success.
(No route renders this yet; full visual check happens in Task 6.)

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/namespace-memory/NamespaceMemoryConstellation.tsx apps/web/src/components/namespace-memory/namespace-memory.css
git commit -m "feat(web): make memory constellation embeddable (measured size + .nmc-host)"
```

---

### Task 3: `MemoryNamespacePicker`

Reuses the directory fetch `ShowcasePage` already does (`GET ${API_BASE}/api/directory` → `{ namespaces: [...] }`, `main.tsx:1778`), but defines its own minimal type so it doesn't import from `main.tsx`.

**Files:**
- Create: `apps/web/src/components/namespace-memory/MemoryNamespacePicker.tsx`
- Modify: `apps/web/src/components/namespace-memory/namespace-memory.css` (append picker styles)

- [ ] **Step 1: Create the picker component**

`apps/web/src/components/namespace-memory/MemoryNamespacePicker.tsx`:
```tsx
import { useEffect, useState } from "react";
import { API_BASE } from "../../lib/api-base.js";

export type PickerNamespace = { namespace: string; displayName?: string; description?: string };

type PickerState =
  | { status: "loading" }
  | { status: "ready"; items: PickerNamespace[] }
  | { status: "error"; message: string };

export function MemoryNamespacePicker({ onSelect }: { onSelect: (namespace: string) => void }) {
  const [state, setState] = useState<PickerState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/directory`);
        if (!res.ok) throw new Error(`Failed to load namespaces (${res.status}).`);
        const body = (await res.json()) as { namespaces?: PickerNamespace[] };
        if (!cancelled) setState({ status: "ready", items: body.namespaces ?? [] });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") return <div className="panel">Loading namespaces…</div>;
  if (state.status === "error") return <div className="panel errorState"><p>{state.message}</p></div>;
  if (!state.items.length) {
    return <div className="panel subEmpty">No namespaces yet — publish a context package to populate the directory.</div>;
  }

  return (
    <section className="nmc-picker">
      <p className="nmc-picker-hint">Pick a namespace to explore its memory constellation.</p>
      <div className="nmc-picker-grid">
        {state.items.map((item) => (
          <button
            key={item.namespace}
            type="button"
            className="panel nmc-picker-card"
            onClick={() => onSelect(item.namespace)}
          >
            <strong>{item.displayName ?? item.namespace}</strong>
            <code>{item.namespace}</code>
            {item.description ? <span>{item.description}</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Append picker styles**

Append to `namespace-memory.css`:
```css
.nmc-picker { display: flex; flex-direction: column; gap: 12px; }
.nmc-picker-hint { font-size: 14px; color: var(--cm-muted, #6b7280); }
.nmc-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 12px; }
.nmc-picker-card {
  display: flex; flex-direction: column; gap: 6px;
  align-items: flex-start; text-align: left; cursor: pointer;
}
.nmc-picker-card code { font-size: 12px; color: var(--cm-accent, #a8d946); }
.nmc-picker-card span { font-size: 13px; color: var(--cm-muted, #6b7280); }
```
> Reuses the shared `.panel` class for card chrome; `.nmc-picker-card` adds layout on top.

- [ ] **Step 3: Typecheck + build**

Run: `bun run --filter @contextmem/web typecheck` → exit 0.
Run: `bun run --filter @contextmem/web build` → success.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/namespace-memory/MemoryNamespacePicker.tsx apps/web/src/components/namespace-memory/namespace-memory.css
git commit -m "feat(web): add MemoryNamespacePicker (reuses /api/directory)"
```

---

### Task 4: `MemoryView`

Always calls `useNamespaceChunks` unconditionally (the hooks-safety boundary from spec §4.2 / Risk 1). Renders the loading/error/empty/ready branches inside the height-defined `.nmc-host`, plus a small header with a "Change namespace" button.

**Files:**
- Create: `apps/web/src/components/namespace-memory/MemoryView.tsx`
- Modify: `apps/web/src/components/namespace-memory/namespace-memory.css` (append `.nmc-view-head`)

- [ ] **Step 1: Create the view component**

`apps/web/src/components/namespace-memory/MemoryView.tsx`:
```tsx
import { useMemo } from "react";
import { useNamespaceChunks } from "../../hooks/use-namespace-chunks.js";
import { deriveMemoryGraph } from "../../lib/derive-memory-graph.js";
import { NamespaceMemoryConstellation } from "./NamespaceMemoryConstellation.js";

export function MemoryView({ namespace, onChange }: { namespace: string; onChange: () => void }) {
  const state = useNamespaceChunks(namespace);
  const graph = useMemo(
    () => (state.status === "ready" ? deriveMemoryGraph(state.chunks) : null),
    [state],
  );

  return (
    <>
      <header className="nmc-view-head">
        <span className="nmc-view-ns">{namespace}</span>
        <button type="button" className="secondary" onClick={onChange}>Change namespace</button>
      </header>
      <div className="nmc-host">
        {state.status === "loading" ? (
          <div className="nmc-root"><div className="nmc-overlay-msg">Loading memory…</div></div>
        ) : state.status === "error" ? (
          <div className="nmc-root"><div className="nmc-overlay-msg">{state.message}</div></div>
        ) : state.status === "empty" || !graph ? (
          <div className="nmc-root"><div className="nmc-overlay-msg">This namespace has no chunks yet — re-publish to enable the memory map.</div></div>
        ) : (
          <NamespaceMemoryConstellation graph={graph} />
        )}
      </div>
    </>
  );
}
```
> The state-overlay `div`s reuse `.nmc-root` (now `position: absolute; inset: 0`) so they fill `.nmc-host` just like the constellation's own root does. `useNamespaceChunks` is called once, unconditionally, at the top — the conditional rendering is all in JSX, never around the hook.

- [ ] **Step 2: Append the view-header style**

Append to `namespace-memory.css`:
```css
.nmc-view-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.nmc-view-ns { font-weight: 600; font-size: 14px; }
```

- [ ] **Step 3: Typecheck + build**

Run: `bun run --filter @contextmem/web typecheck` → exit 0.
Run: `bun run --filter @contextmem/web build` → success.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/namespace-memory/MemoryView.tsx apps/web/src/components/namespace-memory/namespace-memory.css
git commit -m "feat(web): add MemoryView (unconditional hook + in-shell states)"
```

---

### Task 5: `MemoryConsolePage`

Thin orchestrator: holds the selected namespace in `localStorage`, renders the picker when empty and `MemoryView` otherwise. No hooks are called conditionally (`useState`/`useEffect` run unconditionally; the picker/view choice is a render branch).

**Files:**
- Create: `apps/web/src/components/namespace-memory/MemoryConsolePage.tsx`

- [ ] **Step 1: Create the page component**

`apps/web/src/components/namespace-memory/MemoryConsolePage.tsx`:
```tsx
import { useEffect, useState } from "react";
import { MemoryNamespacePicker } from "./MemoryNamespacePicker.js";
import { MemoryView } from "./MemoryView.js";

const STORAGE_KEY = "cm.memory.namespace";

export function MemoryConsolePage() {
  const [selectedNamespace, setSelectedNamespace] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? "",
  );

  useEffect(() => {
    if (selectedNamespace) localStorage.setItem(STORAGE_KEY, selectedNamespace);
    else localStorage.removeItem(STORAGE_KEY);
  }, [selectedNamespace]);

  if (!selectedNamespace) {
    return <MemoryNamespacePicker onSelect={setSelectedNamespace} />;
  }
  return <MemoryView namespace={selectedNamespace} onChange={() => setSelectedNamespace("")} />;
}
```

- [ ] **Step 2: Typecheck + build**

Run: `bun run --filter @contextmem/web typecheck` → exit 0.
Run: `bun run --filter @contextmem/web build` → success.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/namespace-memory/MemoryConsolePage.tsx
git commit -m "feat(web): add MemoryConsolePage (localStorage selection + picker/view)"
```

---

### Task 6: Wire the route + sidebar item

Adds the in-shell route and the new "Visualizers" nav item. `Sparkles` is already imported in `main.tsx` (line 6) and unused as a nav icon.

**Files:**
- Modify: `apps/web/src/main.tsx` (component imports; `Routes` block; `appNavItems` 1326–1335)

- [ ] **Step 1: Import `MemoryConsolePage`**

Near the top of `main.tsx`, with the other component imports, add:
```tsx
import { MemoryConsolePage } from "./components/namespace-memory/MemoryConsolePage.js";
```

- [ ] **Step 2: Add the route**

In the `<Routes>` block, add a new route alongside the other `/app/*` routes (e.g. right after the `/app/namespaces` route, ~line 1288):
```tsx
      <Route path="/app/visualizers" element={renderShell("Visualizers", "Explore a namespace's remembered context as a constellation.", <MemoryConsolePage />)} />
```

- [ ] **Step 3: Add the sidebar nav item**

In `appNavItems` (1326–1335), insert after the `Namespaces` entry:
```tsx
  { to: "/app/namespaces", label: "Namespaces", icon: Database },
  { to: "/app/visualizers", label: "Visualizers", icon: Sparkles },
  { to: "/app/settings", label: "Settings", icon: Settings }
```
> Do not change the existing `{ to: "/app/memory", label: "Memory", icon: Brain }` entry — that remains the MemWal recall/remember page.

- [ ] **Step 4: Typecheck + build**

Run: `bun run --filter @contextmem/web typecheck` → exit 0.
Run: `bun run --filter @contextmem/web build` → success.

- [ ] **Step 5: Unit tests stay green**

Run: `cd apps/web && bunx vitest run`
Expected: all pass (no test files changed since Task 1).

- [ ] **Step 6: Manual verification**

Start the app (`bun run --filter @contextmem/web dev`, or the repo's standard dev command) and confirm:
- [ ] Sidebar shows a new **"Visualizers"** item (Sparkles icon); the existing **"Memory"** item still opens the unchanged MemWal recall/remember page.
- [ ] Click **Visualizers** with no prior selection → the **namespace picker** renders inside the shell (sidebar visible).
- [ ] Pick a namespace → the **constellation renders inside the shell**; the canvas **fills `.nmc-host`** (no overflow, not window-sized, no 0-height collapse).
- [ ] **Nodes are visible immediately on first selection** — not blank until a resize nudge (guards against the mount-frame NaN-aspect failure; a correctly *sized* but *blank* canvas would otherwise pass the size check above).
- [ ] **Resize the window / collapse the sidebar** → the canvas re-fits (ResizeObserver working).
- [ ] **Hover / click a node / search / bloom** still work; "Change namespace" returns to the picker.
- [ ] **Reload** the page → the previously selected namespace is restored (localStorage).
- [ ] **Offline (stop the API)** → the view still renders the bundled mock scene (the hook's network-failure fallback).
- [ ] Navigating to `/showcase/<anything>` → redirects to `/` (old route gone); `/showcase` directory page still works and its cards no longer show "Visualize memory".

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/main.tsx
git commit -m "feat(web): add Visualizers sidebar destination at /app/visualizers"
```

---

## Self-review (completed by plan author)

**1. Spec coverage** — every spec §1 "Done when" criterion maps to a task:
- New "Visualizers" item + in-shell page → Task 6 (route/nav), Tasks 3–5 (page).
- Existing "Memory" unchanged → asserted in Task 1 (not touched) + Task 6 Step 6.
- Picker when no selection → Task 3 + Task 5.
- Persist across reloads + "Change namespace" → Task 5 + Task 4.
- Embedded, resizing canvas → Task 2.
- Loading/empty/error in-shell → Task 4.
- Old full-screen entry removed → Task 1.
- typecheck/build/vitest green → every task's verification steps.

**2. Placeholder scan** — no "TBD/TODO/handle edge cases/similar to Task N"; every code step shows complete code; verification steps show exact commands + expected results.

**3. Type/name consistency** — `MemoryConsolePage`, `MemoryView`, `MemoryNamespacePicker`, `PickerNamespace`, `STORAGE_KEY = "cm.memory.namespace"`, `onSelect`/`onChange`, `.nmc-host`/`.nmc-view-head`/`.nmc-picker*`, route `/app/visualizers`, label `"Visualizers"`, icon `Sparkles` — all used identically across tasks. `useNamespaceChunks`/`deriveMemoryGraph`/`NamespaceMemoryConstellation` are removed from `main.tsx` (Task 1) and imported into `MemoryView` (Task 4) — net imports balance.
