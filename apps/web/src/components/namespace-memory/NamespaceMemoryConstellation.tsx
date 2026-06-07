import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Maximize2, Minimize2 } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import type { MemoryGraph, MemoryNode, EntityDetail, RelatedNeighbor } from "../../lib/memory-graph-types.js";
import { MemoryChunkPanel } from "./MemoryChunkPanel.js";
import { relatedNeighbors } from "./related-neighbors.js";
import { MemorySearchBox } from "./MemorySearchBox.js";
import { MemoryLegend } from "./MemoryLegend.js";
import "./namespace-memory.css";

// Ported from ark-hive's NeuralGraph3D (github.com/Philotheephilix/ark-hive,
// itself adapted from a fabianferno gist): batched shader-Points nodes with
// white-hot cores, bezier "synapse" edges with a flowing-energy shader, whole-scene
// bloom + fog + starfield, click-to-pulse. Adapted to our entity/relationship data
// (d3-force-3d layout), kept monochrome lime, and enhanced with crisp HTML labels.

function linkEndId(end: unknown): string {
  return typeof end === "object" && end !== null ? (end as { id: string }).id : (end as string);
}

const noiseFunctions = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const nodeShader = {
  vertexShader: `${noiseFunctions}
  attribute float nodeSize; attribute float nodeType; attribute vec3 nodeColor; attribute float distanceFromRoot;
  uniform float uTime; uniform vec3 uPulsePositions[3]; uniform float uPulseTimes[3]; uniform float uPulseSpeed; uniform float uBaseNodeSize;
  varying vec3 vColor; varying float vNodeType; varying vec3 vPosition; varying float vPulseIntensity; varying float vDistanceFromRoot; varying float vGlow;
  float getPulseIntensity(vec3 worldPos, vec3 pulsePos, float pulseTime){
    if(pulseTime<0.0)return 0.0; float t=uTime-pulseTime; if(t<0.0||t>4.0)return 0.0;
    float pr=t*uPulseSpeed; float d=distance(worldPos,pulsePos); float wp=abs(d-pr);
    return smoothstep(3.0,0.0,wp)*smoothstep(4.0,0.0,t);
  }
  void main(){
    vNodeType=nodeType; vColor=nodeColor; vDistanceFromRoot=distanceFromRoot;
    vec3 worldPos=(modelMatrix*vec4(position,1.0)).xyz; vPosition=worldPos;
    float tot=0.0; for(int i=0;i<3;i++){tot+=getPulseIntensity(worldPos,uPulsePositions[i],uPulseTimes[i]);}
    vPulseIntensity=min(tot,1.0);
    float breathe=sin(uTime*0.7+distanceFromRoot*0.15)*0.15+0.85;
    float baseSize=nodeSize*breathe; float pulseSize=baseSize*(1.0+vPulseIntensity*2.5);
    vGlow=0.5+0.5*sin(uTime*0.5+distanceFromRoot*0.2);
    vec3 mp=position;
    if(nodeType>0.5){ float n=snoise(position*0.08+uTime*0.08); mp+=normalize(position+0.001)*n*0.15; }
    vec4 mvPosition=modelViewMatrix*vec4(mp,1.0);
    gl_PointSize=pulseSize*uBaseNodeSize*(1000.0/-mvPosition.z);
    gl_Position=projectionMatrix*mvPosition;
  }`,
  fragmentShader: `
  uniform float uTime; uniform vec3 uPulseColors[3];
  varying vec3 vColor; varying float vNodeType; varying vec3 vPosition; varying float vPulseIntensity; varying float vDistanceFromRoot; varying float vGlow;
  void main(){
    vec2 c=2.0*gl_PointCoord-1.0; float dist=length(c); if(dist>1.0)discard;
    float glow1=1.0-smoothstep(0.0,0.5,dist); float glow2=1.0-smoothstep(0.0,1.0,dist);
    float gs=pow(glow1,1.2)+glow2*0.3;
    float bc=0.9+0.1*sin(uTime*0.6+vDistanceFromRoot*0.25);
    vec3 baseColor=vColor*bc; vec3 finalColor=baseColor;
    if(vPulseIntensity>0.0){ vec3 pc=mix(vec3(1.0),uPulseColors[0],0.4); finalColor=mix(baseColor,pc,vPulseIntensity*0.8); finalColor*=(1.0+vPulseIntensity*1.2); gs*=(1.0+vPulseIntensity); }
    float core=smoothstep(0.4,0.0,dist); finalColor+=vec3(1.0)*core*0.3;
    float alpha=gs*(0.95-0.3*dist);
    float cd=length(vPosition-cameraPosition); float df=smoothstep(120.0,15.0,cd);
    if(vNodeType>0.5){ finalColor*=1.1; alpha*=0.9; }
    finalColor*=(1.0+vGlow*0.1);
    gl_FragColor=vec4(finalColor,alpha*df);
  }`,
};

