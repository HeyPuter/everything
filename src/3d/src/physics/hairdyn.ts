// Hair dynamics: parent strands are simulated as chains (stretch and bending springs, roots
// pinned to the emitter, optional pull towards the groomed shape), frame by frame into a cache;
// children follow their simulated parents.
import { Matrix4, Vector3 } from 'three';
import type { ModifierBase, ObjectData } from '../data/types';
import type { ModifierContext } from '../eval/types';
import type { Depsgraph } from '../eval/depsgraph';
import { arrayChecksum, frameOf, getCache, motionKey, outOfTime, rand01, strHash, worldAt, type FrameCache, type SimContext } from './common';
import { collectEffectors, fieldsKey } from './fields';
import { buildColliders, collidersKey } from './colliders';
import { initState, stepFrame, KIND_STRUCT, KIND_BEND, type PBDParams, type PBDState, type Topology } from './pbd';
import { fps, gravityOf } from './meshsim';
import { compliance, MESH_SIM_FRAME_TIME } from './cloth';
import { childStrands } from './children';
import { defaultHairDynamics, defaultPointCache, type ParticleSettingsX, type ParticleSystemX } from './types';
import type { HairResult } from './particles';

export const hairDynKey = (ob: ObjectData, m: ModifierBase) => `HAIRDYN:${ob.id}:${m.id}`;

interface Live {
  state: PBDState;
  topo: Topology;
}

function chainTopology(rest: Float32Array, strands: number, seg: number): Topology {
  const a: number[] = [],
    b: number[] = [],
    kind: number[] = [],
    len: number[] = [];
  const per = seg + 1;
  const d = (i: number, j: number) => Math.hypot(rest[i * 3] - rest[j * 3], rest[i * 3 + 1] - rest[j * 3 + 1], rest[i * 3 + 2] - rest[j * 3 + 2]);
  for (let s = 0; s < strands; s++)
    for (let k = 0; k < seg; k++) {
      const i = s * per + k;
      a.push(i);
      b.push(i + 1);
      kind.push(KIND_STRUCT);
      len.push(d(i, i + 1));
      if (k + 2 <= seg) {
        a.push(i);
        b.push(i + 2);
        kind.push(KIND_BEND);
        len.push(d(i, i + 2));
      }
    }
  return { a: Uint32Array.from(a), b: Uint32Array.from(b), kind: Uint8Array.from(kind), rest: Float32Array.from(len), tris: new Uint32Array(0), nverts: strands * per };
}

function toWorld(local: Float32Array, m: Matrix4): Float32Array {
  const out = new Float32Array(local.length);
  const v = new Vector3();
  for (let i = 0; i < local.length; i += 3) {
    v.set(local[i], local[i + 1], local[i + 2]).applyMatrix4(m);
    out[i] = v.x;
    out[i + 1] = v.y;
    out[i + 2] = v.z;
  }
  return out;
}

/** Bending compliance per constraint with a random stiffness factor per strand. */
function bendCompliance(topo: Topology, d: { bending_stiffness: number; bending_random?: number }, strands: number, per: number): Float32Array {
  const out = new Float32Array(topo.a.length);
  for (let c = 0; c < topo.a.length; c++) {
    if (topo.kind[c] !== KIND_BEND) {
      out[c] = 1e-7;
      continue;
    }
    const strand = Math.floor(topo.a[c] / per);
    const r = 1 - Math.max(0, Math.min(1, d.bending_random ?? 0)) * rand01(strand, 7, 0, 501);
    out[c] = compliance(d.bending_stiffness * r);
  }
  void strands;
  return out;
}

/**
 * Hair volume: strands moving through the same cell share their velocity (internal friction),
 * and crowded cells push their points apart towards the target density.
 */
