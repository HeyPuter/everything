// Sculpting a multiresolution mesh at its sculpt level: entering Sculpt Mode swaps the mesh for
// the detailed level; leaving it turns the sculpted changes back into displacements and restores
// the base mesh.
import { app, onAppReady } from '../../../app/app';
import type { MeshData, ModifierBase, ObjectData } from '../../../data/types';
import type { EvalMesh } from '../../../eval/types';
import { modeHandlers } from '../../../ops/modes';
import { baseEvalMesh } from '../../../eval/depsgraph';
import { catmullClark } from '../../../eval/modifiers';
import { encodeDisps, displacedTop, multiresAtLevel, multiresTotal } from '../../../eval/mods/multires';

const GEOMETRY = ['positions', 'offsets', 'indices', 'uvs', 'normals', 'smooth', 'material_index', 'seams', 'sharp', 'creases', 'custom_normals', 'quad_flip', 'face_strength', 'select_vert', 'hide_vert', 'loose_edges', 'sculpt_mask', 'sculpt_face_set', 'hide_poly', 'skin_vertices'] as const;

function sculptTarget(ob: ObjectData): { me: MeshData; m: ModifierBase } | null {
  const me = ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  const m = ob.modifiers.find((x) => x.type === 'MULTIRES' && x.show_viewport);
  if (!me || !m || m.use_sculpt_base_mesh || me.shape_keys.length) return null;
  return { me, m };
}

let sculpted: { ob: ObjectData; m: ModifierBase } | null = null;

/** Swap the mesh for its multires sculpt level. */
export function beginMultiresSculpt(ob: ObjectData): boolean {
  const t = sculptTarget(ob);
  if (!t || t.m._sculpt_base) return false;
  const total = multiresTotal(t.m);
  const level = Math.min(total, Math.round(Number(t.m.sculpt_levels ?? total)));
  if (!total || level <= 0) return false;
  const base = baseEvalMesh(t.me);
  const lvl = multiresAtLevel(base, t.m, level);
  const saved: Record<string, unknown> = {};
  for (const k of GEOMETRY) saved[k] = (t.me as unknown as Record<string, unknown>)[k];
  saved.weights = t.me.weights;
  t.m._sculpt_base = saved;
  t.m._sculpt_level = level;
  Object.assign(t.me, {
    positions: Float32Array.from(lvl.positions),
    offsets: lvl.offsets,
    indices: lvl.indices,
    uvs: lvl.uvs,
    normals: lvl.normals,
    smooth: lvl.smooth,
    material_index: lvl.material_index,
    seams: undefined,
    sharp: undefined,
    creases: undefined,
    custom_normals: undefined,
    quad_flip: undefined,
    face_strength: undefined,
    select_vert: undefined,
    hide_vert: undefined,
    loose_edges: undefined,
    sculpt_mask: undefined,
    sculpt_face_set: undefined,
    hide_poly: undefined,
    skin_vertices: undefined,
    weights: lvl.weights ? lvl.weights.map((w) => Float32Array.from(w)) : t.me.weights.map(() => new Float32Array(lvl.positions.length / 3)),
  });
  sculpted = { ob, m: t.m };
  app.graph.invalidate(ob.id);
  return true;
}

/** Store the sculpted level as displacements and bring the base mesh back. */
export function endMultiresSculpt(ob: ObjectData, m: ModifierBase) {
  const me = ob.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  const saved = m._sculpt_base as Record<string, unknown> | undefined;
  if (!me || !saved) return;
  const level = Number(m._sculpt_level ?? 0);
  const S = me.positions;
  Object.assign(me, saved);
  delete m._sculpt_base;
  delete m._sculpt_level;
  const base = baseEvalMesh(me);
  const total = multiresTotal(m);
  const before = multiresAtLevel(base, m, level);
  if (before.positions.length !== S.length) {
    app.report('WARNING', 'The sculpted mesh changed its topology: multires detail was kept as it was');
    app.graph.invalidate(ob.id);
    return;
  }
  const useCreases = m.use_creases !== false;
  let newTop: Float32Array;
  if (level === total) newTop = Float32Array.from(S);
  else {
    // carry the change made at the sculpt level up to the finest level
    let delta: EvalMesh = { ...before, positions: Float32Array.from(S, (x, i) => x - before.positions[i]) };
    for (let l = level; l < total; l++) delta = catmullClark(delta, 1, true, false);
    const top = displacedTop(base, m).positions;
    newTop = Float32Array.from(top, (x, i) => x + (delta.positions[i] ?? 0));
  }
  m._disps = encodeDisps(catmullClark(base, total, false, useCreases), newTop);
  app.graph.invalidate(ob.id);
}

onAppReady(() => {
  const prev = modeHandlers.SCULPT;
  if (!prev) return;
  modeHandlers.SCULPT = {
    ...prev,
    enter: (ob) => {
      const swapped = beginMultiresSculpt(ob);
      const ok = prev.enter ? prev.enter(ob) : true;
      if (!ok && swapped && sculpted) {
        endMultiresSculpt(sculpted.ob, sculpted.m);
        sculpted = null;
      }
      return ok;
    },
    exit: () => {
      prev.exit?.();
      if (sculpted) {
        endMultiresSculpt(sculpted.ob, sculpted.m);
        sculpted = null;
      }
    },
  };
});
