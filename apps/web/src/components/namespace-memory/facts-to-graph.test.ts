import { describe, it, expect } from "vitest";
import { factsToMemoryGraph } from "./facts-to-graph.js";

const ent = (id: string, salience = 0.5, type = "concept") => ({ id, name: id.toUpperCase(), type, salience });
const rel = (sourceEntityId: string, targetEntityId: string) => ({ sourceEntityId, targetEntityId });

describe("factsToMemoryGraph", () => {
  it("maps entities to labelled nodes keyed/coloured by type, sized by salience", () => {
    const g = factsToMemoryGraph([ent("a", 1, "product"), ent("b", 0.5, "feature")], []);
    expect(g.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(g.nodes[0]).toMatchObject({ label: "A", routePath: "product" });
    // higher salience must render a bigger node, else the constellation can't convey importance
    expect(g.nodes[0]!.val).toBeGreaterThan(g.nodes[1]!.val);
  });

  it("keeps only relationships between kept nodes and drops self-loops", () => {
    const g = factsToMemoryGraph([ent("a"), ent("b")], [rel("a", "b"), rel("a", "ghost"), rel("a", "a")]);
    expect(g.links).toHaveLength(1);
    expect(g.links[0]).toMatchObject({ source: "a", target: "b" });
  });

  it("preserves relationship kind/label/confidence so edges can be typed and explained", () => {
    // The richest part of the data — discarding it is what made the old graph read as undifferentiated lines.
    const g = factsToMemoryGraph(
      [ent("a"), ent("b")],
      [{ sourceEntityId: "a", targetEntityId: "b", kind: "built_with", label: "binds blobs to Sui", confidence: 0.9 }],
    );
    expect(g.links[0]).toMatchObject({ relKind: "built_with", relLabel: "binds blobs to Sui", confidence: 0.9 });
  });

  it("marks the identity entity as primary, falling back to the highest-salience node", () => {
    const entities = [ent("a", 0.4), ent("b", 0.9)];
    // explicit identity wins even if it isn't the most salient
    expect(factsToMemoryGraph(entities, [], "a").nodes.find((n) => n.id === "a")!.primary).toBe(true);
    // no identity -> the top-salience node becomes the focal point
    const fallback = factsToMemoryGraph(entities, []);
    expect(fallback.nodes.find((n) => n.id === "b")!.primary).toBe(true);
    expect(fallback.nodes.find((n) => n.id === "a")!.primary).toBe(false);
  });

  it("caps at 40 highest-salience nodes and drops links that reference a dropped node", () => {
    const entities = Array.from({ length: 45 }, (_, i) => ent(`e${i}`, i)); // salience 0..44
    const g = factsToMemoryGraph(entities, [rel("e0", "e44")]); // e0 is lowest salience -> dropped
    expect(g.nodes).toHaveLength(40);
    expect(g.nodes.some((n) => n.id === "e0")).toBe(false);
    expect(g.links).toHaveLength(0);
  });

  it("returns an empty graph when there are no entities", () => {
    expect(factsToMemoryGraph([], [rel("a", "b")])).toEqual({ nodes: [], links: [] });
  });
});
