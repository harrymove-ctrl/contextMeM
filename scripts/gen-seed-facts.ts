// Regenerate apps/api/src/seed-facts.ts from every seed/facts.*.json so the
// worker-bundled demo facts never drift from seed/.
//   bun run scripts/gen-seed-facts.ts
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SEED = path.join(ROOT, "seed");

const nsMeta = JSON.parse(fs.readFileSync(path.join(SEED, "namespaces.json"), "utf8")).namespaces as Array<{
  namespace: string;
  displayName?: string;
  category?: string;
}>;
const nsByName = new Map(nsMeta.map((n) => [n.namespace, n]));

const factsFiles = fs
  .readdirSync(SEED)
  .filter((f) => f.startsWith("facts.") && f.endsWith(".json"))
  .sort();

const entries: string[] = [];
const list: Array<{ namespace: string; displayName: string; target: string; entities: number; relationships: number; topics: number; questions: number; category: string }> = [];

for (const file of factsFiles) {
  const slug = file.replace(/^facts\./, "").replace(/\.json$/, "");
  const ns = `demo:${slug}`;
  const facts = JSON.parse(fs.readFileSync(path.join(SEED, file), "utf8"));
  const meta = nsByName.get(ns) ?? {};
  entries.push(`  ${JSON.stringify(ns)}: ${JSON.stringify(facts)}`);
  list.push({
    namespace: ns,
    displayName: meta.displayName ?? facts.identity?.name ?? slug,
    target: facts.target,
    entities: facts.entities?.length ?? 0,
    relationships: facts.relationships?.length ?? 0,
    topics: facts.topics?.length ?? 0,
    questions: facts.questions?.length ?? 0,
    category: meta.category ?? "web3"
  });
}

const out =
  `// AUTO-GENERATED from seed/facts.*.json by scripts/gen-seed-facts.ts — DO NOT EDIT BY HAND.\n` +
  `// Embedded so the (fs-less) Worker can serve the seeded SiteFacts publicly without a build.\n` +
  `// Regenerate after editing seed/: bun run scripts/gen-seed-facts.ts\n` +
  `import type { SiteFacts } from "@contextmem/core";\n\n` +
  `export const SEED_FACTS: Record<string, SiteFacts> = {\n${entries.join(",\n")}\n} as unknown as Record<string, SiteFacts>;\n\n` +
  `export const SEED_FACTS_LIST = ${JSON.stringify(list, null, 2)} as const;\n`;

const target = path.join(ROOT, "apps/api/src/seed-facts.ts");
fs.writeFileSync(target, out);
console.log(`wrote ${path.relative(ROOT, target)} (${(out.length / 1024).toFixed(1)}KB, ${list.length} namespaces)`);
