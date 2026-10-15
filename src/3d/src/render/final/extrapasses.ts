// Render passes beyond the guide passes: object/material indexes, cryptomatte (object, material
// and asset IDs with per-pixel coverage of the most covering IDs) and shader AOVs. Rendered with
// override materials on the final render scene after the beauty pass.
import {
  ShaderMaterial,
  Vector4,
  Vector3,
  Quaternion,
  Matrix4,
  DoubleSide,
  type Mesh,
  type Camera,
  type Material,
  type PerspectiveCamera,
  type Scene,
  type WebGLRenderer,
  type WebGLRenderTarget,
} from 'three';
import type { DocumentData, ObjectData } from '../../data/types';
import { floatTarget, renderOverride } from './gbuffer';
import { jitter } from './units';
import { jitterProjection } from './camera';
import { materialSlots } from '../../editors/view3d/draw';
import { aovMaterial, disposeAovMaterial } from '../../nodes/shader/aov';
import { app } from '../../app/app';

export interface AovData {
  name: string;
  type: 'COLOR' | 'VALUE';
}

declare module '../../data/types' {
  interface RenderSettings {
    use_pass_material_index?: boolean;
    use_pass_cryptomatte_object?: boolean;
    use_pass_cryptomatte_material?: boolean;
    use_pass_cryptomatte_asset?: boolean;
    /** number of ID/coverage pairs stored per pixel (2 per pass layer) */
    pass_cryptomatte_depth?: number;
    /** shader AOVs written by AOV Output nodes */
    aovs?: AovData[];
    /** speed vectors: xy towards the previous frame, zw from the next frame (pixels) */
    use_pass_vector?: boolean;
  }
}

// ---------------------------------------------------------------------------
// Cryptomatte IDs: 32-bit MurmurHash3 of the name, made a finite float

