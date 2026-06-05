// Stable string hash (FNV-1a) → hue. Saturation/lightness fixed for the neon look.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function routePathColor(routePath: string): string {
  const hue = hashString(routePath) % 360;
  return `hsl(${hue} 85% 62%)`;
}

// Node area ∝ bytes; clamp so tiny chunks stay visible and huge ones don't dominate.
export function sizeScale(byteLength: number): number {
  return Math.min(12, Math.max(1, Math.sqrt(Math.max(0, byteLength)) / 6));
}
