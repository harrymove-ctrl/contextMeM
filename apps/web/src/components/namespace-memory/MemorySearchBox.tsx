import { useMemo, useState } from "react";
import type { MemoryNode } from "../../lib/memory-graph-types.js";

export function MemorySearchBox({ nodes, onSelect }: { nodes: MemoryNode[]; onSelect: (n: MemoryNode) => void }) {
  const [q, setQ] = useState("");
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return nodes
      .filter((n) =>
        n.label.toLowerCase().includes(needle) ||
        n.routePath.toLowerCase().includes(needle) ||
        n.textPreview.toLowerCase().includes(needle))
      .slice(0, 20);
  }, [q, nodes]);
  return (
    <div className="nmc-search">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory…" />
      {results.length > 0 && (
        <div className="nmc-results">
          {results.map((n) => (
            <button key={n.id} onClick={() => { onSelect(n); setQ(""); }}>
              <strong>{n.label}</strong>
              <span style={{ color: "#8b95a3" }}> — {n.routePath}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
