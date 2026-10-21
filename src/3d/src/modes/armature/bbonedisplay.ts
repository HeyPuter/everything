// B-Bone display: with the armature drawn as B-Bones, bones whose segments bend are drawn as a
// chain of boxes through their segment joints (instead of the straight segmented box).
import { BufferGeometry, Float32BufferAttribute, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Vector3, type Group, type Matrix4 } from 'three';
import type { DocumentData } from '../../data/types';
import { sceneSyncHooks, type SyncedObject } from '../../render/scene';
import type { EvalObject } from '../../eval/depsgraph';
import { customShapeOf } from './customshape';

const done = new WeakMap<Group, string>();

/** Box chain through joint frames (armature space): rectangle cross-sections of half-size hx × hz. */
export function bboneChainGeometry(joints: Matrix4[], hx: number, hz: number): { lines: number[]; tris: number[] } {
  const corners = joints.map((m) => [new Vector3(-hx, 0, -hz), new Vector3(hx, 0, -hz), new Vector3(hx, 0, hz), new Vector3(-hx, 0, hz)].map((c) => c.applyMatrix4(m)));
  const lines: number[] = [],
    tris: number[] = [];
  const P = (v: Vector3) => [v.x, v.y, v.z];
  for (let k = 0; k < corners.length; k++) {
    const c = corners[k];
    for (let i = 0; i < 4; i++) lines.push(...P(c[i]), ...P(c[(i + 1) % 4]));
    if (k + 1 < corners.length) {
      const d = corners[k + 1];
      for (let i = 0; i < 4; i++) {
        lines.push(...P(c[i]), ...P(d[i]));
        const j = (i + 1) % 4;
        tris.push(...P(c[i]), ...P(d[i]), ...P(d[j]), ...P(c[i]), ...P(d[j]), ...P(c[j]));
      }
    }
  }
  // end caps
  for (const c of [corners[0], corners[corners.length - 1]]) tris.push(...P(c[0]), ...P(c[1]), ...P(c[2]), ...P(c[0]), ...P(c[2]), ...P(c[3]));
  return { lines, tris };
}

function syncBBones(doc: DocumentData, ev: EvalObject, so: SyncedObject) {
  const ob = ev.ob;
  if (ob.type !== 'ARMATURE' || !so.bones || !ev.pose || !ob.data) return;
  const arm = doc.armatures[ob.data];
  if (!arm || arm.display_type !== 'BBONE') return;
  const g = so.bones;
  const sig = ev.pose.signature;
  if (done.get(g) === sig) return;
  done.set(g, sig);
  for (const c of [...g.children]) if (c.userData.bboneChain) g.remove(c);
  for (const name of ev.pose.order) {
    const be = ev.pose.bones.get(name)!;
    if (!be.bbone || customShapeOf(doc, ob, name)) continue;
    const bone = arm.bones.find((b) => b.name === name);
    if (!bone) continue;
    for (const c of g.children) if (c.userData.bone === name && !c.userData.customShape) c.visible = false;
    if (bone.hide) continue;
    const geo = bboneChainGeometry(be.bbone.pose, bone.bbone_x ?? 0.1 * be.length, bone.bbone_z ?? 0.1 * be.length);
    const lg = new BufferGeometry();
    lg.setAttribute('position', new Float32BufferAttribute(geo.lines, 3));
    const tg = new BufferGeometry();
    tg.setAttribute('position', new Float32BufferAttribute(geo.tris, 3));
    const l = new LineSegments(lg, new LineBasicMaterial({ color: 0x000000 }));
    const f = new Mesh(tg, new MeshBasicMaterial({ color: 0x8b8c8e, transparent: true, opacity: 0.85 }));
    for (const o of [l, f]) {
      o.matrixAutoUpdate = false;
      o.userData.bone = name;
      o.userData.id = ev.id;
      o.userData.bboneChain = true;
    }
    f.userData.boneFill = true;
    if (bone.show_wire) f.visible = false;
    g.add(f, l);
  }
}

sceneSyncHooks.push(syncBBones);
