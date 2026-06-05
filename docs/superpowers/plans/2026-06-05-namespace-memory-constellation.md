# Namespace Memory Constellation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render one namespace's `ContextChunk` memory as an interactive, bloom-lit 3D force-directed graph in `apps/web`, fed by a new public artifact-file API route.

**Architecture:** Pure functions (`parse-chunks-ndjson`, `derive-memory-graph`) turn `chunks.ndjson` into a connected `{nodes, links}` tree — derived once, client-side. A thin hook fetches the file (with a bundled mock fallback). `react-force-graph-3d` + `three` render it; bloom is applied via the wrapper's `postProcessingComposer()`. A small `apps/api/worker.ts` change uploads `chunks.ndjson` with hosted namespaces and exposes it for public read.

**Tech Stack:** Vite 7 + React 19, React Router v7, `react-force-graph-3d` + `three`, `motion`, `lucide-react`, `react-markdown`; tests via Vitest; Cloudflare Worker API.

**Spec:** `docs/superpowers/specs/2026-06-05-namespace-memory-constellation-design.md` (revised after review).

---

## Conventions (read before starting any task)

- **Imports:** relative, with explicit `.js` extensions (NodeNext). No `@/*` aliases exist. Example: `import { deriveMemoryGraph } from "../lib/derive-memory-graph.js"`.
- **The web app must NOT `import` from `@contextmem/core`.** Its `tsconfig` `rootDir: "src"` makes cross-package source imports fail `TS6059`. Mirror DTO shapes locally (see `memory-graph-types.ts`). The web reads `chunks.ndjson` over HTTP — it is a separate deployable.
- **Tests:** `import { describe, expect, it } from "vitest";`. Run one file: `bunx vitest run <path>`. Run all: `bunx vitest run`.
- **Typecheck (web):** `bun run --filter @contextmem/web typecheck` (must exit 0).
- **Build (web):** `bun run --filter @contextmem/web build` (`vite build`; must succeed).
- **Styling:** `--cm-*` CSS tokens in `apps/web/src/styles.css`; scoped `.nmc-*` classes; `lucide-react` icons; `motion` for animation. No shadcn, no Tailwind utilities.
- **Commit cadence:** one commit per task. We are on `main` — **create a branch first** (`git switch -c feat/namespace-memory-constellation`) before the first commit.

### What is and isn't unit-tested (be honest — Rule 12)
- **Unit-tested (TDD):** `derive-memory-graph` (done), `parse-chunks-ndjson`, `memory-theme` pure functions, the backend route.
- **Verified by typecheck + `vite build` + manual run (no React test infra in repo, adding it is out of scope/YAGNI):** the hook and all `.tsx` components + three.js helpers. Manual verification uses the chrome-devtools skill against `vite dev`.

---

## Status

- [x] **Task 1: `derive-memory-graph` + types (DONE).** `apps/web/src/lib/memory-graph-types.ts`, `derive-memory-graph.ts`, `derive-memory-graph.test.ts` — 7 tests pass, web typecheck clean. Not yet committed.

---

## Task 2: `parse-chunks-ndjson` (tolerant NDJSON → ContextChunk[])

**Files:**
- Create: `apps/web/src/lib/parse-chunks-ndjson.ts`
- Test: `apps/web/src/lib/parse-chunks-ndjson.test.ts`

**Why tolerant:** the file is produced by a build tool but fetched over HTTP; a trailing newline, blank lines, or one corrupt line must not crash the whole view. Drop unparseable/invalid lines, keep the rest.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/src/lib/parse-chunks-ndjson.test.ts
import { describe, expect, it } from "vitest";
import { parseChunksNdjson } from "./parse-chunks-ndjson.js";

const valid = JSON.stringify({
  chunkId: "a", routePath: "/", headingPath: ["Home"], heading: "Home",
  text: "hi", contentHash: "h", byteLength: 2, order: 0,
});

