// More armature operators: Extrude (without moving), Duplicate and Rename, Pick Shortest Path
// and removing one named bone from a bone collection.
import { app, registerOperators, type OpContext } from '../../app/app';
import type { Bone } from '../../data/types';
import type { View3D } from '../../editors/view3d/view3d';
import { activeView3D } from '../../editors/view3d/view3d';
import { activeArmature, ensurePose, newBone, pickBone } from './armature';
import * as A from './armkernels';

const editPoll = () => app.doc.mode === 'EDIT' && !!activeArmature();

function viewMouse(ctx: OpContext): { v: View3D; x: number; y: number } | null {
  const v = (ctx.area?.editor as View3D | undefined) ?? activeView3D();
  if (!v || !(v as unknown as { project?: unknown }).project) return null;
  const r = v.el.getBoundingClientRect();
  const e = ctx.event ?? app.pointer;
  return { v, x: e.x - r.left, y: e.y - r.top };
}

/**
 * Extrude new bones from the selected joints: from each selected tail a connected child (two
 * mirrored .L/.R children when forked), from a selected head of a root bone an unparented bone.
 * The new bones start with zero length and their tails selected.
 */
export function extrudeBones(forked: boolean): Bone[] {
  const { ob, arm } = activeArmature()!;
  const vis = (b: Bone) => A.boneVisible(arm, b);
  const tails = arm.bones.filter((b) => vis(b) && b.select_tail);
  const heads = arm.bones.filter((b) => vis(b) && b.select_head && !b.select_tail && !b.parent);
  const created: Bone[] = [];
  for (const t of tails) {
    if (forked) {
      const base = A.stripSide(t.name);
      created.push(newBone(arm, `${base}.L`, t.tail, t.tail, t.name, true), newBone(arm, `${base}.R`, t.tail, t.tail, t.name, true));
    } else created.push(newBone(arm, t.name, t.tail, t.tail, t.name, true));
  }
  if (!forked) for (const t of heads) created.push(newBone(arm, t.name, t.head, t.head, null, false));
  if (!created.length) return created;
  for (const b of arm.bones) A.setBoneSelected(b, false);
  for (const c of created) c.select_tail = true;
  arm.active_bone = created[created.length - 1].name;
  ensurePose(ob, arm);
  return created;
}

registerOperators([
  {
    idname: 'armature.extrude',
    label: 'Extrude',
    description: 'Create new bones from the selected joints (move them afterwards with G)',
    props: [{ id: 'forked', label: 'Forked', type: 'bool', default: false }],
    poll: editPoll,
    exec: (_ctx, p) => {
      if (!extrudeBones(!!p.forked).length) return 'CANCELLED';
    },
  },
  {
    idname: 'armature.duplicate_rename',
    label: 'Duplicate and Rename',
    description: 'Duplicate the selected bones, naming the copies by replacing text in the names (or by flipping their sides)',
    props: [
      { id: 'do_flip_names', label: 'Flip Names', type: 'bool', default: false },
      { id: 'search', label: 'Search', type: 'string', default: '' },
      { id: 'replace', label: 'Replace', type: 'string', default: '' },
    ],
    poll: editPoll,
    exec: (_ctx, p) => {
      const { ob, arm } = activeArmature()!;
      const sel = arm.bones.filter((b) => b.select && A.boneVisible(arm, b));
      if (!sel.length) return 'CANCELLED';
      const rename = (name: string) => {
        let n = name;
        const s = String(p.search ?? '');
        if (s) n = n.split(s).join(String(p.replace ?? ''));
        if (p.do_flip_names) n = A.flipSideName(n);
        return n;
      };
      const map = new Map<string, string>();
      const copies = sel.map((b) => {
        const c = newBone(arm, rename(b.name), b.head, b.tail, b.parent, b.use_connect, b);
        c.roll = b.roll;
        map.set(b.name, c.name);
        return c;
      });
      // copies keep their hierarchy among themselves
      for (const c of copies) if (c.parent && map.has(c.parent)) c.parent = map.get(c.parent)!;
      for (const b of arm.bones) A.setBoneSelected(b, false);
      for (const c of copies) A.setBoneSelected(c, true);
      arm.active_bone = copies[copies.length - 1].name;
      ensurePose(ob, arm);
    },
  },
  {
    idname: 'armature.shortest_path_pick',
    label: 'Pick Shortest Path',
    description: 'Select the bones on the hierarchy path between the active bone and the bone under the mouse',
    poll: () => editPoll() && !!activeArmature()!.arm.active_bone,
    invoke: (ctx) => {
      const m = viewMouse(ctx);
      const { arm } = activeArmature()!;
      const hit = m ? pickBone(m.v, m.x, m.y, false) : null;
      const act = arm.bones.find((b) => b.name === arm.active_bone);
      if (!hit || !act || act === hit.bone) return 'CANCELLED';
      const path = A.bonePath(arm, act, hit.bone);
      if (!path.length) {
        app.report('WARNING', 'The bones are not in the same hierarchy');
        return 'CANCELLED';
      }
      for (const b of path) A.setBoneSelected(b, true);
      arm.active_bone = hit.bone.name;
      return 'FINISHED';
    },
  },
  {
    idname: 'armature.collection_unassign_named',
    label: 'Remove Bone from Bone Collection',
    description: 'Remove one bone (by name, or the active bone) from a bone collection (by name)',
    props: [
      { id: 'name', label: 'Bone Collection', type: 'string', default: '' },
      { id: 'bone_name', label: 'Bone Name', type: 'string', default: '' },
    ],
    poll: () => (app.doc.mode === 'EDIT' || app.doc.mode === 'POSE' || app.activeObject?.type === 'ARMATURE') && !!activeArmature(),
    exec: (_ctx, p) => {
      const { arm } = activeArmature()!;
      const bone = arm.bones.find((b) => b.name === (p.bone_name || arm.active_bone));
      const coll = String(p.name || arm.collections?.[arm.active_collection_index ?? 0]?.name || '');
      if (!bone || !coll || !bone.collections?.includes(coll)) return 'CANCELLED';
      A.unassignBone(bone, coll);
    },
  },
]);
