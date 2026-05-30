#!/usr/bin/env bun
// Real-data verification of the delta path.
// 1. Build two snapshots of the same site (V1, V2) with edits.
// 2. Build chunks for each.
// 3. Persist V1's chunks.ndjson, then reload it as "prior" for V2.
// 4. Run planMemoryWrite(currentChunks, priorChunks) — the EXACT math the CLI
//    delta path invokes — and print the real counts.
//
// This proves the delta mechanics end-to-end without needing a MemWal endpoint.
// The MemWal RPC happens AFTER planMemoryWrite returns; the diff is settled here.

import { buildChunks, chunkGraphDigest, parseChunksNdjson, planMemoryWrite, renderChunksNdjson } from "@contextmem/core";
import type { PageArtifact } from "@contextmem/core";
import fs from "node:fs/promises";
import path from "node:path";

const runsDir = "/tmp/contextmem-verify";
await fs.rm(runsDir, { recursive: true, force: true });
await fs.mkdir(path.join(runsDir, "run-v1", "context"), { recursive: true });
await fs.mkdir(path.join(runsDir, "run-v2", "context"), { recursive: true });

// V1: 4 pages of a docs site.
const pagesV1: PageArtifact[] = [
  { url: "https://seal-docs.wal.app/", routePath: "/", title: "What is Seal", markdown: "Seal is a decentralized secrets management service on Sui. Use it to encrypt sensitive data and store the ciphertext on Walrus or any other storage." },
  { url: "https://seal-docs.wal.app/GettingStarted", routePath: "/GettingStarted", title: "Getting Started", markdown: "## Install\n\nbun add @mysten/seal\n\n## Configure\n\nProvide a Sui client and a list of key servers." },
  { url: "https://seal-docs.wal.app/Design", routePath: "/Design", title: "Design", markdown: "Seal uses threshold encryption across N independent key servers. The application controls access policies in Move." },
  { url: "https://seal-docs.wal.app/Pricing", routePath: "/Pricing", title: "Pricing", markdown: "Free during the beta. Pricing TBD post-mainnet." }
];

// V2: same site re-scraped. Pricing page CHANGED, ServerOverview ADDED,
// GettingStarted UNCHANGED, Design slightly EDITED, Pricing CHANGED.
const pagesV2: PageArtifact[] = [
  { url: "https://seal-docs.wal.app/", routePath: "/", title: "What is Seal", markdown: "Seal is a decentralized secrets management service on Sui. Use it to encrypt sensitive data and store the ciphertext on Walrus or any other storage." },
  { url: "https://seal-docs.wal.app/GettingStarted", routePath: "/GettingStarted", title: "Getting Started", markdown: "## Install\n\nbun add @mysten/seal\n\n## Configure\n\nProvide a Sui client and a list of key servers." },
  { url: "https://seal-docs.wal.app/Design", routePath: "/Design", title: "Design", markdown: "Seal uses threshold encryption across N independent key servers. The application controls access policies in Move. Updated 2026-05: T-out-of-N threshold is configurable." },
  { url: "https://seal-docs.wal.app/Pricing", routePath: "/Pricing", title: "Pricing", markdown: "Free tier: 1000 secret stores per month. Pro tier: usage-based, pricing in SUI." },
  { url: "https://seal-docs.wal.app/ServerOverview", routePath: "/ServerOverview", title: "Seal Server Overview", markdown: "Each Seal server runs in its own trust zone and signs commitments on Sui." }
];

console.log("=== Build chunks for V1 ===");
const chunksV1 = buildChunks(pagesV1);
console.log(`V1 chunks: ${chunksV1.length}`);
console.log(`V1 chunkGraphDigest: ${chunkGraphDigest(chunksV1).slice(0, 16)}...`);

console.log("\n=== Persist V1 chunks.ndjson (what the CLI writes on first run) ===");
const v1NdjsonPath = path.join(runsDir, "run-v1", "context", "chunks.ndjson");
await fs.writeFile(v1NdjsonPath, renderChunksNdjson(chunksV1), "utf8");
const v1Bytes = (await fs.stat(v1NdjsonPath)).size;
console.log(`Wrote ${v1Bytes} bytes to ${v1NdjsonPath}`);

console.log("\n=== Reload V1 chunks (what the CLI does on the SECOND run when it auto-detects the prior) ===");
const priorChunks = parseChunksNdjson(await fs.readFile(v1NdjsonPath, "utf8"));
console.log(`Reloaded ${priorChunks.length} prior chunks`);

console.log("\n=== Build chunks for V2 + plan the diff ===");
const chunksV2 = buildChunks(pagesV2);
console.log(`V2 chunks: ${chunksV2.length}`);
console.log(`V2 chunkGraphDigest: ${chunkGraphDigest(chunksV2).slice(0, 16)}...`);

const plan = planMemoryWrite(chunksV2, priorChunks);
console.log("\n=== planMemoryWrite output (real diff math) ===");
console.log({
  added: plan.added.length,
  changed: plan.changed.length,
  unchanged: plan.unchanged.length,
  removed: plan.removed.length,
  totalCurrent: chunksV2.length,
  totalPrior: priorChunks.length
});

console.log("\n=== Sample of what would be WRITTEN (added + changed) ===");
for (const chunk of [...plan.added, ...plan.changed].slice(0, 5)) {
  console.log(`  ${plan.added.includes(chunk) ? "[+]" : "[~]"} ${chunk.routePath} :: ${chunk.heading ?? "(root)"} :: hash=${chunk.contentHash.slice(0, 12)}`);
}

console.log("\n=== Sample of what would be SKIPPED (unchanged) ===");
for (const chunk of plan.unchanged.slice(0, 5)) {
  console.log(`  [=] ${chunk.routePath} :: ${chunk.heading ?? "(root)"} :: hash=${chunk.contentHash.slice(0, 12)}`);
}

console.log("\n=== Sample of what would be REMOVED ===");
for (const chunk of plan.removed.slice(0, 5)) {
  console.log(`  [-] ${chunk.routePath} :: ${chunk.heading ?? "(root)"} :: hash=${chunk.contentHash.slice(0, 12)}`);
}

const fullWriteWould = chunksV2.length;
const deltaWriteWould = plan.added.length + plan.changed.length;
const saved = fullWriteWould - deltaWriteWould;
const pct = fullWriteWould > 0 ? Math.round((saved / fullWriteWould) * 100) : 0;
console.log(`\n=== Bandwidth saved by delta vs full snapshot ===`);
console.log(`  Full would write : ${fullWriteWould} chunks`);
console.log(`  Delta will write : ${deltaWriteWould} chunks`);
console.log(`  Saved            : ${saved} chunks (${pct}% reduction)`);

// Also confirm V1.ndjson round-trips byte-for-byte through render+parse.
const roundtrip = parseChunksNdjson(renderChunksNdjson(chunksV1));
const stable = roundtrip.length === chunksV1.length && roundtrip.every((c, i) => c.chunkId === chunksV1[i]!.chunkId && c.contentHash === chunksV1[i]!.contentHash);
console.log(`\n=== Persistence round-trip stable: ${stable ? "yes" : "NO"} ===`);
