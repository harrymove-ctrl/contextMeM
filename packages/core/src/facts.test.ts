import { describe, expect, it } from "vitest";
import { buildChunks, normalizeText } from "./chunks.js";
import {
  buildSiteFacts,
  generateContextQuestions,
  entityId,
  validateQuote,
  type FactsModel,
  type FactSourceRef,
  type SiteFacts
} from "./facts.js";
import type { ContextChunk, PageArtifact } from "./types.js";

function page(routePath: string, markdown: string, title = routePath): PageArtifact {
  return {
    url: `https://acme.test${routePath === "/" ? "" : routePath}`,
    routePath,
    title,
    markdown,
    html: "",
    text: "",
    metadata: { title },
    links: [],
    images: [],
    contentHash: ""
  };
}

const PAGES: PageArtifact[] = [
  page(
    "/",
    "# Acme Cloud\n\nAcme Cloud is a decentralized storage platform for developers and enterprises. It offers 99.99% uptime and stores over 10,000+ blobs."
  ),
  page("/pricing", "# Pricing\n\nAcme Cloud costs $0.01/GB for blob storage. Plans start free for developers."),
  page("/docs", "# Docs\n\nAcme Cloud integrates with Sui and the Walrus protocol. Get started by installing the Acme SDK.")
];

const CHUNKS = buildChunks(PAGES);

/** Collect every source ref across all fact-bearing nodes + questions. */
function allSources(facts: SiteFacts, questions: SiteFacts["questions"] = facts.questions): Array<{ ref: FactSourceRef; chunk: ContextChunk | undefined }> {
  const byId = new Map(CHUNKS.map((chunk) => [chunk.chunkId, chunk]));
  const refs: FactSourceRef[] = [
    ...facts.identity.sources,
    ...facts.entities.flatMap((entity) => entity.sources),
    ...facts.claims.flatMap((claim) => claim.sources),
    ...facts.stats.flatMap((stat) => stat.sources),
    ...questions.flatMap((question) => question.sources)
  ];
  return refs.map((ref) => ({ ref, chunk: ref.chunkId ? byId.get(ref.chunkId) : undefined }));
}

describe("validateQuote", () => {
  it("treats whitespace-normalized substrings as grounded and rejects fabrications", () => {
    const chunk = "Acme   Cloud is a\ndecentralized storage platform.";
    expect(validateQuote("Acme Cloud is a decentralized storage", chunk)).toBe(true);
    expect(validateQuote("Acme Cloud is the WORLD'S BEST storage", chunk)).toBe(false);
    expect(validateQuote("", chunk)).toBe(false);
    expect(validateQuote("x".repeat(241), `${"x".repeat(241)} extra`)).toBe(false); // over 240 chars
  });
});

describe("buildSiteFacts heuristic fallback (no model)", () => {
  it("emits only grounded facts — every source quote is a substring of its cited chunk", async () => {
    const facts = await buildSiteFacts("https://acme.test", PAGES, CHUNKS);
    expect(facts.usedProvider).toBe("heuristic");
    expect(facts.schemaVersion).toBe(2);
    const sources = allSources(facts);
    expect(sources.length).toBeGreaterThan(0);
    for (const { ref, chunk } of sources) {
      expect(chunk, `source must cite a real chunk: ${ref.chunkId}`).toBeDefined();
      expect(validateQuote(ref.quote, chunk!.text)).toBe(true);
    }
  });

  it("derives stats by regex with grounded sources", async () => {
    const facts = await buildSiteFacts("https://acme.test", PAGES, CHUNKS);
    const values = facts.stats.map((stat) => stat.valueRaw);
    expect(values.some((value) => /99\.99\s*%/.test(value))).toBe(true);
    expect(values.some((value) => /\$\s?0\.01/.test(value))).toBe(true);
    for (const stat of facts.stats) {
      expect(stat.sources.length).toBeGreaterThan(0);
      const chunk = CHUNKS.find((candidate) => candidate.chunkId === stat.sources[0]!.chunkId);
      expect(validateQuote(stat.sources[0]!.quote, chunk!.text)).toBe(true);
    }
  });

  it("produces stable ids and identical facts (minus timestamp) across reruns", async () => {
    const a = await buildSiteFacts("https://acme.test", PAGES, CHUNKS);
    const b = await buildSiteFacts("https://acme.test", PAGES, CHUNKS);
    expect(a.entities.map((entity) => entity.id)).toEqual(b.entities.map((entity) => entity.id));
    expect(a.claims.map((claim) => claim.id)).toEqual(b.claims.map((claim) => claim.id));
    expect(a.stats.map((stat) => stat.id)).toEqual(b.stats.map((stat) => stat.id));
    const strip = (facts: SiteFacts) => ({ ...facts, generatedAt: "" });
    expect(strip(a)).toEqual(strip(b));
  });
});

