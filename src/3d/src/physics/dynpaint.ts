// Dynamic Paint: brush objects paint onto canvas meshes over time. A canvas has surfaces
// (per-vertex) of four kinds:
//  - Paint: colour + wetness, with dissolve, drying, spread, drip and shrink effects
//  - Weight: a 0..1 value written to a vertex group
//  - Displace: brushes press the surface in (optionally accumulating)
//  - Waves: brushes disturb a height field that ripples across the mesh
// Each surface is simulated frame by frame from its start frame into a frame cache.
import { Matrix4, Vector3 } from 'three';
import { registerModifier } from '../eval/modifiers';
import type { DocumentData, ModifierBase, ObjectData, ID } from '../data/types';
import type { EvalMesh, ModifierContext } from '../eval/types';
import type { Depsgraph } from '../eval/depsgraph';
import { meshSignature } from '../eval/depsgraph';
import { closestOnTriangle, meshTriangles } from '../eval/geomquery';
import { vertexNormals } from '../eval/meshbuild';
import { arrayChecksum, frameOf, getCache, motionKey, outOfTime, strHash, worldAt, caches, type FrameCache, type SimContext } from './common';
import { physicsDoc } from './state';
import { defaultPointCache, type PointCacheSettings } from './types';
import { particleCacheKey, systemOf } from './particles';

export type DPSurfaceType = 'PAINT' | 'WEIGHT' | 'DISPLACE' | 'WAVE';

export interface DPSurface {
  id: string;
  name: string;
  is_active: boolean;
  surface_format: 'VERTEX';
  surface_type: DPSurfaceType;
  point_cache: PointCacheSettings;
  frame_substeps: number;
  brush_collection: ID | null;
  brush_influence_scale: number;
  brush_radius_scale: number;
  init_color_type: 'NONE' | 'COLOR' | 'VERTEX_COLOR';
  init_color: [number, number, number, number];
  init_layername: string;
  use_dissolve: boolean;
  dissolve_speed: number;
  use_dissolve_log: boolean;
  use_drying: boolean;
  dry_speed: number;
  color_dry_threshold: number;
  use_spread: boolean;
  spread_speed: number;
  color_spread_speed: number;
  use_drip: boolean;
  drip_velocity: number;
  drip_acceleration: number;
  use_shrink: boolean;
  shrink_speed: number;
  use_output_a: boolean;
  output_name_a: string;
  use_output_b: boolean;
  output_name_b: string;
  displace_factor: number;
  depth_clamp: number;
  use_incremental_displace: boolean;
  wave_damping: number;
  wave_speed: number;
  wave_timescale: number;
  wave_spring: number;
  wave_smoothness: number;
  use_wave_open_border: boolean;
}

export interface DPBrush {
  paint_color: [number, number, number];
  paint_alpha: number;
  paint_wetness: number;
  use_absolute_alpha: boolean;
  use_paint_erase: boolean;
  paint_source: 'VOLUME' | 'DISTANCE' | 'VOLUME_DISTANCE' | 'POINT' | 'PSYS';
  paint_distance: number;
  proximity_falloff: 'SMOOTH' | 'CONSTANT';
  invert_proximity: boolean;
  particle_system: string;
  use_particle_radius: boolean;
  solid_radius: number;
  smooth_radius: number;
  wave_type: 'CHANGE' | 'DEPTH' | 'FORCE' | 'REFLECT';
  wave_factor: number;
  wave_clamp: number;
  use_velocity_alpha: boolean;
  use_velocity_depth: boolean;
  velocity_max: number;
}

export interface DynamicPaintModifier extends ModifierBase {
  ui_type: 'CANVAS' | 'BRUSH';
  canvas_settings: { canvas_surfaces: DPSurface[]; active_index: number } | null;
  brush_settings: DPBrush | null;
}

let surfaceCounter = 0;
export function defaultSurface(type: DPSurfaceType = 'PAINT', name = 'Surface'): DPSurface {
  const sc = physicsDoc()?.scene;
  return {
    id: `dps${Date.now().toString(36)}${(surfaceCounter++).toString(36)}`,
    name,
    is_active: true,
    surface_format: 'VERTEX',
    surface_type: type,
    point_cache: defaultPointCache(sc?.frame_start ?? 1, sc?.frame_end ?? 250),
    frame_substeps: 0,
    brush_collection: null,
    brush_influence_scale: 1,
    brush_radius_scale: 1,
    init_color_type: 'NONE',
    init_color: [0, 0, 0, 1],
    init_layername: '',
    use_dissolve: false,
    dissolve_speed: 250,
    use_dissolve_log: true,
    use_drying: true,
    dry_speed: 14,
    color_dry_threshold: 1,
    use_spread: false,
    spread_speed: 1,
    color_spread_speed: 1,
    use_drip: false,
    drip_velocity: 1,
    drip_acceleration: 1,
    use_shrink: false,
    shrink_speed: 1,
    use_output_a: true,
    output_name_a: type === 'WEIGHT' ? 'dp_weight' : 'dp_paintmap',
    use_output_b: false,
    output_name_b: 'dp_wetmap',
    displace_factor: 1,
    depth_clamp: 0,
    use_incremental_displace: false,
    wave_damping: 0.04,
    wave_speed: 1,
    wave_timescale: 1,
    wave_spring: 0.2,
    wave_smoothness: 1,
    use_wave_open_border: false,
  };
}

