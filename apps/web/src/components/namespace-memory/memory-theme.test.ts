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
