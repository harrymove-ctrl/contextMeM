import { routePathColor } from "./memory-theme.js";

export function MemoryLegend({ routes, nodeCount, linkCount }: { routes: string[]; nodeCount: number; linkCount: number }) {
  return (
    <div className="nmc-legend">
      <div style={{ marginBottom: 6 }}>{nodeCount} memories · {linkCount} links</div>
      {routes.map((r) => (
        <div key={r}><span className="swatch" style={{ background: routePathColor(r) }} />{r}</div>
      ))}
    </div>
  );
}
