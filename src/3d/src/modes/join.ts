// Object ▸ Join (Ctrl J) for curves and armatures: splines / bones of the selected objects move
// into the active one (kept in place in world space). Mesh joining stays with the original
// operator, which is wrapped once the app is ready.
import { Matrix3, Matrix4, Vector3 } from 'three';
import { app, onAppReady, operators, registerOperator, type OpContext } from '../app/app';
import type { ArmatureData, Bone, CurveData, DocumentData, ObjectData, Vec3 } from '../data/types';
import { deleteObjects } from '../ops/object';
import { boneRestMatrix, boneRotation, defaultPoseBone } from '../eval/armature';

const worldOf = (ob: ObjectData) => app.graph.get(ob.id)?.world ?? new Matrix4();

function joinables(type: 'CURVE' | 'ARMATURE') {
  const act = app.activeObject;
  if (!act || act.type !== type) return [];
  return app.selectedObjects().filter((o) => o.id !== act.id && o.type === type && o.data && o.data !== act.data);
}

/** Splines of other curve objects, transformed into the active object's space. */
export function joinCurves(doc: DocumentData, target: ObjectData, others: ObjectData[]) {
  const cu = doc.curves[target.data!] as CurveData;
  const inv = worldOf(target).clone().invert();
  for (const ob of others) {
    const src = doc.curves[ob.data!];
    const m = inv.clone().multiply(worldOf(ob));
    const tr = (c: ArrayLike<number>) => new Vector3(c[0], c[1], c[2]).applyMatrix4(m).toArray() as Vec3;
    // materials: append missing slots and remap indices
    const remap = src.materials.map((mat) => {
      let i = cu.materials.indexOf(mat);
      if (i < 0) {
        cu.materials.push(mat);
        i = cu.materials.length - 1;
      }
      return i;
    });
    for (const sp0 of src.splines) {
      const sp = structuredClone(sp0);
      for (const b of sp.bezier_points) {
        b.co = tr(b.co);
        b.handle_left = tr(b.handle_left);
        b.handle_right = tr(b.handle_right);
      }
      for (const p of sp.points) {
        const q = tr(p.co);
        p.co = [q[0], q[1], q[2], p.co[3]];
      }
      sp.material_index = remap[sp.material_index] ?? 0;
      cu.splines.push(sp);
    }
    if (src.dimensions === '3D') cu.dimensions = '3D';
  }
}

/** Roll that gives a bone pointing head → tail the Z axis `z` (projected). */
function rollFor(head: Vector3, tail: Vector3, z: Vector3) {
  const y = tail.clone().sub(head);
  if (y.lengthSq() < 1e-12) return 0;
  y.normalize();
  const m0 = boneRotation(y, 0);
  const z0 = new Vector3().setFromMatrixColumn(m0, 2);
  const t = z.clone().sub(y.clone().multiplyScalar(z.dot(y)));
  if (t.lengthSq() < 1e-12) return 0;
  t.normalize();
  let ang = Math.acos(Math.max(-1, Math.min(1, z0.dot(t))));
  if (z0.clone().cross(t).dot(y) < 0) ang = -ang;
  return ang;
}

/** Bones of other armatures (with pose channels and collections) merged into the active armature. */
export function joinArmatures(doc: DocumentData, target: ObjectData, others: ObjectData[]) {
  const arm = doc.armatures[target.data!] as ArmatureData;
  const inv = worldOf(target).clone().invert();
  target.pose ??= {};
  for (const ob of others) {
    const src = doc.armatures[ob.data!];
    const m = inv.clone().multiply(worldOf(ob));
    const rot = new Matrix3().setFromMatrix4(m);
    // collections: same-named collections merge
    const colNames = new Map<string, string>();
    for (const c of src.collections ?? []) {
      colNames.set(c.name, c.name);
      if (!arm.collections?.some((x) => x.name === c.name)) (arm.collections ??= []).push({ ...c });
    }
    // bone names (renamed on clashes)
    const taken = new Set(arm.bones.map((b) => b.name));
    const names = new Map<string, string>();
    for (const b of src.bones) {
      let name = b.name;
      if (taken.has(name)) {
        const stem = name.replace(/\.\d{3}$/, '');
        for (let i = 1; taken.has(name); i++) name = `${stem}.${String(i).padStart(3, '0')}`;
      }
      taken.add(name);
      names.set(b.name, name);
    }
    for (const b0 of src.bones) {
      const b: Bone = structuredClone(b0);
      const head = new Vector3(...b0.head).applyMatrix4(m),
        tail = new Vector3(...b0.tail).applyMatrix4(m);
      const z = new Vector3().setFromMatrixColumn(boneRestMatrix(b0), 2).applyMatrix3(rot).normalize();
      b.name = names.get(b0.name)!;
      b.parent = b0.parent ? names.get(b0.parent) ?? null : null;
      b.head = head.toArray() as Vec3;
      b.tail = tail.toArray() as Vec3;
      b.roll = rollFor(head, tail, z);
      if (b.collections) b.collections = b.collections.map((n) => colNames.get(n) ?? n);
      arm.bones.push(b);
      target.pose[b.name] = structuredClone(ob.pose?.[b0.name] ?? defaultPoseBone());
    }
    // things that pointed at the joined armature now use the active one
    const renamed = new Map([...names].filter(([a, b]) => a !== b));
    for (const o of Object.values(doc.objects)) {
      for (const md of o.modifiers)
        if (md.type === 'ARMATURE' && md.object === ob.id) {
          md.object = target.id;
          if (o.type === 'MESH' && o.data && renamed.size) {
            const me = doc.meshes[o.data];
            me.vertex_groups.forEach((g) => (g.name = renamed.get(g.name) ?? g.name));
          }
        }
      if (o.parent === ob.id) {
        o.parent = target.id;
        if (o.parent_bone) o.parent_bone = names.get(o.parent_bone) ?? o.parent_bone;
        // keep the child where it is: new parent inverse from the old parent's world
        const pmi = new Matrix4().fromArray(o.matrix_parent_inverse);
        o.matrix_parent_inverse = inv.clone().multiply(worldOf(ob)).multiply(pmi).toArray();
      }
    }
  }
}

function joinExec(ctx: OpContext): 'FINISHED' | 'CANCELLED' {
  const act = app.activeObject!;
  const type = act.type as 'CURVE' | 'ARMATURE';
  const others = joinables(type);
  if (!others.length) return 'CANCELLED';
  if (type === 'CURVE') joinCurves(ctx.doc, act, others);
  else joinArmatures(ctx.doc, act, others);
  deleteObjects(ctx.doc, new Set(others.map((o) => o.id)));
  ctx.doc.scene.active_object = act.id;
  act.select = true;
  return 'FINISHED';
}

onAppReady(() => {
  const prev = operators.get('object.join');
  if (!prev) return;
  const ours = (ctx: OpContext) => ctx.doc.mode === 'OBJECT' && (app.activeObject?.type === 'CURVE' || app.activeObject?.type === 'ARMATURE') && joinables(app.activeObject.type).length > 0;
  registerOperator({
    ...prev,
    description: 'Join selected objects into the active object (meshes, curves, armatures)',
    poll: (ctx) => ours(ctx) || (!!prev.poll && prev.poll(ctx)),
    exec: (ctx, p) => (ours(ctx) ? joinExec(ctx) : prev.exec ? prev.exec(ctx, p) : 'CANCELLED'),
  });
});
