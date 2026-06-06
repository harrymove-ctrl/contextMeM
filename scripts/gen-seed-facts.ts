// Regenerate apps/api/src/seed-facts.ts from the committed seed/ fixtures so the
// worker-bundled demo facts never drift from seed/facts.*.json.
//   bun run scripts/gen-seed-facts.ts
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SLUGS = ["sui-docs", "walrus-docs", "seal-docs"] as const;

const nsMeta = JSON.parse(fs.readFileSync(path.join(ROOT, "seed/namespaces.json"), "utf8")).namespaces as Array<{
  namespace: string;
  displayName?: string;
}>;

const entries: string[] = [];
const list: Array<{ namespace: string; displayName: string; target: string; entities: number; relationships: number; topics: number; questions: number }> = [];

for (const slug of SLUGS) {
  const ns = `demo:${slug}`;
  const facts = JSON.parse(fs.readFileSync(path.join(ROOT, `seed/facts.${slug}.json`), "utf8"));
  const meta = nsMeta.find((n) => n.namespace === ns) ?? {};
  entries.push(`  ${JSON.stringify(ns)}: ${JSON.stringify(facts)}`);
  list.push({
    namespace: ns,
    displayName: meta.displayName ?? slug,
    target: facts.target,
    entities: facts.entities?.length ?? 0,
    relationships: facts.relationships?.length ?? 0,
    topics: facts.topics?.length ?? 0,
    questions: facts.questions?.length ?? 0
  });
}

const out =
  `// AUTO-GENERATED from seed/facts.*.json by scripts/gen-seed-facts.ts — DO NOT EDIT BY HAND.\n` +
  `// Embedded so the (fs-less) Worker can serve the seeded Sui/Walrus/Seal SiteFacts publicly\n` +
  `// without a build. Regenerate after editing seed/: bun run scripts/gen-seed-facts.ts\n` +
  `import type { SiteFacts } from "@contextmem/core";\n\n` +
  `export const SEED_FACTS: Record<string, SiteFacts> = {\n${entries.join(",\n")}\n} as unknown as Record<string, SiteFacts>;\n\n` +
  `export const SEED_FACTS_LIST = ${JSON.stringify(list, null, 2)} as const;\n`;

const target = path.join(ROOT, "apps/api/src/seed-facts.ts");
fs.writeFileSync(target, out);
console.log(`wrote ${path.relative(ROOT, target)} (${(out.length / 1024).toFixed(1)}KB, ${list.length} namespaces)`);