const connectionShader = {
  vertexShader: `${noiseFunctions}
  attribute vec3 startPoint; attribute vec3 endPoint; attribute float connectionStrength; attribute float pathIndex; attribute vec3 connectionColor;
  uniform float uTime; uniform vec3 uPulsePositions[3]; uniform float uPulseTimes[3]; uniform float uPulseSpeed;
  varying vec3 vColor; varying float vConnectionStrength; varying float vPulseIntensity; varying float vPathPosition; varying float vDistanceFromCamera;
  float getPulseIntensity(vec3 worldPos, vec3 pulsePos, float pulseTime){
    if(pulseTime<0.0)return 0.0; float t=uTime-pulseTime; if(t<0.0||t>4.0)return 0.0;
    float pr=t*uPulseSpeed; float d=distance(worldPos,pulsePos); float wp=abs(d-pr);
    return smoothstep(3.0,0.0,wp)*smoothstep(4.0,0.0,t);
  }
  void main(){
    float t=position.x; vPathPosition=t;
    vec3 midPoint=mix(startPoint,endPoint,0.5);
    float pathOffset=sin(t*3.14159)*0.15;
    vec3 perpendicular=normalize(cross(normalize(endPoint-startPoint),vec3(0.0,1.0,0.0)));
    if(length(perpendicular)<0.1)perpendicular=vec3(1.0,0.0,0.0);
    midPoint+=perpendicular*pathOffset;
    vec3 p0=mix(startPoint,midPoint,t); vec3 p1=mix(midPoint,endPoint,t); vec3 finalPos=mix(p0,p1,t);
    float noise=snoise(vec3(pathIndex*0.08,t*0.6,uTime*0.15)); finalPos+=perpendicular*noise*0.12;
    vec3 worldPos=(modelMatrix*vec4(finalPos,1.0)).xyz;
    float tot=0.0; for(int i=0;i<3;i++){tot+=getPulseIntensity(worldPos,uPulsePositions[i],uPulseTimes[i]);}
    vPulseIntensity=min(tot,1.0);
    vColor=connectionColor; vConnectionStrength=connectionStrength;
    vDistanceFromCamera=length(worldPos-cameraPosition);
    gl_Position=projectionMatrix*modelViewMatrix*vec4(finalPos,1.0);
  }`,
  fragmentShader: `
  uniform float uTime; uniform vec3 uPulseColors[3];
  varying vec3 vColor; varying float vConnectionStrength; varying float vPulseIntensity; varying float vPathPosition; varying float vDistanceFromCamera;
  void main(){
    float f1=sin(vPathPosition*25.0-uTime*4.0)*0.5+0.5;
    float f2=sin(vPathPosition*15.0-uTime*2.5+1.57)*0.5+0.5;
    float flow=(f1+f2*0.5)/1.5;
    vec3 baseColor=vColor*(0.8+0.2*sin(uTime*0.6+vPathPosition*12.0));
    float fi=0.4*flow*vConnectionStrength; vec3 finalColor=baseColor;
    if(vPulseIntensity>0.0){ vec3 pc=mix(vec3(1.0),uPulseColors[0],0.3); finalColor=mix(baseColor,pc*1.2,vPulseIntensity*0.7); fi+=vPulseIntensity*0.8; }
    finalColor*=(0.7+fi+vConnectionStrength*0.5);
    float alpha=0.7*vConnectionStrength+flow*0.3;
    alpha=mix(alpha,min(1.0,alpha*2.5),vPulseIntensity);
    float df=smoothstep(120.0,15.0,vDistanceFromCamera);
    gl_FragColor=vec4(finalColor,alpha*df);
  }`,
};

