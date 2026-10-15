// Hook modifier operators: hook vertices to a selected object, and manage existing hooks
// (assign, reset, recenter, select, remove). Also the Edit Mode "Hooks" and "Vertex Groups" menus.
import { Matrix4, Vector3 } from 'three';
import { app, registerOperators, type OpContext } from '../app/app';
import { uid } from '../data/defaults';
import type { MeshData, ModifierBase, ObjectData } from '../data/types';
import { newModifier } from '../eval/modifiers';
import type { MenuItem } from '../ui/menu';
import { h } from '../ui/h';
import { opButton } from '../ui/widgets';
import { modifierExtraUI } from '../editors/properties/stack';
import { findModifier } from './modifierops';

const editMesh = (ctx: OpContext) => ctx.doc.mode === 'EDIT' && app.activeObject?.type === 'MESH';

function editTarget(): { ob: ObjectData; me: MeshData } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'MESH' || !ob.data) return null;
  const me = app.doc.meshes[ob.data];
  return me ? { ob, me } : null;
}

function selectedIndices(me: MeshData): number[] {
  const out: number[] = [];
  const s = me.select_vert;
  if (s) for (let i = 0; i < s.length; i++) if (s[i] && !me.hide_vert?.[i]) out.push(i);
  return out;
}

function centroid(me: MeshData, idx: number[]): Vector3 {
  const c = new Vector3();
  for (const i of idx) c.add(new Vector3(me.positions[i * 3], me.positions[i * 3 + 1], me.positions[i * 3 + 2]));
  return idx.length ? c.multiplyScalar(1 / idx.length) : c;
}

function worldOf(id: string): Matrix4 {
  return app.graph.get(id)?.world.clone() ?? new Matrix4();
}

/** World matrix of a hook target, or of one of its bones when `bone` is set. */
function targetWorld(target: ObjectData, bone?: string): Matrix4 {
  const w = worldOf(target.id);
  if (!bone) return w;
  const b = app.graph.get(target.id)?.pose?.bones.get(bone);
  return b ? w.multiply(b.pose) : w;
}

const hooksOf = (ob: ObjectData | null) => (ob ? ob.modifiers.filter((m) => m.type === 'HOOK') : []);
const hookProp = { id: 'modifier', label: 'Modifier', type: 'string' as const, default: '' };

function hookFor(p: Record<string, unknown>): ModifierBase | undefined {
  const ob = app.activeObject;
  const m = p.modifier ? findModifier(ob, p.modifier) : hooksOf(ob)[0];
  return m?.type === 'HOOK' ? m : undefined;
}

/** Bind (or rebind) the hook so the target's current transform is its rest state. */
function bindHook(ob: ObjectData, m: ModifierBase, target: ObjectData, bone?: string) {
  m.matrix_inverse = targetWorld(target, bone).invert().toArray();
  void ob;
}

