// Running a bake: plan the targets, rasterize each object in texture space, evaluate or trace the
// chosen pass per texel, fill the margins and store the result in the images (or color
// attributes). The same steps run synchronously (operator exec, scripts) or spread over frames
// with progress in the status bar and Esc to cancel (interactive).
import { Color, Vector4, type Material, type MeshPhysicalMaterial, type Mesh, type WebGLRenderer, type Matrix4 } from 'three';
import { app } from '../app/app';
import { renderContext } from '../render/context';
import { RenderScene } from '../render/final/renderscene';
import { meshGeometry } from '../render/geometry';
import { viewportMaterial } from '../render/pbr';
import { materialSlots } from '../editors/view3d/draw';
import { readPixels, writePixels } from '../render/final/imageops';
import { bounceSettings, formatTime } from '../render/final/units';
import { shell, statusWidgets } from '../ui/shell';
import { h } from '../ui/h';
import { icon } from '../ui/icons';
import type { ObjectData, MeshData, ImageData } from '../data/types';
import { isTiled, tileCell } from '../render/udim';
import { readTile, writeTile } from '../render/final/udimops';
import type { EvalMesh } from '../eval/types';
import { BakeTracer, type TraceConfig, type Lobe } from './tracer';
import { rasterGeometry, rasterMaterial, type MaterialChannel, type RasterSource } from './raster';
import { planTargets, type BakeTarget } from './targets';
import { newBuffer, BAKED, swizzle, toTangentSpace, toObjectSpace, encodeUnit, extendMargin, adjacentFacesMargin, seamEdges, composite, storeBytes, type BakeBuffer } from './encode';
import { SAMPLED_TYPES, BAKE_TYPES, contributionProblem, type BakeType, type Contributions, type BakeSettings, type NormalSwizzle } from './settings';

/** Everything a bake needs (the operator's properties resolved against the scene settings). */
export interface BakeOptions {
  type: BakeType;
  filter: Contributions;
  margin: number;
  margin_type: BakeSettings['margin_type'];
  use_selected_to_active: boolean;
  use_cage: boolean;
  cage_object: string | null;
  cage_extrusion: number;
  max_ray_distance: number;
  normal_space: 'OBJECT' | 'TANGENT';
  normal_r: NormalSwizzle;
  normal_g: NormalSwizzle;
  normal_b: NormalSwizzle;
  target: 'IMAGE_TEXTURES' | 'VERTEX_COLORS';
  use_clear: boolean;
  /** where view-dependent shading is seen from */
  view_from?: 'ABOVE_SURFACE' | 'ACTIVE_CAMERA';
  /** samples for noisy passes (default: the scene's render samples) */
  samples?: number;
}

export interface BakeState {
  label: string;
  phase: string;
  /** 0..1 */
  progress: number;
  sample: number;
  maxSamples: number;
  started: number;
  cancelled: boolean;
}

let state: BakeState | null = null;
export function bakeState(): BakeState | null {
  return state;
}

export function cancelBake() {
  if (state) state.cancelled = true;
}

class Cancelled extends Error {}
class BakeError extends Error {}

let tracer: BakeTracer | null = null;

// ---------------------------------------------------------------------------
// renderer state

export function withGL<T>(renderer: WebGLRenderer, fn: () => T): T {
  const target = renderer.getRenderTarget();
  const scissor = renderer.getScissorTest();
  const viewport = renderer.getViewport(new Vector4());
  const clear = renderer.getClearColor(new Color());
  const clearAlpha = renderer.getClearAlpha();
  const auto = renderer.autoClear;
  try {
    return fn();
  } finally {
    renderer.setRenderTarget(target);
    renderer.setScissorTest(scissor);
    renderer.setViewport(viewport);
    renderer.setClearColor(clear, clearAlpha);
    renderer.autoClear = auto;
    renderContext?.engine.requestDraw();
  }
}

// ---------------------------------------------------------------------------
// per-texel surface data of a target

export interface Surface {
  W: number;
  H: number;
  /** world position, smooth normal, tangent, bitangent per texel (xyz, stride 4) */
  P: Float32Array;
  N: Float32Array;
  T: Float32Array;
  B: Float32Array;
  /** covered texels */
  covered: Uint8Array;
  /** texture coordinate of each texel */
  uv: Float32Array;
  /** cage position / normal per texel (selected to active with a cage) */
  cageP?: Float32Array;
  cageN?: Float32Array;
  /** object world 3×3 (column-major) for object-space normals */
  basis: number[];
  raster?: RasterSource;
  /** color attribute targets: texel → element */
  elements?: number;
  /** object size (ray offsets) */
  radius?: number;
}