export function defaultBrush(): DPBrush {
  return {
    paint_color: [0.15, 0.15, 0.15],
    paint_alpha: 1,
    paint_wetness: 1,
    use_absolute_alpha: false,
    use_paint_erase: false,
    paint_source: 'VOLUME',
    paint_distance: 1,
    proximity_falloff: 'SMOOTH',
    invert_proximity: false,
    particle_system: '',
    use_particle_radius: true,
    solid_radius: 0.1,
    smooth_radius: 0.1,
    wave_type: 'CHANGE',
    wave_factor: 1,
    wave_clamp: 0,
    use_velocity_alpha: false,
    use_velocity_depth: false,
    velocity_max: 1,
  };
}

export const dpCacheKey = (ob: ObjectData, m: ModifierBase, s: DPSurface) => `DPAINT:${ob.id}:${m.id}:${s.id}`;

const isDP = (m: ModifierBase): m is DynamicPaintModifier => m.type === 'DYNAMIC_PAINT';

/** Brush objects (with their brush settings) a surface can be painted by. */
export function brushObjects(doc: DocumentData, surface: DPSurface | null, self?: string): { ob: ObjectData; m: DynamicPaintModifier; b: DPBrush }[] {
  const out: { ob: ObjectData; m: DynamicPaintModifier; b: DPBrush }[] = [];
  const coll = surface?.brush_collection ? doc.collections[surface.brush_collection] : undefined;
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (!ob || ob.id === self) continue;
    if (coll && !collectionHas(doc, coll.id, ob.id)) continue;
    for (const m of ob.modifiers) if (isDP(m) && m.ui_type === 'BRUSH' && m.brush_settings && m.show_viewport !== false) out.push({ ob, m, b: { ...defaultBrush(), ...m.brush_settings } });
  }
  return out;
}

function collectionHas(doc: DocumentData, cid: string, oid: string, depth = 0): boolean {
  const c = doc.collections[cid];
  if (!c || depth > 32) return false;
  if (c.objects.includes(oid)) return true;
  return c.children.some((ch) => collectionHas(doc, ch, oid, depth + 1));
}

// ---------------------------------------------------------------------------
// Brush geometry

interface BrushShape {
  b: DPBrush;
  /** world positions and triangles of the brush mesh */
  pos: Float32Array;
  tris: Uint32Array;
  min: Vector3;
  max: Vector3;
  origin: Vector3;
  /** world velocity of the origin (units per frame) */
  vel: Vector3;
  /** particle positions (PSYS) */
  particles: Float32Array | null;
  psize: number;
}

function brushShape(ctx: SimContext, ob: ObjectData, m: DynamicPaintModifier, b: DPBrush, frame: number, radiusScale: number): BrushShape | null {
  const W = worldAt(ctx, ob, frame);
  const prev = worldAt(ctx, ob, frame - 1);
  const origin = new Vector3().setFromMatrixPosition(W);
  const vel = origin.clone().sub(new Vector3().setFromMatrixPosition(prev));
  const me = ob.type === 'MESH' && ob.data ? ctx.doc.meshes[ob.data] : undefined;
  let pos: Float32Array = new Float32Array(0),
    tris: Uint32Array = new Uint32Array(0);
  const min = new Vector3(Infinity, Infinity, Infinity),
    max = new Vector3(-Infinity, -Infinity, -Infinity);
  if (me) {
    pos = new Float32Array(me.positions.length);
    const v = new Vector3();
    for (let i = 0; i < pos.length; i += 3) {
      v.set(me.positions[i], me.positions[i + 1], me.positions[i + 2]).applyMatrix4(W);
      pos[i] = v.x;
      pos[i + 1] = v.y;
      pos[i + 2] = v.z;
      min.min(v);
      max.max(v);
    }
    tris = meshTriangles({ positions: pos, offsets: me.offsets, indices: me.indices } as EvalMesh);
  }
  let particles: Float32Array | null = null;
  if (b.paint_source === 'PSYS') {
    const pm = ob.modifiers.find((x) => x.type === 'PARTICLE_SYSTEM' && systemOf(ob, x) && ((systemOf(ob, x) as { id?: string }).id === b.particle_system || !b.particle_system));
    const cache = pm ? caches.get(particleCacheKey(ob, pm)) : undefined;
    const fr = cache ? ((cache as FrameCache<{ pos: Float32Array; state: Uint8Array }>).frames.get(frame) ?? (cache as FrameCache<{ pos: Float32Array; state: Uint8Array }>).nearest(frame)) : undefined;
    if (fr) {
      const pts: number[] = [];
      for (let i = 0; i < fr.state.length; i++) if (fr.state[i] === 1) pts.push(fr.pos[i * 3], fr.pos[i * 3 + 1], fr.pos[i * 3 + 2]);
      particles = Float32Array.from(pts);
      for (let i = 0; i < particles.length; i += 3) {
        min.min(new Vector3(particles[i], particles[i + 1], particles[i + 2]));
        max.max(new Vector3(particles[i], particles[i + 1], particles[i + 2]));
      }
    }
  }
  const reach = (b.paint_source === 'PSYS' ? b.solid_radius + b.smooth_radius : b.paint_distance) * radiusScale;
  if (b.paint_source === 'POINT') {
    min.copy(origin);
    max.copy(origin);
  }
  if (min.x === Infinity) return null;
  min.subScalar(reach);
  max.addScalar(reach);
  void m;
  return { b, pos, tris, min, max, origin, vel, particles, psize: 0 };
}

