// Frame-cached runner for mesh simulations (Cloth, Soft Body) used by their modifiers.
import { Matrix4 } from 'three';
import type { DocumentData, ModifierBase, ObjectData } from '../data/types';
import type { EvalMesh, ModifierContext } from '../eval/types';
import type { Depsgraph } from '../eval/depsgraph';
import { meshSignature } from '../eval/depsgraph';
import { arrayChecksum, frameOf, getCache, motionKey, outOfTime, strHash, worldAt, type FrameCache, type SimContext } from './common';
import { collectEffectors, fieldsKey, fieldObjects } from './fields';
import { buildColliders, collidersKey, colliderObjects } from './colliders';
import { buildTopology, initState, stepFrame, KIND_STRUCT, KIND_SHEAR, type PBDParams, type PBDState, type Topology } from './pbd';
import type { PointCacheSettings } from './types';

export interface MeshSimSetup {
  params: PBDParams;
  /** world-space shape for shape matching (rest), optional */
  useRestShape?: boolean;
  shear: boolean;
  bend: boolean;
  /** collisions with collider objects enabled */
  collide: boolean;
  /** loose edges pull their vertices together */
  sewing?: boolean;
  internal?: { maxLength: number; maxDiversion: number; normalCheck: boolean } | null;
  /** vertex group driven stiffness (and shrinking), interpolated from the base to the max value */
  weights?: {
    base: [number, number, number, number];
    structural?: { w: ArrayLike<number>; tensionMax: number; compressionMax: number };
    shear?: { w: ArrayLike<number>; max: number };
    bending?: { w: ArrayLike<number>; max: number };
    shrink?: { w: ArrayLike<number>; min: number; max: number };
  } | null;
}

interface Live {
  state: PBDState;
  topo: Topology;
}

export const fps = (doc: DocumentData) => doc.scene.render.fps / (doc.scene.render.fps_base || 1);

export function gravityOf(doc: DocumentData, weight: number): [number, number, number] {
  const g = doc.scene.use_gravity ? doc.scene.gravity : [0, 0, 0];
  return [g[0] * weight, g[1] * weight, g[2] * weight];
}

/** Ids of objects mesh simulations depend on (colliders and fields). */
export function simDeps(doc: DocumentData | null, self?: string): string[] {
  if (!doc) return [];
  return [...colliderObjects(doc, self).map((o) => o.id), ...fieldObjects(doc).map((o) => o.id)];
}

export function meshSimKey(kind: string, ob: ObjectData, m: ModifierBase) {
  return `${kind}:${ob.id}:${m.id}`;
}

function transform(local: Float32Array, m: Matrix4): Float32Array {
  const e = m.elements;
  const out = new Float32Array(local.length);
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i],
      y = local[i + 1],
      z = local[i + 2];
    out[i] = e[0] * x + e[4] * y + e[8] * z + e[12];
    out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  return out;
}

/** Inputs hash: settings, scene, mesh, object motion, colliders and fields. */
export function meshSimHash(doc: DocumentData, ob: ObjectData, m: ModifierBase, mesh: EvalMesh | null, source: ModifierContext['source']): string {
  const pc = m.point_cache as PointCacheSettings;
  const before: unknown[] = [];
  for (const x of ob.modifiers) {
    if (x === m) break;
    before.push(x);
  }
  const s = [
    JSON.stringify({ ...m, name: '', show_expanded: 0, point_cache: { frame_start: pc.frame_start, frame_end: pc.frame_end } }),
    JSON.stringify(before),
    source ? meshSignature(source) : '',
    mesh ? `${mesh.positions.length}:${arrayChecksum(mesh.indices)}` : '',
    doc.scene.use_gravity,
    doc.scene.gravity.join(','),
    fps(doc),
    motionKey(doc, ob, pc.frame_start),
    collidersKey(doc, pc.frame_start, ob.id),
    fieldsKey(doc, pc.frame_start),
  ].join('#');
  return strHash(s);
}

/**
 * Evaluate a mesh simulation modifier at the context frame: step the cache from the
 * start frame as needed and return the deformed mesh (object space).
 */
