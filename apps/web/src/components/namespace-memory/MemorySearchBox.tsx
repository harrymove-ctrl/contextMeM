import { useMemo, useState } from "react";
import type { MemoryNode } from "../../lib/memory-graph-types.js";

export function MemorySearchBox({ nodes, onSelect }: { nodes: MemoryNode[]; onSelect: (n: MemoryNode) => void }) {
  const [q, setQ] = useState("");
  // Lowercase the full-text haystack once per graph, not on every keystroke.
  const haystacks = useMemo(
    () => nodes.map((n) => `${n.label} ${n.routePath} ${n.text}`.toLowerCase()),
    [nodes],
  );
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return nodes.filter((_, i) => haystacks[i]!.includes(needle)).slice(0, 20);
  }, [q, nodes, haystacks]);
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
