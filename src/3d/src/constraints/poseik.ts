// Shift I in Pose Mode: add an IK constraint to the active bone, choosing its target from a menu
// (the other selected bone, the other selected object, a new empty, or none).
import { Vector3 } from 'three';
import { app, onAppReady, operators, registerOperators } from '../app/app';
import { newObject, uid } from '../data/defaults';
import { newConstraint } from '../eval/constraints';
import { openMenu, type MenuItem } from '../ui/menu';
import type { ObjectData } from '../data/types';

function poseState() {
  const ob = app.activeObject;
  const arm = ob?.type === 'ARMATURE' && ob.data ? app.doc.armatures[ob.data] : undefined;
  if (!ob || !arm || app.doc.mode !== 'POSE' || !arm.active_bone || !ob.pose?.[arm.active_bone]) return null;
  const otherBone = Object.entries(ob.pose).find(([n, pb]) => pb.select && n !== arm.active_bone)?.[0];
  const otherOb = app.selectedObjects().find((o) => o.id !== ob.id);
  return { ob, arm, bone: arm.active_bone, otherBone, otherOb };
}

/** New empty at the active bone's tail, linked next to the armature (selection stays as it is). */
function newTargetEmpty(ob: ObjectData, bone: string): ObjectData {
  const doc = app.doc;
  const e = newObject('Empty', 'EMPTY', null);
  const names = new Set(Object.values(doc.objects).map((o) => o.name));
  for (let i = 1; names.has(e.name); i++) e.name = `Empty.${String(i).padStart(3, '0')}`;
  const ev = app.graph.get(ob.id);
  const b = ev?.pose?.bones.get(bone);
  const tail = b && ev ? new Vector3(0, b.length, 0).applyMatrix4(b.pose).applyMatrix4(ev.world) : new Vector3();
  e.location = [tail.x, tail.y, tail.z];
  doc.objects[e.id] = e;
  doc.object_order.push(e.id);
  const coll = Object.values(doc.collections).find((c) => c.objects.includes(ob.id)) ?? doc.collections[doc.scene.collection];
  coll.objects.push(e.id);
  return e;
}

onAppReady(() => {
  const prev = operators.get('pose.ik_add');
  registerOperators([
    {
      ...(prev ?? { idname: 'pose.ik_add', label: 'Add IK' }),
      idname: 'pose.ik_add',
      label: 'Add IK to Bone',
      description: 'Add an IK constraint to the active bone, targeting the other selected bone or object, a new empty, or nothing',
      props: [{ id: 'with_targets', label: 'With Targets', type: 'bool', default: true }],
      poll: () => !!poseState(),
      invoke: () => {
        const s = poseState();
        if (!s) return 'CANCELLED';
        const items: MenuItem[] = [];
        const run = (with_targets: boolean) => () => app.run('pose.ik_add', { with_targets }, { invoke: false });
        if (s.otherBone) items.push({ label: 'To Active Bone', action: run(true) });
        else if (s.otherOb) items.push({ label: 'To Active Object', action: run(true) });
        else items.push({ label: 'To New Empty Object', action: run(true) });
        items.push({ label: 'Without Targets', action: run(false) });
        openMenu(items, { x: app.pointer.x, y: app.pointer.y }, { title: 'Add IK' });
        return 'CANCELLED';
      },
      exec: (_ctx, p) => {
        const s = poseState();
        if (!s) return 'CANCELLED';
        const pb = s.ob.pose![s.bone];
        if (pb.constraints.some((c) => c.type === 'IK')) {
          app.report('ERROR', 'Bone already has an IK constraint');
          return 'CANCELLED';
        }
        const c = newConstraint('IK', uid('cn'), pb.constraints);
        if (p.with_targets) {
          if (s.otherBone) {
            c.target = s.ob.id;
            c.subtarget = s.otherBone;
          } else if (s.otherOb) c.target = s.otherOb.id;
          else c.target = newTargetEmpty(s.ob, s.bone).id;
        }
        pb.constraints.push(c);
      },
    },
  ]);
});
