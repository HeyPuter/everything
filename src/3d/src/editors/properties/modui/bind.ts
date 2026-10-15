// Panels and bind operators of Corrective Smooth, Laplacian Deform, Mesh Deform and Surface Deform.
import { h, type Child } from '../../../ui/h';
import { num, bool, enumProp } from '../../../ui/props';
import { app, registerOperators } from '../../../app/app';
import type { ModifierBase, ObjectData } from '../../../data/types';
import type { EvalMesh } from '../../../eval/types';
import { modifierFields, modifierExtraUI } from '../stack';
import { vgroupRow, objRow, wideButton } from './kit';
import { findModifier } from '../../../object/modifierops';
import { bindMeshDeform, bindSurface } from '../../../eval/mods/bind';
import { triangles, transformedPositions } from '../../../eval/mods/spatial';
import { groupWeights } from '../../../eval/meshbuild';

type Rec = Record<string, unknown>;

/** The mesh a modifier receives: the stack evaluated up to (not including) it. */
export function modifierInput(ob: ObjectData, m: ModifierBase): EvalMesh | null {
  const keep = ob.modifiers;
  const idx = keep.indexOf(m);
  if (idx < 0) return null;
  ob.modifiers = keep.slice(0, idx).filter((x) => x.show_viewport);
  try {
    app.graph.invalidate(ob.id);
    app.graph.evaluate(app.doc, false);
    const mesh = app.graph.get(ob.id)?.mesh;
    return mesh ? { ...mesh, positions: Float32Array.from(mesh.positions) } : null;
  } finally {
    ob.modifiers = keep;
    app.graph.invalidate(ob.id);
  }
}

const BIND_KEYS = ['_bind_coords', '_bind_rest', '_bind_cage', '_bind_index', '_bind_weight', '_bind_k', '_bind_tris', '_bind_bary', '_bind_offset', '_bind_target_verts'];
export const isBound = (m: ModifierBase) => BIND_KEYS.some((k) => m[k] !== undefined);
function unbind(m: ModifierBase) {
  for (const k of BIND_KEYS) delete m[k];
}

/** Local-space positions and mesh of another object relative to `ob`. */
function otherInLocal(ob: ObjectData, id: unknown): { mesh: EvalMesh; positions: Float32Array } | null {
  if (typeof id !== 'string') return null;
  const t = app.graph.get(id),
    own = app.graph.get(ob.id);
  if (!t?.mesh || !own) return null;
  return { mesh: t.mesh, positions: transformedPositions(t.mesh.positions, own.world.clone().invert().multiply(t.world)) };
}

const modProp = { id: 'modifier', label: 'Modifier', type: 'string' as const, default: '' };
const bindPoll = (type: string) => () => !!app.activeObject?.modifiers.some((x) => x.type === type);

function bindOp(idname: string, label: string, type: string, bindFn: (ob: ObjectData, m: ModifierBase) => string | null) {
  return {
    idname,
    label,
    description: `Bind the ${label.replace(/ Bind$/, '')} modifier to its current state, or release an existing bind`,
    props: [modProp],
    poll: bindPoll(type),
    exec: (_ctx: unknown, p: Record<string, unknown>) => {
      const ob = app.activeObject!;
      const m = findModifier(ob, p.modifier) ?? ob.modifiers.find((x) => x.type === type && x.is_active) ?? ob.modifiers.find((x) => x.type === type);
      if (!m || m.type !== type) return 'CANCELLED' as const;
      if (isBound(m)) {
        unbind(m);
        app.graph.invalidate(ob.id);
        return;
      }
      const err = bindFn(ob, m);
      app.graph.invalidate(ob.id);
      if (err) {
        app.report('ERROR', err);
        return 'CANCELLED' as const;
      }
    },
  };
}

