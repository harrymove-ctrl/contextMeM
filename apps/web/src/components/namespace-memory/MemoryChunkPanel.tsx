import { motion } from "motion/react";
import { X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { MemoryNode } from "../../lib/memory-graph-types.js";

export function MemoryChunkPanel({ node, onClose }: { node: MemoryNode; onClose: () => void }) {
  return (
    <motion.aside
      className="nmc-panel"
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={{ duration: 0.2 }}
    >
      <button className="nmc-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
      <div className="nmc-breadcrumb">{node.headingPath.join(" › ")}</div>
      <div style={{ fontSize: 12, color: "#8b95a3", marginBottom: 12 }}>
        {node.routePath} · {node.byteLength} bytes
        {node.url ? <> · <a href={node.url} target="_blank" rel="noreferrer" style={{ color: "var(--cm-accent)" }}>source</a></> : null}
      </div>
      <div className="nmc-panel-text">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{node.textPreview ?? ""}</ReactMarkdown>
      </div>
    </motion.aside>
  );
}
