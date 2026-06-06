import { motion } from "motion/react";
import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MemoryNode, EntityDetail, RelatedNeighbor } from "../../lib/memory-graph-types.js";
import { labelForType, colorForType } from "../../lib/entity-colors.js";

const SENTIMENT_COLOR: Record<string, string> = {
  positive: "#46a758",
  negative: "#d65b5f",
  neutral: "#8b95a3",
};

export function MemoryChunkPanel({
  node,
  detail,
  related,
  onClose,
  onSelectRelated,
}: {
  node: MemoryNode;
  detail?: EntityDetail;
  related: RelatedNeighbor[];
  onClose: () => void;
  onSelectRelated: (node: MemoryNode) => void;
}) {
  const aliases = detail?.aliases ?? [];
  const topics = detail?.topics ?? [];
  const claims = detail?.claims ?? [];
  const stats = detail?.stats ?? [];
  return (
    <motion.aside
      className="nmc-panel"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <button className="nmc-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <div className="nmc-breadcrumb" style={{ color: "var(--cm-accent)" }}>{labelForType(node.routePath)}</div>
      <h3 style={{ margin: "2px 0 8px", fontSize: 20, lineHeight: 1.25 }}>{node.label}</h3>
      <div style={{ fontSize: 12, color: "#8b95a3", marginBottom: 12 }}>
        {typeof node.mentions === "number" ? <>{node.mentions} mention{node.mentions === 1 ? "" : "s"}</> : null}
        {node.url ? <>{typeof node.mentions === "number" ? " · " : ""}<a href={node.url} target="_blank" rel="noreferrer" style={{ color: "var(--cm-accent)" }}>source</a></> : null}
      </div>

      {aliases.length || topics.length ? (
        <div className="nmc-section nmc-chips">
          {aliases.map((a) => <span className="nmc-chip nmc-chip-alias" key={`a-${a}`}>{a}</span>)}
          {topics.map((t) => <span className="nmc-chip" key={`t-${t}`}>{t}</span>)}
        </div>
      ) : null}

      <div className="nmc-panel-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.text}</ReactMarkdown>
      </div>

      {stats.length ? (
        <div className="nmc-section">
          <div className="nmc-section-title">Stats</div>
          {stats.map((s, i) => (
            <div className="nmc-stat-row" key={`${s.label}-${i}`}>
              <strong>{s.value}</strong>
              <span>{s.label}</span>
            </div>
          ))}
        </div>
      ) : null}

      {claims.length ? (
        <div className="nmc-section">
          <div className="nmc-section-title">Claims</div>
          {claims.map((c, i) => (
            <div className="nmc-claim" key={i}>
              <span className="nmc-claim-dot" style={{ background: SENTIMENT_COLOR[c.sentiment] ?? SENTIMENT_COLOR.neutral }} />
              <span>{c.text} <em className="nmc-claim-kind">{c.kind.replace(/_/g, " ")}</em></span>
            </div>
          ))}
        </div>
      ) : null}

      {related.length ? (
        <div className="nmc-section">
          <div className="nmc-section-title">Related</div>
          <div className="nmc-related-list">
            {related.map((r) => {
              const relText = r.relLabel || (r.relKind ? r.relKind.replace(/_/g, " ") : "related");
              // The arrow encodes edge direction relative to this entity; the title spells
              // out the full relationship so "in" edges (where this is the object) read truthfully.
              const statement = r.direction === "out" ? `${node.label} ${relText} ${r.node.label}` : `${r.node.label} ${relText} ${node.label}`;
              return (
                <button className="nmc-related" key={r.node.id} onClick={() => onSelectRelated(r.node)} title={statement}>
                  <span className="nmc-related-dot" style={{ background: colorForType(r.node.routePath) }} />
                  <span className="nmc-related-name">{r.node.label}</span>
                  <span className="nmc-related-rel">
                    {r.direction === "in" ? "← " : ""}{relText}{r.direction === "out" ? " →" : ""}
                    {typeof r.confidence === "number" ? ` · ${Math.round(r.confidence * 100)}%` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </motion.aside>
  );
}