export function hairVolume(st: PBDState, strands: number, per: number, d: { internal_friction?: number; voxel_cell_size?: number; density_target?: number; density_strength?: number }, dt: number) {
  const friction = Math.max(0, d.internal_friction ?? 0),
    strength = Math.max(0, d.density_strength ?? 0);
  if (!friction && !strength) return;
  const cell = Math.max(1e-3, d.voxel_cell_size ?? 0.1);
  const x = st.x,
    v = st.v;
  const n = strands * per;
  const cells = new Map<string, { n: number; vx: number; vy: number; vz: number; cx: number; cy: number; cz: number }>();
  const keyOf = (i: number) => `${Math.floor(x[i * 3] / cell)},${Math.floor(x[i * 3 + 1] / cell)},${Math.floor(x[i * 3 + 2] / cell)}`;
  for (let i = 0; i < n; i++) {
    if (i % per === 0) continue;
    const k = keyOf(i);
    let c = cells.get(k);
    if (!c) cells.set(k, (c = { n: 0, vx: 0, vy: 0, vz: 0, cx: 0, cy: 0, cz: 0 }));
    c.n++;
    c.vx += v[i * 3];
    c.vy += v[i * 3 + 1];
    c.vz += v[i * 3 + 2];
    c.cx += x[i * 3];
    c.cy += x[i * 3 + 1];
    c.cz += x[i * 3 + 2];
  }
  const vol = cell * cell * cell;
  const t = 1 - Math.exp(-friction * dt * 10);
  for (let i = 0; i < n; i++) {
    if (i % per === 0) continue;
    const c = cells.get(keyOf(i))!;
    if (friction && c.n > 1) {
      v[i * 3] += (c.vx / c.n - v[i * 3]) * t;
      v[i * 3 + 1] += (c.vy / c.n - v[i * 3 + 1]) * t;
      v[i * 3 + 2] += (c.vz / c.n - v[i * 3 + 2]) * t;
    }
    // density in points per cubic metre against the target (points per cell volume)
    const target = Math.max(0, d.density_target ?? 1);
    if (strength && c.n / vol > target && c.n > 1) {
      const ex = x[i * 3] - c.cx / c.n,
        ey = x[i * 3 + 1] - c.cy / c.n,
        ez = x[i * 3 + 2] - c.cz / c.n;
      const l = Math.hypot(ex, ey, ez) || 1;
      const push = Math.min(1, strength) * cell * 0.05 * Math.min(4, c.n / vol / Math.max(1e-6, target) - 1);
      x[i * 3] += (ex / l) * push;
      x[i * 3 + 1] += (ey / l) * push;
      x[i * 3 + 2] += (ez / l) * push;
    }
  }
}

/** Limit the velocity change of every point in one frame (collision impulse clamp). */
function clampImpulses(st: PBDState, before: Float64Array, max: number) {
  const v = st.v;
  for (let i = 0; i < v.length; i += 3) {
    const dx = v[i] - before[i],
      dy = v[i + 1] - before[i + 1],
      dz = v[i + 2] - before[i + 2];
    const l = Math.hypot(dx, dy, dz);
    if (l <= max) continue;
    const f = max / l;
    v[i] = before[i] + dx * f;
    v[i + 1] = before[i + 1] + dy * f;
    v[i + 2] = before[i + 2] + dz * f;
  }
}

