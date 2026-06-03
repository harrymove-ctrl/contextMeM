import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentReadableSite } from "./package.js";
import { verifySnapshot } from "./snapshot.js";
import type { PageArtifact } from "./types.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function buildFixture(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cm-verify-"));
  dirs.push(dir);
  const pages: PageArtifact[] = [
    { url: "https://x.test/", routePath: "/", title: "Home", markdown: "# Home\n\nWelcome.\n\n## More\n\nDetails.", html: "<h1>Home</h1>", text: "Home", metadata: {}, links: [], images: [], contentHash: "a" }
  ];
  await buildAgentReadableSite({ runId: "verify", target: "https://x.test/", outputDir: dir, pages });
  return dir;
}

describe("verifySnapshot", () => {
  it("passes for an untouched package", async () => {
    const result = await verifySnapshot(await buildFixture());
    expect(result.ok).toBe(true);
    expect(result.artifactDigest.ok).toBe(true);
    expect(result.chunkGraphDigest.ok).toBe(true);
    expect(result.signature.present).toBe(false);
    expect(result.signature.ok).toBeNull();
  });

  it("fails and reports the file when an artifact is tampered", async () => {
    const dir = await buildFixture();
    await fs.writeFile(path.join(dir, "context", "sitemap.json"), '{"tampered":true}\n');
    const result = await verifySnapshot(dir);
    expect(result.ok).toBe(false);
    expect(result.artifactDigest.ok).toBe(false);
    expect(result.artifacts.mismatched).toContain("/context/sitemap.json");
  });

  it("detects a removed artifact", async () => {
    const dir = await buildFixture();
    await fs.rm(path.join(dir, "context", "images.json"));
    const result = await verifySnapshot(dir);
    expect(result.ok).toBe(false);
    expect(result.artifacts.missing).toContain("/context/images.json");
  });
});
