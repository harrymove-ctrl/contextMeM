import { describe, it, expect } from "vitest";
import { buildEntityDetail } from "./entity-detail.js";

const claim = (subjectEntityId: string, text: string, confidence: number) =>
  ({ subjectEntityId, text, kind: "value_prop", sentiment: "positive" as const, confidence });

describe("buildEntityDetail", () => {
  it("joins claims/stats by subjectEntityId and inverts topics onto member entities", () => {
    const detail = buildEntityDetail(
      [{ id: "a", aliases: ["Acme Inc"] }],
      [claim("a", "fast", 0.9)],
      [{ subjectEntityId: "a", label: "uptime", valueRaw: "99.9%" }],
      [{ label: "Reliability", entityIds: ["a"] }],
    );
    const a = detail.get("a")!;
    expect(a.aliases).toEqual(["Acme Inc"]);
    expect(a.topics).toEqual(["Reliability"]); // topic.entityIds is inverted into per-entity topic labels
    expect(a.claims).toEqual([{ text: "fast", kind: "value_prop", sentiment: "positive" }]);
    expect(a.stats).toEqual([{ value: "99.9%", label: "uptime" }]); // valueRaw surfaces as the display value
  });

  it("omits entities with no detail so the panel renders a section only when there is data", () => {
    // 'b' has no aliases/topics/claims/stats — it must not get an entry at all.
    const detail = buildEntityDetail([{ id: "b" }], [claim("a", "x", 0.5)], [], []);
    expect(detail.has("b")).toBe(false);
  });

  it("orders claims by confidence desc so the most-trusted claims read first", () => {
    const detail = buildEntityDetail(
      [{ id: "a" }],
      [claim("a", "low", 0.2), claim("a", "high", 0.95), claim("a", "mid", 0.6)],
      [],
      [],
    );
    expect(detail.get("a")!.claims.map((c) => c.text)).toEqual(["high", "mid", "low"]);
  });
});
