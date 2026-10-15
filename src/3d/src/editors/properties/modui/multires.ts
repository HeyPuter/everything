// Multiresolution: panel and level operators (subdivide, unsubdivide, rebuild, delete higher,
// apply base, reshape).
import { h } from '../../../ui/h';
import { num, bool } from '../../../ui/props';
import { app, registerOperators } from '../../../app/app';
import type { MeshData, ModifierBase, ObjectData } from '../../../data/types';
import type { EvalMesh } from '../../../eval/types';
import { modifierFields, modifierExtraUI } from '../stack';
import { sub, wideButton } from './kit';
import { findModifier } from '../../../object/modifierops';
import { baseEvalMesh } from '../../../eval/depsgraph';
import { catmullClark } from '../../../eval/modifiers';
import { MAX_MULTIRES_LEVEL, displacedTop, encodeDisps, multiresAtLevel, multiresTotal, subdivideDisps, subdividedMap, unsubdivide } from '../../../eval/mods/multires';

type Rec = Record<string, unknown>;

const meshOf = (ob: ObjectData | null) => (ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined);
const modProp = { id: 'modifier', label: 'Modifier', type: 'string' as const, default: '' };

function target(p: Record<string, unknown>): { ob: ObjectData; me: MeshData; m: ModifierBase } | null {
  const ob = app.activeObject;
  const me = meshOf(ob);
  if (!ob || !me) return null;
  const m = findModifier(ob, p.modifier) ?? ob.modifiers.find((x) => x.type === 'MULTIRES');
  if (!m || m.type !== 'MULTIRES') return null;
  return { ob, me, m };
}

const poll = () => app.doc.mode === 'OBJECT' && !!app.activeObject?.modifiers.some((m) => m.type === 'MULTIRES');

/** Raise the display levels that were at the top along with the new top. */
function setTotal(m: ModifierBase, total: number) {
  const old = multiresTotal(m);
  m.total_levels = total;
  for (const k of ['levels', 'sculpt_levels', 'render_levels']) {
    const v = Number(m[k] ?? 0);
    m[k] = v >= old ? total : Math.min(v, total);
  }
}

/** Replace the mesh's geometry by a (coarser) evaluated mesh. */
function replaceGeometry(me: MeshData, g: EvalMesh) {
  const nv = g.positions.length / 3;
  me.positions = Float32Array.from(g.positions);
  me.offsets = Uint32Array.from(g.offsets);
  me.indices = Uint32Array.from(g.indices);
  me.uvs = Float32Array.from(g.uvs);
  me.normals = Float32Array.from(g.normals);
  me.smooth = g.smooth ? Uint8Array.from(g.smooth) : undefined;
  me.material_index = g.material_index ? Uint16Array.from(g.material_index) : undefined;
  me.seams = me.sharp = undefined;
  me.creases = undefined;
  me.custom_normals = undefined;
  me.quad_flip = undefined;
  me.face_strength = undefined;
  me.select_vert = me.hide_vert = undefined;
  me.loose_edges = undefined;
  me.skin_vertices = undefined;
  me.sculpt_mask = undefined;
  me.sculpt_face_set = undefined;
  me.hide_poly = undefined;
  if (g.weights) me.weights = g.weights.map((w) => Float32Array.from(w));
  const orig = g.origIndex;
  me.color_attributes = me.color_attributes.map((c, i) => {
    if (c.domain === 'POINT') {
      const data = new Float32Array(nv * 4).fill(1);
      if (orig) for (let v = 0; v < nv; v++) if (orig[v] >= 0) data.set(c.data.subarray(orig[v] * 4, orig[v] * 4 + 4), v * 4);
      return { ...c, data };
    }
    if (i === me.active_color_index && g.colors) return { ...c, data: Float32Array.from(g.colors) };
    return { ...c, data: new Float32Array(g.indices.length * 4).fill(1) };
  });
}

