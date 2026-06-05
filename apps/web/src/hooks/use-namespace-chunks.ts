import { useEffect, useState } from "react";
import { API_BASE } from "../lib/api-base.js";
import { parseChunksNdjson } from "../lib/parse-chunks-ndjson.js";
import type { ContextChunk } from "../lib/memory-graph-types.js";
import { mockChunks } from "../data/mock-chunks.js";

export type ChunksState =
  | { status: "loading" }
  | { status: "ready"; chunks: ContextChunk[]; source: "api" | "mock" }
  | { status: "empty" }
  | { status: "error"; message: string };

const ARTIFACT_PATH = "context/chunks.ndjson";

export function useNamespaceChunks(namespace: string): ChunksState {
  const [state, setState] = useState<ChunksState>({ status: "loading" });

  useEffect(() => {
    if (!namespace) {
      setState({ status: "empty" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });

    (async () => {
      try {
        const url = `${API_BASE}/api/namespaces/${encodeURIComponent(namespace)}/artifact-file?path=${encodeURIComponent(ARTIFACT_PATH)}`;
        const res = await fetch(url);
        if (cancelled) return;
        if (res.status === 404) {
          setState({ status: "empty" });
          return;
        }
        if (!res.ok) {
          setState({ status: "error", message: `Failed to load memory (${res.status}).` });
          return;
        }
        const chunks = parseChunksNdjson(await res.text());
        if (cancelled) return;
        setState(chunks.length ? { status: "ready", chunks, source: "api" } : { status: "empty" });
      } catch {
        // Network unreachable (offline dev) -> fall back to bundled mock so the view still renders.
        if (!cancelled) setState({ status: "ready", chunks: mockChunks, source: "mock" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [namespace]);

  return state;
}
