import { Vector2 } from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";

// Whole-scene bloom: add one UnrealBloomPass to the force-graph's post-processing composer.
// `provider` is the ForceGraph3D ref (typed loosely to keep this three-only helper decoupled).
// Returns a teardown that removes the pass — so an effect re-run (React StrictMode
// double-invoke in dev) doesn't stack bloom passes or leak their render targets.
export function attachBloom(provider: { postProcessingComposer?: () => EffectComposer } | null | undefined): () => void {
  const composer = provider?.postProcessingComposer?.();
  if (!composer) return () => {};
  const bloom = new UnrealBloomPass(new Vector2(256, 256), 2, 1, 0);
  composer.addPass(bloom);
  return () => {
    composer.removePass(bloom);
    bloom.dispose();
  };
}