registerOperators([
  {
    idname: 'object.hook_add_selob',
    label: 'Hook to Selected Object',
    description: 'Hook the selected vertices to the other selected object',
    props: [{ id: 'use_bone', label: 'Active Bone', type: 'bool', default: false }],
    poll: (ctx) => editMesh(ctx) && app.selectedObjects().some((o) => o !== app.activeObject),
    exec: (_ctx, p) => {
      const { ob, me } = editTarget()!;
      const target = app.selectedObjects().find((o) => o !== ob && (!p.use_bone || o.type === 'ARMATURE'));
      if (!target) {
        app.report('ERROR', p.use_bone ? 'Select an armature to hook to its active bone' : 'Select another object to hook to');
        return 'CANCELLED';
      }
      const idx = selectedIndices(me);
      if (!idx.length) {
        app.report('ERROR', 'Select the vertices to hook first');
        return 'CANCELLED';
      }
      let bone: string | undefined;
      if (p.use_bone) {
        const arm = target.data ? app.doc.armatures[target.data] : undefined;
        bone = arm?.bones.find((b) => b.name === arm.active_bone)?.name ?? arm?.bones[0]?.name;
        if (!bone) {
          app.report('ERROR', 'The armature has no bones');
          return 'CANCELLED';
        }
      }
      const md = newModifier('HOOK', uid('md'), ob.modifiers);
      md.name = newModifier('HOOK', md.id, ob.modifiers).name.replace(/^Hook/, `Hook-${target.name}`);
      md.object = target.id;
      if (bone) md.subtarget = bone;
      md.vertex_indices = idx;
      const c = centroid(me, idx);
      md.center = [c.x, c.y, c.z];
      bindHook(ob, md, target, bone);
      ob.modifiers = [...ob.modifiers, md];
    },
  },
  {
    idname: 'object.hook_assign',
    label: 'Assign to Hook',
    description: 'Make the hook move exactly the selected vertices',
    props: [hookProp],
    poll: (ctx) => editMesh(ctx) && hooksOf(app.activeObject).length > 0,
    exec: (_ctx, p) => {
      const m = hookFor(p);
      const t = editTarget();
      if (!m || !t) return 'CANCELLED';
      const idx = selectedIndices(t.me);
      if (!idx.length) {
        app.report('ERROR', 'Select the vertices to assign first');
        return 'CANCELLED';
      }
      m.vertex_indices = idx;
    },
  },
  {
    idname: 'object.hook_reset',
    label: 'Reset Hook',
    description: 'Treat the hook object’s current transform as its rest position',
    props: [hookProp],
    poll: () => hooksOf(app.activeObject).length > 0,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const m = hookFor(p);
      const target = m && typeof m.object === 'string' ? app.doc.objects[m.object] : undefined;
      if (!m || !target) return 'CANCELLED';
      bindHook(ob, m, target, (m.subtarget as string) || undefined);
    },
  },
  {
    idname: 'object.hook_recenter',
    label: 'Recenter Hook',
    description: 'Move the hook’s falloff center to the 3D cursor',
    props: [hookProp],
    poll: () => hooksOf(app.activeObject).length > 0,
    exec: (ctx, p) => {
      const ob = app.activeObject!;
      const m = hookFor(p);
      if (!m) return 'CANCELLED';
      const c = new Vector3(...ctx.doc.scene.cursor.location).applyMatrix4(worldOf(ob.id).invert());
      m.center = [c.x, c.y, c.z];
    },
  },
  {
    idname: 'object.hook_select',
    label: 'Select Hook',
    description: 'Select the vertices the hook moves',
    props: [hookProp],
    poll: (ctx) => editMesh(ctx) && hooksOf(app.activeObject).length > 0,
    exec: (_ctx, p) => {
      const m = hookFor(p);
      const t = editTarget();
      if (!m || !t) return 'CANCELLED';
      const s = new Uint8Array(t.me.select_vert ?? new Uint8Array(t.me.positions.length / 3));
      for (const i of (m.vertex_indices as number[]) ?? []) if (i < s.length) s[i] = 1;
      t.me.select_vert = s;
      app.changed('select');
    },
  },
  {
    idname: 'object.hook_remove',
    label: 'Remove Hook',
    description: 'Delete the hook modifier',
    props: [hookProp],
    poll: () => hooksOf(app.activeObject).length > 0,
    exec: (_ctx, p) => {
      const ob = app.activeObject!;
      const m = hookFor(p);
      if (!m) return 'CANCELLED';
      ob.modifiers = ob.modifiers.filter((x) => x !== m);
    },
  },
]);

/** Pick one hook of the active object, then run `op` on it. */
function perHook(label: string, op: string): MenuItem {
  return {
    label,
    submenu: () => {
      const hooks = hooksOf(app.activeObject);
      return hooks.length ? hooks.map((m) => ({ label: m.name, icon: 'hook', op, props: { modifier: m.id } })) : [{ label: 'No hooks', disabled: true }];
    },
    disabled: !hooksOf(app.activeObject).length,
  };
}

/** Edit Mode ▸ Ctrl H. */
export function hooksMenu(): MenuItem[] {
  return [
    { label: 'Hook to New Object', op: 'object.hook_add_newob' },
    { label: 'Hook to Selected Object', op: 'object.hook_add_selob' },
    { label: 'Hook to Selected Object Bone', op: 'object.hook_add_selob', props: { use_bone: true } },
    { separator: true },
    perHook('Assign to Hook', 'object.hook_assign'),
    perHook('Reset Hook', 'object.hook_reset'),
    perHook('Recenter Hook', 'object.hook_recenter'),
    perHook('Select Hook', 'object.hook_select'),
    perHook('Remove Hook', 'object.hook_remove'),
  ];
}

/** Edit Mode ▸ Ctrl G. */
export function vertexGroupsMenu(): MenuItem[] {
  const ob = app.activeObject;
  const me = ob?.type === 'MESH' && ob.data ? app.doc.meshes[ob.data] : undefined;
  const groups = me?.vertex_groups ?? [];
  return [
    { label: 'Assign to New Group', op: 'object.vertex_group_assign_new' },
    ...(groups.length
      ? [
          { separator: true },
          { label: 'Assign to Active Group', op: 'object.vertex_group_assign' },
          { label: 'Remove from Active Group', op: 'object.vertex_group_remove_from', props: { use_all_groups: false } },
          { label: 'Remove from All', op: 'object.vertex_group_remove_from', props: { use_all_groups: true } },
          { separator: true },
          {
            label: 'Set Active Group',
            submenu: () => groups.map((g, i) => ({ label: g.name, icon: 'group_vertex', active: i === (ob!.vertex_group_active_index ?? 0), op: 'object.vertex_group_set_active', props: { group: g.name } })),
          },
        ]
      : []),
  ];
}

// Hook modifier panel buttons
modifierExtraUI.HOOK = (ob, m) => {
  const edit = app.doc.mode === 'EDIT' && app.activeObject === ob;
  return h(
    'div',
    { class: 'btn-row' },
    opButton('object.hook_reset', 'Reset', { modifier: m.id }),
    opButton('object.hook_recenter', 'Recenter', { modifier: m.id }),
    edit ? opButton('object.hook_select', 'Select', { modifier: m.id }) : null,
    edit ? opButton('object.hook_assign', 'Assign', { modifier: m.id }) : null,
  );
};
