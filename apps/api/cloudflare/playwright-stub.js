// Worker build stub. The hosted Worker never captures screenshots, but the
// @contextmem/core index re-exports screenshots.ts which lazy-imports
// "playwright". esbuild would otherwise try to bundle playwright-core +
// chromium-bidi (which don't resolve for Workers). Aliasing "playwright" to
// this stub keeps the bundle clean; if screenshot code ever runs on the
// Worker it throws clearly instead of silently no-oping.
export const chromium = {
  launch() {
    throw new Error("playwright is not available in the ContextMeM Worker runtime (screenshots are local-only).");
  }
};
export default { chromium };
