import { useEffect, useState } from "react";
import { API_BASE } from "../../lib/api-base.js";

export type PickerNamespace = { namespace: string; displayName?: string; description?: string };

type PickerState =
  | { status: "loading" }
  | { status: "ready"; items: PickerNamespace[] }
  | { status: "error"; message: string };

export function MemoryNamespacePicker({ onSelect }: { onSelect: (namespace: string) => void }) {
  const [state, setState] = useState<PickerState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/api/directory`);
        if (!res.ok) throw new Error(`Failed to load namespaces (${res.status}).`);
        const body = (await res.json()) as { namespaces?: PickerNamespace[] };
        if (!cancelled) setState({ status: "ready", items: body.namespaces ?? [] });
      } catch (err) {
        if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.status === "loading") return <div className="panel">Loading namespaces…</div>;
  if (state.status === "error") return <div className="panel errorState"><p>{state.message}</p></div>;
  if (!state.items.length) {
    return <div className="panel subEmpty">No namespaces yet — publish a context package to populate the directory.</div>;
  }

  return (
    <section className="nmc-picker">
      <p className="nmc-picker-hint">Pick a namespace to explore its memory constellation.</p>
      <div className="nmc-picker-grid">
        {state.items.map((item) => (
          <button
            key={item.namespace}
            type="button"
            className="panel nmc-picker-card"
            onClick={() => onSelect(item.namespace)}
          >
            <strong>{item.displayName ?? item.namespace}</strong>
            <code>{item.namespace}</code>
            {item.description ? <span>{item.description}</span> : null}
          </button>
        ))}
      </div>
    </section>
  );
}