const _p = new Vector3(),
  _a = new Vector3(),
  _b = new Vector3(),
  _c = new Vector3(),
  _q = new Vector3(),
  _d = new Vector3(),
  _e1 = new Vector3(),
  _e2 = new Vector3(),
  _h = new Vector3(),
  _s = new Vector3(),
  _qq = new Vector3();

/** Whether a point is inside a closed triangle mesh (crossings of a ray along a skewed axis). */
function inside(p: Vector3, pos: Float32Array, tris: Uint32Array): boolean {
  _d.set(0.5773, 0.5774, 0.5775).normalize();
  let crossings = 0;
  for (let t = 0; t < tris.length; t += 3) {
    _a.fromArray(pos, tris[t] * 3);
    _b.fromArray(pos, tris[t + 1] * 3);
    _c.fromArray(pos, tris[t + 2] * 3);
    _e1.subVectors(_b, _a);
    _e2.subVectors(_c, _a);
    _h.crossVectors(_d, _e2);
    const det = _e1.dot(_h);
    if (Math.abs(det) < 1e-12) continue;
    const f = 1 / det;
    _s.subVectors(p, _a);
    const u = f * _s.dot(_h);
    if (u < 0 || u > 1) continue;
    _qq.crossVectors(_s, _e1);
    const v = f * _d.dot(_qq);
    if (v < 0 || u + v > 1) continue;
    if (f * _e2.dot(_qq) > 0) crossings++;
  }
  return (crossings & 1) === 1;
}

function nearestDistance(p: Vector3, pos: Float32Array, tris: Uint32Array): number {
  let best = Infinity;
  for (let t = 0; t < tris.length; t += 3) {
    _a.fromArray(pos, tris[t] * 3);
    _b.fromArray(pos, tris[t + 1] * 3);
    _c.fromArray(pos, tris[t + 2] * 3);
    closestOnTriangle(p, _a, _b, _c, _q);
    const d = _q.distanceToSquared(p);
    if (d < best) best = d;
  }
  if (best === Infinity) for (let i = 0; i < pos.length; i += 3) best = Math.min(best, _a.fromArray(pos, i).distanceToSquared(p));
  return Math.sqrt(best);
}

const smooth = (t: number) => t * t * (3 - 2 * t);

/** Influence (0..1) and penetration depth of a brush at a canvas point. */
function brushAt(s: BrushShape, p: Vector3, radiusScale: number): { a: number; depth: number } {
  const b = s.b;
  if (p.x < s.min.x || p.y < s.min.y || p.z < s.min.z || p.x > s.max.x || p.y > s.max.y || p.z > s.max.z) return { a: 0, depth: 0 };
  const dist = b.paint_distance * radiusScale;
  const prox = (d: number) => {
    if (d > dist) return 0;
    let f = b.proximity_falloff === 'CONSTANT' ? 1 : smooth(1 - d / Math.max(1e-6, dist));
    if (b.invert_proximity) f = 1 - f;
    return f;
  };
  switch (b.paint_source) {
    case 'POINT': {
      const d = p.distanceTo(s.origin);
      const a = prox(d);
      return { a, depth: a * dist };
    }
    case 'PSYS': {
      if (!s.particles) return { a: 0, depth: 0 };
      const solid = b.solid_radius * radiusScale,
        soft = b.smooth_radius * radiusScale;
      let best = 0;
      for (let i = 0; i < s.particles.length; i += 3) {
        const d = Math.hypot(p.x - s.particles[i], p.y - s.particles[i + 1], p.z - s.particles[i + 2]);
        const a = d <= solid ? 1 : soft > 0 && d < solid + soft ? smooth(1 - (d - solid) / soft) : 0;
        if (a > best) best = a;
        if (best >= 1) break;
      }
      return { a: best, depth: best * solid };
    }
    case 'DISTANCE': {
      const d = nearestDistance(p, s.pos, s.tris);
      return { a: prox(d), depth: 0 };
    }
    default: {
      const d = nearestDistance(p, s.pos, s.tris);
      if (s.tris.length && inside(p, s.pos, s.tris)) return { a: 1, depth: d };
      if (b.paint_source === 'VOLUME_DISTANCE') return { a: prox(d), depth: 0 };
      return { a: 0, depth: 0 };
    }
  }
}

