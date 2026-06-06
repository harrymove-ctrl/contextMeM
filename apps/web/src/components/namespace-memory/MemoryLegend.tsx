// Monochrome graph → no colour key to show. Just the dataset scale, quietly.
export function MemoryLegend({ nodeCount, linkCount }: { nodeCount: number; linkCount: number }) {
  return (
    <div className="nmc-legend">
      <span>{nodeCount} entities · {linkCount} relationships</span>
    </div>
  );
}
