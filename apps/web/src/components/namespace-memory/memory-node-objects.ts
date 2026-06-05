import { Sprite, SpriteMaterial, CanvasTexture, AdditiveBlending, Color } from "three";
import type { MemoryNode } from "../../lib/memory-graph-types.js";

// One radial-gradient texture, shared and tinted per node (cheap; avoids N textures).
let glowTexture: CanvasTexture | null = null;
function getGlowTexture(): CanvasTexture {
  if (glowTexture) return glowTexture;
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.3, "rgba(255,255,255,0.8)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  glowTexture = new CanvasTexture(canvas);
  return glowTexture;
}

export const BLOOM_LAYER = 1;

export function createNodeObject(node: MemoryNode, color: string, selective: boolean): Sprite {
  const material = new SpriteMaterial({
    map: getGlowTexture(),
    color: new Color(color),
    blending: AdditiveBlending,
    depthWrite: false,
    transparent: true,
  });
  const sprite = new Sprite(material);
  const scale = 4 + node.val * 2;
  sprite.scale.set(scale, scale, 1);
  if (selective) sprite.layers.set(BLOOM_LAYER); // only sprites bloom (future selective mode)
  return sprite;
}