// ---------------------------------------------------------------------------
// Canvas simulation

interface Graph {
  /** neighbour lists (CSR) */
  start: Uint32Array;
  nb: Uint32Array;
  border: Uint8Array;
}

function meshGraph(mesh: EvalMesh): Graph {
  const n = mesh.positions.length / 3;
  const sets: Set<number>[] = Array.from({ length: n }, () => new Set());
  const edgeUse = new Map<string, number>();
  for (let f = 0; f < mesh.offsets.length - 1; f++) {
    const s = mesh.offsets[f],
      e = mesh.offsets[f + 1];
    for (let k = s; k < e; k++) {
      const a = mesh.indices[k],
        b = mesh.indices[k + 1 < e ? k + 1 : s];
      sets[a].add(b);
      sets[b].add(a);
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
  }
  if (mesh.looseEdges)
    for (let i = 0; i < mesh.looseEdges.length; i += 2) {
      sets[mesh.looseEdges[i]].add(mesh.looseEdges[i + 1]);
      sets[mesh.looseEdges[i + 1]].add(mesh.looseEdges[i]);
    }
  const border = new Uint8Array(n);
  for (const [k, c] of edgeUse)
    if (c === 1) {
      const [a, b] = k.split('_').map(Number);
      border[a] = border[b] = 1;
    }
  const start = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) start[i + 1] = start[i] + sets[i].size;
  const nb = new Uint32Array(start[n]);
  for (let i = 0; i < n; i++) nb.set([...sets[i]].sort((x, y) => x - y), start[i]);
  return { start, nb, border };
}

/** Per-frame state of a surface: values per vertex (layout depends on the surface type). */
type DPFrame = Float32Array;

const STRIDE: Record<DPSurfaceType, number> = { PAINT: 5, WEIGHT: 1, DISPLACE: 1, WAVE: 2 };

interface Live {
  state: Float32Array;
  graph: Graph;
}

function initState(sf: DPSurface, mesh: EvalMesh, doc: DocumentData, dataId: string | null | undefined): Float32Array {
  const n = mesh.positions.length / 3;
  const st = new Float32Array(n * STRIDE[sf.surface_type]);
  if (sf.surface_type !== 'PAINT') return st;
  if (sf.init_color_type === 'COLOR') {
    for (let i = 0; i < n; i++) st.set([sf.init_color[0], sf.init_color[1], sf.init_color[2], sf.init_color[3], 0], i * 5);
  } else if (sf.init_color_type === 'VERTEX_COLOR') {
    const me = dataId ? doc.meshes[dataId] : undefined;
    const ca = me?.color_attributes.find((c) => c.name === sf.init_layername) ?? me?.color_attributes[me.active_color_index];
    if (ca && me && me.positions.length === mesh.positions.length) {
      if (ca.domain === 'POINT') for (let i = 0; i < n; i++) st.set([ca.data[i * 4], ca.data[i * 4 + 1], ca.data[i * 4 + 2], ca.data[i * 4 + 3], 0], i * 5);
      else {
        const cnt = new Uint16Array(n);
        for (let c = 0; c < me.indices.length; c++) {
          const v = me.indices[c];
          for (let k = 0; k < 4; k++) st[v * 5 + k] += ca.data[c * 4 + k];
          cnt[v]++;
        }
        for (let i = 0; i < n; i++) if (cnt[i]) for (let k = 0; k < 4; k++) st[i * 5 + k] /= cnt[i];
      }
    }
  }
  return st;
}

