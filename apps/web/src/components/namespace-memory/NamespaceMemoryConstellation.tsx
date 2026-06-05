import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import ForceGraph3D from "react-force-graph-3d";
import type { MemoryGraph, MemoryNode } from "../../lib/memory-graph-types.js";
import { routePathColor } from "./memory-theme.js";
import { createNodeObject } from "./memory-node-objects.js";
import { attachBloom } from "./memory-bloom.js";
import { MemoryChunkPanel } from "./MemoryChunkPanel.js";
import { MemorySearchBox } from "./MemorySearchBox.js";
import { MemoryLegend } from "./MemoryLegend.js";
import "./namespace-memory.css";

const SELECTIVE_BLOOM = false; // Task 7/8 decision — one source of truth.
const GRAPH_BG = "#0f1115";    // THREE.Color can't resolve var(--…); use the literal.

function linkEndId(end: unknown): string {
  return typeof end === "object" && end !== null ? (end as { id: string }).id : (end as string);
}

export function NamespaceMemoryConstellation({ graph }: { graph: MemoryGraph }) {
  const fgRef = useRef<any>(null);
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const reducedMotion = useMemo(
    () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
    [],
  );
  const routes = useMemo(() => [...new Set(graph.nodes.map((n) => n.routePath))], [graph]);

  const neighbours = useMemo(() => {
    const m = new Map<string, Set<string>>();
    for (const n of graph.nodes) m.set(n.id, new Set());
    for (const l of graph.links) {
      const s = linkEndId(l.source);
      const t = linkEndId(l.target);
      m.get(s)?.add(t);
      m.get(t)?.add(s);
    }
    return m;
  }, [graph]);

  const isLit = useCallback(
    (id: string) => !hoverId || id === hoverId || (neighbours.get(hoverId)?.has(id) ?? false),
    [hoverId, neighbours],
  );

  useEffect(() => {
    attachBloom(fgRef.current);
    const controls = fgRef.current?.controls?.();
    if (controls && "autoRotate" in controls) {
      controls.autoRotate = !reducedMotion; // requires controlType="orbit"
      controls.autoRotateSpeed = 0.4;
    }
  }, [reducedMotion]);

  useEffect(() => {
    for (const n of graph.nodes) {
      const obj = (n as { __threeObj?: { material?: { opacity: number } } }).__threeObj;
      if (obj?.material) obj.material.opacity = isLit(n.id) ? 1 : 0.12;
    }
  }, [graph, isLit]);

  function focusNode(node: MemoryNode) {
    setSelected(node);
    const fg = fgRef.current;
    if (!fg) return;
    const n = node as unknown as { x: number; y: number; z: number };
    const dist = 120;
    const ratio = 1 + dist / Math.hypot(n.x || 1, n.y || 1, n.z || 1);
    fg.cameraPosition({ x: (n.x || 0) * ratio, y: (n.y || 0) * ratio, z: (n.z || 0) * ratio }, n, reducedMotion ? 0 : 1200);
  }

  return (
    <div className="nmc-root">
      <MemorySearchBox nodes={graph.nodes} onSelect={focusNode} />
      <div className="nmc-canvas">
        <ForceGraph3D
          ref={fgRef}
          graphData={graph}
          controlType="orbit"
          backgroundColor={GRAPH_BG}
          nodeThreeObject={(n: any) => createNodeObject(n, routePathColor(n.routePath), SELECTIVE_BLOOM)}
          nodeLabel={(n: any) => n.label}
          onNodeHover={(n: any) => setHoverId(n ? n.id : null)}
          linkColor={(l: any) => {
            const lit = isLit(linkEndId(l.source)) && isLit(linkEndId(l.target));
            const base = l.kind === "spine" ? 0.5 : 0.18;
            return `rgba(168,217,70,${lit ? base : 0.04})`;
          }}
          linkWidth={(l: any) => (l.kind === "spine" ? 0.8 : 0.4)}
          onNodeClick={(n: any) => focusNode(n)}
          enableNodeDrag={false}
        />
      </div>
      <MemoryLegend routes={routes} nodeCount={graph.nodes.length} linkCount={graph.links.length} />
      <AnimatePresence>
        {selected && <MemoryChunkPanel node={selected} onClose={() => setSelected(null)} />}
      </AnimatePresence>
    </div>
  );
}
