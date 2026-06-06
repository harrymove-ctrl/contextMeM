import { useMemo } from "react";
import { useNamespaceChunks } from "../../hooks/use-namespace-chunks.js";
import { deriveMemoryGraph } from "../../lib/derive-memory-graph.js";
import { NamespaceMemoryConstellation } from "./NamespaceMemoryConstellation.js";

export function MemoryView({ namespace, onChange }: { namespace: string; onChange: () => void }) {
  const state = useNamespaceChunks(namespace);
  const graph = useMemo(
    () => (state.status === "ready" ? deriveMemoryGraph(state.chunks) : null),
    [state],
  );

  return (
    <>
      <header className="nmc-view-head">
        <span className="nmc-view-ns">{namespace}</span>
        <button type="button" className="secondary" onClick={onChange}>Change namespace</button>
      </header>
      <div className="nmc-host">
        {state.status === "loading" ? (
          <div className="nmc-root"><div className="nmc-overlay-msg">Loading memory…</div></div>
        ) : state.status === "error" ? (
          <div className="nmc-root"><div className="nmc-overlay-msg">{state.message}</div></div>
        ) : state.status === "empty" || !graph ? (
          <div className="nmc-root"><div className="nmc-overlay-msg">This namespace has no chunks yet — re-publish to enable the memory map.</div></div>
        ) : (
          <NamespaceMemoryConstellation graph={graph} />
        )}
      </div>
    </>
  );
}