export function runMeshSim(kind: string, mesh: EvalMesh, m: ModifierBase, ctx: ModifierContext, setup: (mesh: EvalMesh, doc: DocumentData) => MeshSimSetup): EvalMesh {
  if (ctx.editMode) return mesh;
  const doc = ctx.doc,
    ob = ctx.ob;
  const pc = m.point_cache as PointCacheSettings;
  const f = frameOf(ctx.graph);
  const cache = getCache<Float32Array, Live>(meshSimKey(kind, ob, m)) as FrameCache<Float32Array, Live>;
  cache.label = `${ob.name} ▸ ${m.name}`;
  cache.start = pc.frame_start;
  cache.end = pc.frame_end;
  cache.baked = pc.is_baked;
  const nverts = mesh.positions.length;
  const hash = meshSimHash(doc, ob, m, mesh, ctx.source);
  const usable = pc.is_baked && cache.frames.size > 0 && cache.frames.values().next().value?.length === nverts;
  if (!usable && cache.hash !== hash) cache.reset(hash);
  if (f <= pc.frame_start) return mesh;
  const ft = Math.min(f, pc.frame_end);
  let out = cache.frames.get(ft);
  if (!out) {
    const sctx: SimContext = { doc, graph: ctx.graph };
    const local = mesh.positions;
    const st = setup(mesh, doc);
    if (!cache.live || cache.last < pc.frame_start || cache.live.topo.nverts * 3 !== nverts) {
      const w0 = transform(local, worldAt(sctx, ob, pc.frame_start));
      cache.frames.clear();
      cache.frames.set(pc.frame_start, w0);
      cache.live = { state: initState(w0), topo: buildTopology(local, mesh.offsets, mesh.indices, { shear: st.shear, bend: st.bend, sewing: st.sewing ? mesh.looseEdges : null, internal: st.internal }) };
      cache.last = pc.frame_start;
    }
    const live = cache.live;
    if (st.weights) applyPropertyWeights(st, live.topo);
    const restShape = st.useRestShape ? local : undefined;
    while (cache.last < ft) {
      if (cache.last > pc.frame_start && outOfTime()) break;
      const k = cache.last + 1;
      const t0 = transform(local, worldAt(sctx, ob, k - 1));
      const t1 = transform(local, worldAt(sctx, ob, k));
      const effs = collectEffectors(sctx, k - 1);
      const cols = st.collide ? buildColliders(sctx, k, ob.id, (st.params.collision?.distance ?? 0) + 0.1) : [];
      stepFrame(live.state, live.topo, st.params, t0, t1, effs, cols, k, restShape ? transform(restShape, worldAt(sctx, ob, k)) : undefined);
      cache.frames.set(k, Float32Array.from(live.state.x));
      cache.last = k;
    }
    out = cache.frames.get(ft) ?? cache.nearest(ft);
    if (!out) return mesh;
  }
  if (out.length !== nverts) return mesh;
  // world → object space of the current evaluation
  const ev = (ctx.graph as Depsgraph).get(ob.id);
  const inv = (ev ? ev.world.clone() : new Matrix4()).invert();
  return { ...mesh, positions: transform(out, inv) };
}

/** Per-constraint stiffness and rest scale from vertex group weights (average of both ends). */
function applyPropertyWeights(st: MeshSimSetup, topo: Topology) {
  const W = st.weights!;
  const n = topo.a.length;
  const comp = (k: number) => (k > 0 ? 1 / (k * 1000) : 1e6);
  const stretch = new Float32Array(n),
    compress = new Float32Array(n);
  const P = st.params;
  for (let c = 0; c < n; c++) {
    const i = topo.a[c],
      j = topo.b[c];
    const kind = topo.kind[c];
    const avg = (w: ArrayLike<number>) => ((w[i] ?? 0) + (w[j] ?? 0)) / 2;
    if (kind === KIND_STRUCT) {
      const w = W.structural ? avg(W.structural.w) : 0;
      stretch[c] = W.structural ? comp(W.base[0] + (W.structural.tensionMax - W.base[0]) * w) : P.compliance[0];
      compress[c] = W.structural ? comp(W.base[1] + (W.structural.compressionMax - W.base[1]) * w) : P.compliance[1];
    } else if (kind === KIND_SHEAR) {
      stretch[c] = compress[c] = W.shear ? comp(W.base[2] + (W.shear.max - W.base[2]) * avg(W.shear.w)) : P.compliance[2];
    } else {
      stretch[c] = compress[c] = W.bending ? comp(W.base[3] + (W.bending.max - W.base[3]) * avg(W.bending.w)) : P.compliance[3];
    }
  }
  P.stretchCompliance = stretch;
  P.compressCompliance = compress;
  if (W.shrink) {
    const rs = new Float32Array(n);
    for (let c = 0; c < n; c++) {
      const w = ((W.shrink.w[topo.a[c]] ?? 0) + (W.shrink.w[topo.b[c]] ?? 0)) / 2;
      rs[c] = 1 - Math.min(0.99, Math.max(-1, W.shrink.min + (W.shrink.max - W.shrink.min) * w));
    }
    P.restScales = rs;
  }
}

/** Signature for the depsgraph's mesh cache: changes whenever the cached output would. */
export function meshSimSignature(kind: string, m: ModifierBase, c: { doc: DocumentData; ob: ObjectData; graph: Depsgraph; frame: number }): string {
  const cache = getCache<Float32Array, Live>(meshSimKey(kind, c.ob, m));
  const pc = m.point_cache as PointCacheSettings;
  const f = Math.min(frameOf(c.graph), pc.frame_end);
  const hash = meshSimHash(c.doc, c.ob, m, null, null);
  return `${hash}:${pc.is_baked}:${cache.frames.has(f) ? 'hit' : 'miss' + cache.last}:${cache.frames.size}`;
}
