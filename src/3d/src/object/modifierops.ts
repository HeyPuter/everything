// Modifier stack operators beyond add/remove/apply: ordering, active modifier, copying, clearing,
// and applying a deform modifier as a shape key.
import { app, registerOperators, type OpContext } from '../app/app';
import { cloneShared } from '../data/cow';
import { uid } from '../data/defaults';
import type { ModifierBase, ObjectData } from '../data/types';
import { baseEvalMesh } from '../eval/depsgraph';
import { modifierTypes, newModifier } from '../eval/modifiers';
import type { ModifierContext } from '../eval/types';
import { ensureBasis } from './shapekeys';
import { uniqueIn } from './core';

/** Find a modifier by id or by name (scripts pass names). */
export function findModifier(ob: ObjectData | null, key: unknown): ModifierBase | undefined {
  if (!ob) return undefined;
  return ob.modifiers.find((m) => m.id === key) ?? ob.modifiers.find((m) => m.name === key);
}

const modProp = { id: 'modifier', label: 'Modifier', type: 'string' as const, default: '' };
const hasStack = (o: ObjectData | null) => !!o && ['MESH', 'CURVE', 'FONT', 'LATTICE'].includes(o.type);

function move(ob: ObjectData, m: ModifierBase, delta: number): boolean {
  const i = ob.modifiers.indexOf(m);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= ob.modifiers.length) return false;
  const list = ob.modifiers.slice();
  [list[i], list[j]] = [list[j], list[i]];
  ob.modifiers = list;
  return true;
}

function copyModifier(m: ModifierBase, existing: ModifierBase[]): ModifierBase {
  const c = cloneShared(m);
  c.id = uid('md');
  c.is_active = false;
  if (existing.some((x) => x.name === c.name)) c.name = newModifier(c.type, c.id, existing).name;
  return c;
}

const objectMode = (ctx: OpContext) => ctx.doc.mode === 'OBJECT';

registerOperators([
  {
    idname: 'object.modifier_move_up',
    label: 'Move Up Modifier',
    description: 'Move the modifier one step earlier in the stack',
    props: [modProp],
    poll: () => hasStack(app.activeObject),
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const m = findModifier(ob, p.modifier);
      if (!m || !move(ob, m, -1)) return 'CANCELLED';
    },
  },
  {
    idname: 'object.modifier_move_down',
    label: 'Move Down Modifier',
    description: 'Move the modifier one step later in the stack',
    props: [modProp],
    poll: () => hasStack(app.activeObject),
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const m = findModifier(ob, p.modifier);
      if (!m || !move(ob, m, 1)) return 'CANCELLED';
    },
  },
  {
    idname: 'object.modifier_set_active',
    label: 'Set Active Modifier',
    description: 'Make the modifier the active one (its node group shows in the node editor)',
    props: [modProp],
    poll: () => hasStack(app.activeObject),
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const m = findModifier(ob, p.modifier);
      if (!m) return 'CANCELLED';
      for (const x of ob.modifiers) x.is_active = x === m;
    },
    internal: true,
  },
  {
    idname: 'object.modifiers_clear',
    label: 'Clear Object Modifiers',
    description: 'Remove every modifier from the selected objects',
    poll: (ctx) => objectMode(ctx) && app.selectedObjects().some((o) => o.modifiers.length > 0),
    exec: () => {
      for (const ob of app.selectedObjects()) ob.modifiers = [];
    },
  },
  {
    idname: 'object.modifiers_copy_to_selected',
    label: 'Copy Modifiers to Selected Objects',
    description: 'Append copies of all of the active object’s modifiers to the other selected objects',
    poll: (ctx) => objectMode(ctx) && !!app.activeObject?.modifiers.length && app.selectedObjects().some((o) => o !== app.activeObject && hasStack(o)),
    exec: () => {
      const act = app.activeObject!;
      for (const ob of app.selectedObjects()) {
        if (ob === act || !hasStack(ob)) continue;
        const list = ob.modifiers.slice();
        for (const m of act.modifiers) {
          const t = modifierTypes[m.type];
          // mesh-only modifiers cannot go onto lattices
          if (ob.type === 'LATTICE' && t && !t.deformOnly) continue;
          list.push(copyModifier(m, list));
        }
        ob.modifiers = list;
      }
    },
  },
  {
    idname: 'object.modifier_apply_as_shapekey',
    label: 'Apply Modifier as Shape Key',
    description: 'Store the deformation of a deform modifier as a new shape key',
    props: [modProp, { id: 'keep_modifier', label: 'Keep Modifier', type: 'bool', default: false }],
    poll: (ctx) => objectMode(ctx) && app.activeObject?.type === 'MESH',
    exec: (ctx, p) => {
      const ob = app.activeObject!;
      const m = findModifier(ob, p.modifier);
      if (!m) return 'CANCELLED';
      const t = modifierTypes[m.type];
      if (!t?.deformOnly) {
        app.report('ERROR', 'Only deform modifiers can be applied as shape keys');
        return 'CANCELLED';
      }
      const me = ctx.doc.meshes[ob.data!];
      const users = Object.values(ctx.doc.objects).filter((o) => o.data === me.id).length;
      if (users > 1) {
        app.report('ERROR', 'Modifiers cannot be applied to multi-user data');
        return 'CANCELLED';
      }
      ensureBasis(me);
      const base = baseEvalMesh({ ...me, shape_keys: [], positions: me.shape_keys[0].data });
      const mctx: ModifierContext = { doc: ctx.doc, ob, graph: app.graph, frame: ctx.doc.scene.frame_current, source: me, editMode: false, render: false };
      const out = t.apply({ ...base, positions: new Float32Array(base.positions) }, m, mctx);
      if (out.positions.length !== me.positions.length) {
        app.report('ERROR', 'Modifier changed the vertex count');
        return 'CANCELLED';
      }
      me.shape_keys = [...me.shape_keys, { name: uniqueIn(me.shape_keys.map((k) => k.name), m.name), data: new Float32Array(out.positions), value: 0, slider_min: 0, slider_max: 1, mute: false, relative_key: me.shape_keys[0].name }];
      me.active_shape_key_index = me.shape_keys.length - 1;
      if (!p.keep_modifier) ob.modifiers = ob.modifiers.filter((x) => x !== m);
    },
  },
]);
