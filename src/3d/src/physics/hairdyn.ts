// Hair dynamics: parent strands are simulated as chains (stretch and bending springs, roots
// pinned to the emitter, optional pull towards the groomed shape), frame by frame into a cache;
// children follow their simulated parents.
import { Matrix4, Vector3 } from 'three';
import type { ModifierBase, ObjectData } from '../data/types';
import type { ModifierContext } from '../eval/types';
import type { Depsgraph } from '../eval/depsgraph';
import { arrayChecksum, frameOf, getCache, motionKey, outOfTime, strHash, worldAt, type FrameCache, type SimContext } from './common';
import { collectEffectors, fieldsKey } from './fields';
import { buildColliders, collidersKey } from './colliders';
import { initState, stepFrame, KIND_STRUCT, KIND_BEND, type PBDParams, type PBDState, type Topology } from './pbd';
import { fps, gravityOf } from './meshsim';
import { compliance } from './cloth';
import { valueNoise } from './fields';
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
      dt: 1 / fps(doc),
      substeps: Math.max(1, Math.round(d.quality)),
      iterations: 4,
      gravity: gravityOf(doc, d.effector_weights_gravity * d.effector_weights_all),
      airDamping: d.air_damping,
      compliance: [1e-7, 1e-7, 1e-7, compliance(d.bending_stiffness)],
      damping: [0, 0, 0, d.bending_damping],
      mass: Math.max(1e-4, d.mass),
      pin,
      pinStiffness: 1,
      goal,
      shapeMatch: 0,
      fieldWeight: d.effector_weights_all,
      collision: d.use_collision ? { distance: d.collision_distance, quality: 1 } : null,
      self: null,
      restScale: 1,
    };
    const live = cache.live!;
    while (cache.last < ft) {
      if (cache.last > pc.frame_start && outOfTime()) break;
      const k = cache.last + 1;
      const t0 = toWorld(rest, worldAt(sctx, ob, k - 1)),
        t1 = toWorld(rest, worldAt(sctx, ob, k));
      const effs = collectEffectors(sctx, k - 1, ob.id);
      const cols = d.use_collision ? buildColliders(sctx, k, ob.id, d.collision_distance + 0.1) : [];
      stepFrame(live.state, live.topo, P, t0, t1, effs, cols, k);
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
  if (hair.children) {
    const C = hair.children;
    let w = nParentPts * 3;
    for (let c = 0; c < C.length; c += 5) {
      const pi = C[c],
        ox = C[c + 1],
        oy = C[c + 2],
        oz = C[c + 3],
        cs = C[c + 4];
      for (let k = 0; k <= seg; k++) {
        const u = k / seg;
        const clump = 1 - (s.clump_factor ?? 0) * u;
        const q = (pi * per + k) * 3;
        let x = points[q] + ox * clump,
          y = points[q + 1] + oy * clump,
          z = points[q + 2] + oz * clump;
        const r = (s.roughness_1 ?? 0) * u * s.hair_length;
        if (r) {
          x += valueNoise(x * 4, y * 4, z * 4, cs, 0) * r;
          y += valueNoise(x * 4, y * 4, z * 4, cs, 1) * r;
          z += valueNoise(x * 4, y * 4, z * 4, cs, 2) * r;
        }
        points[w++] = x;
        points[w++] = y;
        points[w++] = z;
      }
    }
  }
  return { ...hair, points };
}