function worldVerts(mesh: EvalMesh, W: Matrix4): { P: Float32Array; N: Float32Array } {
  const n = mesh.positions.length / 3;
  const P = new Float32Array(n * 3);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    v.fromArray(mesh.positions, i * 3).applyMatrix4(W);
    P[i * 3] = v.x;
    P[i * 3 + 1] = v.y;
    P[i * 3 + 2] = v.z;
  }
  const ln = vertexNormals(mesh);
  const N = new Float32Array(n * 3);
  const nm = new Matrix4().copy(W).invert().transpose();
  for (let i = 0; i < n; i++) {
    v.fromArray(ln, i * 3).applyMatrix4(nm).normalize();
    N[i * 3] = v.x;
    N[i * 3 + 1] = v.y;
    N[i * 3 + 2] = v.z;
  }
  return { P, N };
}

/** One frame of a surface: brushes act, then the surface's own effects run. */
function stepSurface(sf: DPSurface, live: Live, P: Float32Array, N: Float32Array, brushes: BrushShape[], gravity: Vector3) {
  const st = live.state;
  const n = P.length / 3;
  const T = sf.surface_type;
  const scale = sf.brush_influence_scale ?? 1,
    rscale = sf.brush_radius_scale ?? 1;
  const p = _p;
  const wave = T === 'WAVE' ? new Float32Array(n) : null;
  const waveMask = T === 'WAVE' ? new Uint8Array(n) : null;
  for (let i = 0; i < n; i++) {
    p.fromArray(P, i * 3);
    for (const s of brushes) {
      const r = brushAt(s, p, rscale);
      if (r.a <= 0) continue;
      const b = s.b;
      let a = r.a * scale;
      if (b.use_velocity_alpha) a *= Math.min(1, s.vel.length() / Math.max(1e-6, b.velocity_max));
      if (T === 'PAINT') {
        const j = i * 5;
        const alpha = Math.min(1, a * b.paint_alpha);
        if (b.use_paint_erase) {
          st[j + 3] = Math.max(0, st[j + 3] - alpha);
          continue;
        }
        const oa = st[j + 3];
        for (let k = 0; k < 3; k++) st[j + k] = oa > 0 ? st[j + k] + (b.paint_color[k] - st[j + k]) * alpha : b.paint_color[k];
        st[j + 3] = b.use_absolute_alpha ? Math.max(oa, alpha) : oa + alpha * (1 - oa);
        st[j + 4] = Math.max(st[j + 4], Math.min(1, b.paint_wetness * a));
      } else if (T === 'WEIGHT') {
        const w = Math.min(1, a * b.paint_alpha);
        st[i] = b.use_paint_erase ? Math.max(0, st[i] - w) : Math.max(st[i], w);
      } else if (T === 'DISPLACE') {
        let depth = (r.depth || a * b.paint_distance * rscale) * scale;
        if (b.use_velocity_depth) depth *= Math.min(1, s.vel.length() / Math.max(1e-6, b.velocity_max));
        if (b.use_paint_erase) st[i] = Math.max(0, st[i] - depth);
        else st[i] = sf.use_incremental_displace ? st[i] + depth * 0.1 : Math.max(st[i], depth);
        if (sf.depth_clamp > 0) st[i] = Math.min(st[i], sf.depth_clamp);
      } else if (T === 'WAVE') {
        const f = b.wave_factor;
        let h = 0;
        if (b.wave_type === 'DEPTH') h = -(r.depth || a) * f;
        else if (b.wave_type === 'FORCE') h = -a * f * 0.1;
        else h = -a * f;
        if (b.wave_clamp > 0) h = Math.max(-b.wave_clamp, Math.min(b.wave_clamp, h));
        if (b.wave_type === 'REFLECT') waveMask![i] = 2;
        else if (b.wave_type === 'FORCE') {
          st[i * 2 + 1] += h;
        } else {
          wave![i] = Math.min(wave![i], h);
          waveMask![i] = Math.max(waveMask![i], 1);
        }
      }
    }
  }
  const g = live.graph;
  if (T === 'PAINT') paintEffects(sf, st, P, g, gravity);
  else if (T === 'WEIGHT' || T === 'DISPLACE') {
    if (sf.use_dissolve) {
      const k = 1 / Math.max(1, sf.dissolve_speed);
      for (let i = 0; i < n; i++) st[i] = sf.use_dissolve_log ? st[i] * (1 - k * 4) : Math.max(0, st[i] - k);
    }
  } else if (T === 'WAVE') waveStep(sf, st, P, g, wave!, waveMask!);
}

