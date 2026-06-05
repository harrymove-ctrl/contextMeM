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
