import { Vector2 } from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";

// Whole-scene bloom: add one UnrealBloomPass to the force-graph's post-processing composer.
// `provider` is the ForceGraph3D ref (typed loosely to keep this three-only helper decoupled).
// Returns a teardown that removes the passes — so an effect re-run (React StrictMode
// double-invoke in dev) doesn't stack passes or leak their render targets.
//
// 3d-force-graph's composer is just a RenderPass. UnrealBloomPass renders in linear space,
// so when it's the final (to-screen) pass the output skips the sRGB/tone-mapping conversion
// the renderer would otherwise do — the canvas blows out to white (three r152+ behaviour).
// An OutputPass appended last restores that conversion, exactly as three's own bloom example does.
export function attachBloom(provider: { postProcessingComposer?: () => EffectComposer } | null | undefined): () => void {
  const composer = provider?.postProcessingComposer?.();
  if (!composer) return () => {};
  const bloom = new UnrealBloomPass(new Vector2(256, 256), 1.1, 0.7, 0.1);
  const output = new OutputPass();
  composer.addPass(bloom);
  composer.addPass(output);
  return () => {
    composer.removePass(output);
    composer.removePass(bloom);
    output.dispose();
    bloom.dispose();
  };
}
