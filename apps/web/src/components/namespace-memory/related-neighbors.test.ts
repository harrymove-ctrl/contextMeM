import { describe, it, expect } from "vitest";
import { relatedNeighbors } from "./related-neighbors.js";
import type { MemoryGraph } from "../../lib/memory-graph-types.js";

const node = (id: string) => ({ id, label: id, routePath: "concept", headingPath: [], text: "", byteLength: 0, order: 0, val: 1 });
const graph = (links: MemoryGraph["links"]): MemoryGraph => ({
  nodes: [node("a"), node("b"), node("c")],
  links,
});

describe("relatedNeighbors", () => {
  it("collapses two edges between the same pair into one neighbour, keeping the strongest", () => {
    // The exact regression that caused duplicate React keys + a ghost row: a offers b
    // AND b depends_on a both surface b as a's neighbour. Must dedupe to one entry.
    const r = relatedNeighbors(
      graph([
        { source: "a", target: "b", kind: "spine", relKind: "offers", confidence: 0.9 },
        { source: "b", target: "a", kind: "spine", relKind: "depends_on", confidence: 0.82 },
      ]),
      "a",
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ relKind: "offers", confidence: 0.9 }); // strongest edge wins
  });

  it("tags direction relative to the selected node so the relationship reads truthfully", () => {
    const r = relatedNeighbors(graph([{ source: "a", target: "b", kind: "spine", relKind: "offers", confidence: 0.9 }]), "b");
    // selected 'b' is the target → the edge points inward
    expect(r[0]).toMatchObject({ direction: "in", relKind: "offers" });
  });

  it("orders neighbours by confidence desc", () => {
    const r = relatedNeighbors(
      graph([
        { source: "a", target: "b", kind: "spine", confidence: 0.4 },
        { source: "a", target: "c", kind: "spine", confidence: 0.95 },
      ]),
      "a",
    );
    expect(r.map((n) => n.node.id)).toEqual(["c", "b"]);
  });
});