describe("parseChunksNdjson", () => {
  it("parses one ContextChunk per non-empty line", () => {
    const out = parseChunksNdjson(`${valid}\n${valid.replace('"a"', '"b"')}\n`);
    expect(out.map((c) => c.chunkId)).toEqual(["a", "b"]);
  });

  it("ignores blank lines and trailing whitespace", () => {
    expect(parseChunksNdjson(`\n  \n${valid}\n\n`)).toHaveLength(1);
  });

  it("skips malformed JSON lines instead of throwing", () => {
    expect(parseChunksNdjson(`{not json\n${valid}`)).toHaveLength(1);
  });

  it("skips lines missing required fields", () => {
    const bad = JSON.stringify({ chunkId: "x" }); // no headingPath/text/order
    expect(parseChunksNdjson(`${bad}\n${valid}`).map((c) => c.chunkId)).toEqual(["a"]);
  });

  it("returns an empty array for empty input", () => {
    expect(parseChunksNdjson("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bunx vitest run apps/web/src/lib/parse-chunks-ndjson.test.ts`
Expected: FAIL — `parseChunksNdjson` is not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/web/src/lib/parse-chunks-ndjson.ts
import type { ContextChunk } from "./memory-graph-types.js";

function isContextChunk(v: unknown): v is ContextChunk {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.chunkId === "string" &&
    typeof o.routePath === "string" &&
    Array.isArray(o.headingPath) &&
    typeof o.text === "string" &&
    typeof o.byteLength === "number" &&
    typeof o.order === "number"
  );
}

// Tolerant: one JSON object per line; blank/corrupt/invalid lines are dropped.
export function parseChunksNdjson(text: string): ContextChunk[] {
  const out: ContextChunk[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isContextChunk(parsed)) out.push(parsed);
    } catch {
      // skip corrupt line
    }
  }
  return out;
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bunx vitest run apps/web/src/lib/parse-chunks-ndjson.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/parse-chunks-ndjson.ts apps/web/src/lib/parse-chunks-ndjson.test.ts
git commit -m "feat(web): tolerant NDJSON parser for namespace chunks"
```

---

## Task 3: `memory-theme` (stable colour + size, pure)

**Files:**
- Create: `apps/web/src/components/namespace-memory/memory-theme.ts`
- Test: `apps/web/src/components/namespace-memory/memory-theme.test.ts`

**Responsibility:** map `routePath → stable hue` (so each page is a distinct, deterministic colour family) and `byteLength → node size`. Pure, so it is TDD'd.

- [ ] **Step 1: Write the failing test**

```ts
// memory-theme.test.ts
import { describe, expect, it } from "vitest";
import { routePathColor, sizeScale } from "./memory-theme.js";

describe("routePathColor", () => {
  it("is deterministic for the same route", () => {
    expect(routePathColor("/guide/auth")).toBe(routePathColor("/guide/auth"));
  });
  it("returns an hsl() string", () => {
    expect(routePathColor("/")).toMatch(/^hsl\(\d+(\.\d+)? \d+% \d+%\)$/);
  });
  it("usually differs between different routes", () => {
    expect(routePathColor("/a")).not.toBe(routePathColor("/b"));
  });
});

describe("sizeScale", () => {
  it("is monotonic non-decreasing in byteLength", () => {
    expect(sizeScale(4000)).toBeGreaterThanOrEqual(sizeScale(100));
  });
  it("never returns below 1 (zero-byte chunk still visible)", () => {
    expect(sizeScale(0)).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bunx vitest run apps/web/src/components/namespace-memory/memory-theme.test.ts`
Expected: FAIL — functions not exported.

- [ ] **Step 3: Write minimal implementation**

```ts
// memory-theme.ts
// Stable string hash (FNV-1a) → hue. Saturation/lightness fixed for the neon look.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function routePathColor(routePath: string): string {
  const hue = hashString(routePath) % 360;
  return `hsl(${hue} 85% 62%)`;
}

// Node area ∝ bytes; clamp so tiny chunks stay visible and huge ones don't dominate.
export function sizeScale(byteLength: number): number {
  return Math.min(12, Math.max(1, Math.sqrt(Math.max(0, byteLength)) / 6));
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bunx vitest run apps/web/src/components/namespace-memory/memory-theme.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Update `derive-memory-graph.ts` to use the shared `sizeScale`**

Replace the inline `val` computation so size logic lives in one place (DRY). In `apps/web/src/lib/derive-memory-graph.ts`:

```ts
// add import at top
import { sizeScale } from "../components/namespace-memory/memory-theme.js";
```
```ts
// in toNode(), replace:
//   val: Math.max(1, Math.sqrt(c.byteLength)), // node area ∝ bytes
// with:
    val: sizeScale(c.byteLength),
```

- [ ] **Step 6: Re-run derive + theme tests, verify still green**

Run: `bunx vitest run apps/web/src/lib/derive-memory-graph.test.ts apps/web/src/components/namespace-memory/memory-theme.test.ts`
Expected: PASS (7 + 5).

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/namespace-memory/memory-theme.ts apps/web/src/components/namespace-memory/memory-theme.test.ts apps/web/src/lib/derive-memory-graph.ts
git commit -m "feat(web): stable per-page colour + byte size scale"
```

---

## Task 4: `mock-chunks` (bundled offline data)

**Files:**
- Create: `apps/web/src/data/mock-chunks.ts`

**Responsibility:** ~50 realistic `ContextChunk`s across 4 pages so the view renders with the API offline. Generated deterministically (no hand-typing 50 objects), with real heading hierarchies so `derive-memory-graph` produces a rich tree.

- [ ] **Step 1: Write the file**

```ts
// apps/web/src/data/mock-chunks.ts
import type { ContextChunk } from "../lib/memory-graph-types.js";

type Seed = { route: string; sections: Array<{ path: string[]; bodies: number }> };

const SEEDS: Seed[] = [
  { route: "/", sections: [
    { path: ["Overview"], bodies: 2 },
    { path: ["Overview", "Why"], bodies: 3 },
    { path: ["Overview", "Concepts"], bodies: 3 },
  ] },
  { route: "/guide/auth", sections: [
    { path: ["Auth"], bodies: 2 },
    { path: ["Auth", "Tokens"], bodies: 4 },
    { path: ["Auth", "Tokens", "Rotation"], bodies: 2 },
    { path: ["Auth", "Sessions"], bodies: 3 },
  ] },
  { route: "/guide/storage", sections: [
    { path: ["Storage"], bodies: 2 },
    { path: ["Storage", "Walrus"], bodies: 4 },
    { path: ["Storage", "Caching"], bodies: 3 },
  ] },
  { route: "/api/reference", sections: [
    { path: ["Reference"], bodies: 2 },
    { path: ["Reference", "Endpoints"], bodies: 5 },
    { path: ["Reference", "Errors"], bodies: 3 },
  ] },
];

function build(): ContextChunk[] {
  const chunks: ContextChunk[] = [];
  let order = 0;
  for (const seed of SEEDS) {
    for (const section of seed.sections) {
      for (let b = 0; b < section.bodies; b++) {
        const heading = section.path[section.path.length - 1]!;
        const text =
          `## ${section.path.join(" › ")}\n\n` +
          `Paragraph ${b + 1} of the "${heading}" section on ${seed.route}. ` +
          `It describes how ContextMeM remembers this slice of the document so an agent can recall it later.`;
        chunks.push({
          chunkId: `${seed.route}#${section.path.join("/")}#${b}`,
          routePath: seed.route,
          url: `https://docs.example.com${seed.route}`,
          heading,
          headingPath: section.path,
          text,
          contentHash: `mock-${order}`,
          byteLength: text.length,
          order: order++,
        });
      }
    }
  }
  return chunks;
}

export const mockChunks: ContextChunk[] = build();
```

- [ ] **Step 2: Verify it typechecks and produces a connected graph**

Run: `bun run --filter @contextmem/web typecheck`
Expected: exit 0.

(Optional sanity check — paste into the derive test temporarily or trust Task 1's invariant; `mockChunks` has 4 pages, ~47 chunks, and is guaranteed connected by `deriveMemoryGraph`.)

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/data/mock-chunks.ts
git commit -m "feat(web): bundled mock chunks for offline rendering"
```

---

## Task 5: `use-namespace-chunks` hook (fetch + parse + states + mock fallback)

**Files:**
- Create: `apps/web/src/lib/api-base.ts`
- Create: `apps/web/src/hooks/use-namespace-chunks.ts`

**Responsibility:** thin React glue — fetch `chunks.ndjson` for a namespace, parse with `parseChunksNdjson`, expose discriminated state. Mock fallback when the API is **unreachable** (offline dev); `empty` when the artifact is **404** (namespace published before chunks were uploaded). No unit test (no React test infra; covered by typecheck + build + manual).

**No circular import:** `API_BASE` lives in its own module `apps/web/src/lib/api-base.ts` (your spec-review §11 recommendation), so the hook never imports the entry module — this avoids a `main → hook → main` cycle that Vite/HMR punishes, and removes any task-ordering dependency.

- [ ] **Step 1: Create `apps/web/src/lib/api-base.ts`**

```ts
// apps/web/src/lib/api-base.ts
export const API_BASE = import.meta.env.VITE_CONTEXTMEM_API_BASE ?? "http://localhost:8791";
```

- [ ] **Step 2: Write the hook**

```ts
// apps/web/src/hooks/use-namespace-chunks.ts
import { useEffect, useState } from "react";
import { API_BASE } from "../lib/api-base.js";
import { parseChunksNdjson } from "../lib/parse-chunks-ndjson.js";
import type { ContextChunk } from "../lib/memory-graph-types.js";
import { mockChunks } from "../data/mock-chunks.js";

export type ChunksState =
  | { status: "loading" }
  | { status: "ready"; chunks: ContextChunk[]; source: "api" | "mock" }
  | { status: "empty" }
  | { status: "error"; message: string };

const ARTIFACT_PATH = "context/chunks.ndjson";

export function useNamespaceChunks(namespace: string): ChunksState {
  const [state, setState] = useState<ChunksState>({ status: "loading" });

  useEffect(() => {
    if (!namespace) {
      setState({ status: "empty" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const url = `${API_BASE}/api/namespaces/${encodeURIComponent(namespace)}/artifact-file?path=${encodeURIComponent(ARTIFACT_PATH)}`;
        const res = await fetch(url);
        if (cancelled) return;
        if (res.status === 404) {
          setState({ status: "empty" });
          return;
        }
        if (!res.ok) {
          setState({ status: "error", message: `Failed to load memory (${res.status}).` });
          return;
        }
        const chunks = parseChunksNdjson(await res.text());
        if (cancelled) return;
        setState(chunks.length ? { status: "ready", chunks, source: "api" } : { status: "empty" });
      } catch {
        // Network unreachable (offline dev) → fall back to bundled mock so the view still renders.
        if (!cancelled) setState({ status: "ready", chunks: mockChunks, source: "mock" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [namespace]);

  return state;
}
```

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @contextmem/web typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/api-base.ts apps/web/src/hooks/use-namespace-chunks.ts
git commit -m "feat(web): API_BASE module + useNamespaceChunks hook (mock + empty states)"
```

---

## Task 6: Backend — upload `chunks.ndjson` + public artifact-file route

**Files:**
- Modify: `apps/api/src/worker.ts` (builders ≈ 2092 & 2423; route block ≈ 679)
- Test: `apps/api/src/worker.test.ts` (follow the existing harness in this file)

**Verified facts (from review):** `chunks.ndjson` is not uploaded today (`grep chunks.ndjson worker.ts` is empty). `store.authorizeNamespace(namespace, token)` returns `{ ok: true, ... }` for public namespaces with no token (worker.ts:490). `store.readArtifact(namespace, path)` does an exact-match DB lookup scoped to `(namespace, version_id)` and `normalizeHostedArtifactPath` (worker.ts:436) — `..` cannot escape. `cors(...)` helper exists. The generic `GET /api/namespaces/...` handler is at ≈ line 679 and already uses `store.authorizeNamespace(namespace, readAccessToken(request))`.

- [ ] **Step 1: Add `chunks.ndjson` to both hosted upload builders**

At the top of `worker.ts`, ensure the import exists:
```ts
import { buildChunks, renderChunksNdjson } from "@contextmem/core/chunks";
```
In **`buildCombinedNamespaceBundle`** (≈ line 2092) and **`extractTargetContext`** (≈ line 2423), wherever the `files[]` array is built and `pages` is in scope, add this entry alongside the existing `/context/*.json` entries:
```ts
{
  path: "/context/chunks.ndjson",
  contentType: "application/x-ndjson; charset=utf-8",
  encoding: "utf8",
  content: renderChunksNdjson(buildChunks(pages)),
},
```

- [ ] **Step 2: Add the public artifact-file read route**

Immediately **before** the generic `GET /api/namespaces/:ns` handler (≈ line 679), add a branch. Match the surrounding code's exact response/utility style (`cors`, `readAccessToken`):
```ts
if (request.method === "GET" && url.pathname.startsWith("/api/namespaces/") && url.pathname.endsWith("/artifact-file")) {
  const namespace = decodeURIComponent(url.pathname.slice("/api/namespaces/".length, -"/artifact-file".length));
  const artifactPath = url.searchParams.get("path") ?? "";
  const auth = await store.authorizeNamespace(namespace, readAccessToken(request));
  if (!auth.ok) return cors(new Response(auth.message, { status: auth.status }));
  const artifact = await store.readArtifact(namespace, artifactPath);
  if (!artifact) return cors(new Response("Artifact not found", { status: 404 }));
  return cors(new Response(artifact.content, {
    status: 200,
    headers: { "content-type": artifact.contentType },
  }));
}
```
> Disclosure invariant (spec §12.5): this serves any artifact path of a **public** namespace tokenless; private namespaces still require a token via `authorizeNamespace`. The existing bundle (`manifest.json`, `sources.json`, …) is already public, so `chunks.ndjson` fits that tier. Do not loosen the `authorizeNamespace` gate.

- [ ] **Step 3: Write the backend test**

Open `apps/api/src/worker.test.ts`, read how it constructs a worker/store + a public namespace, and add a test following that harness. Assert these behaviors:
1. `GET /api/namespaces/<public-ns>/artifact-file?path=context/chunks.ndjson` → `200` and a body whose first line `JSON.parse`s to an object with a `chunkId`.
2. `GET …/artifact-file?path=context/does-not-exist.json` → `404`.
3. `GET …/artifact-file?path=context/chunks.ndjson` for a **private** namespace with no token → `401` (or the store's configured status from `authorizeNamespace`).

- [ ] **Step 4: Run backend tests, verify pass**

Run: `bunx vitest run apps/api/src/worker.test.ts`
Expected: PASS, including the three new assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/worker.ts apps/api/src/worker.test.ts
git commit -m "feat(api): upload chunks.ndjson and serve it via public artifact-file route"
```

---

## Task 7: Spike — add deps + prove the bloom recipe

**Files:**
- Modify: `apps/web/package.json`
- Temporary: `apps/web/src/components/namespace-memory/_spike.tsx` (throwaway — delete after)

**This is the top technical risk (spec §12.2).** The official react-force-graph bloom example does **whole-scene** bloom, not selective. Prove the recipe before building components.

- [ ] **Step 1: Add dependencies**

```bash
cd apps/web
bun add react-force-graph-3d three
bun add -d @types/three
cd ../..
```
Confirm `react-force-graph-3d`, `three` are in `dependencies` and `@types/three` in `devDependencies` of `apps/web/package.json`.

- [ ] **Step 2: Write a throwaway spike component (whole-scene bloom first)**

```tsx
// apps/web/src/components/namespace-memory/_spike.tsx  (DELETE after the spike)
import { useEffect, useRef } from "react";
import ForceGraph3D from "react-force-graph-3d";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { deriveMemoryGraph } from "../../lib/derive-memory-graph.js";
import { mockChunks } from "../../data/mock-chunks.js";

export function Spike() {
  const fgRef = useRef<any>(null);
  const graph = deriveMemoryGraph(mockChunks);
  useEffect(() => {
    const composer = fgRef.current?.postProcessingComposer?.();
    if (!composer) return;
    const bloom = new UnrealBloomPass(undefined as any, 2, 1, 0);
    composer.addPass(bloom);
  }, []);
  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <ForceGraph3D
        ref={fgRef}
        graphData={graph}
        controlType="orbit"
        backgroundColor="#0f1115"
        nodeLabel={(n: any) => n.label}
        linkColor={() => "rgba(168,217,70,0.25)"}
        linkWidth={0.4}
      />
    </div>
  );
}
```
Temporarily route to it (e.g. change `main.tsx` `/showcase` route element to `<Spike />`, or render it from a scratch entry). Run `bun run --filter @contextmem/web dev`.

- [ ] **Step 3: Observe and decide (use the chrome-devtools skill)**

Open the dev URL, take a screenshot. Check:
1. Does the React wrapper mount under React 19 without runtime errors? (peerDep is `react:"*"`; if it throws, switch to driving vanilla `3d-force-graph` imperatively in a `useEffect` — spec §12.1.)
2. With **whole-scene** bloom + thin dim edges, do the nodes glow while edges stay acceptably crisp?
   - **If YES →** record "whole-scene bloom is sufficient" and Task 8's `memory-bloom.ts` is the simple version below.
   - **If edges wash out →** record "selective bloom required" and Task 8 uses the layer-masked two-composer variant (see Task 8 alt).
3. **Auto-rotation (criterion §1.7):** with `controlType="orbit"`, does `fgRef.current.controls().autoRotate = true` actually rotate? The default trackball controls have **no** `autoRotate`, so without orbit controls §1.7 silently doesn't exist.
4. **`__threeObj` (Task 9 hover-dim):** confirm `graph.nodes[0].__threeObj` is populated after first render and exposes `.material.opacity`. If not, Task 9 hover falls back to link-only highlighting.

- [ ] **Step 4: Delete the spike, revert the temporary route**

```bash
rm apps/web/src/components/namespace-memory/_spike.tsx
# revert the temporary main.tsx route change
```

- [ ] **Step 5: Commit the dependency addition + spike decision**

```bash
git add apps/web/package.json bun.lock
git commit -m "build(web): add react-force-graph-3d + three (bloom spike decision: <whole-scene|selective>)"
```
Record the spike decision in the commit message and proceed to Task 8 with the chosen variant.

---

## Task 8: Rendering helpers — `memory-node-objects` + `memory-bloom`

**Files:**
- Create: `apps/web/src/components/namespace-memory/memory-node-objects.ts`
- Create: `apps/web/src/components/namespace-memory/memory-bloom.ts`

- [ ] **Step 1: Write `memory-node-objects.ts` (cached glow sprite factory)**

```ts
// memory-node-objects.ts
import { Sprite, SpriteMaterial, CanvasTexture, AdditiveBlending, Color } from "three";
import type { MemoryNode } from "../../lib/memory-graph-types.js";

// One radial-gradient texture, shared and tinted per node (cheap; avoids N textures).
let glowTexture: CanvasTexture | null = null;
function getGlowTexture(): CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new CanvasTexture(canvas);
  return glowTexture;
}

export const BLOOM_LAYER = 1;

export function createNodeObject(node: MemoryNode, color: string, selective: boolean): Sprite {
  const material = new SpriteMaterial({
    map: getGlowTexture(),
    color: new Color(color),
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new Sprite(material);
  const scale = 4 + node.val * 2;
  sprite.scale.set(scale, scale, 1);
  if (selective) sprite.layers.set(BLOOM_LAYER); // only sprites bloom
  return sprite;
}
```

- [ ] **Step 2: Write `memory-bloom.ts` — use the variant chosen in Task 7**

**Variant A — whole-scene (if spike said sufficient):**
```ts
// memory-bloom.ts
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

export function attachBloom(fgRef: { postProcessingComposer?: () => any } | null): void {
  const composer = fgRef?.postProcessingComposer?.();
  if (!composer) return;
  const bloom = new UnrealBloomPass(undefined as unknown as never, 2, 1, 0);
  composer.addPass(bloom);
}
```

**Variant B — selective (only if spike said edges wash out):** render the bloom layer to a texture with its own `EffectComposer`, then composite over the base render with a shader pass that adds the bloom buffer. Use the node sprites' `BLOOM_LAYER` (Task 8 Step 1). Implement following the three.js "selective bloom" docs; gate the camera to render `BLOOM_LAYER` in the bloom composer and all-but-`BLOOM_LAYER` in the base. Keep the public API identical: `export function attachBloom(fgRef): void`. **Only build this if Task 7 required it** (YAGNI — spec §9/§12.2).

- [ ] **Step 3: Typecheck**

Run: `bun run --filter @contextmem/web typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/namespace-memory/memory-node-objects.ts apps/web/src/components/namespace-memory/memory-bloom.ts
git commit -m "feat(web): glowing node sprites + bloom setup"
```

---

## Task 9: UI components — Constellation, Panel, Search, Legend, CSS

**Files:**
- Modify: `apps/web/src/main.tsx:512` (import `API_BASE` from `lib/api-base.js`)
- Modify: `apps/web/src/styles.css` (add `--cm-graph-bg` token)
- Create: `apps/web/src/components/namespace-memory/MemoryChunkPanel.tsx`
- Create: `apps/web/src/components/namespace-memory/MemorySearchBox.tsx`
- Create: `apps/web/src/components/namespace-memory/MemoryLegend.tsx`
- Create: `apps/web/src/components/namespace-memory/NamespaceMemoryConstellation.tsx`
- Create: `apps/web/src/components/namespace-memory/namespace-memory.css`

- [ ] **Step 1: Point `main.tsx` at the `api-base` module**

In `apps/web/src/main.tsx:512`, replace the local constant:
```ts
const API_BASE = import.meta.env.VITE_CONTEXTMEM_API_BASE ?? "http://localhost:8791";
```
with an import placed among the other top-of-file imports, so `API_BASE` has one home and the hook → main cycle never forms:
```ts
import { API_BASE } from "./lib/api-base.js";
```
Every existing `main.tsx` use of `API_BASE` keeps working unchanged. (Created in Task 5 Step 1.)

- [ ] **Step 2: Add the `--cm-graph-bg` token**

In `apps/web/src/styles.css`, inside the `:root`/`--cm-*` token block (≈ lines 2333–2344), add:
```css
  --cm-graph-bg: #0f1115;
```

- [ ] **Step 3: Write `namespace-memory.css` (scoped `.nmc-*`)**

```css
/* namespace-memory.css */
.nmc-root { position: fixed; inset: 0; background: var(--cm-graph-bg); overflow: hidden; }
.nmc-canvas { position: absolute; inset: 0; }
.nmc-panel {
  position: absolute; top: 0; right: 0; height: 100%; width: min(420px, 92vw);
  background: rgba(15,17,21,0.92); color: #e8edf2; border-left: 1px solid var(--cm-border-strong, #2a2f3a);
  padding: 20px; overflow-y: auto; backdrop-filter: blur(6px);
}
.nmc-breadcrumb { font-size: 12px; color: var(--cm-accent, #a8d946); margin-bottom: 8px; }
.nmc-panel-text { font-size: 14px; line-height: 1.6; }
.nmc-search { position: absolute; top: 16px; left: 16px; width: min(320px, 80vw); z-index: 2; }
.nmc-search input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--cm-border-strong, #2a2f3a); background: rgba(15,17,21,0.9); color: #e8edf2; }
.nmc-results { margin-top: 4px; background: rgba(15,17,21,0.95); border-radius: 8px; max-height: 40vh; overflow-y: auto; }
.nmc-results button { display: block; width: 100%; text-align: left; padding: 8px 12px; background: none; border: none; color: #cdd6df; cursor: pointer; }
.nmc-results button:hover { background: rgba(168,217,70,0.12); }
.nmc-legend { position: absolute; bottom: 16px; left: 16px; z-index: 2; font-size: 12px; color: #cdd6df; background: rgba(15,17,21,0.85); padding: 10px 12px; border-radius: 8px; }
.nmc-legend .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 6px; }
.nmc-overlay-msg { position: absolute; inset: 0; display: grid; place-items: center; color: #cdd6df; }
.nmc-close { position: absolute; top: 12px; right: 12px; background: none; border: none; color: #cdd6df; cursor: pointer; }
```

- [ ] **Step 4: Write `MemoryChunkPanel.tsx`**

```tsx
// MemoryChunkPanel.tsx
import { motion } from "motion/react";
import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MemoryNode } from "../../lib/memory-graph-types.js";

export function MemoryChunkPanel({ node, onClose }: { node: MemoryNode; onClose: () => void }) {
  return (
    <motion.aside
      className="nmc-panel"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <button className="nmc-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <div className="nmc-breadcrumb">{node.headingPath.join(" › ")}</div>
      <div style={{ fontSize: 12, color: "#8b95a3", marginBottom: 12 }}>
        {node.routePath} · {node.byteLength} bytes
        {node.url ? <> · <a href={node.url} target="_blank" rel="noreferrer" style={{ color: "var(--cm-accent)" }}>source</a></> : null}
      </div>
      <div className="nmc-panel-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.textPreview ?? ""}</ReactMarkdown>
      </div>
    </motion.aside>
  );
}
```
> Note: `node.textPreview` is the first 200 chars (derive-memory-graph). If full text is wanted in the panel, store full `text` on the node in a later iteration; v1 shows the preview (spec keeps full text out of the graph payload — §4).

- [ ] **Step 5: Write `MemorySearchBox.tsx`**

```tsx
// MemorySearchBox.tsx
import { useMemo, useState } from "react";
import type { MemoryNode } from "../../lib/memory-graph-types.js";

export function MemorySearchBox({ nodes, onSelect }: { nodes: MemoryNode[]; onSelect: (n: MemoryNode) => void }) {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return nodes
      .filter((n) =>
        n.label.toLowerCase().includes(needle) ||
        n.routePath.toLowerCase().includes(needle) ||
        n.textPreview.toLowerCase().includes(needle))
      .slice(0, 20);
  }, [q, nodes]);
  return (
    <div className="nmc-search">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory…" />
      {results.length > 0 && (
        <div className="nmc-results">
          {results.map((n) => (
            <button key={n.id} onClick={() => { onSelect(n); setQ(""); }}>
              <strong>{n.label}</strong>
              <span style={{ color: "#8b95a3" }}> — {n.routePath}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Write `MemoryLegend.tsx`**

```tsx
// MemoryLegend.tsx
import { routePathColor } from "./memory-theme.js";

export function MemoryLegend({ routes, nodeCount, linkCount }: { routes: string[]; nodeCount: number; linkCount: number }) {
  return (
    <div className="nmc-legend">
      <div style={{ marginBottom: 6 }}>{nodeCount} memories · {linkCount} links</div>
      {routes.map((r) => (
        <div key={r}><span className="swatch" style={{ background: routePathColor(r) }} />{r}</div>
      ))}
    </div>
  );
}
```

- [ ] **Step 7: Write `NamespaceMemoryConstellation.tsx`** (wires graph + interaction + bloom)

```tsx
// NamespaceMemoryConstellation.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import ForceGraph3D from "react-force-graph-3d";
import type { MemoryGraph, MemoryNode } from "../../lib/memory-graph-types.js";
import { routePathColor } from "./memory-theme.js";
import { createNodeObject } from "./memory-node-objects.js";
import { attachBloom } from "./memory-bloom.js";
import { MemoryChunkPanel } from "./MemoryChunkPanel.js";
import { MemorySearchBox } from "./MemorySearchBox.js";
import { MemoryLegend } from "./MemoryLegend.js";
import "./namespace-memory.css";

const SELECTIVE_BLOOM = false; // Task 7/8 decision — one source of truth.
const GRAPH_BG = "#0f1115";    // THREE.Color can't resolve `var(--…)`; use the literal.

function linkEndId(end: unknown): string {
  return typeof end === "object" && end !== null ? (end as { id: string }).id : (end as string);
}

export function NamespaceMemoryConstellation({ graph }: { graph: MemoryGraph }) {
  const fgRef = useRef<any>(null);
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const routes = useMemo(() => [...new Set(graph.nodes.map((n) => n.routePath))], [graph]);

  // id -> neighbour ids, for hover highlighting.
  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of graph.nodes) m.set(n.id, new Set());
    for (const l of graph.links) {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      m.get(s)?.add(t);
      m.get(t)?.add(s);
    }
    return m;
  }, [graph]);

  const isLit = useCallback(
    (id: string) => !hoverId || id === hoverId || (neighbours.get(hoverId)?.has(id) ?? false),
    [hoverId, neighbours],
  );

  useEffect(() => {
    attachBloom(fgRef.current);
    const controls = fgRef.current?.controls?.();
    if (controls && "autoRotate" in controls) {
      controls.autoRotate = !reducedMotion; // requires controlType="orbit" (OrbitControls)
      controls.autoRotateSpeed = 0.4;
    }
  }, [reducedMotion]);

  // Hover (spec §1.3): dim non-neighbour node sprites via 3d-force-graph's __threeObj.
  useEffect(() => {
    for (const n of graph.nodes) {
      const obj = (n as { __threeObj?: { material?: { opacity: number } } }).__threeObj;
      if (obj?.material) obj.material.opacity = isLit(n.id) ? 1 : 0.12;
    }
  }, [graph, isLit]);

  function focusNode(node: MemoryNode) {
    setSelected(node);
    const fg = fgRef.current;
    if (!fg) return;
    const n = node as unknown as { x: number; y: number; z: number };
    const dist = 120;
    const ratio = 1 + dist / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
    fg.cameraPosition({ x: (n.x || 0) * ratio, y: (n.y || 0) * ratio, z: (n.z || 0) * ratio }, n, reducedMotion ? 0 : 1200);
  }

  return (
    <div className="nmc-root">
      <MemorySearchBox nodes={graph.nodes} onSelect={focusNode} />
      <div className="nmc-canvas">
        <ForceGraph3D
          ref={fgRef}
          graphData={graph}
          controlType="orbit"
          backgroundColor={GRAPH_BG}
          nodeThreeObject={(n: any) => createNodeObject(n, routePathColor(n.routePath), SELECTIVE_BLOOM)}
          nodeLabel={(n: any) => n.label}
          onNodeHover={(n: any) => setHoverId(n ? n.id : null)}
          linkColor={(l: any) => {
            const lit = isLit(linkEndId(l.source)) && isLit(linkEndId(l.target));
            const base = l.kind === "spine" ? 0.5 : 0.18;
            return `rgba(168,217,70,${lit ? base : 0.04})`;
          }}
          linkWidth={(l: any) => (l.kind === "spine" ? 0.8 : 0.4)}
          onNodeClick={(n: any) => focusNode(n)}
          enableNodeDrag={false}
        />
      </div>
      <MemoryLegend routes={routes} nodeCount={graph.nodes.length} linkCount={graph.links.length} />
      <AnimatePresence>
        {selected && <MemoryChunkPanel node={selected} onClose={() => setSelected(null)} />}
      </AnimatePresence>
    </div>
  );
}
```
> Hover dims non-neighbour nodes (via 3d-force-graph's `__threeObj`) and fades non-incident links — satisfies spec §1.3. The DOM `nodeLabel` tooltip stays crisp (not bloomed). `__threeObj` access and `controlType="orbit"` auto-rotation are 3d-force-graph internals **validated in the Task 7 spike** — if `__threeObj` is unavailable, fall back to highlighting links only.

- [ ] **Step 8: Typecheck**

Run: `bun run --filter @contextmem/web typecheck`
Expected: exit 0. (Set `react-force-graph-3d` ref types to `any` as above; the wrapper's types are loose.)

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/main.tsx apps/web/src/styles.css apps/web/src/components/namespace-memory/
git commit -m "feat(web): namespace memory constellation components + styles"
```

---

## Task 10: Integration — route + page + ShowcasePage action

**Files:**
- Modify: `apps/web/src/main.tsx` (add page component, route ≈ 1256, card footer ≈ 1843)

- [ ] **Step 1: Add the page component** (model on `SharePage`, main.tsx:1343)

Add near the other page components in `main.tsx`:
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
Add imports at the top of `main.tsx`:
```ts
import { useNamespaceChunks } from "./hooks/use-namespace-chunks.js";
import { deriveMemoryGraph } from "./lib/derive-memory-graph.js";
import { NamespaceMemoryConstellation } from "./components/namespace-memory/NamespaceMemoryConstellation.js";
```
(`useMemo`, `useParams` are already imported in main.tsx.)

- [ ] **Step 2: Register the route** (after main.tsx:1256)

```tsx
<Route path="/showcase/:namespace" element={<NamespaceMemoryPage />} />
```

- [ ] **Step 3: Add the "Visualize memory" action to each card** (footer ≈ 1843–1846)

Inside the card `<footer>`, add (uses the already-imported `Link`):
```tsx
<Link to={`/showcase/${item.namespace}`}>Visualize memory</Link>
```

- [ ] **Step 4: Typecheck + build**

Run: `bun run --filter @contextmem/web typecheck && bun run --filter @contextmem/web build`
Expected: typecheck exit 0; `vite build` succeeds.

- [ ] **Step 5: Manual verification (chrome-devtools skill)**

Run `bun run --filter @contextmem/web dev`. With the API offline, open `/showcase/<any>` → mock constellation renders (glowing nodes, one connected globe). Click a node → panel opens with breadcrumb + preview. Type in search → camera flies to the result. Take a screenshot to confirm bloom + connectivity.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/main.tsx
git commit -m "feat(web): /showcase/:namespace route + Visualize memory action"
```

---

## Task 11: Full verification + finish

- [ ] **Step 1: Run the full suite + typecheck + build**

```bash
bunx vitest run
bun run --filter @contextmem/web typecheck
bun run --filter @contextmem/web build
```
Expected: all tests pass; typecheck exit 0; build succeeds.

- [ ] **Step 2: Walk the spec's success criteria (§1) — confirm each**

1. Fetches `chunks.ndjson` and renders (mock fallback offline) — Tasks 5, 10.
2. One connected component — Task 1 invariant test.
3. Hover dims/highlights neighbours — Task 9 Step 7 (implemented; `__threeObj` access validated in Task 7 spike).
4. Click opens panel (breadcrumb, route, text, URL) — Task 9 Step 4.
5. Search focuses camera — Task 9 Steps 5 + 7.
6. Bloom glows nodes; overlay/labels crisp — Tasks 7–8.
7. `prefers-reduced-motion` disables auto-rotation/fly — Task 9 Step 7.
8. Web typecheck clean; derive test passes; `vite build` succeeds — Task 11 Step 1.

- [ ] **Step 3: Finish the branch** — use the `superpowers:finishing-a-development-branch` skill to choose merge/PR.

---

## Self-review notes (author)

- **Spec coverage:** every §1 criterion maps to a task (see Task 11 Step 2). Criterion 3 (hover) is now a concrete step in Task 9; only the selective-bloom path stays conditional (gated behind the Task 7 spike — YAGNI), flagged not hidden.
- **Type consistency:** `ContextChunk`, `MemoryNode/Link/Graph`, `deriveMemoryGraph`, `parseChunksNdjson`, `routePathColor`, `sizeScale`, `createNodeObject`, `attachBloom`, `useNamespaceChunks`/`ChunksState`, `NamespaceMemoryConstellation` are used identically across tasks.
- **Honesty:** hook + `.tsx` + three.js are verified by typecheck/build/manual, not unit tests (no React test infra; adding it is out of scope). Backend test follows the existing `worker.test.ts` harness (read it first). The bloom recipe is a real spike (Task 7), not assumed.
- **Open decisions carried from spec review:** confirm no public-namespace artifact is sensitive (§12.5); panel shows `textPreview` not full text (payload, §4) — revisit if full text in-panel is required.