function paintEffects(sf: DPSurface, st: Float32Array, P: Float32Array, g: Graph, gravity: Vector3) {
  const n = P.length / 3;
  if (sf.use_spread || sf.use_drip || sf.use_shrink) {
    const next = st.slice();
    for (let i = 0; i < n; i++) {
      const j = i * 5;
      const wet = st[j + 4];
      for (let e = g.start[i]; e < g.start[i + 1]; e++) {
        const o = g.nb[e];
        const k = o * 5;
        const deg = g.start[i + 1] - g.start[i] || 1;
        if (sf.use_spread && wet > 0 && st[j + 3] > st[k + 3]) {
          // wet paint runs into less covered neighbours
          const amt = ((st[j + 3] - st[k + 3]) * Math.min(1, sf.spread_speed) * wet * 0.5) / deg;
          next[k + 3] += amt;
          next[j + 3] -= amt * 0.5;
          const cs = Math.min(1, sf.color_spread_speed * wet * 0.5) / deg;
          for (let c = 0; c < 3; c++) next[k + c] += (st[j + c] - st[k + c]) * cs;
          next[k + 4] = Math.max(next[k + 4], wet * 0.9);
        }
        if (sf.use_drip && wet > 0) {
          // drips flow to neighbours lower along gravity
          const dx = P[o * 3] - P[i * 3],
            dy = P[o * 3 + 1] - P[i * 3 + 1],
            dz = P[o * 3 + 2] - P[i * 3 + 2];
          const len = Math.hypot(dx, dy, dz) || 1;
          const down = (dx * gravity.x + dy * gravity.y + dz * gravity.z) / len / (gravity.length() || 1);
          if (down > 0.2) {
            const amt = st[j + 3] * wet * Math.min(1, sf.drip_velocity * 0.2 * down * sf.drip_acceleration);
            next[k + 3] += amt;
            next[j + 3] -= amt;
            for (let c = 0; c < 3; c++) next[k + c] += (st[j + c] - st[k + c]) * Math.min(1, amt * 2);
            next[k + 4] = Math.max(next[k + 4], wet);
          }
        }
        if (sf.use_shrink && st[k + 3] < st[j + 3]) next[j + 3] -= ((st[j + 3] - st[k + 3]) * Math.min(1, sf.shrink_speed) * 0.25) / deg;
      }
    }
    for (let i = 0; i < n; i++) {
      next[i * 5 + 3] = Math.max(0, Math.min(1, next[i * 5 + 3]));
      for (let c = 0; c < 3; c++) next[i * 5 + c] = Math.max(0, Math.min(1, next[i * 5 + c]));
    }
    st.set(next);
  }
  for (let i = 0; i < n; i++) {
    const j = i * 5;
    if (sf.use_drying) st[j + 4] = Math.max(0, st[j + 4] - 1 / Math.max(1, sf.dry_speed));
    if (sf.use_dissolve) {
      const k = 1 / Math.max(1, sf.dissolve_speed);
      st[j + 3] = sf.use_dissolve_log ? st[j + 3] * (1 - k * 4) : Math.max(0, st[j + 3] - k);
    }
  }
}

function waveStep(sf: DPSurface, st: Float32Array, P: Float32Array, g: Graph, wave: Float32Array, mask: Uint8Array) {
  const n = P.length / 3;
  const speed = Math.max(0.01, sf.wave_speed) * Math.max(0.01, sf.wave_timescale);
  const steps = Math.max(1, Math.ceil(speed * 2));
  const c2 = Math.min(0.5, (speed / steps) * 0.5);
  const damp = 1 - Math.min(1, Math.max(0, sf.wave_damping));
  const spring = Math.max(0, sf.wave_spring) * 0.05;
  const h = new Float32Array(n),
    v = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    h[i] = st[i * 2];
    v[i] = st[i * 2 + 1];
    if (mask[i] === 1) h[i] = Math.min(h[i], wave[i]);
  }
  for (let s = 0; s < steps; s++) {
    const nh = h.slice();
    for (let i = 0; i < n; i++) {
      if (mask[i] === 2) {
        v[i] = 0;
        nh[i] = 0;
        continue;
      }
      if (sf.use_wave_open_border && g.border[i]) {
        v[i] = 0;
        nh[i] = 0;
        continue;
      }
      const deg = g.start[i + 1] - g.start[i];
      if (!deg) continue;
      let avg = 0;
      for (let e = g.start[i]; e < g.start[i + 1]; e++) avg += h[g.nb[e]];
      avg /= deg;
      v[i] = (v[i] + (avg - h[i]) * c2 * 4 - h[i] * spring) * damp;
      nh[i] = h[i] + v[i];
    }
    // smoothness: limit steep differences to neighbours
    if (sf.wave_smoothness > 0) {
      const lim = 1 / Math.max(0.01, sf.wave_smoothness);
      for (let i = 0; i < n; i++) nh[i] = Math.max(-lim, Math.min(lim, nh[i]));
    }
    h.set(nh);
  }
  for (let i = 0; i < n; i++) {
    st[i * 2] = h[i];
    st[i * 2 + 1] = v[i];
  }
}

// ---------------------------------------------------------------------------
// Modifier