/** One unsubdivide step; returns false when the base is not a subdivided mesh. */
function unsubdivideStep(me: MeshData, m: ModifierBase): boolean {
  if (me.shape_keys.length) return false;
  const base = baseEvalMesh(me);
  const total = multiresTotal(m);
  if (total >= MAX_MULTIRES_LEVEL) return false;
  const r = unsubdivide(base);
  if (!r) return false;
  // the current finest positions, re-ordered as the subdivision of the new coarse base
  const top = displacedTop(base, m).positions;
  const map = total ? subdividedMap(base, catmullClark(r.coarse, 1, true, false), r.map, total) : r.map;
  const ordered = new Float32Array(top.length);
  for (let v = 0; v < map.length; v++) ordered.set(top.subarray(v * 3, v * 3 + 3), map[v] * 3);
  const newTop = catmullClark(r.coarse, total + 1, false, m.use_creases !== false);
  if (newTop.positions.length !== ordered.length) return false;
  m._disps = encodeDisps(newTop, ordered);
  replaceGeometry(me, r.coarse);
  setTotal(m, total + 1);
  return true;
}

registerOperators([
  {
    idname: 'object.multires_subdivide',
    label: 'Multires Subdivide',
    description: 'Add a level of detail to the multiresolution modifier',
    props: [modProp, { id: 'mode', label: 'Subdivision Mode', type: 'enum', default: 'CATMULL_CLARK', items: [['CATMULL_CLARK', 'Catmull-Clark'], ['SIMPLE', 'Simple'], ['LINEAR', 'Linear']] }],
    poll,
    exec: (_ctx, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      const total = multiresTotal(t.m);
      if (total >= MAX_MULTIRES_LEVEL) {
        app.report('WARNING', `Multires is limited to ${MAX_MULTIRES_LEVEL} levels here`);
        return 'CANCELLED';
      }
      const base = baseEvalMesh(t.me);
      t.m._disps = subdivideDisps(base, t.m, String(p.mode ?? 'CATMULL_CLARK'));
      setTotal(t.m, total + 1);
    },
  },
  {
    idname: 'object.multires_unsubdivide',
    label: 'Unsubdivide',
    description: 'Rebuild a lower level of detail from the base mesh, keeping the shape',
    props: [modProp],
    poll,
    exec: (_ctx, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      if (!unsubdivideStep(t.me, t.m)) {
        app.report('ERROR', 'No valid subdivisions found to rebuild a lower level');
        return 'CANCELLED';
      }
    },
  },
  {
    idname: 'object.multires_rebuild_subdiv',
    label: 'Rebuild Lower Subdivisions',
    description: 'Rebuild every possible lower level of detail from the base mesh',
    props: [modProp],
    poll,
    exec: (_ctx, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      let n = 0;
      while (unsubdivideStep(t.me, t.m)) n++;
      if (!n) {
        app.report('ERROR', 'No valid subdivisions found to rebuild lower levels');
        return 'CANCELLED';
      }
      app.report('INFO', `Rebuilt ${n} level${n > 1 ? 's' : ''}`);
    },
  },
  {
    idname: 'object.multires_higher_levels_delete',
    label: 'Delete Higher Levels',
    description: 'Remove the levels above the viewport level',
    props: [modProp],
    poll,
    exec: (_ctx, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      const level = Math.max(0, Math.min(multiresTotal(t.m), Math.round(Number(t.m.levels ?? 0))));
      const base = baseEvalMesh(t.me);
      const keep = multiresAtLevel(base, t.m, level);
      t.m._disps = level ? encodeDisps(catmullClark(base, level, false, t.m.use_creases !== false), keep.positions) : undefined;
      if (!level) delete t.m._disps;
      t.m.total_levels = level;
      for (const k of ['levels', 'sculpt_levels', 'render_levels']) t.m[k] = Math.min(Number(t.m[k] ?? 0), level);
    },
  },
  {
    idname: 'object.multires_base_apply',
    label: 'Apply Base',
    description: 'Move the base mesh towards the detailed shape, keeping the detailed shape unchanged',
    props: [modProp],
    poll,
    exec: (_ctx, p) => {
      const t = target(p);
      if (!t || !multiresTotal(t.m)) return 'CANCELLED';
      const base = baseEvalMesh(t.me);
      const top = displacedTop(base, t.m).positions;
      const nb = t.me.positions.length;
      const moved = Float32Array.from(top.subarray(0, nb));
      t.me.positions = moved;
      t.me.shape_keys = t.me.shape_keys.map((k, i) => (i === 0 ? { ...k, data: moved } : k));
      const newTop = catmullClark({ ...base, positions: moved }, multiresTotal(t.m), false, t.m.use_creases !== false);
      t.m._disps = encodeDisps(newTop, top);
    },
  },
  {
    idname: 'object.multires_reshape',
    label: 'Multires Reshape',
    description: 'Copy the shape of another selected mesh with the same vertex count as the finest level (or the base)',
    props: [modProp],
    poll: () => poll() && app.selectedObjects().filter((o) => o.type === 'MESH').length > 1,
    exec: (_ctx, p) => {
      const t = target(p);
      if (!t) return 'CANCELLED';
      const other = app.selectedObjects().find((o) => o !== t.ob && o.type === 'MESH');
      const src = other ? app.graph.get(other.id)?.mesh : undefined;
      if (!src) return 'CANCELLED';
      const base = baseEvalMesh(t.me);
      const total = multiresTotal(t.m);
      const top = catmullClark(base, total, false, t.m.use_creases !== false);
      if (src.positions.length === top.positions.length) t.m._disps = encodeDisps(top, src.positions);
      else if (src.positions.length === t.me.positions.length) t.me.positions = Float32Array.from(src.positions);
      else {
        app.report('ERROR', 'Objects do not have the same number of vertices');
        return 'CANCELLED';
      }
    },
  },
]);