registerOperators([
  bindOp('object.correctivesmooth_bind', 'Corrective Smooth Bind', 'CORRECTIVE_SMOOTH', (ob, m) => {
    const input = modifierInput(ob, m);
    if (!input) return 'Nothing to bind';
    m._bind_coords = input.positions;
    return null;
  }),
  bindOp('object.laplaciandeform_bind', 'Laplacian Deform Bind', 'LAPLACIANDEFORM', (ob, m) => {
    const input = modifierInput(ob, m);
    if (!input) return 'Nothing to bind';
    if (!groupWeights(input, String(m.vertex_group ?? ''))) return 'Set an anchor vertex group first';
    m._bind_rest = input.positions;
    return null;
  }),
  bindOp('object.meshdeform_bind', 'Mesh Deform Bind', 'MESH_DEFORM', (ob, m) => {
    const input = modifierInput(ob, m);
    const cage = otherInLocal(ob, m.object);
    if (!input || !cage) return 'Set a cage object first';
    const { tris } = triangles(cage.mesh);
    if (!tris.length) return 'The cage needs faces';
    const b = bindMeshDeform(input.positions, cage.positions, tris);
    Object.assign(m, { _bind_cage: b.cage, _bind_index: b.index, _bind_weight: b.weight, _bind_rest: b.rest, _bind_k: b.k });
    return null;
  }),
  bindOp('object.surfacedeform_bind', 'Surface Deform Bind', 'SURFACE_DEFORM', (ob, m) => {
    const input = modifierInput(ob, m);
    const target = otherInLocal(ob, m.target);
    if (!input || !target) return 'Set a target object first';
    if (target.mesh.offsets.length < 2) return 'The target needs faces';
    let only: Uint8Array | null = null;
    if (m.use_sparse_bind) {
      const w = groupWeights(input, String(m.vertex_group ?? ''));
      if (w) only = Uint8Array.from(w, (x) => ((x > 0) !== !!m.invert_vertex_group ? 1 : 0));
    }
    const b = bindSurface(input.positions, target.mesh, target.positions, Number(m.falloff ?? 4), only);
    Object.assign(m, { _bind_tris: b.tris, _bind_bary: b.bary, _bind_offset: b.offset, _bind_weight: b.weight, _bind_k: b.k, _bind_target_verts: b.targetVerts });
    return null;
  }),
]);

function bindButton(m: ModifierBase, op: string, enabled = true): Child {
  const bound = isBound(m);
  return wideButton(`${m.id}.bind`, bound ? 'Unbind' : 'Bind', () => app.run(op, { modifier: m.id }), { disabled: !enabled && !bound });
}

modifierFields.CORRECTIVE_SMOOTH = [];
modifierExtraUI.CORRECTIVE_SMOOTH = (ob, m) => {
  const r = m as Rec;
  return [
    num(r, 'factor', 'Factor', { softMin: 0, softMax: 1, slider: true }),
    num(r, 'iterations', 'Repeat', { int: true, min: 0, max: 32767, softMax: 200 }),
    num(r, 'scale', 'Scale', { softMin: 0, softMax: 10 }),
    enumProp(r, 'smooth_type', 'Smooth Type', [
      ['SIMPLE', 'Simple'],
      ['LENGTH_WEIGHTED', 'Length Weight'],
    ]),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    bool(r, 'use_only_smooth', 'Only Smooth'),
    bool(r, 'use_pin_boundary', 'Pin Boundaries'),
    enumProp(r, 'rest_source', 'Rest Source', [
      ['ORCO', 'Original Coords'],
      ['BIND', 'Bind Coords'],
    ]),
    r.rest_source === 'BIND' ? bindButton(m, 'object.correctivesmooth_bind') : null,
  ];
};

modifierFields.LAPLACIANDEFORM = [];
modifierExtraUI.LAPLACIANDEFORM = (ob, m) => {
  const r = m as Rec;
  return [
    num(r, 'iterations', 'Repeat', { int: true, min: 0, softMin: 1, softMax: 50 }),
    vgroupRow(ob, m, 'vertex_group', 'Anchors Vertex Group', 'invert_vertex_group'),
    h('div', { class: 'ui-sep' }),
    bindButton(m, 'object.laplaciandeform_bind', !!r.vertex_group),
  ];
};

modifierFields.MESH_DEFORM = [];
modifierExtraUI.MESH_DEFORM = (ob, m) => {
  const r = m as Rec;
  const bound = isBound(m);
  return [
    bound ? h('div', { class: 'mod-note' }, 'Bound to the cage. Unbind to change the cage object.') : objRow(r, 'object', 'Object', (o) => o.id !== ob.id && o.type === 'MESH'),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    h('div', { class: 'ui-sep' }),
    !bound ? num(r, 'precision', 'Precision', { int: true, min: 2, max: 10 }) : null,
    bool(r, 'use_dynamic_bind', 'Dynamic'),
    bindButton(m, 'object.meshdeform_bind', !!r.object),
  ];
};

modifierFields.SURFACE_DEFORM = [];
modifierExtraUI.SURFACE_DEFORM = (ob, m) => {
  const r = m as Rec;
  const bound = isBound(m);
  return [
    bound ? h('div', { class: 'mod-note' }, 'Bound to the target. Unbind to change it.') : objRow(r, 'target', 'Target', (o) => o.id !== ob.id && o.type === 'MESH'),
    num(r, 'falloff', 'Interpolation Falloff', { min: 2, max: 16, disabled: bound }),
    num(r, 'strength', 'Strength', { min: -100, max: 100 }),
    vgroupRow(ob, m, 'vertex_group', 'Vertex Group', 'invert_vertex_group'),
    bool(r, 'use_sparse_bind', 'Sparse Bind', { disabled: bound }),
    bindButton(m, 'object.surfacedeform_bind', !!r.target),
  ];
};
