import { describe, expect, it } from "vitest";
import { deriveQuiltPatchId } from "./quilt.js";

describe("deriveQuiltPatchId", () => {
  it("derives a stable 50-character patch id", () => {
    const id = deriveQuiltPatchId("BjJAfHLJKMDZ0tFZaLKVw0R74re5RG65-xNhaZ5uwow", "0x0101000200");
    expect(id).toHaveLength(50);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