/** MurmurHash3 (x86, 32 bit) of the UTF-8 bytes of a string. */
export function murmur3(str: string, seed = 0): number {
  const data = new TextEncoder().encode(str);
  let h = seed >>> 0;
  const c1 = 0xcc9e2d51,
    c2 = 0x1b873593;
  const n = data.length & ~3;
  for (let i = 0; i < n; i += 4) {
    let k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    h ^= k;
    h = (h << 13) | (h >>> 19);
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  let k = 0;
  switch (data.length & 3) {
    case 3:
      k ^= data[n + 2] << 16;
    // falls through
    case 2:
      k ^= data[n + 1] << 8;
    // falls through
    case 1:
      k ^= data[n];
      k = Math.imul(k, c1);
      k = (k << 15) | (k >>> 17);
      k = Math.imul(k, c2);
      h ^= k;
  }
  h ^= data.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Float ID of a name (exponents of 0 and 255 are avoided so the value is a normal float). */
export function cryptoId(name: string): number {
  let h = murmur3(name);
  const e = (h >>> 23) & 255;
  if (e === 0 || e === 255) h ^= 1 << 23;
  u32[0] = h >>> 0;
  return f32[0];
}

/** Hexadecimal hash of a name as written in cryptomatte manifests. */
export function cryptoHex(name: string): string {
  f32[0] = cryptoId(name);
  return u32[0].toString(16).padStart(8, '0');
}

export type CryptoLayer = 'CryptoObject' | 'CryptoMaterial' | 'CryptoAsset';

// ---------------------------------------------------------------------------
// ID materials

const ID_VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
void main() {
  #include <batching_vertex>
  #include <begin_vertex>
  #include <project_vertex>
}`;
const ID_FRAGMENT = /* glsl */ `
uniform vec4 u_ids;
void main() { gl_FragColor = u_ids; }`;

function idMaterial(cache: Map<string, ShaderMaterial>, key: string, ids: [number, number, number, number]): ShaderMaterial {
  let m = cache.get(key);
  if (!m) {
    m = new ShaderMaterial({ vertexShader: ID_VERTEX, fragmentShader: ID_FRAGMENT, uniforms: { u_ids: { value: new Vector4(...ids) } } });
    m.side = DoubleSide;
    cache.set(key, m);
  }
  return m;
}

function topParent(doc: DocumentData, ob: ObjectData): ObjectData {
  let o = ob;
  for (let i = 0; i < 64 && o.parent && doc.objects[o.parent]; i++) o = doc.objects[o.parent];
  return o;
}

/** Per-mesh material arrays (one per material slot) built by `make`, applied for one override render. */
function perMesh(doc: DocumentData, make: (ob: ObjectData | null, slot: number, maId: string | null) => Material) {
  return (m: Mesh) => {
    const ob = (m.userData.id as string | undefined) ? doc.objects[m.userData.id as string] : undefined;
    const slots = ob ? materialSlots(doc, ob) : [];
    const n = Math.max(1, Array.isArray(m.material) ? m.material.length : 1, slots.length);
    const out: Material[] = [];
    for (let s = 0; s < n; s++) out.push(make(ob ?? null, s, slots[s] ?? null));
    return Array.isArray(m.material) ? out : out[0];
  };
}

function readTopDown(renderer: WebGLRenderer, rt: WebGLRenderTarget, W: number, H: number): Float32Array {
  const buf = new Float32Array(W * H * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
  const row = W * 4;
  const tmp = new Float32Array(row);
  for (let y = 0; y < H >> 1; y++) {
    const a = y * row,
      b = (H - 1 - y) * row;
    tmp.set(buf.subarray(a, a + row));
    buf.copyWithin(a, b, b + row);
    buf.set(tmp, b);
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Speed vectors

const VEL_VERTEX = /* glsl */ `
#include <common>
#include <batching_pars_vertex>
uniform mat4 u_prevModel;
uniform mat4 u_nextModel;
uniform mat4 u_prevVP;
uniform mat4 u_nextVP;
varying vec4 vCur;
varying vec4 vPrev;
varying vec4 vNext;
void main() {
  #include <batching_vertex>
  #include <begin_vertex>
  vec4 lp = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
  lp = instanceMatrix * lp;
  #endif
  vCur = projectionMatrix * viewMatrix * modelMatrix * lp;
  vPrev = u_prevVP * u_prevModel * lp;
  vNext = u_nextVP * u_nextModel * lp;
  gl_Position = vCur;
}`;
const VEL_FRAGMENT = /* glsl */ `
uniform vec2 u_size;
varying vec4 vCur;
varying vec4 vPrev;
varying vec4 vNext;
vec2 px(vec4 c) { return (c.xy / c.w * 0.5 + 0.5) * u_size; }
void main() {
  vec2 cur = px(vCur);
  gl_FragColor = vec4(px(vPrev) - cur, cur - px(vNext));
}`;

/** World matrices of every object and the camera's view-projection at another frame. */
function motionAt(doc: DocumentData, frame: number, camera: Camera, cameraId: string | null) {
  const s = doc.scene;
  const f0 = s.frame_current,
    sub0 = s.frame_subframe ?? 0;
  s.frame_current = frame;
  s.frame_subframe = 0;
  app.evaluate();
  const worlds = new Map<string, Matrix4>();
  for (const id of Object.keys(doc.objects)) {
    const ev = app.graph.get(id);
    if (ev) worlds.set(id, ev.world.clone());
  }
  const camEv = cameraId ? app.graph.get(cameraId) : undefined;
  const view = new Matrix4();
  if (camEv) {
    const pos = new Vector3(),
      q = new Quaternion(),
      sc = new Vector3();
    camEv.world.decompose(pos, q, sc);
    view.compose(pos, q, new Vector3(1, 1, 1)).invert();
  } else view.copy((camera as PerspectiveCamera).matrixWorldInverse);
  s.frame_current = f0;
  s.frame_subframe = sub0;
  app.evaluate();
  return { worlds, vp: new Matrix4().multiplyMatrices((camera as PerspectiveCamera).projectionMatrix, view) };
}

// ---------------------------------------------------------------------------
// Coverage accumulation (pure, unit tested)

/**
 * Rank IDs per pixel by coverage. `samples` are top-down float buffers with the ID in channel
 * `ch` and the coverage flag in alpha; returns `depth` (ID, coverage) pairs per pixel as
 * ceil(depth / 2) RGBA layers.
 */
export function rankCoverage(samples: Float32Array[], ch: number, n: number, depth: number): Float32Array[] {
  const K = Math.max(1, depth);
  const MAX = Math.max(K, 8);
  const ids = new Float32Array(n * MAX);
  const counts = new Uint16Array(n * MAX);
  const used = new Uint8Array(n);
  for (const s of samples)
    for (let i = 0; i < n; i++) {
      if (s[i * 4 + 3] <= 0) continue;
      const id = s[i * 4 + ch];
      const base = i * MAX;
      let j = 0;
      for (; j < used[i]; j++) if (ids[base + j] === id) break;
      if (j === used[i]) {
        if (j >= MAX) continue;
        ids[base + j] = id;
        used[i]++;
      }
      counts[base + j]++;
    }
  const layers: Float32Array[] = [];
  for (let l = 0; l < Math.ceil(K / 2); l++) layers.push(new Float32Array(n * 4));
  const total = samples.length;
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    const base = i * MAX;
    order.length = 0;
    for (let j = 0; j < used[i]; j++) order.push(j);
    order.sort((a, b) => counts[base + b] - counts[base + a]);
    for (let r = 0; r < Math.min(K, order.length); r++) {
      const L = layers[r >> 1];
      const o = i * 4 + (r & 1) * 2;
      L[o] = ids[base + order[r]];
      L[o + 1] = counts[base + order[r]] / total;
    }
  }
  return layers;
}

// ---------------------------------------------------------------------------

export interface ExtraPassResult {
  passes: Record<string, Float32Array>;
  /** cryptomatte manifests: layer → name → hex hash */
  manifest: Partial<Record<CryptoLayer, Record<string, string>>>;
}

/** Manifest of the last render with cryptomatte passes (names offered by the Cryptomatte node). */
export let latestCryptoManifest: ExtraPassResult['manifest'] = {};

/** Whether any extra pass is enabled. */
export function wantsExtraPasses(doc: DocumentData): boolean {
  const r = doc.scene.render;
  return !!(
    r.use_pass_vector ||
    r.use_pass_object_index ||
    r.use_pass_material_index ||
    r.use_pass_cryptomatte_object ||
    r.use_pass_cryptomatte_material ||
    r.use_pass_cryptomatte_asset ||
    r.aovs?.length
  );
}

/** Render the enabled extra passes of the scene (top-down rows like the other passes). */
export async function renderExtraPasses(o: {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: Camera;
  W: number;
  H: number;
  doc: DocumentData;
  yieldFrame?: () => Promise<void>;
}): Promise<ExtraPassResult> {
  const { renderer, scene, camera, W, H, doc } = o;
  const r = doc.scene.render;
  const res: ExtraPassResult = { passes: {}, manifest: {} };
  const n = W * H;
  const mats = new Map<string, ShaderMaterial>();
  const target = floatTarget(W, H);
  const base = (camera as PerspectiveCamera).projectionMatrix.clone();
  try {
    // indexes: one sample, no anti-aliasing (the values are labels)
    if (r.use_pass_object_index || r.use_pass_material_index) {
      renderOverride(
        renderer,
        scene,
        camera,
        target,
        null,
        perMesh(doc, (ob, _s, ma) => idMaterial(mats, `ix|${ob?.id}|${ma}`, [ob?.pass_index ?? 0, ma ? (doc.materials[ma]?.pass_index ?? 0) : 0, 0, 1])),
      );
      const px = readTopDown(renderer, target, W, H);
      if (r.use_pass_object_index) res.passes.IndexOB = Float32Array.from({ length: n }, (_, i) => px[i * 4]);
      if (r.use_pass_material_index) res.passes.IndexMA = Float32Array.from({ length: n }, (_, i) => px[i * 4 + 1]);
    }
    // cryptomatte: jittered samples of the three ID layers, ranked by coverage
    const layers: [CryptoLayer, boolean, number][] = [
      ['CryptoObject', !!r.use_pass_cryptomatte_object, 0],
      ['CryptoMaterial', !!r.use_pass_cryptomatte_material, 1],
      ['CryptoAsset', !!r.use_pass_cryptomatte_asset, 2],
    ];
    if (layers.some((l) => l[1])) {
      const names: Record<CryptoLayer, Record<string, string>> = { CryptoObject: {}, CryptoMaterial: {}, CryptoAsset: {} };
      const make = (ob: ObjectData | null, _s: number, ma: string | null) => {
        const on = ob?.name ?? '',
          mn = ma ? (doc.materials[ma]?.name ?? '') : '',
          an = ob ? topParent(doc, ob).name : '';
        if (on) names.CryptoObject[on] = cryptoHex(on);
        if (mn) names.CryptoMaterial[mn] = cryptoHex(mn);
        if (an) names.CryptoAsset[an] = cryptoHex(an);
        return idMaterial(mats, `cr|${ob?.id}|${ma}`, [on ? cryptoId(on) : 0, mn ? cryptoId(mn) : 0, an ? cryptoId(an) : 0, 1]);
      };
      const S = 16;
      const samples: Float32Array[] = [];
      for (let i = 0; i < S; i++) {
        const [jx, jy] = jitter(i);
        jitterProjection(camera, base, jx, jy, W, H);
        renderOverride(renderer, scene, camera, target, null, perMesh(doc, make));
        samples.push(readTopDown(renderer, target, W, H));
        if (o.yieldFrame && i % 4 === 3) await o.yieldFrame();
      }
      jitterProjection(camera, base, 0, 0, W, H);
      const depth = Math.max(2, Math.min(16, Math.round(r.pass_cryptomatte_depth ?? 6)));
      for (const [name, on, ch] of layers) {
        if (!on) continue;
        rankCoverage(samples, ch, n, depth).forEach((L, i) => (res.passes[`${name}${String(i).padStart(2, '0')}`] = L));
        res.manifest[name] = names[name];
      }
      latestCryptoManifest = res.manifest;
    }
    // speed vectors from the object and camera motion to the neighbouring frames (rigid motion)
    if (r.use_pass_vector) {
      const f = doc.scene.frame_current;
      const prev = motionAt(doc, f - 1, camera, doc.scene.camera ?? null),
        next = motionAt(doc, f + 1, camera, doc.scene.camera ?? null);
      const vel = new Map<string, ShaderMaterial>();
      renderOverride(renderer, scene, camera, target, null, (m: Mesh) => {
        const id = (m.userData.id as string | undefined) ?? '';
        let mat = vel.get(id);
        if (!mat) {
          const cur = m.matrixWorld;
          mat = new ShaderMaterial({
            vertexShader: VEL_VERTEX,
            fragmentShader: VEL_FRAGMENT,
            side: DoubleSide,
            uniforms: {
              u_prevModel: { value: prev.worlds.get(id) ?? cur.clone() },
              u_nextModel: { value: next.worlds.get(id) ?? cur.clone() },
              u_prevVP: { value: prev.vp },
              u_nextVP: { value: next.vp },
              u_size: { value: [W, H] },
            },
          });
          vel.set(id, mat);
        }
        return Array.isArray(m.material) ? m.material.map(() => mat!) : mat;
      });
      res.passes.Vector = readTopDown(renderer, target, W, H);
      for (const m of vel.values()) m.dispose();
    }
    // shader AOVs
    for (const aov of r.aovs ?? []) {
      if (!aov.name) continue;
      const made: Material[] = [];
      const black = idMaterial(mats, 'black', [0, 0, 0, 1]);
      const aovTarget = floatTarget(W, H, { samples: 4 });
      renderOverride(
        renderer,
        scene,
        camera,
        aovTarget,
        null,
        perMesh(doc, (_ob, _s, ma) => {
          const m = ma && doc.materials[ma] ? aovMaterial(doc, doc.materials[ma], aov.name, aov.type) : null;
          if (m) made.push(m);
          return m ?? black;
        }),
      );
      const px = readTopDown(renderer, aovTarget, W, H);
      aovTarget.dispose();
      for (const m of made) disposeAovMaterial(m);
      res.passes[`AOV ${aov.name}`] = aov.type === 'VALUE' ? Float32Array.from({ length: n }, (_, i) => px[i * 4]) : px;
    }
  } finally {
    (camera as PerspectiveCamera).projectionMatrix.copy(base);
    (camera as PerspectiveCamera).projectionMatrixInverse.copy(new Matrix4().copy(base).invert());
    target.dispose();
    for (const m of mats.values()) m.dispose();
  }
  return res;
}