describe("generateContextQuestions heuristic fallback (no model)", () => {
  it("produces the 5 canonical questions, each grounded or flagged as a coverage gap", async () => {
    const facts = await buildSiteFacts("https://acme.test", PAGES, CHUNKS);
    const questions = await generateContextQuestions("https://acme.test", CHUNKS, facts);
    expect(questions.length).toBe(5);
    expect(questions.map((question) => question.category)).toEqual([
      "what_is_it",
      "who_is_it_for",
      "how_it_works",
      "pricing",
      "getting_started"
    ]);
    for (const question of questions) {
      if (question.unanswerable) {
        expect(question.sources.length).toBe(0);
      } else {
        expect(question.sources.length).toBeGreaterThan(0);
        const byId = new Map(CHUNKS.map((chunk) => [chunk.chunkId, chunk]));
        for (const source of question.sources) {
          const chunk = byId.get(source.chunkId!);
          expect(validateQuote(source.quote, chunk!.text)).toBe(true);
        }
      }
    }
  });

  it("keeps question ids stable across reruns", async () => {
    const facts = await buildSiteFacts("https://acme.test", PAGES, CHUNKS);
    const a = await generateContextQuestions("https://acme.test", CHUNKS, facts);
    const b = await generateContextQuestions("https://acme.test", CHUNKS, facts);
    expect(a.map((question) => question.id)).toEqual(b.map((question) => question.id));
  });
});

describe("buildSiteFacts LLM pass + the no-hallucination gate", () => {
  it("drops facts whose quote is NOT a substring of the cited chunk and counts them in ungroundedDropped", async () => {
    const realChunk = CHUNKS[0]!;
    const realQuote = normalizeText(realChunk.text).slice(0, 60);
    const model: FactsModel = {
      provider: "openai-compatible",
      complete: async () => ({
        entities: [
          // GROUNDED: quote is a real substring of the cited chunk.
          { name: "Acme Cloud", type: "organization", chunkIds: [realChunk.chunkId], quote: realQuote },
          // FABRICATED: quote is NOT in the chunk -> must be dropped + counted.
          { name: "Ghost Corp", type: "organization", chunkIds: [realChunk.chunkId], quote: "Acme Cloud is powered by fairy dust and unicorns." }
        ],
        claims: [
          // FABRICATED claim -> dropped.
          { text: "Acme is the #1 fastest storage in the universe", kind: "value_prop", chunkIds: [realChunk.chunkId], quote: "guaranteed to be the fastest in the entire universe" }
        ],
        stats: [],
        relationships: []
      })
    };
    const facts = await buildSiteFacts("https://acme.test", PAGES, CHUNKS, { model });
    expect(facts.usedProvider).toBe("openai-compatible");
    // Only the grounded entity survives.
    expect(facts.entities.map((entity) => entity.name)).toContain("Acme Cloud");
    expect(facts.entities.map((entity) => entity.name)).not.toContain("Ghost Corp");
    // The fabricated entity + fabricated claim are both counted.
    expect(facts.coverage.ungroundedDropped).toBeGreaterThanOrEqual(2);
    // Every surviving source still passes the substring check.
    for (const { ref, chunk } of allSources(facts, [])) {
      expect(chunk).toBeDefined();
      expect(validateQuote(ref.quote, chunk!.text)).toBe(true);
    }
  });

  it("uses the documented stable entity id derivation", () => {
    expect(entityId("organization", "Acme Cloud")).toBe(entityId("organization", "  acme   cloud "));
    expect(entityId("organization", "Acme Cloud")).not.toBe(entityId("product", "Acme Cloud"));
    expect(entityId("organization", "Acme Cloud")).toHaveLength(12);
  });

  it("falls back to heuristic facts when the model throws (run never fails)", async () => {
    const model: FactsModel = {
      provider: "workers-ai",
      complete: async () => {
        throw new Error("model exploded");
      }
    };
    const facts = await buildSiteFacts("https://acme.test", PAGES, CHUNKS, { model });
    expect(facts.usedProvider).toBe("heuristic");
    expect(facts.entities.length).toBeGreaterThan(0);
  });
});