function basisOf(m: Matrix4): number[] {
  const e = m.elements;
  return [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]];
}

export function imageSurface(renderer: WebGLRenderer, ev: { mesh: EvalMesh; world: Matrix4 }, slots: number[], W: number, H: number, cage: { mesh: EvalMesh; world: Matrix4 } | null, tile: [number, number] = [0, 0]): Surface {
  const geometry = meshGeometry(ev.mesh).geometry;
  const src: RasterSource = { geometry, world: ev.world, slots: new Set(slots), tile };
  const P = withGL(renderer, () => rasterGeometry(renderer, src, 'POSITION', W, H));
  const n = W * H;
  const covered = new Uint8Array(n);
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    covered[i] = P[i * 4 + 3] > 0.5 ? 1 : 0;
    uv[i * 2] = tile[0] + ((i % W) + 0.5) / W;
    uv[i * 2 + 1] = tile[1] + (Math.floor(i / W) + 0.5) / H;
  }
  const s = { W, H, P, covered, uv, basis: basisOf(ev.world), raster: src } as Surface;
  // the other channels are drawn when a pass first needs them (large images hold a lot of floats)
  for (const [key, ch] of [
    ['N', 'NORMAL'],
    ['T', 'TANGENT'],
    ['B', 'BITANGENT'],
  ] as const) {
    let v: Float32Array | null = null;
    Object.defineProperty(s, key, { enumerable: true, get: () => (v ??= withGL(renderer, () => rasterGeometry(renderer, src, ch, W, H))) });
  }
  if (cage) {
    const cg = meshGeometry(cage.mesh).geometry;
    const csrc: RasterSource = { geometry: cg, world: cage.world, slots: new Set(slots), tile };
    [s.cageP, s.cageN] = withGL(renderer, () => (['POSITION', 'NORMAL'] as const).map((c) => rasterGeometry(renderer, csrc, c, W, H)));
  }
  return s;
}

