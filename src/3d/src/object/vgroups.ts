// Vertex group management operators (Object Data ▸ Vertex Groups list and its specials menu).
import { app, registerOperators, type OpContext, type PropDef } from '../app/app';
import type { MeshData, ObjectData } from '../data/types';
import { invalidatePaintAttributes } from '../paint/display';
import { deformGroups } from '../paint/wpaint';
import { levelWeights, mirrorVertexGroups, mirrorVertexMap, quantizeWeights, reorderGroups, sortedGroupOrder, uniqueIn } from './core';

export function activeMesh(): { ob: ObjectData; me: MeshData } | null {
  const ob = app.activeObject;
  if (!ob || ob.type !== 'MESH' || !ob.data) return null;
  const me = app.doc.meshes[ob.data];
  return me ? { ob, me } : null;
}

const hasGroups = () => (activeMesh()?.me.vertex_groups.length ?? 0) > 0;
const objectOrEdit = (ctx: OpContext) => ctx.doc.mode === 'OBJECT' || ctx.doc.mode === 'EDIT' || ctx.doc.mode === 'WEIGHT_PAINT';

function activeIndex(ob: ObjectData, me: MeshData) {
  const i = ob.vertex_group_active_index ?? 0;
  return Math.max(0, Math.min(me.vertex_groups.length - 1, i));
}

/** In Edit Mode weight tools only touch selected vertices. */
function vertexMask(me: MeshData): ((v: number) => boolean) | undefined {
  if (app.doc.mode !== 'EDIT' || !me.select_vert) return undefined;
  const s = me.select_vert;
  return (v) => !!s[v];
}

export const groupSubsetProp: PropDef = {
  id: 'group_select_mode',
  label: 'Subset',
  type: 'enum',
  default: 'ACTIVE',
  items: [
    ['ACTIVE', 'Active Group'],
    ['BONE_DEFORM', 'Deform Pose Bones'],
    ['BONE_NOT_DEFORM', 'Other'],
    ['ALL', 'All Groups'],
  ],
};

function subset(ob: ObjectData, me: MeshData, mode: unknown): number[] {
  const all = me.vertex_groups.map((_, i) => i);
  if (mode === 'ALL') return all;
  if (mode === 'BONE_DEFORM' || mode === 'BONE_NOT_DEFORM') {
    const hasArm = ob.modifiers.some((m) => m.type === 'ARMATURE' && m.object);
    if (!hasArm) return mode === 'BONE_DEFORM' ? [] : all;
    const deform = new Set(deformGroups(ob, me));
    return all.filter((g) => deform.has(g) === (mode === 'BONE_DEFORM'));
  }
  return [activeIndex(ob, me)];
}

function finish() {
  invalidatePaintAttributes();
}

/** Bone names of the deforming armature in hierarchy (depth-first) order. */
function boneHierarchyOrder(ob: ObjectData): string[] {
  const doc = app.doc;
  const armOb = ob.modifiers.map((m) => (m.type === 'ARMATURE' && m.object ? doc.objects[m.object as string] : undefined)).find((o) => o?.type === 'ARMATURE') ?? (ob.parent && doc.objects[ob.parent]?.type === 'ARMATURE' ? doc.objects[ob.parent] : undefined);
  const arm = armOb?.data ? doc.armatures[armOb.data] : undefined;
  if (!arm) return [];
  const out: string[] = [];
  const visit = (parent: string | null) => {
    for (const b of arm.bones) {
      if ((b.parent ?? null) !== parent) continue;
      out.push(b.name);
      visit(b.name);
    }
  };
  visit(null);
  return out;
}