modifierFields.MULTIRES = [];
modifierExtraUI.MULTIRES = (_ob, m) => {
  const r = m as Rec;
  const total = multiresTotal(m);
  const run = (op: string, props: Record<string, unknown> = {}) => () => app.run(op, { modifier: m.id, ...props });
  const objectMode = app.doc.mode === 'OBJECT';
  return [
    num(r, 'levels', 'Level Viewport', { int: true, min: 0, max: total }),
    num(r, 'render_levels', 'Render', { int: true, min: 0, max: total }),
    h('div', { class: 'mod-note' }, `Total levels: ${total}`),
    h(
      'div',
      { class: 'mod-wide' },
      wideButton(`${m.id}.sub`, 'Subdivide', run('object.multires_subdivide', { mode: 'CATMULL_CLARK' }), { disabled: !objectMode || total >= MAX_MULTIRES_LEVEL }),
      wideButton(`${m.id}.simple`, 'Simple', run('object.multires_subdivide', { mode: 'SIMPLE' }), { disabled: !objectMode || total >= MAX_MULTIRES_LEVEL }),
      wideButton(`${m.id}.linear`, 'Linear', run('object.multires_subdivide', { mode: 'LINEAR' }), { disabled: !objectMode || total >= MAX_MULTIRES_LEVEL }),
    ),
    h('div', { class: 'mod-wide' }, wideButton(`${m.id}.unsub`, 'Unsubdivide', run('object.multires_unsubdivide'), { disabled: !objectMode }), wideButton(`${m.id}.del`, 'Delete Higher', run('object.multires_higher_levels_delete'), { disabled: !objectMode || Number(r.levels ?? 0) >= total })),
    sub(m, 'shape', 'Shape', () => [h('div', { class: 'mod-wide' }, wideButton(`${m.id}.reshape`, 'Reshape', run('object.multires_reshape'), { disabled: !objectMode }), wideButton(`${m.id}.applybase`, 'Apply Base', run('object.multires_base_apply'), { disabled: !objectMode || !total }))]),
    sub(m, 'generate', 'Generate', () => [wideButton(`${m.id}.rebuild`, 'Rebuild Subdivisions', run('object.multires_rebuild_subdiv'), { disabled: !objectMode })]),
    sub(m, 'advanced', 'Advanced', () => [bool(r, 'use_creases', 'Use Creases')]),
  ];
};