const PULSE = [0xbef264, 0xa3e635, 0xd9f99d];
function makePulseUniforms() {
  const u = {
    uTime: { value: 0 },
    uPulsePositions: { value: [new THREE.Vector3(1e3, 1e3, 1e3), new THREE.Vector3(1e3, 1e3, 1e3), new THREE.Vector3(1e3, 1e3, 1e3)] },
    uPulseTimes: { value: [-1e3, -1e3, -1e3] },
    uPulseColors: { value: [new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1), new THREE.Color(1, 1, 1)] },
    uPulseSpeed: { value: 16 },
    uBaseNodeSize: { value: 0.72 },
  };
  PULSE.forEach((c, i) => { if (i < 3) u.uPulseColors.value[i]!.set(c); });
  return u;
}

function starfield() {
  const count = 5000;
  const positions: number[] = [], colors: number[] = [], sizes: number[] = [];
  for (let i = 0; i < count; i++) {
    const r = THREE.MathUtils.randFloat(70, 170);
    const phi = Math.acos(THREE.MathUtils.randFloatSpread(2));
    const theta = THREE.MathUtils.randFloat(0, Math.PI * 2);
    positions.push(r * Math.sin(phi) * Math.cos(theta), r * Math.sin(phi) * Math.sin(theta), r * Math.cos(phi));
    const k = Math.random();
    if (k < 0.82) colors.push(0.85, 0.95, 0.7); else colors.push(1, 1, 1); // mostly faint green-white
    sizes.push(THREE.MathUtils.randFloat(0.1, 0.28));
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setAttribute("size", new THREE.Float32BufferAttribute(sizes, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: `attribute float size; attribute vec3 color; varying vec3 vColor; uniform float uTime;
      void main(){ vColor=color; vec4 mv=modelViewMatrix*vec4(position,1.0);
      float tw=sin(uTime*2.0+position.x*100.0)*0.3+0.7; gl_PointSize=size*tw*(300.0/-mv.z); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `varying vec3 vColor; void main(){ vec2 c=gl_PointCoord-0.5; float d=length(c); if(d>0.5)discard;
      float a=1.0-smoothstep(0.0,0.5,d); gl_FragColor=vec4(vColor,a*0.4); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  return new THREE.Points(geo, mat);
}

// Monochrome lime value ramp (deep → base → bright), by salience.
const DEEP = new THREE.Color(0x65a30d), BASE = new THREE.Color(0xa3e635), BRIGHT = new THREE.Color(0xbef264);
function rampColor(sal: number): THREE.Color {
  const c = new THREE.Color();
  if (sal < 0.5) c.copy(DEEP).lerp(BASE, sal / 0.5);
  else c.copy(BASE).lerp(BRIGHT, (sal - 0.5) / 0.5);
  return c.offsetHSL(THREE.MathUtils.randFloatSpread(0.015), THREE.MathUtils.randFloatSpread(0.05), THREE.MathUtils.randFloatSpread(0.06));
}

interface Rec { id: string; node: MemoryNode; x: number; y: number; z: number; }

const GOLDEN = Math.PI * (3 - Math.sqrt(5));
// Evenly distributed unit vectors on a sphere (Fibonacci sphere) — ark-hive's trick
// for spreading a hub's children so the "synapses" radiate cleanly in 3D.
function fibDir(i: number, n: number): [number, number, number] {
  const y = n <= 1 ? 0 : 1 - (i / (n - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = GOLDEN * i;
  return [Math.cos(th) * r, y, Math.sin(th) * r];
}

// Deterministic hub-radial layout, generalized from ark-hive's layout3d: each
// connected component's root (the primary, else its highest-degree node) is a hub;
// its neighbours burst outward on golden-angle sphere shells by BFS level. Reads as
// an intentional neural structure — far more beautiful than a force-scatter — and is
// compact, so it always frames well. Normalized to a fixed radius for the shaders.
function computeLayout(graph: MemoryGraph): Rec[] {
  const TARGET = 16;
  const adj = new Map<string, string[]>();
  for (const n of graph.nodes) adj.set(n.id, []);
  for (const l of graph.links) {
    const s = linkEndId(l.source), t = linkEndId(l.target);
    if (adj.has(s) && adj.has(t)) { adj.get(s)!.push(t); adj.get(t)!.push(s); }
  }
  const primaryId = graph.nodes.find((n) => n.primary)?.id;
  // connected components
  const seen = new Set<string>(); const comps: string[][] = [];
  for (const n of graph.nodes) {
    if (seen.has(n.id)) continue;
    const comp: string[] = []; const q = [n.id]; seen.add(n.id);
    while (q.length) { const c = q.shift()!; comp.push(c); for (const nb of adj.get(c)!) if (!seen.has(nb)) { seen.add(nb); q.push(nb); } }
    comps.push(comp);
  }
  const pos = new Map<string, [number, number, number]>();
  // The primary's component (else the largest) goes FIRST and at the origin — that's
  // the cluster the default view frames. Other components are pushed far out and may
  // be cropped; we don't shrink the main graph to chase distant disconnected nodes.
  comps.sort((a, b) => {
    const ap = a.includes(primaryId ?? "") ? 1 : 0, bp = b.includes(primaryId ?? "") ? 1 : 0;
    return bp - ap || b.length - a.length;
  });
  comps.forEach((comp, ci) => {
    const root = comp.includes(primaryId ?? "") ? primaryId! : comp.slice().sort((a, b) => adj.get(b)!.length - adj.get(a)!.length)[0]!;
    const w = fibDir(ci, comps.length);
    const hub: [number, number, number] = ci === 0 ? [0, 0, 0] : [w[0] * 60, w[1] * 60, w[2] * 60];
    pos.set(root, hub);
    const level = new Map<string, number>([[root, 0]]); const q = [root];
    while (q.length) { const c = q.shift()!; for (const nb of adj.get(c)!) if (!level.has(nb)) { level.set(nb, level.get(c)! + 1); q.push(nb); } }
    const byLevel = new Map<number, string[]>();
    for (const id of comp) { if (id === root) continue; const L = level.get(id) ?? 1; (byLevel.get(L) ?? byLevel.set(L, []).get(L)!).push(id); }
    for (const [L, members] of byLevel) {
      const radius = 7 + (L - 1) * 7;
      members.forEach((id, i) => {
        const d = fibDir(i, members.length);
        pos.set(id, [hub[0] + d[0] * radius, hub[1] + d[1] * radius, hub[2] + d[2] * radius]);
      });
    }
  });
  // Normalize by the PRIMARY component's radius (centred at origin) so it fills the
  // frame; far components scale with it and sit outside the default view.
  const primaryComp = comps[0] ?? [];
  let maxR = 1e-3;
  for (const id of primaryComp) { const p = pos.get(id); if (p) maxR = Math.max(maxR, Math.hypot(p[0], p[1], p[2])); }
  const scale = TARGET / maxR;
  return graph.nodes.map((n) => { const p = pos.get(n.id) ?? [0, 0, 0]; return { id: n.id, node: n, x: p[0] * scale, y: p[1] * scale, z: p[2] * scale }; });
}

export function NamespaceMemoryConstellation({ graph, entityDetail }: { graph: MemoryGraph; entityDetail?: Map<string, EntityDetail> }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const labelHostRef = useRef<HTMLDivElement>(null);
  const sref = useRef<any>(null);
  const [selected, setSelected] = useState<MemoryNode | null>(null);
  const selectedRef = useRef<MemoryNode | null>(null);
  selectedRef.current = selected;
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Native Fullscreen API on the root (not CSS position:fixed): the constellation is
  // embedded in a backdrop-blurred, scrollable panel whose ancestors form a containing
  // block that would clip a fixed element — the top layer sidesteps that. The canvas
  // ResizeObserver already refits the renderer to the new size, so nothing else to do.
  useEffect(() => {
    const onChange = () => {
      const fsEl = document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;
      setIsFullscreen(fsEl === rootRef.current);
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange as EventListener);
    };
  }, []);

  function toggleFullscreen() {
    const el = rootRef.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    if (!el) return;
    const fsEl = document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;
    if (fsEl) {
      (document.exitFullscreen ?? (document as any).webkitExitFullscreen)?.call(document);
    } else {
      (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el);
    }
  }

  // BFS hop distance from the primary entity → label/animation phase + edge feel.
  const levelOf = useMemo(() => {
    const adj = new Map<string, string[]>();
    for (const n of graph.nodes) adj.set(n.id, []);
    for (const l of graph.links) {
      const s = linkEndId(l.source), t = linkEndId(l.target);
      adj.get(s)?.push(t); adj.get(t)?.push(s);
    }
    const root = graph.nodes.find((n) => n.primary)?.id ?? graph.nodes[0]?.id;
    const lvl = new Map<string, number>();
    if (root) {
      const q = [root]; lvl.set(root, 0);
      while (q.length) { const c = q.shift()!; for (const nb of adj.get(c) ?? []) if (!lvl.has(nb)) { lvl.set(nb, lvl.get(c)! + 1); q.push(nb); } }
    }
    const deg = new Map<string, number>();
    for (const [id, ns] of adj) deg.set(id, ns.length);
    return { lvl, deg };
  }, [graph]);

  const related = useMemo<RelatedNeighbor[]>(
    () => (selected ? relatedNeighbors(graph, selected.id) : []),
    [selected, graph],
  );

  // ---- one-time scene ----
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const w = mount.clientWidth || 1, h = mount.clientHeight || 1;

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x000000, 0.0019);
    const camera = new THREE.PerspectiveCamera(62, w / h, 0.1, 1000);
    camera.position.set(0, 6, 40);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance", alpha: false });
    renderer.setSize(w, h);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x05070a);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.display = "block";
    mount.appendChild(renderer.domElement);

    const stars = starfield();
    scene.add(stars);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.dampingFactor = 0.05; controls.rotateSpeed = 0.6;
    controls.minDistance = 12; controls.maxDistance = 110;
    controls.autoRotate = true; controls.autoRotateSpeed = 0.28; controls.enablePan = false;

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 1.6, 0.6, 0.7);
    composer.addPass(bloom);
    composer.addPass(new OutputPass());

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points = { threshold: 1.8 };

    const s: any = { renderer, scene, camera, controls, composer, bloom, raycaster, nodesMesh: null, connMesh: null, records: [] as Rec[], labels: [] as HTMLDivElement[], raf: 0, desired: null, lastPulse: 0 };
    sref.current = s;

    const proj = new THREE.Vector3();
    const clock = new THREE.Clock();
    const animate = () => {
      s.raf = requestAnimationFrame(animate);
      const t = clock.getElapsedTime();
      s.clockT = t;
      if (s.nodesMesh) { s.nodesMesh.material.uniforms.uTime.value = t; s.nodesMesh.rotation.y = Math.sin(t * 0.04) * 0.05; }
      if (s.connMesh) { s.connMesh.material.uniforms.uTime.value = t; s.connMesh.rotation.y = Math.sin(t * 0.04) * 0.05; }
      stars.rotation.y += 0.0002;
      (stars.material as THREE.ShaderMaterial).uniforms.uTime!.value = t;
      if (s.desired) {
        s.controls.target.lerp(s.desired.target, 0.08);
        s.camera.position.lerp(s.desired.cam, 0.08);
        if (t > s.desired.until) { s.desired = null; if (!selectedRef.current) s.controls.autoRotate = true; }
      }
      s.controls.update();
      s.composer.render();
      // project HTML labels
      const ry = s.nodesMesh ? s.nodesMesh.rotation.y : 0;
      const cosr = Math.cos(ry), sinr = Math.sin(ry);
      for (let i = 0; i < s.records.length; i++) {
        const rec = s.records[i] as Rec; const el = s.labels[i] as HTMLDivElement; if (!el) continue;
        // apply the same gentle y-rotation the meshes use
        const x = rec.x * cosr + rec.z * sinr, z = -rec.x * sinr + rec.z * cosr;
        proj.set(x, rec.y, z).project(s.camera);
        if (proj.z > 1) { el.style.opacity = "0"; continue; }
        const sx = (proj.x * 0.5 + 0.5) * mount.clientWidth;
        const sy = (-proj.y * 0.5 + 0.5) * mount.clientHeight;
        const depth = THREE.MathUtils.clamp((proj.z), 0, 1);
        el.style.transform = `translate(-50%,0) translate(${sx}px,${sy}px)`;
        el.style.opacity = String(0.92 - depth * 0.5);
      }
    };

    let downX = 0, downY = 0;
    const onDown = (e: PointerEvent) => { downX = e.clientX; downY = e.clientY; };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
      s.raycaster.setFromCamera(ndc, s.camera);
      if (s.nodesMesh) {
        const hits = s.raycaster.intersectObject(s.nodesMesh);
        if (hits.length && hits[0].index != null) {
          const rec = s.records[hits[0].index] as Rec;
          if (rec) { focusRec(rec); setSelected(rec.node); return; }
        }
      }
      // empty space → ripple pulse
      const plane = new THREE.Plane(s.camera.position.clone().normalize(), 0);
      plane.constant = -plane.normal.dot(s.camera.position) + s.camera.position.length() * 0.5;
      const pt = new THREE.Vector3();
      if (s.raycaster.ray.intersectPlane(plane, pt)) {
        s.lastPulse = (s.lastPulse + 1) % 3;
        for (const m of [s.nodesMesh, s.connMesh]) {
          if (!m) continue;
          m.material.uniforms.uPulsePositions.value[s.lastPulse].copy(pt);
          m.material.uniforms.uPulseTimes.value[s.lastPulse] = s.clockT ?? 0;
        }
      }
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);

    function focusRec(rec: Rec) {
      const p = new THREE.Vector3(rec.x, rec.y, rec.z);
      const dir = s.camera.position.clone().sub(s.controls.target).normalize();
      s.desired = { target: p.clone(), cam: p.clone().add(dir.multiplyScalar(20)), until: (s.clockT ?? 0) + 1.2 };
      s.controls.autoRotate = false;
    }
    s.focusRec = focusRec;

    const ro = new ResizeObserver(() => {
      if (!mount.clientWidth) return;
      s.camera.aspect = mount.clientWidth / mount.clientHeight;
      s.camera.updateProjectionMatrix();
      s.renderer.setSize(mount.clientWidth, mount.clientHeight);
      s.composer.setSize(mount.clientWidth, mount.clientHeight);
      s.bloom.resolution.set(mount.clientWidth, mount.clientHeight);
    });
    ro.observe(mount);
    animate();

    return () => {
      cancelAnimationFrame(s.raf);
      ro.disconnect();
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      if (s.nodesMesh) { s.nodesMesh.geometry.dispose(); s.nodesMesh.material.dispose(); }
      if (s.connMesh) { s.connMesh.geometry.dispose(); s.connMesh.material.dispose(); }
      stars.geometry.dispose(); (stars.material as THREE.Material).dispose();
      controls.dispose(); renderer.dispose(); renderer.domElement.remove();
      sref.current = null;
    };
  }, []);

  // pause auto-rotate while reading a selected node
  useEffect(() => {
    const s = sref.current;
    if (s) s.controls.autoRotate = !selected && !s.desired;
  }, [selected]);

  // ---- (re)build meshes + labels on data change ----
  useEffect(() => {
    const s = sref.current;
    if (!s) return;
    const records = computeLayout(graph);
    s.records = records;

    if (s.nodesMesh) { s.scene.remove(s.nodesMesh); s.nodesMesh.geometry.dispose(); s.nodesMesh.material.dispose(); s.nodesMesh = null; }
    if (s.connMesh) { s.scene.remove(s.connMesh); s.connMesh.geometry.dispose(); s.connMesh.material.dispose(); s.connMesh = null; }
    // rebuild labels
    const host = labelHostRef.current!;
    host.innerHTML = "";
    s.labels = records.map((rec: Rec) => {
      const el = document.createElement("div");
      el.className = "nmc-label3d";
      el.textContent = rec.node.label;
      host.appendChild(el);
      return el;
    });
    if (!records.length) return;

    const np: number[] = [], nt: number[] = [], nsz: number[] = [], nc: number[] = [], nd: number[] = [];
    for (const rec of records) {
      const sal = Math.max(0, Math.min(1, rec.node.salience ?? 0.5));
      np.push(rec.x, rec.y, rec.z);
      const deg = levelOf.deg.get(rec.id) ?? 0;
      nt.push(rec.node.primary ? 0 : deg <= 1 ? 1 : 0);
      nsz.push(1.0 + sal * 1.6 + (rec.node.primary ? 0.6 : 0));
      nd.push(levelOf.lvl.get(rec.id) ?? 3);
      const c = rampColor(sal);
      nc.push(c.r, c.g, c.b);
    }
    const ng = new THREE.BufferGeometry();
    ng.setAttribute("position", new THREE.Float32BufferAttribute(np, 3));
    ng.setAttribute("nodeType", new THREE.Float32BufferAttribute(nt, 1));
    ng.setAttribute("nodeSize", new THREE.Float32BufferAttribute(nsz, 1));
    ng.setAttribute("nodeColor", new THREE.Float32BufferAttribute(nc, 3));
    ng.setAttribute("distanceFromRoot", new THREE.Float32BufferAttribute(nd, 1));
    s.nodesMesh = new THREE.Points(ng, new THREE.ShaderMaterial({
      uniforms: makePulseUniforms(), vertexShader: nodeShader.vertexShader, fragmentShader: nodeShader.fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    s.scene.add(s.nodesMesh);

    const byId = new Map(records.map((r: Rec) => [r.id, r]));
    const pos: number[] = [], sp: number[] = [], ep: number[] = [], cs: number[] = [], cc: number[] = [], pi: number[] = [];
    let path = 0;
    for (const l of graph.links) {
      const a = byId.get(linkEndId(l.source)) as Rec | undefined, b = byId.get(linkEndId(l.target)) as Rec | undefined;
      if (!a || !b) continue;
      const col = rampColor(Math.max(0, Math.min(1, a.node.salience ?? 0.5)));
      const strength = typeof l.confidence === "number" ? l.confidence : 0.7;
      for (let i = 0; i < 20; i++) {
        pos.push(i / 19, 0, 0); sp.push(a.x, a.y, a.z); ep.push(b.x, b.y, b.z);
        pi.push(path); cs.push(strength); cc.push(col.r, col.g, col.b);
      }
      path++;
    }
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    cg.setAttribute("startPoint", new THREE.Float32BufferAttribute(sp, 3));
    cg.setAttribute("endPoint", new THREE.Float32BufferAttribute(ep, 3));
    cg.setAttribute("connectionStrength", new THREE.Float32BufferAttribute(cs, 1));
    cg.setAttribute("connectionColor", new THREE.Float32BufferAttribute(cc, 3));
    cg.setAttribute("pathIndex", new THREE.Float32BufferAttribute(pi, 1));
    s.connMesh = new THREE.LineSegments(cg, new THREE.ShaderMaterial({
      uniforms: makePulseUniforms(), vertexShader: connectionShader.vertexShader, fragmentShader: connectionShader.fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    s.scene.add(s.connMesh);

    // Frame the (normalized, radius≈22) constellation. Skip if the reader is
    // mid-focus so a dataset rebuild doesn't yank the camera off a selected node.
    if (!s.desired && !selectedRef.current) {
      s.camera.position.set(0, 3, 32);
      s.controls.target.set(0, 0, 0);
      s.controls.update();
    }
  }, [graph, levelOf]);

  function focusById(node: MemoryNode) {
    const s = sref.current;
    setSelected(node);
    const rec = s?.records.find((r: Rec) => r.id === node.id);
    if (rec) s.focusRec(rec);
  }

  return (
    <div className="nmc-root nmc-3d" ref={rootRef}>
      <MemorySearchBox nodes={graph.nodes} onSelect={focusById} />
      <button
        className="nmc-fullscreen"
        onClick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
      >
        {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
      </button>
      <div className="nmc-canvas" ref={mountRef} />
      <div className="nmc-labels" ref={labelHostRef} aria-hidden="true" />
      <MemoryLegend nodeCount={graph.nodes.length} linkCount={graph.links.length} />
      <AnimatePresence>
        {selected && (
          <MemoryChunkPanel
            node={selected}
            detail={entityDetail?.get(selected.id)}
            related={related}
            onClose={() => setSelected(null)}
            onSelectRelated={focusById}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
