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
  // Comma-separated form: THREE.Color.setStyle only parses comma hsl(), not the
  // space-separated CSS Color 4 syntax — the space form leaves every sprite white.
  return `hsl(${hue}, 85%, 62%)`;
}