/** Color attribute targets: one texel per corner or per vertex. */
function elementSurface(ev: { mesh: EvalMesh; world: Matrix4 }, domain: 'POINT' | 'CORNER'): Surface {
  const m = ev.mesh;
  const nc = m.indices.length;
  const nv = m.positions.length / 3;
  const count = domain === 'CORNER' ? nc : nv;
  const W = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(count))));
  const H = Math.max(1, Math.ceil(count / W));
  const n = W * H;
  const P = new Float32Array(n * 4),
    N = new Float32Array(n * 4),
    T = new Float32Array(n * 4),
    B = new Float32Array(n * 4),
    uv = new Float32Array(n * 2),
    covered = new Uint8Array(n);
  const geo = meshGeometry(m).geometry;
  const cn = geo.getAttribute('normal').array as Float32Array;
  const e = ev.world.elements;
  const nm = ev.world.clone().invert().transpose().elements;
  const xf = (x: number, y: number, z: number, out: Float32Array, o: number) => {
    out[o] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[o + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[o + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
    out[o + 3] = 1;
  };
  const xn = (x: number, y: number, z: number, out: Float32Array, o: number) => {
    const a = nm[0] * x + nm[4] * y + nm[8] * z,
      b = nm[1] * x + nm[5] * y + nm[9] * z,
      c = nm[2] * x + nm[6] * y + nm[10] * z;
    const l = Math.hypot(a, b, c) || 1;
    out[o] = a / l;
    out[o + 1] = b / l;
    out[o + 2] = c / l;
    out[o + 3] = 1;
  };
  // per-face tangent frame from the face's first triangle
  const faceT = new Float32Array((m.offsets.length - 1) * 3),
    faceB = new Float32Array((m.offsets.length - 1) * 3);
  for (let f = 0; f < m.offsets.length - 1; f++) {
    const s = m.offsets[f];
    const [a, b, c] = [s, s + 1, s + 2].map((k) => m.indices[k]);
    const p = (v: number, i: number) => m.positions[v * 3 + i];
    const e1 = [0, 1, 2].map((i) => p(b, i) - p(a, i)),
      e2 = [0, 1, 2].map((i) => p(c, i) - p(a, i));
    const u = (k: number, i: number) => m.uvs[k * 2 + i] ?? 0;
    const d1 = [u(s + 1, 0) - u(s, 0), u(s + 1, 1) - u(s, 1)],
      d2 = [u(s + 2, 0) - u(s, 0), u(s + 2, 1) - u(s, 1)];
    const det = d1[0] * d2[1] - d2[0] * d1[1];
    for (let i = 0; i < 3; i++) {
      faceT[f * 3 + i] = det ? (e1[i] * d2[1] - e2[i] * d1[1]) / det : i === 0 ? 1 : 0;
      faceB[f * 3 + i] = det ? (e2[i] * d1[0] - e1[i] * d2[0]) / det : i === 1 ? 1 : 0;
    }
  }
  const cornerFace = new Int32Array(nc);
  for (let f = 0; f < m.offsets.length - 1; f++) for (let c = m.offsets[f]; c < m.offsets[f + 1]; c++) cornerFace[c] = f;
  const setFrame = (k: number, f: number) => {
    const o = k * 4;
    for (const [src, dst] of [
      [faceT, T],
      [faceB, B],
    ] as const) {
      // world direction, made perpendicular to the normal
      let x = e[0] * src[f * 3] + e[4] * src[f * 3 + 1] + e[8] * src[f * 3 + 2],
        y = e[1] * src[f * 3] + e[5] * src[f * 3 + 1] + e[9] * src[f * 3 + 2],
        z = e[2] * src[f * 3] + e[6] * src[f * 3 + 1] + e[10] * src[f * 3 + 2];
      const d = x * N[o] + y * N[o + 1] + z * N[o + 2];
      x -= d * N[o];
      y -= d * N[o + 1];
      z -= d * N[o + 2];
      const l = Math.hypot(x, y, z) || 1;
      dst[o] = x / l;
      dst[o + 1] = y / l;
      dst[o + 2] = z / l;
    }
  };
  if (domain === 'CORNER') {
    for (let c = 0; c < nc; c++) {
      const v = m.indices[c];
      xf(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2], P, c * 4);
      xn(cn[c * 3], cn[c * 3 + 1], cn[c * 3 + 2], N, c * 4);
      setFrame(c, cornerFace[c]);
      uv[c * 2] = m.uvs[c * 2] ?? 0;
      uv[c * 2 + 1] = m.uvs[c * 2 + 1] ?? 0;
      covered[c] = 1;
    }
  } else {
    const acc = new Float32Array(nv * 3);
    const anyCorner = new Int32Array(nv).fill(-1);
    for (let c = 0; c < nc; c++) {
      const v = m.indices[c];
      acc[v * 3] += cn[c * 3];
      acc[v * 3 + 1] += cn[c * 3 + 1];
      acc[v * 3 + 2] += cn[c * 3 + 2];
      if (anyCorner[v] < 0) anyCorner[v] = c;
    }
    for (let v = 0; v < nv; v++) {
      xf(m.positions[v * 3], m.positions[v * 3 + 1], m.positions[v * 3 + 2], P, v * 4);
      xn(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2] || (anyCorner[v] < 0 ? 1 : 0), N, v * 4);
      if (anyCorner[v] >= 0) {
        setFrame(v, cornerFace[anyCorner[v]]);
        uv[v * 2] = m.uvs[anyCorner[v] * 2] ?? 0;
        uv[v * 2 + 1] = m.uvs[anyCorner[v] * 2 + 1] ?? 0;
      }
      covered[v] = 1;
    }
  }
  let radius = 0;
  for (let i = 0; i < nv * 3; i++) radius = Math.max(radius, Math.abs(m.positions[i]));
  return { W, H, P, N, T, B, covered, uv, basis: basisOf(ev.world), elements: count, radius: Math.max(1e-3, radius) };
}

// ---------------------------------------------------------------------------
// the bake

/** The scene camera's position and viewing direction (null without a camera). */
function cameraView(): { pos: number[]; forward: number[]; ortho: boolean } | null {
  const doc = app.doc;
  const id = doc.scene.camera;
  const ob = id ? doc.objects[id] : null;
  const ev = id ? app.graph.get(id) : null;
  if (!ob || !ev) return null;
  const e = ev.world.elements;
  const f = [-e[8], -e[9], -e[10]];
  const l = Math.hypot(f[0], f[1], f[2]) || 1;
  return { pos: [e[12], e[13], e[14]], forward: f.map((x) => x / l), ortho: (ob.data ? doc.cameras[ob.data]?.type : undefined) === 'ORTHO' };
}