function surfaceHash(doc: DocumentData, ob: ObjectData, m: DynamicPaintModifier, sf: DPSurface, mesh: EvalMesh | null, source: ModifierContext['source']): string {
  const before: unknown[] = [];
  for (const x of ob.modifiers) {
    if (x === m) break;
    before.push(x);
  }
  const brushes = brushObjects(doc, sf, ob.id).map(({ ob: b, m: bm }) => {
    const me = b.type === 'MESH' && b.data ? doc.meshes[b.data] : undefined;
    let k = `${b.id}:${JSON.stringify(bm.brush_settings)}:${motionKey(doc, b, sf.point_cache.frame_start)}:${me ? meshSignature(me) : ''}`;
    if (bm.brush_settings?.paint_source === 'PSYS') k += ':' + JSON.stringify(b.particle_systems) + JSON.stringify(b.particle_systems.map((p) => doc.particles[p.settings]));
    return k;
  });
  return strHash(
    [
      JSON.stringify({ ...sf, name: '', point_cache: { s: sf.point_cache.frame_start, e: sf.point_cache.frame_end } }),
      JSON.stringify(before),
      source ? meshSignature(source) : '',
      mesh ? `${mesh.positions.length}:${arrayChecksum(mesh.indices)}` : '',
      motionKey(doc, ob, sf.point_cache.frame_start),
      doc.scene.gravity.join(','),
      ...brushes,
    ].join('#'),
  );
}

/** Surface state at the context frame (stepping the cache as needed). */
export function surfaceState(ob: ObjectData, m: DynamicPaintModifier, sf: DPSurface, mesh: EvalMesh, ctx: ModifierContext): Float32Array | null {
  const doc = ctx.doc;
  const pc = sf.point_cache;
  const cache = getCache<DPFrame, Live>(dpCacheKey(ob, m, sf)) as FrameCache<DPFrame, Live>;
  cache.label = `${ob.name} ▸ ${sf.name}`;
  cache.start = pc.frame_start;
  cache.end = pc.frame_end;
  cache.baked = pc.is_baked;
  const n = mesh.positions.length / 3;
  const size = n * STRIDE[sf.surface_type];
  const hash = surfaceHash(doc, ob, m, sf, mesh, ctx.source);
  const usable = pc.is_baked && cache.frames.size > 0 && cache.frames.values().next().value?.length === size;
  if (!usable && cache.hash !== hash) cache.reset(hash);
  const f = Math.max(pc.frame_start, Math.min(frameOf(ctx.graph), pc.frame_end));
  let out = cache.frames.get(f);
  if (out) return out.length === size ? out : null;
  const sctx: SimContext = { doc, graph: ctx.graph };
  if (!cache.live || cache.last < pc.frame_start || cache.live.state.length !== size) {
    cache.frames.clear();
    cache.live = { state: initState(sf, mesh, doc, ob.data), graph: meshGraph(mesh) };
    cache.frames.set(pc.frame_start, cache.live.state.slice());
    cache.last = pc.frame_start;
  }
  const live = cache.live;
  const g = doc.scene.use_gravity ? doc.scene.gravity : [0, 0, -9.81];
  const gravity = new Vector3(g[0], g[1], g[2]);
  const brushes = brushObjects(doc, sf, ob.id);
  const sub = Math.max(0, Math.round(sf.frame_substeps ?? 0));
  while (cache.last < f) {
    if (cache.last > pc.frame_start && outOfTime()) break;
    const k = cache.last + 1;
    for (let s = 0; s <= sub; s++) {
      // substeps sample the brushes between frames (fast brushes leave continuous strokes)
      const t = k - 1 + (s + 1) / (sub + 1);
      const fk = s === sub ? k : t;
      const W = sub ? lerpMat(worldAt(sctx, ob, k - 1), worldAt(sctx, ob, k), (s + 1) / (sub + 1)) : worldAt(sctx, ob, k);
      const { P, N } = worldVerts(mesh, W);
      const shapes: BrushShape[] = [];
      for (const { ob: bo, m: bm, b } of brushes) {
        const sh = brushShape(sctx, bo, bm, b, Math.round(fk), sf.brush_radius_scale ?? 1);
        if (sh) shapes.push(sh);
      }
      stepSurface(sf, live, P, N, shapes, gravity);
    }
    cache.frames.set(k, live.state.slice());
    cache.last = k;
  }
  out = cache.frames.get(f) ?? cache.nearest(f);
  return out && out.length === size ? out : null;
}

function lerpMat(a: Matrix4, b: Matrix4, t: number) {
  const out = new Matrix4();
  for (let i = 0; i < 16; i++) out.elements[i] = a.elements[i] + (b.elements[i] - a.elements[i]) * t;
  return out;
}