/** The hair with simulated parent strands (and children rebuilt around them), or null when not simulated. */
export function hairWithDynamics(ob: ObjectData, m: ModifierBase, psys: ParticleSystemX, s: ParticleSettingsX, hair: HairResult, ctx: ModifierContext): HairResult | null {
  if (ctx.editMode || !hair.parents) return null;
  const doc = ctx.doc;
  const d = { ...defaultHairDynamics(), ...(psys.hair_dynamics ?? {}) };
  const pc = (psys.point_cache ??= defaultPointCache(doc.scene.frame_start, doc.scene.frame_end));
  const seg = hair.segments,
    per = seg + 1;
  const nParentPts = hair.parents * per;
  const rest = hair.points.subarray(0, nParentPts * 3);
  const cache = getCache<Float32Array, Live>(hairDynKey(ob, m)) as FrameCache<Float32Array, Live>;
  cache.label = `${ob.name} ▸ ${psys.name}`;
  cache.start = pc.frame_start;
  cache.end = pc.frame_end;
  cache.baked = pc.is_baked;
  const hash = strHash([JSON.stringify(d), seg, hair.parents, arrayChecksum(rest), pc.frame_start, pc.frame_end, doc.scene.use_gravity, doc.scene.gravity.join(','), fps(doc), motionKey(doc, ob, pc.frame_start), d.use_collision ? collidersKey(doc, pc.frame_start, ob.id) : '', fieldsKey(doc, pc.frame_start)].join('#'));
  const usable = pc.is_baked && cache.frames.size > 0 && cache.frames.values().next().value?.length === nParentPts * 3;
  if (!usable && cache.hash !== hash) cache.reset(hash);
  const f = frameOf(ctx.graph);
  if (f <= pc.frame_start) return null;
  const ft = Math.min(f, pc.frame_end);
  let out = cache.frames.get(ft);
  if (!out) {
    const sctx: SimContext = { doc, graph: ctx.graph };
    if (!cache.live || cache.last < pc.frame_start || cache.live.topo.nverts !== nParentPts) {
      const w0 = toWorld(rest, worldAt(sctx, ob, pc.frame_start));
      cache.frames.clear();
      cache.frames.set(pc.frame_start, w0);
      cache.live = { state: initState(w0), topo: chainTopology(rest, hair.parents, seg) };
      cache.last = pc.frame_start;
    }
    const pin = new Float32Array(nParentPts);
    for (let i = 0; i < hair.parents; i++) pin[i * per] = 1;
    const goal = d.pin_stiffness > 0 ? { weights: new Float32Array(nParentPts).fill(1), spring: Math.min(0.999, d.pin_stiffness), friction: 0 } : null;
    const P: PBDParams = {
      dt: MESH_SIM_FRAME_TIME,
      substeps: Math.max(1, Math.round(d.quality)),
      iterations: 4,
      gravity: gravityOf(doc, d.effector_weights_gravity * d.effector_weights_all),
      airDamping: d.air_damping,
      compliance: [1e-7, 1e-7, 1e-7, compliance(d.bending_stiffness)],
      // random stiffness per strand
      stretchCompliance: d.bending_random ? bendCompliance(cache.live!.topo, d, hair.parents, per) : null,
      compressCompliance: null,
      damping: [0, 0, 0, d.bending_damping],
      mass: Math.max(1e-4, d.mass),
      pin,
      pinStiffness: 1,
      goal,
      shapeMatch: 0,
      fieldWeight: d.effector_weights_all,
      collision: d.use_collision ? { distance: d.collision_distance, quality: Math.max(1, Math.round(d.collision_quality ?? 1)) } : null,
      self: null,
      restScale: 1,
    };
    const live = cache.live!;
    if (P.stretchCompliance) P.compressCompliance = P.stretchCompliance;
    while (cache.last < ft) {
      if (cache.last > pc.frame_start && outOfTime()) break;
      const k = cache.last + 1;
      const t0 = toWorld(rest, worldAt(sctx, ob, k - 1)),
        t1 = toWorld(rest, worldAt(sctx, ob, k));
      const effs = collectEffectors(sctx, k - 1, ob.id);
      const cols = d.use_collision ? buildColliders(sctx, k, ob.id, d.collision_distance + 0.1, d.collision_collection ?? null) : [];
      const vBefore = d.impulse_clamp ? Float64Array.from(live.state.v) : null;
      stepFrame(live.state, live.topo, P, t0, t1, effs, cols, k);
      hairVolume(live.state, hair.parents, per, d, MESH_SIM_FRAME_TIME);
      if (vBefore) clampImpulses(live.state, vBefore, d.impulse_clamp!);
      cache.frames.set(k, Float32Array.from(live.state.x));
      cache.last = k;
    }
    out = cache.frames.get(ft) ?? cache.nearest(ft);
    if (!out) return null;
  }
  // world → object space of this evaluation, then children around their parents
  const ev = (ctx.graph as Depsgraph).get(ob.id);
  const inv = (ev ? ev.world.clone() : new Matrix4()).invert();
  const points = new Float32Array(hair.points.length);
  points.set(toWorld(out, inv));
  if (hair.childDesc && hair.childSettings) points.set(childStrands(points.subarray(0, nParentPts * 3), per, hair.childDesc, hair.childSettings), nParentPts * 3);
  return { ...hair, points };
}
