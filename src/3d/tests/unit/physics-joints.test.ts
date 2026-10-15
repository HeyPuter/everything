import { describe, it, expect, beforeAll } from 'vitest';
import { Euler, Matrix4, Quaternion, Vector3 } from 'three';
import { emptyDocument, newObject, newMeshData } from '../../src/data/defaults';
import { cube } from '../../src/mesh/primitives';
import { Depsgraph } from '../../src/eval/depsgraph';
import type { DocumentData, ObjectData } from '../../src/data/types';
import { loadRapier } from '../../src/physics/engine';
import { caches, startBudget } from '../../src/physics/common';
import { defaultRigidBody, defaultRigidBodyWorld, type ObjectPhysics, type RigidBodyConstraintData } from '../../src/physics/types';
import { rbcDefaults } from '../../src/physics/rbjoints';

function link(doc: DocumentData, ob: ObjectData) {
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}
function box(doc: DocumentData, name: string, size: number, loc: [number, number, number], type: 'ACTIVE' | 'PASSIVE') {
  const me = newMeshData(name, cube(size));
  doc.meshes[me.id] = me;
  const ob = link(doc, newObject(name, 'MESH', me.id));
  ob.location = loc;
  ob.rigid_body = { ...defaultRigidBody(type), collision_shape: 'BOX' };
  return ob;
}
function joint(doc: DocumentData, a: ObjectData, b: ObjectData, loc: [number, number, number], rot: [number, number, number], settings: Partial<RigidBodyConstraintData>) {
  const e = link(doc, newObject('Constraint', 'EMPTY', null)) as ObjectPhysics;
  e.location = loc;
  e.rotation_euler = rot;
  e.rigid_body_constraint = { ...rbcDefaults(), enabled: true, disable_collisions: true, object1: a.id, object2: b.id, type: 'FIXED', ...settings } as RigidBodyConstraintData;
  return e;
}
function scene() {
  caches.clear();
  const doc = emptyDocument();
  doc.scene.rigidbody_world = defaultRigidBodyWorld(1, 250);
  return doc;
}
const at = (g: Depsgraph, doc: DocumentData, ob: ObjectData, f: number) => {
  doc.scene.frame_current = f;
  g.evaluate(doc);
  return g.get(ob.id)!.world.clone();
};
const pos = (m: Matrix4) => new Vector3().setFromMatrixPosition(m);

beforeAll(async () => {
  await loadRapier();
  startBudget(Infinity);
});