export interface BakeOutcome {
  ok: boolean;
  message: string;
}

interface RunContext {
  sync: boolean;
  st: BakeState;
}

function check(ctx: RunContext) {
  if (ctx.st.cancelled) throw new Cancelled();
}

/** Objects and their sources: for selected-to-active, the active object receives, the others are seen. */
function bakeObjects(o: BakeOptions): { receivers: ObjectData[]; sources: ObjectData[] } {
  const sel = app.selectedObjects().filter((ob) => ob.type === 'MESH');
  const act = app.activeObject;
  if (o.use_selected_to_active) {
    if (!act || act.type !== 'MESH') throw new BakeError('Selected to Active needs an active mesh object to bake into');
    const sources = sel.filter((ob) => ob.id !== act.id);
    if (!sources.length) throw new BakeError('Selected to Active needs at least one other selected mesh to bake from');
    return { receivers: [act], sources };
  }
  const list = sel.length ? sel : act?.type === 'MESH' ? [act] : [];
  if (!list.length) throw new BakeError('Select the mesh objects to bake');
  return { receivers: list, sources: [] };
}

/** The bake as a sequence of steps; yields between chunks of GPU work. */
export function* bakeSteps(o: BakeOptions, ctx: RunContext): Generator<void, BakeOutcome> {
  const st = ctx.st;
  try {
    const problem = contributionProblem(o.type, o.filter);
    if (problem) throw new BakeError(problem);
    if (!renderContext) throw new BakeError('Baking needs the 3D renderer');
    const renderer = renderContext.engine.renderer;
    const doc = app.doc;
    app.evaluate();
    const { receivers, sources } = bakeObjects(o);
    const plan = planTargets(doc, receivers, o.target);
    if (plan.errors.length) throw new BakeError(plan.errors.join('; '));
    const cage = o.use_selected_to_active && o.use_cage && o.cage_object ? doc.objects[o.cage_object] : null;
    if (o.use_selected_to_active && o.use_cage && o.cage_object && !cage) throw new BakeError('The cage object no longer exists');
    const samples = Math.max(1, Math.round(o.samples ?? doc.scene.render.samples ?? 128));
    const accum = new Map<string, { img: ImageData; tile: number | null; buf: BakeBuffer }>();
    const colorWrites: { me: MeshData; attr: number; data: Float32Array }[] = [];
    // UDIM images bake each tile separately (its UV square drawn into the tile's pixels)
    const units: { t: BakeTarget; tile: number | null }[] = [];
    for (const t of plan.targets) {
      const img = t.kind === 'IMAGE' ? doc.images[t.image!] : null;
      if (isTiled(img)) img.tiles.forEach((_, i) => units.push({ t, tile: i }));
      else units.push({ t, tile: null });
    }
    const total = units.length;
    for (let ti = 0; ti < total; ti++) {
      check(ctx);
      const { t, tile } = units[ti];
      const ev = app.graph.get(t.object.id);
      if (!ev?.mesh || !ev.mesh.indices.length) throw new BakeError(`"${t.object.name}" has no faces to bake`);
      const img = t.kind === 'IMAGE' ? doc.images[t.image!] : null;
      st.label = img ? `${t.object.name} → ${img.name}${tile !== null ? ` ${img.tiles![tile].number}` : ''}` : `${t.object.name} → color attribute`;
      const base = ti / total;
      const span = 1 / total;
      let surf: Surface;
      const cell: [number, number] = tile !== null ? tileCell(img!.tiles![tile].number) : [0, 0];
      if (img) {
        let pixels = tile !== null ? readTile(img, tile) : readPixels(img);
        // tiles decode in the background: wait a little for them when baking interactively
        for (let k = 0; !pixels && !ctx.sync && k < 120; k++) {
          yield;
          pixels = tile !== null ? readTile(img, tile) : readPixels(img);
        }
        if (!pixels) throw new BakeError(`Image "${img.name}" is still loading: bake again in a moment`);
        let cageEv: { mesh: EvalMesh; world: Matrix4 } | null = null;
        if (cage) {
          const cev = app.graph.get(cage.id);
          if (!cev?.mesh || cev.mesh.indices.length !== ev.mesh.indices.length) throw new BakeError(`The cage "${cage.name}" must have the same faces as "${t.object.name}"`);
          cageEv = { mesh: cev.mesh, world: cev.world };
        }
        surf = imageSurface(renderer, { mesh: ev.mesh, world: ev.world }, t.slots, pixels.width, pixels.height, cageEv, cell);
      } else {
        const me = doc.meshes[t.object.data!];
        const attr = me.color_attributes[me.active_color_index ?? 0];
        const count = attr.domain === 'CORNER' ? me.indices.length : me.positions.length / 3;
        const evCount = attr.domain === 'CORNER' ? ev.mesh.indices.length : ev.mesh.positions.length / 3;
        if (count !== evCount) throw new BakeError(`"${t.object.name}": modifiers change its topology, so the color attribute cannot receive the bake`);
        surf = elementSurface({ mesh: ev.mesh, world: ev.world }, attr.domain);
      }
      const own = !o.use_selected_to_active && t.kind === 'IMAGE';
      const result = yield* bakePass(o, ctx, renderer, t, surf, own, sources, samples, (f) => (st.progress = base + span * f));
      if (img) {
        if (o.margin > 0) {
          if (o.margin_type === 'ADJACENT_FACES') {
            const slots = new Set(t.slots);
            const mi = ev.mesh.material_index;
            const edges = seamEdges(ev.mesh, surf.W, surf.H, (f) => slots.has(mi?.[f] ?? 0), cell);
            adjacentFacesMargin(result, o.margin, edges);
          } else extendMargin(result, o.margin);
        }
        const key = `${img.id}|${tile ?? -1}`;
        const acc = accum.get(key);
        if (acc) composite(acc.buf, result);
        else accum.set(key, { img, tile, buf: result });
      } else {
        const me = doc.meshes[t.object.data!];
        const ai = me.active_color_index ?? 0;
        const data = new Float32Array(me.color_attributes[ai].data.length);
        for (let k = 0; k < surf.elements!; k++) data.set(result.data.subarray(k * 4, k * 4 + 4), k * 4);
        colorWrites.push({ me, attr: ai, data });
      }
      st.progress = base + span;
    }
    // store
    const clear: [number, number, number, number] = o.type === 'NORMAL' ? [0.5, 0.5, 1, 1] : [0, 0, 0, 1];
    for (const { img, tile, buf } of accum.values()) {
      const prev = tile !== null ? readTile(img, tile) : readPixels(img);
      const bytes = storeBytes(buf, prev?.data ?? null, { srgb: img.colorspace === 'sRGB', clear: o.use_clear ? clear : null });
      const data = new ImageData(bytes as Uint8ClampedArray<ArrayBuffer>, buf.width, buf.height);
      if (tile !== null) writeTile(img, tile, data);
      else writePixels(img, data);
    }
    for (const w of colorWrites) {
      const attr = w.me.color_attributes[w.attr];
      w.me.color_attributes = w.me.color_attributes.slice();
      w.me.color_attributes[w.attr] = { ...attr, data: w.data };
    }
    app.changed('doc');
    const where = [...new Set([...accum.values()].map((a) => a.img.name))].map((n) => `"${n}"`).concat(colorWrites.map((w) => `the colors of "${w.me.name}"`));
    const label = BAKE_TYPES.find(([t]) => t === o.type)?.[1] ?? o.type;
    return { ok: true, message: `Baked ${label} into ${where.join(', ')} in ${formatTime((performance.now() - st.started) / 1000)}` };
  } catch (e) {
    if (e instanceof Cancelled) return { ok: false, message: 'Bake cancelled' };
    if (e instanceof BakeError) return { ok: false, message: e.message };
    console.error(e);
    return { ok: false, message: `Bake failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Bake one target: returns the texel values (linear) with baked texels marked. */
function* bakePass(o: BakeOptions, ctx: RunContext, renderer: WebGLRenderer, t: BakeTarget, s: Surface, own: boolean, sources: ObjectData[], samples: number, progress: (f: number) => void): Generator<void, BakeBuffer> {
  const st = ctx.st;
  const { W, H } = s;
  const n = W * H;
  const doc = app.doc;
  const out = newBuffer(W, H);
  const c = o.filter;
  const type = o.type;
  const s2a = o.use_selected_to_active;
  const slotMats = materialSlots(doc, t.object);
  const matFor = (slot: number): Material => viewportMaterial(doc, slotMats[slot] ?? null);
  const raster = (ch: MaterialChannel) => withGL(renderer, () => rasterMaterial(renderer, s.raster!, ch, matFor, W, H));

  // tracing setup (lazily: only passes that need rays)
  let traced = false;
  const setupTracer = () => {
    if (traced) return;
    traced = true;
    st.phase = 'Preparing scene';
    tracer ??= new BakeTracer(renderer);
    const rs = new RenderScene('pathtrace');
    rs.build(app, { mode: 'pathtrace', final: true, filmTransparent: false });
    const allowed = new Set<Material>();
    const allow = new Set((s2a ? sources : [t.object]).map((ob) => ob.id));
    for (const child of [...rs.scene.children]) {
      const m = child as Mesh;
      if (!m.isMesh) continue;
      const id = m.userData.id as string | undefined;
      if (s2a && id === t.object.id) {
        rs.scene.remove(m);
        continue;
      }
      if (id && allow.has(id)) {
        const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => (x as MeshPhysicalMaterial).clone());
        mats.forEach((x) => allowed.add(x));
        m.material = mats.length === 1 ? mats[0] : mats;
      }
    }
    // bake rays never see the background directly: leaving it out frees a texture unit for the rays
    rs.scene.background = null;
    rs.scene.updateMatrixWorld(true);
    const r = doc.scene.render;
    const b = bounceSettings(r);
    withGL(renderer, () => tracer!.setScene(rs, allowed, { total: b.bounces, transmissive: b.transmissive }, { direct: Math.max(0, r.sample_clamp_direct ?? 0), indirect: Math.max(0, r.sample_clamp_indirect ?? 0) }));
    // rays: from just above the surface (own) or from the cage / extruded surface (selected to active)
    const origin = new Float32Array(n * 4),
      dir = new Float32Array(n * 4);
    const radius = s.raster?.geometry.boundingSphere?.radius ?? s.radius ?? 1;
    const eps = Math.max(1e-4, 2e-4 * radius);
    // View From ▸ Active Camera: the surface is seen from the scene camera (where it faces it)
    const cam = !s2a && o.view_from === 'ACTIVE_CAMERA' ? cameraView() : null;
    for (let i = 0; i < n; i++) {
      if (!s.covered[i]) continue;
      const P = s.cageP && s.cageP[i * 4 + 3] > 0.5 ? s.cageP : s.P;
      const N = s.cageP && s.cageP[i * 4 + 3] > 0.5 ? s.cageN! : s.N;
      const off = !s2a || s.cageP ? eps : Math.max(eps, o.cage_extrusion);
      let d = [-N[i * 4], -N[i * 4 + 1], -N[i * 4 + 2]];
      if (cam) {
        const v = cam.ortho ? cam.forward : [P[i * 4] - cam.pos[0], P[i * 4 + 1] - cam.pos[1], P[i * 4 + 2] - cam.pos[2]];
        const l = Math.hypot(v[0], v[1], v[2]);
        if (l > 0 && v[0] * N[i * 4] + v[1] * N[i * 4 + 1] + v[2] * N[i * 4 + 2] < -0.05 * l) d = v.map((x) => x / l);
      }
      for (let k = 0; k < 3; k++) {
        origin[i * 4 + k] = P[i * 4 + k] - d[k] * off;
        dir[i * 4 + k] = d[k];
      }
      origin[i * 4 + 3] = 1;
      dir[i * 4 + 3] = !s2a ? 3 * eps : o.max_ray_distance > 0 ? o.max_ray_distance + off : 0;
    }
    withGL(renderer, () => tracer!.setRays(origin, dir, W, H));
  };

  // the GPU work of one traced pass, `share` of this target's progress starting at `from`
  function* trace(cfg: TraceConfig, count: number, from: number, share: number): Generator<void, Float32Array> {
    setupTracer();
    const tr = tracer!;
    withGL(renderer, () => tr.configure(cfg));
    st.phase = 'Compiling shaders';
    st.maxSamples = count;
    st.sample = 0;
    withGL(renderer, () => tr.sample(ctx.sync));
    while (tr.isCompiling) {
      check(ctx);
      yield;
      withGL(renderer, () => tr.sample(ctx.sync));
    }
    st.phase = 'Baking';
    let last = performance.now();
    while (tr.samples < count) {
      check(ctx);
      withGL(renderer, () => tr.sample(ctx.sync));
      st.sample = tr.samples;
      progress(from + share * (tr.samples / count));
      if (performance.now() - last > 30) {
        yield;
        last = performance.now();
      }
    }
    return withGL(renderer, () => tr.read());
  }

  const sampleCount = SAMPLED_TYPES.has(type) ? samples : 1;
  // the texels whose ray found its surface (traced) or that are covered (rasterized)
  let valid: Uint8Array = s.covered;
  const setValid = (traceOut: Float32Array) => {
    const v = new Uint8Array(n);
    for (let i = 0; i < n; i++) v[i] = s.covered[i] && traceOut[i * 4 + 3] > 0.5 ? 1 : 0;
    valid = v;
  };
  /** values (rgb, stride 4) of a traced pass: averaged over the samples that reached the surface */
  const tracedValues = function* (cfg: TraceConfig, count: number, from: number, share: number): Generator<void, Float32Array> {
    const r = yield* trace(cfg, count, from, share);
    if (valid === s.covered) setValid(r);
    return r;
  };
  const colorOf = function* (lobe: Lobe, from: number, share: number): Generator<void, Float32Array> {
    const ch = (lobe === 'DIFFUSE' ? 'DIFFUSE_COLOR' : lobe === 'GLOSSY' ? 'GLOSSY_COLOR' : 'TRANSMISSION_COLOR') as MaterialChannel & TraceConfig['mode'];
    return own ? raster(ch) : yield* tracedValues({ mode: ch }, 1, from, share);
  };

  let values: Float32Array;
  switch (type) {
    case 'NORMAL': {
      const nrm = own ? raster('NORMAL') : yield* tracedValues({ mode: 'NORMAL' }, 1, 0, 1);
      values = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        const w = [nrm[i * 4], nrm[i * 4 + 1], nrm[i * 4 + 2]];
        const local = o.normal_space === 'TANGENT' ? toTangentSpace(w, s.T.subarray(i * 4, i * 4 + 3), s.B.subarray(i * 4, i * 4 + 3), s.N.subarray(i * 4, i * 4 + 3)) : toObjectSpace(w, s.basis);
        values.set(encodeUnit(swizzle(local, o.normal_r, o.normal_g, o.normal_b)), i * 4);
      }
      break;
    }
    case 'POSITION':
      values = own ? s.P : yield* tracedValues({ mode: 'POSITION' }, 1, 0, 1);
      break;
    case 'UV': {
      if (!own) yield* tracedValues({ mode: 'HIT' }, 1, 0, 1);
      values = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) (values[i * 4] = s.uv[i * 2]), (values[i * 4 + 1] = s.uv[i * 2 + 1]);
      break;
    }
    case 'ROUGHNESS':
    case 'EMIT':
      values = own ? raster(type) : yield* tracedValues({ mode: type }, 1, 0, 1);
      break;
    case 'AO':
      values = yield* tracedValues({ mode: 'AO', aoDistance: doc.scene.render.ambient_occlusion_distance ?? 1 }, sampleCount, 0, 1);
      break;
    case 'SHADOW':
    case 'ENVIRONMENT':
      values = yield* tracedValues({ mode: type }, type === 'SHADOW' ? sampleCount : 1, 0, 1);
      break;
    case 'DIFFUSE':
    case 'GLOSSY':
    case 'TRANSMISSION': {
      const lit = c.direct || c.indirect;
      const color = c.color ? yield* colorOf(type, 0, lit ? 0.05 : 1) : null;
      if (lit) {
        const light = yield* tracedValues({ mode: 'LIGHT', lobe: type, direct: c.direct, indirect: c.indirect, emit: false }, sampleCount, c.color ? 0.05 : 0, c.color ? 0.95 : 1);
        if (color) for (let i = 0; i < n * 4; i++) light[i] *= color[i];
        values = light;
      } else values = color!;
      break;
    }
    case 'COMBINED': {
      const lobes = (['DIFFUSE', 'GLOSSY', 'TRANSMISSION'] as const).filter((l) => (l === 'DIFFUSE' ? c.diffuse : l === 'GLOSSY' ? c.glossy : c.transmission));
      const lit = (c.direct || c.indirect) && lobes.length > 0;
      values = new Float32Array(n * 4);
      if (c.emit) {
        const em = own ? raster('EMIT') : yield* tracedValues({ mode: 'EMIT' }, 1, 0, 0.02);
        for (let i = 0; i < n * 4; i++) values[i] += em[i];
      }
      if (lit && !own && lobes.length === 3) {
        const l = yield* tracedValues({ mode: 'LIGHT', lobe: 'ALL', direct: c.direct, indirect: c.indirect, emit: false }, sampleCount, 0.02, 0.98);
        for (let i = 0; i < n * 4; i++) values[i] += l[i];
      } else if (lit) {
        const share = 0.98 / lobes.length;
        for (let k = 0; k < lobes.length; k++) {
          const lobe = lobes[k];
          const col = yield* colorOf(lobe, 0.02 + share * k, own ? 0 : share * 0.05);
          let any = false;
          for (let i = 0; i < n && !any; i++) if (s.covered[i] && (col[i * 4] > 1e-5 || col[i * 4 + 1] > 1e-5 || col[i * 4 + 2] > 1e-5)) any = true;
          if (!any) continue;
          const l = yield* tracedValues({ mode: 'LIGHT', lobe, direct: c.direct, indirect: c.indirect, emit: false }, sampleCount, 0.02 + share * k, share);
          for (let i = 0; i < n * 4; i++) values[i] += l[i] * col[i];
        }
      }
      break;
    }
  }
  for (let i = 0; i < n; i++) {
    if (!valid[i]) continue;
    out.data[i * 4] = values[i * 4];
    out.data[i * 4 + 1] = values[i * 4 + 1];
    out.data[i * 4 + 2] = values[i * 4 + 2];
    out.data[i * 4 + 3] = 1;
    out.mask[i] = BAKED;
  }
  progress(1);
  return out;
}

// ---------------------------------------------------------------------------
// drivers

function newState(): BakeState {
  return { label: '', phase: '', progress: 0, sample: 0, maxSamples: 0, started: performance.now(), cancelled: false };
}

/** Run a bake to completion now (scripts, operator exec). */
export function bakeNow(o: BakeOptions): BakeOutcome {
  if (state) return { ok: false, message: 'A bake is already running' };
  const st = newState();
  state = st;
  try {
    const it = bakeSteps(o, { sync: true, st });
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
    }
  } finally {
    state = null;
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

function statusText(st: BakeState) {
  const parts = [st.label, `Time:${formatTime((performance.now() - st.started) / 1000)}`];
  if (st.phase) parts.push(st.phase);
  if (st.maxSamples > 1 && st.phase === 'Baking') parts.push(`Sample ${Math.min(st.sample, st.maxSamples)}/${st.maxSamples}`);
  return parts.filter(Boolean).join(' | ');
}

function redrawStatus() {
  try {
    shell?.drawStatus();
  } catch {
    app.changed('ui');
  }
}

/** Run a bake over several frames with progress, Esc to cancel; resolves when done. */
export async function bakeInteractive(o: BakeOptions, label = 'Bake'): Promise<BakeOutcome> {
  if (state) return { ok: false, message: 'A bake is already running' };
  const st = newState();
  state = st;
  app.startModal({
    label,
    header: () => statusText(st),
    status: () => [['Esc', 'Cancel']],
    onKey: (e) => {
      if (e.key === 'Escape') {
        if (e.type === 'keydown') st.cancelled = true;
        return true;
      }
      return false;
    },
    cancel: () => {
      st.cancelled = true;
    },
  });
  let outcome: BakeOutcome = { ok: false, message: 'Bake cancelled' };
  try {
    const it = bakeSteps(o, { sync: false, st });
    let lastUi = 0;
    for (;;) {
      const r = it.next();
      if (r.done) {
        outcome = r.value;
        break;
      }
      if (performance.now() - lastUi > 400) {
        lastUi = performance.now();
        // status bar, the area header text and the Bake panel's progress
        app.changed('ui');
      }
      await nextFrame();
    }
  } finally {
    state = null;
    if (app.modal) {
      if (outcome.ok) app.endModal('FINISHED');
      else {
        const m = app.modal;
        m.cancel = () => {};
        app.endModal('CANCELLED');
      }
    }
    redrawStatus();
  }
  app.report(outcome.ok ? 'INFO' : outcome.message === 'Bake cancelled' ? 'WARNING' : 'ERROR', outcome.message);
  return outcome;
}

// progress bar with a cancel button in the status bar while baking
statusWidgets.push(() =>
  state
    ? h(
        'span',
        { key: 'bake-job', class: 'sb-job', 'data-tip': statusText(state) },
        h('span', { class: 'sb-job-label' }, 'Bake'),
        h('span', { class: 'sb-job-bar' }, h('span', { class: 'sb-job-fill', style: { width: `${(Math.min(1, state.progress) * 100).toFixed(1)}%` } })),
        h('button', { class: 'sb-job-cancel', 'data-tip': 'Cancel the bake (Esc)', onclick: () => cancelBake() }, icon('x')),
      )
    : null,
);
