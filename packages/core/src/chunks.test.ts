import { describe, expect, it } from "vitest";
import { buildChunks, chunkGraphDigest, planMemoryWrite } from "./chunks.js";
import type { PageArtifact } from "./types.js";

function page(routePath: string, markdown: string): PageArtifact {
  return { url: `https://x.test${routePath}`, routePath, title: routePath, markdown, html: "", text: "", metadata: {}, links: [], images: [], contentHash: "" };
}

describe("buildChunks", () => {
  it("produces deterministic chunkIds across rebuilds", () => {
    const pages = [page("/", "# Home\n\nIntro.\n\n## Features\n\nFast.")];
    const a = buildChunks(pages);
    const b = buildChunks(pages);
    expect(a.map((c) => c.chunkId)).toEqual(b.map((c) => c.chunkId));
    expect(a.length).toBe(2);
  });

  it("keeps chunkId stable when content is edited but updates contentHash", () => {
    const before = buildChunks([page("/", "# Home\n\nOriginal body.")]);
    const after = buildChunks([page("/", "# Home\n\nEdited body.")]);
    expect(after[0]?.chunkId).toBe(before[0]?.chunkId);
    expect(after[0]?.contentHash).not.toBe(before[0]?.contentHash);
  });
});

describe("planMemoryWrite", () => {
  it("classifies added, changed, unchanged, and removed chunks", () => {
    const prior = buildChunks([page("/", "# Home\n\nIntro.\n\n## Old\n\nGone soon.")]);
    const current = buildChunks([page("/", "# Home\n\nIntro edited.\n\n## New\n\nFresh.")]);
    const plan = planMemoryWrite(current, prior);
    // "/ > Home" intro chunk keeps its id but content changed.
    expect(plan.changed.length).toBe(1);
    // "## New" is a new heading location.
    expect(plan.added.length).toBe(1);
    // "## Old" location disappeared.
    expect(plan.removed.length).toBe(1);
  });

  it("reports everything unchanged when content is identical", () => {
    const chunks = buildChunks([page("/", "# Home\n\nStable.")]);
    const plan = planMemoryWrite(chunks, chunks);
    expect(plan.unchanged.length).toBe(chunks.length);
    expect(plan.added.length + plan.changed.length + plan.removed.length).toBe(0);
  });
});

describe("chunkGraphDigest", () => {
  it("is stable for identical content and changes when content changes", () => {
    const a = buildChunks([page("/", "# Home\n\nBody.")]);
    const b = buildChunks([page("/", "# Home\n\nBody.")]);
    const c = buildChunks([page("/", "# Home\n\nDifferent.")]);
    expect(chunkGraphDigest(a)).toBe(chunkGraphDigest(b));
    expect(chunkGraphDigest(a)).not.toBe(chunkGraphDigest(c));
  });
});