/** Apply the canvas surfaces' outputs to the evaluated mesh. */
function applyCanvas(mesh: EvalMesh, m: DynamicPaintModifier, ctx: ModifierContext): EvalMesh {
  const surfaces = m.canvas_settings?.canvas_surfaces ?? [];
  if (!surfaces.length || ctx.editMode) return mesh;
  let out = mesh;
  const n = mesh.positions.length / 3;
  for (const sf0 of surfaces) {
    if (!sf0.is_active) continue;
    const sf = { ...defaultSurface(sf0.surface_type), ...sf0 } as DPSurface;
    const st = surfaceState(ctx.ob, m, sf, mesh, ctx);
    if (!st) continue;
    if (sf.surface_type === 'PAINT') {
      // the paint goes to the active colour layer when it is the surface's output layer (or the mesh
      // has no colour layers yet); the wetmap shows when its layer is the active one
      const src = ctx.source;
      const act = src?.color_attributes[src.active_color_index]?.name;
      const none = !src || !src.color_attributes.length;
      const wet = sf.use_output_b && act === sf.output_name_b;
      const paint = sf.use_output_a && (none || act === sf.output_name_a);
      if (!wet && !paint) continue;
      const base = out.colors;
      const colors = new Float32Array(out.indices.length * 4);
      for (let c = 0; c < out.indices.length; c++) {
        const v = out.indices[c];
        const j = v * 5;
        if (wet) {
          colors[c * 4] = colors[c * 4 + 1] = colors[c * 4 + 2] = st[j + 4];
        } else {
          // composite over the layer's own colour (white without one)
          const br = base ? base[c * 4] : 1,
            bg = base ? base[c * 4 + 1] : 1,
            bb = base ? base[c * 4 + 2] : 1;
          const a = st[j + 3];
          colors[c * 4] = br + (st[j] - br) * a;
          colors[c * 4 + 1] = bg + (st[j + 1] - bg) * a;
          colors[c * 4 + 2] = bb + (st[j + 2] - bb) * a;
        }
        colors[c * 4 + 3] = 1;
      }
      out = { ...out, colors };
    } else if (sf.surface_type === 'WEIGHT' && sf.use_output_a) {
      const gi = out.vertex_groups?.findIndex((g) => g.name === sf.output_name_a) ?? -1;
      if (gi >= 0 && out.weights) {
        const weights = out.weights.slice();
        weights[gi] = Float32Array.from(st.subarray(0, n));
        out = { ...out, weights };
      }
    } else if (sf.surface_type === 'DISPLACE' || sf.surface_type === 'WAVE') {
      const normals = vertexNormals(out);
      const pos = new Float32Array(out.positions);
      const stride = sf.surface_type === 'WAVE' ? 2 : 1;
      const k = sf.surface_type === 'DISPLACE' ? -(sf.displace_factor ?? 1) : 1;
      for (let i = 0; i < n; i++) {
        const d = st[i * stride] * k;
        if (!d) continue;
        pos[i * 3] += normals[i * 3] * d;
        pos[i * 3 + 1] += normals[i * 3 + 1] * d;
        pos[i * 3 + 2] += normals[i * 3 + 2] * d;
      }
      out = { ...out, positions: pos };
    }
  }
  return out;
}

registerModifier({
  type: 'DYNAMIC_PAINT',
  label: 'Dynamic Paint',
  category: 'PHYSICS',
  icon: 'mod_dynamicpaint',
  defaults: () => ({ ui_type: 'CANVAS', canvas_settings: null, brush_settings: null }),
  timeDependent: () => true,
  deps: (m) => {
    const doc = physicsDoc();
    const dm = m as DynamicPaintModifier;
    if (!doc || dm.ui_type !== 'CANVAS') return [];
    return brushObjects(doc, null).map((b) => b.ob.id);
  },
  signature: (m, c) => {
    const dm = m as DynamicPaintModifier;
    if (dm.ui_type !== 'CANVAS') return 'brush';
    const f = frameOf(c.graph as Depsgraph);
    return (dm.canvas_settings?.canvas_surfaces ?? [])
      .map((sf) => {
        const cache = getCache<DPFrame, Live>(dpCacheKey(c.ob, m, sf));
        const hash = surfaceHash(c.doc, c.ob, dm, sf, null, null);
        return `${sf.id}:${hash}:${sf.point_cache.is_baked}:${cache.frames.has(Math.min(f, sf.point_cache.frame_end)) ? 'hit' : 'miss' + cache.last}:${cache.frames.size}`;
      })
      .join(',');
  },
  apply: (mesh, m, ctx) => ((m as DynamicPaintModifier).ui_type === 'CANVAS' ? applyCanvas(mesh, m as DynamicPaintModifier, ctx) : mesh),
});
