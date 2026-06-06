import { describe, expect, it } from "vitest";
import { routePathColor } from "./memory-theme.js";

describe("routePathColor", () => {
  it("is deterministic for the same route", () => {
    expect(routePathColor("/guide/auth")).toBe(routePathColor("/guide/auth"));
  });
  it("returns an hsl() string", () => {
    expect(routePathColor("/")).toMatch(/^hsl\(\d+(\.\d+)?, \d+%, \d+%\)$/);
  });
  it("usually differs between different routes", () => {
    expect(routePathColor("/a")).not.toBe(routePathColor("/b"));
  });
});