registerOperators([
  {
    idname: 'object.vertex_group_set_active',
    label: 'Set Active Vertex Group',
    description: 'Make the named vertex group the active one',
    props: [{ id: 'group', label: 'Group', type: 'string', default: '' }],
    poll: () => hasGroups(),
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      const i = me.vertex_groups.findIndex((g) => g.name === p.group);
      if (i < 0) return 'CANCELLED';
      ob.vertex_group_active_index = i;
    },
    internal: true,
  },
  {
    idname: 'object.vertex_group_move',
    label: 'Move Vertex Group',
    description: 'Move the active vertex group up or down the list',
    props: [{ id: 'direction', label: 'Direction', type: 'enum', default: 'UP', items: [['UP', 'Up'], ['DOWN', 'Down']] }],
    poll: () => (activeMesh()?.me.vertex_groups.length ?? 0) > 1,
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      const i = activeIndex(ob, me);
      const j = p.direction === 'UP' ? i - 1 : i + 1;
      if (j < 0 || j >= me.vertex_groups.length) return 'CANCELLED';
      const order = me.vertex_groups.map((_, k) => k);
      [order[i], order[j]] = [order[j], order[i]];
      ob.vertex_group_active_index = reorderGroups(me, order, i);
    },
  },
  {
    idname: 'object.vertex_group_sort',
    label: 'Sort Vertex Groups',
    description: 'Reorder the vertex groups alphabetically or by the deforming armature’s bone hierarchy',
    props: [{ id: 'sort_type', label: 'Sort Type', type: 'enum', default: 'NAME', items: [['NAME', 'Name'], ['BONE_HIERARCHY', 'Bone Hierarchy']] }],
    poll: () => (activeMesh()?.me.vertex_groups.length ?? 0) > 1,
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      const order = sortedGroupOrder(
        me.vertex_groups.map((g) => g.name),
        p.sort_type as 'NAME' | 'BONE_HIERARCHY',
        p.sort_type === 'BONE_HIERARCHY' ? boneHierarchyOrder(ob) : [],
      );
      ob.vertex_group_active_index = reorderGroups(me, order, activeIndex(ob, me));
    },
  },
  {
    idname: 'object.vertex_group_copy',
    label: 'Copy Vertex Group',
    description: 'Duplicate the active vertex group with its weights',
    poll: (ctx) => objectOrEdit(ctx) && hasGroups(),
    exec: () => {
      const { ob, me } = activeMesh()!;
      const i = activeIndex(ob, me);
      const name = uniqueIn(
        me.vertex_groups.map((g) => g.name),
        `${me.vertex_groups[i].name}_copy`,
      );
      me.vertex_groups = [...me.vertex_groups, { name }];
      me.weights = [...me.weights, new Float32Array(me.weights[i])];
      ob.vertex_group_active_index = me.vertex_groups.length - 1;
      finish();
    },
  },
  {
    idname: 'object.vertex_group_copy_to_selected',
    label: 'Copy Vertex Group to Selected',
    description: 'Replace the vertex groups of the other selected meshes with copies of the active object’s groups (meshes need matching vertex counts)',
    poll: (ctx) => ctx.doc.mode === 'OBJECT' && hasGroups() && app.selectedObjects().some((o) => o.type === 'MESH' && o !== app.activeObject),
    exec: () => {
      const { ob, me } = activeMesh()!;
      let ok = 0,
        skipped = 0;
      for (const o of app.selectedObjects()) {
        if (o === ob || o.type !== 'MESH' || !o.data || o.data === me.id) continue;
        const other = app.doc.meshes[o.data];
        if (!other || other.positions.length !== me.positions.length) {
          skipped++;
          continue;
        }
        other.vertex_groups = me.vertex_groups.map((g) => ({ ...g }));
        other.weights = me.weights.map((w) => new Float32Array(w));
        o.vertex_group_active_index = ob.vertex_group_active_index;
        ok++;
      }
      if (skipped) app.report('WARNING', `Skipped ${skipped} object(s) with a different vertex count`);
      if (!ok) return 'CANCELLED';
      finish();
    },
  },
  {
    idname: 'object.vertex_group_mirror',
    label: 'Mirror Vertex Group',
    description: 'Mirror weights across the local X axis, swapping left/right named groups',
    props: [
      { id: 'mirror_weights', label: 'Mirror Weights', type: 'bool', default: true },
      { id: 'flip_group_names', label: 'Flip Group Names', type: 'bool', default: true },
      { id: 'all_groups', label: 'All Groups', type: 'bool', default: false },
      { id: 'use_topology', label: 'Topology Mirror', type: 'bool', default: false },
    ],
    poll: (ctx) => objectOrEdit(ctx) && hasGroups(),
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      mirrorVertexGroups(me, activeIndex(ob, me), { mirror_weights: !!p.mirror_weights, flip_group_names: !!p.flip_group_names, all_groups: !!p.all_groups }, mirrorVertexMap(me.positions, p.use_topology ? 1e-3 : 1e-4));
      finish();
    },
  },
  {
    idname: 'object.vertex_group_lock',
    label: 'Change the Lock On Vertex Groups',
    description: 'Lock or unlock vertex groups against weight changes',
    props: [
      { id: 'action', label: 'Action', type: 'enum', default: 'TOGGLE', items: [['TOGGLE', 'Toggle'], ['LOCK', 'Lock'], ['UNLOCK', 'Unlock'], ['INVERT', 'Invert']] },
      { id: 'mask', label: 'Mask', type: 'enum', default: 'ALL', items: [['ALL', 'All'], ['SELECTED', 'Active'], ['UNSELECTED', 'Others'], ['INVERT_UNSELECTED', 'Invert Others']] },
    ],
    poll: () => hasGroups(),
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      const act = activeIndex(ob, me);
      const inMask = (i: number) => p.mask === 'ALL' || (p.mask === 'SELECTED' ? i === act : i !== act);
      let action = p.action as string;
      if (p.mask === 'INVERT_UNSELECTED') {
        // lock the active group's opposite: active unlocked, the others inverted
        me.vertex_groups = me.vertex_groups.map((g, i) => (i === act ? { ...g, lock_weight: false } : { ...g, lock_weight: !g.lock_weight }));
        return;
      }
      if (action === 'TOGGLE') action = me.vertex_groups.some((g, i) => inMask(i) && g.lock_weight) ? 'UNLOCK' : 'LOCK';
      me.vertex_groups = me.vertex_groups.map((g, i) => {
        if (!inMask(i)) return g;
        const lock = action === 'LOCK' ? true : action === 'UNLOCK' ? false : !g.lock_weight;
        return { ...g, lock_weight: lock };
      });
    },
  },
  {
    idname: 'object.vertex_group_levels',
    label: 'Vertex Group Levels',
    description: 'Offset and scale the weights of the chosen vertex groups',
    props: [groupSubsetProp, { id: 'offset', label: 'Offset', type: 'float', default: 0, min: -1, max: 1 }, { id: 'gain', label: 'Gain', type: 'float', default: 1, min: 0, max: 1e10, softMax: 10 }],
    poll: (ctx) => objectOrEdit(ctx) && hasGroups(),
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      const mask = vertexMask(me);
      const ws = me.weights.slice();
      for (const g of subset(ob, me, p.group_select_mode)) if (!me.vertex_groups[g].lock_weight) ws[g] = levelWeights(me.weights[g], p.offset as number, p.gain as number, mask);
      me.weights = ws;
      finish();
    },
  },
  {
    idname: 'object.vertex_group_quantize',
    label: 'Quantize Vertex Weights',
    description: 'Round weights to a fixed number of steps',
    props: [groupSubsetProp, { id: 'steps', label: 'Steps', type: 'int', default: 4, min: 1, max: 1000 }],
    poll: (ctx) => objectOrEdit(ctx) && hasGroups(),
    exec: (_ctx, p) => {
      const { ob, me } = activeMesh()!;
      const mask = vertexMask(me);
      const ws = me.weights.slice();
      for (const g of subset(ob, me, p.group_select_mode)) if (!me.vertex_groups[g].lock_weight) ws[g] = quantizeWeights(me.weights[g], p.steps as number, mask);
      me.weights = ws;
      finish();
    },
  },
  {
    idname: 'object.vertex_group_assign_new',
    label: 'Assign to New Group',
    description: 'Create a vertex group holding the selected vertices',
    poll: (ctx) => ctx.doc.mode === 'EDIT' && !!activeMesh(),
    exec: (ctx) => {
      const { ob, me } = activeMesh()!;
      const nv = me.positions.length / 3;
      const w = new Float32Array(nv);
      const wt = ctx.doc.scene.tool_settings.vertex_group_weight ?? 1;
      const s = me.select_vert;
      if (s) for (let v = 0; v < nv; v++) if (s[v]) w[v] = wt;
      me.vertex_groups = [...me.vertex_groups, { name: uniqueIn(me.vertex_groups.map((g) => g.name), 'Group') }];
      me.weights = [...me.weights, w];
      ob.vertex_group_active_index = me.vertex_groups.length - 1;
    },
  },
]);