describe('rigid body constraint types', () => {
  it('a slider moves only along its X axis and stops at its limit', () => {
    const doc = scene();
    const anchor = box(doc, 'Anchor', 0.2, [0, 0, 5], 'PASSIVE');
    const body = box(doc, 'Body', 0.4, [0, 0, 4], 'ACTIVE');
    // X axis pointing up: the body may slide vertically only, at most 1 m down
    joint(doc, anchor, body, [0, 0, 4], [0, -Math.PI / 2, 0], { type: 'SLIDER', use_limit_lin_x: true, limit_lin_x_lower: -1, limit_lin_x_upper: 0 });
    const g = new Depsgraph(doc);
    const p = pos(at(g, doc, body, 60));
    expect(Math.hypot(p.x, p.y)).toBeLessThan(0.02);
    expect(p.z).toBeGreaterThan(2.9);
    expect(p.z).toBeLessThan(3.1);
  });

  it('a hinge with limits stops swinging at its angle', () => {
    const doc = scene();
    const anchor = box(doc, 'Anchor', 0.2, [0, 0, 3], 'PASSIVE');
    const bob = box(doc, 'Bob', 0.3, [1, 0, 3], 'ACTIVE');
    // hinge around -Y (Z axis turned), limited to ±0.3 rad
    joint(doc, anchor, bob, [0, 0, 3], [Math.PI / 2, 0, 0], { type: 'HINGE', use_limit_ang_z: true, limit_ang_z_lower: -0.3, limit_ang_z_upper: 0.3 });
    const g = new Depsgraph(doc);
    for (const f of [20, 40, 80]) {
      const p = pos(at(g, doc, bob, f));
      const ang = Math.atan2(3 - p.z, p.x);
      expect(Math.abs(ang)).toBeLessThan(0.36);
      expect(Math.hypot(p.x, p.z - 3)).toBeCloseTo(1, 1);
    }
  });

  it('a motor turns the second body around the X axis', () => {
    const doc = scene();
    doc.scene.use_gravity = false;
    const anchor = box(doc, 'Anchor', 0.2, [0, 0, 0], 'PASSIVE');
    const wheel = box(doc, 'Wheel', 1, [3, 0, 0], 'ACTIVE');
    // hold the wheel on an axle (hinge around X) and drive it
    joint(doc, anchor, wheel, [3, 0, 0], [0, Math.PI / 2, 0], { type: 'HINGE' });
    joint(doc, anchor, wheel, [3, 0, 0], [0, 0, 0], { type: 'MOTOR', use_motor_ang: true, motor_ang_target_velocity: 2, motor_ang_max_impulse: 100 });
    const g = new Depsgraph(doc);
    const m = at(g, doc, wheel, 1 + 12);
    const e = new Euler().setFromQuaternion(new Quaternion().setFromRotationMatrix(m), 'XYZ');
    // 12 frames at 24 fps = 0.5 s at 2 rad/s
    expect(Math.abs(e.x)).toBeGreaterThan(0.6);
    expect(Math.abs(e.x)).toBeLessThan(1.2);
    expect(pos(m).distanceTo(new Vector3(3, 0, 0))).toBeLessThan(0.05);
  });

  it('a generic constraint with locked translation behaves like a ball joint', () => {
    const doc = scene();
    const anchor = box(doc, 'Anchor', 0.2, [0, 0, 3], 'PASSIVE');
    const bob = box(doc, 'Bob', 0.3, [1, 0.5, 3], 'ACTIVE');
    const lock = Object.fromEntries(['x', 'y', 'z'].flatMap((a) => [[`use_limit_lin_${a}`, true], [`limit_lin_${a}_lower`, 0], [`limit_lin_${a}_upper`, 0]]));
    joint(doc, anchor, bob, [0, 0, 3], [0, 0, 0], { type: 'GENERIC', ...lock });
    const g = new Depsgraph(doc);
    for (const f of [15, 30, 45]) {
      const p = pos(at(g, doc, bob, f));
      // the attachment point keeps its distance from the anchor while the body swings
      expect(p.distanceTo(new Vector3(0, 0, 3))).toBeCloseTo(Math.hypot(1, 0.5), 1);
    }
    expect(pos(at(g, doc, bob, 15)).z).toBeLessThan(2.8);
  });

  it('a generic spring pulls the body back towards its rest position', () => {
    const doc = scene();
    const anchor = box(doc, 'Anchor', 0.2, [0, 0, 3], 'PASSIVE');
    const bob = box(doc, 'Bob', 0.3, [0, 0, 2], 'ACTIVE');
    const lockXY = { use_limit_lin_x: true, limit_lin_x_lower: 0, limit_lin_x_upper: 0, use_limit_lin_y: true, limit_lin_y_lower: 0, limit_lin_y_upper: 0 };
    const lockAng = Object.fromEntries(['x', 'y', 'z'].flatMap((a) => [[`use_limit_ang_${a}`, true], [`limit_ang_${a}_lower`, 0], [`limit_ang_${a}_upper`, 0]]));
    joint(doc, anchor, bob, [0, 0, 2], [0, 0, 0], { type: 'GENERIC_SPRING', ...lockXY, ...lockAng, use_spring_z: true, spring_stiffness_z: 200, spring_damping_z: 5 });
    const g = new Depsgraph(doc);
    const zs = [10, 30, 60, 120].map((f) => pos(at(g, doc, bob, f)).z);
    // it sags a little under gravity but does not fall away
    for (const z of zs) expect(z).toBeGreaterThan(1.5);
    expect(zs[3]).toBeLessThan(2);
    // determinism: evaluating again gives the cached result
    expect(pos(at(g, doc, bob, 60)).z).toBe(zs[2]);
  });
});

describe('rigid body world collections', () => {
  it('only rigid bodies in the world collection are simulated', () => {
    const doc = scene();
    const a = box(doc, 'In', 0.5, [0, 0, 5], 'ACTIVE');
    const b = box(doc, 'Out', 0.5, [3, 0, 5], 'ACTIVE');
    const coll = { id: 'rbw', name: 'RigidBodyWorld', objects: [a.id], children: [], hide_viewport: false, hide_render: false, hide_select: false, instance_offset: [0, 0, 0] };
    doc.collections[coll.id] = coll as never;
    doc.scene.rigidbody_world!.collection = coll.id;
    const g = new Depsgraph(doc);
    expect(pos(at(g, doc, a, 20)).z).toBeLessThan(4.5);
    expect(pos(at(g, doc, b, 20)).z).toBeCloseTo(5, 5);
  });
});

describe('rigid body collision collections and deactivation', () => {
  it('bodies only collide when they share a collision collection; sleepers wait', () => {
    const doc = scene();
    const ground = box(doc, 'Ground', 10, [0, 0, -5], 'PASSIVE');
    const a = box(doc, 'A', 0.5, [-2, 0, 2], 'ACTIVE');
    const b = box(doc, 'B', 0.5, [2, 0, 2], 'ACTIVE');
    const c = box(doc, 'C', 0.5, [0, 3, 2], 'ACTIVE');
    a.rigid_body = { ...a.rigid_body!, collision_collections: Array.from({ length: 20 }, (_, i) => i === 1) } as never;
    c.rigid_body = { ...c.rigid_body!, use_deactivation: true, use_start_deactivated: true } as never;
    void ground;
    const g = new Depsgraph(doc);
    expect(pos(at(g, doc, a, 60)).z).toBeLessThan(-1);
    expect(pos(at(g, doc, b, 60)).z).toBeGreaterThan(0.1);
    expect(pos(at(g, doc, c, 60)).z).toBeCloseTo(2, 3);
  });
});
