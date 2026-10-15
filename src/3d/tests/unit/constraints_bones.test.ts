import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Matrix4, Vector3 } from 'three';
import { emptyDocument, newObject, newArmature, newCurve, newAction } from '../../src/data/defaults';
import { Depsgraph } from '../../src/eval/depsgraph';
import { newConstraint } from '../../src/eval/constraints';
import { defaultPoseBone } from '../../src/eval/armature';
import { insertKeyframe } from '../../src/anim/fcurve';
import type { ArmatureData, Bone, DocumentData, ObjectData, Vec3 } from '../../src/data/types';

const fx = JSON.parse(readFileSync(new URL('../fixtures/constraint_cases_bones.json', import.meta.url), 'utf8')) as {
  bones: Record<string, Record<string, number[]>>;
  clamp: Record<string, number[]>;
  path: Record<string, number[]>;
  armature: Record<string, number[]>;
  ik: Record<string, { knee: number[]; tip: number[]; b1x: number[] }>;
};

const rowMajor = (a: number[]) => new Matrix4().set(...(a as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]));
function expectMatrix(m: Matrix4, rows: number[], key: string, tol = 2e-3) {
  const e = rowMajor(rows).elements;
  if (m.elements.some((v, i) => Math.abs(v - e[i]) > tol)) throw new Error(`${key}: got ${Array.from(m.clone().transpose().elements).map((x) => x.toFixed(4))} expected ${rows.map((x) => x.toFixed(4))}`);
}
const near = (a: ArrayLike<number>, b: ArrayLike<number>, tol = 2e-3) => [0, 1, 2].every((i) => Math.abs(a[i] - b[i]) < tol);

function link(doc: DocumentData, ob: ObjectData) {
  doc.objects[ob.id] = ob;
  doc.object_order.push(ob.id);
  doc.collections[doc.scene.collection].objects.push(ob.id);
  return ob;
}
function empty(doc: DocumentData, name: string, loc: Vec3 = [0, 0, 0]) {
  const ob = newObject(name, 'EMPTY', null);
  ob.location = loc;
  return link(doc, ob);
}
function bone(name: string, head: number[], tail: number[], parent: string | null = null, connect = false, roll = 0): Bone {
  return { name, parent, head: head as Vec3, tail: tail as Vec3, roll, use_connect: connect, use_deform: true, use_inherit_rotation: true, inherit_scale: 'FULL', envelope_distance: 0.25, head_radius: 0.1, tail_radius: 0.05, bbone_segments: 1 };
}
function armature(doc: DocumentData, bones: Bone[], loc: Vec3 = [0, 0, 0], rot: Vec3 = [0, 0, 0]) {
  const arm: ArmatureData = { ...newArmature('A'), bones };
  doc.armatures[arm.id] = arm;
  const ob = newObject('A', 'ARMATURE', arm.id);
  ob.location = loc;
  ob.rotation_euler = rot;
  ob.pose = Object.fromEntries(bones.map((b) => [b.name, { ...defaultPoseBone(), rotation_mode: 'XYZ' as const }]));
  return { ob: link(doc, ob), arm };
}
function polyCurve(doc: DocumentData, pts: number[][], loc: Vec3 = [0, 0, 0]) {
  const cu = newCurve('C');
  cu.splines.push({ type: 'POLY', bezier_points: [], points: pts.map((p) => ({ co: [p[0], p[1], p[2], 1], radius: 1, tilt: 0, weight: 1, select: false }) as never), use_cyclic_u: false, resolution_u: 12, order_u: 4, use_smooth: false, material_index: 0 });
  doc.curves[cu.id] = cu;
  const ob = newObject('C', 'CURVE', cu.id);
  ob.location = loc;
  return { ob: link(doc, ob), cu };
}

describe('bone constraints and spaces', () => {
  function rig() {
    const doc = emptyDocument();
    const { ob } = armature(doc, [bone('B1', [0, 0, 0], [0, 0, 1], null, false, 0.2), bone('B2', [0, 0, 1], [0, 1, 2], 'B1', true), bone('B3', [0, 0, 2.5], [0, 0, 3.5], 'B2'), bone('T', [1, 0, 0], [1, 0.5, 0.5])], [1, 0, 0], [0, 0, 0.3]);
    const pose = ob.pose!;
    pose.B1.rotation_euler = [0.3, 0, 0.2];
    pose.B2.rotation_euler = [0, 0.4, 0];
    pose.T.rotation_euler = [0.5, 0.1, -0.3];
    pose.T.location = [0.2, 0, 0.1];
    const e2 = empty(doc, 'E2', [2, 2, 2]);
    return { doc, ob, e2 };
  }
  const poseOf = (g: Depsgraph, ob: ObjectData, name: string) => g.get(ob.id)!.pose!.bones.get(name)!.pose;

  it('evaluates the rest of the rig like the reference pose', () => {
    const { doc, ob } = rig();
    const g = new Depsgraph(doc);
    g.evaluate(doc);
    for (const n of ['B1', 'B2', 'B3', 'T']) expectMatrix(poseOf(g, ob, n), fx.bones.base[n], `base ${n}`);
  });

  it('Copy Rotation from a bone in every owner/target space', () => {
    for (const os of ['WORLD', 'POSE', 'LOCAL_WITH_PARENT', 'LOCAL'])
      for (const ts of ['WORLD', 'LOCAL', 'LOCAL_OWNER_ORIENT']) {
        const { doc, ob } = rig();
        const c = newConstraint('COPY_ROTATION', 'c');
        Object.assign(c, { target: ob.id, subtarget: 'T', owner_space: os, target_space: ts });
        ob.pose!.B2.constraints.push(c);
        const g = new Depsgraph(doc);
        g.evaluate(doc);
        const key = `cr_${os}_${ts}`;
        for (const n of ['B2', 'B3']) expectMatrix(poseOf(g, ob, n), fx.bones[key][n], `${key} ${n}`);
      }
  });

  it('Copy Location with head/tail, Limit Rotation, Damped Track and Stretch To on bones', () => {
    for (const os of ['WORLD', 'LOCAL']) {
      const { doc, ob } = rig();
      const c = newConstraint('COPY_LOCATION', 'c');
      Object.assign(c, { target: ob.id, subtarget: 'T', head_tail: 0.5, owner_space: os });
      ob.pose!.B2.constraints.push(c);
      const g = new Depsgraph(doc);
      g.evaluate(doc);
      expectMatrix(poseOf(g, ob, 'B2'), fx.bones[`cl_${os}`].B2, `cl ${os}`);
    }
    {
      const { doc, ob } = rig();
      const c = newConstraint('LIMIT_ROTATION', 'c');
      Object.assign(c, { owner_space: 'LOCAL', use_limit_y: true, max_y: 0.1 });
      ob.pose!.B2.constraints.push(c);
      const g = new Depsgraph(doc);
      g.evaluate(doc);
      expectMatrix(poseOf(g, ob, 'B2'), fx.bones.lr_local.B2, 'limit rotation');
    }
    for (const type of ['DAMPED_TRACK', 'STRETCH_TO']) {
      const { doc, ob, e2 } = rig();
      const c = newConstraint(type, 'c');
      c.target = e2.id;
      ob.pose!.B3.constraints.push(c);
      const g = new Depsgraph(doc);
      g.evaluate(doc);
      expectMatrix(poseOf(g, ob, 'B3'), fx.bones[type === 'DAMPED_TRACK' ? 'dt' : 'st'].B3, type);
    }
  });

  it('IK reaches the target, follows the pole and stretches', () => {
    const doc = emptyDocument();
    const { ob } = armature(doc, [bone('B1', [0, 0, 0], [0, -0.1, 1]), bone('B2', [0, -0.1, 1], [0, 0, 2], 'B1', true)]);
    const t = empty(doc, 'T', [0, 0, 1.5]);
    const pole = empty(doc, 'P', [2, 0, 0.75]);
    const c = newConstraint('IK', 'ik');
    Object.assign(c, { target: t.id, chain_count: 2 });
    ob.pose!.B2.constraints.push(c);
    const g = new Depsgraph(doc);
    const state = () => {
      g.evaluate(doc);
      const b1 = poseOf(g, ob, 'B1'),
        b2 = poseOf(g, ob, 'B2');
      return { knee: new Vector3().setFromMatrixPosition(b2), tip: new Vector3(0, g.get(ob.id)!.pose!.bones.get('B2')!.length, 0).applyMatrix4(b2), b1x: new Vector3(1, 0, 0).transformDirection(b1) };
    };
    let s = state();
    expect(near(s.tip.toArray(), fx.ik.nopole.tip)).toBe(true);
    c.pole_target = pole.id;
    for (const a of [0, -90, 90]) {
      c.pole_angle = (a * Math.PI) / 180;
      s = state();
      expect(near(s.tip.toArray(), fx.ik[`pole${a}`].tip, 0.01), `tip pole ${a}`).toBe(true);
      expect(near(s.knee.toArray(), fx.ik[`pole${a}`].knee, 0.01), `knee pole ${a}: ${s.knee.toArray()}`).toBe(true);
    }
    c.pole_target = null;
    c.pole_angle = 0;
    c.use_tail = false;
    s = state();
    expect(near(s.knee.toArray(), fx.ik.notail.knee, 0.01), `no tail ${s.knee.toArray()}`).toBe(true);
    c.use_tail = true;
    t.location = [0, 0, 3];
    ob.pose!.B1.ik_stretch = 0.5;
    ob.pose!.B2.ik_stretch = 0.5;
    s = state();
    expect(near(s.tip.toArray(), fx.ik.far_stretch.tip, 0.01), `stretch tip ${s.tip.toArray()}`).toBe(true);
    expect(near(s.knee.toArray(), fx.ik.far_stretch.knee, 0.02), `stretch knee ${s.knee.toArray()}`).toBe(true);
  });

  it('IK with rotation follows the target orientation and influence blends', () => {
    const doc = emptyDocument();
    const { ob } = armature(doc, [bone('B1', [0, 0, 0], [0, 0, 1]), bone('B2', [0, 0, 1], [0, 0, 2], 'B1', true)]);
    const t = empty(doc, 'T', [0.5, 0, 1.5]);
    t.rotation_euler = [0, 0.7, 0];
    const c = newConstraint('IK', 'ik');
    Object.assign(c, { target: t.id, chain_count: 2, use_rotation: true, orient_weight: 1 });
    ob.pose!.B2.constraints.push(c);
    const g = new Depsgraph(doc);
    g.evaluate(doc);
    const b2 = g.get(ob.id)!.pose!.bones.get('B2')!.pose;
    const y = new Vector3(0, 1, 0).transformDirection(b2);
    const ty = new Vector3(0, 1, 0).transformDirection(new Matrix4().makeRotationY(0.7));
    expect(y.angleTo(ty)).toBeLessThan(0.05);
    c.influence = 0;
    g.evaluate(doc);
    expect(near(new Vector3().setFromMatrixPosition(g.get(ob.id)!.pose!.bones.get('B2')!.pose).toArray(), [0, 0, 1])).toBe(true);
  });

  it('IK honours bone locks and rotation limits', () => {
    const doc = emptyDocument();
    const { ob } = armature(doc, [bone('B1', [0, 0, 0], [0, 0, 1]), bone('B2', [0, 0, 1], [0, 0, 2], 'B1', true)]);
    const t = empty(doc, 'T', [1, 1, 1]);
    const c = newConstraint('IK', 'ik');
    Object.assign(c, { target: t.id, chain_count: 2 });
    ob.pose!.B2.constraints.push(c);
    // the root may only turn around its local X axis
    Object.assign(ob.pose!.B1, { lock_ik_y: true, lock_ik_z: true });
    // the second bone bends at most 0.3 rad around X
    Object.assign(ob.pose!.B2, { use_ik_limit_x: true, ik_min_x: -0.3, ik_max_x: 0.3, lock_ik_y: true, lock_ik_z: true });
    const g = new Depsgraph(doc);
    g.evaluate(doc);
    const bones = g.get(ob.id)!.pose!.bones;
    // B1 stays in its YZ plane (no turning around Y or Z)
    const b1x = new Vector3(1, 0, 0).transformDirection(bones.get('B1')!.pose);
    expect(b1x.x).toBeGreaterThan(0.999);
    // B2 relative to B1 bends no more than the limit
    const rel = bones.get('B1')!.pose.clone().invert().multiply(bones.get('B2')!.pose);
    const y = new Vector3(0, 1, 0).transformDirection(rel);
    expect(Math.acos(Math.min(1, y.y))).toBeLessThan(0.31);
  });

  it('Spline IK fits a chain along a curve', () => {
    const doc = emptyDocument();
    const { ob } = armature(doc, [bone('B1', [0, 0, 0], [0, 0, 1]), bone('B2', [0, 0, 1], [0, 0, 2], 'B1', true), bone('B3', [0, 0, 2], [0, 0, 3], 'B2', true)]);
    const { ob: cob } = polyCurve(doc, [
      [0, 0, 0],
      [6, 0, 0],
    ]);
    const c = newConstraint('SPLINE_IK', 'sik');
    Object.assign(c, { target: cob.id, chain_count: 3 });
    ob.pose!.B3.constraints.push(c);
    const g = new Depsgraph(doc);
    g.evaluate(doc);
    const bones = g.get(ob.id)!.pose!.bones;
    const headOf = (n: string) => new Vector3().setFromMatrixPosition(bones.get(n)!.pose).toArray();
    expect(near(headOf('B1'), [0, 0, 0])).toBe(true);
    expect(near(headOf('B2'), [2, 0, 0])).toBe(true);
    expect(near(headOf('B3'), [4, 0, 0])).toBe(true);
    // bones keep their length without curve fitting
    c.y_scale_mode = 'NONE';
    g.evaluate(doc);
    expect(near(new Vector3().setFromMatrixPosition(g.get(ob.id)!.pose!.bones.get('B3')!.pose).toArray(), [2, 0, 0])).toBe(true);
  });
});

describe('relationship constraints', () => {
  it('Clamp To projects the owner onto the curve along the main axis', () => {
    for (const x of [3, 5, -1])
      for (const ax of ['CLAMPTO_AUTO', 'CLAMPTO_Y'])
        for (const cyc of [0, 1]) {
          const doc = emptyDocument();
          const { ob: cob } = polyCurve(
            doc,
            [
              [0, 0, 0],
              [4, 0, 0],
              [4, 2, 0],
            ],
            [0, 1, 0],
          );
          const e = empty(doc, 'E', [x, 0.5, 1]);
          const c = newConstraint('CLAMP_TO', 'c');
          Object.assign(c, { target: cob.id, main_axis: ax, use_cyclic: !!cyc });
          e.constraints.push(c);
          const g = new Depsgraph(doc);
          g.evaluate(doc);
          const p = new Vector3().setFromMatrixPosition(g.get(e.id)!.world).toArray();
          expect(near(p, fx.clamp[`clamp_${x}_${ax}_${cyc}`]), `${x} ${ax} ${cyc}: ${p}`).toBe(true);
        }
  });

  it('Follow Path uses the curve evaluation time, offset and fixed position', () => {
    const doc = emptyDocument();
    const { ob: cob, cu } = polyCurve(
      doc,
      [
        [0, 0, 0],
        [4, 0, 0],
        [4, 2, 0],
      ],
      [0, 1, 0],
    );
    cu.path_duration = 100;
    const e = empty(doc, 'E');
    const c = newConstraint('FOLLOW_PATH', 'c');
    c.target = cob.id;
    e.constraints.push(c);
    const g = new Depsgraph(doc);
    const loc = () => {
      g.evaluate(doc);
      return new Vector3().setFromMatrixPosition(g.get(e.id)!.world).toArray();
    };
    for (const t of [0, 25, 50, 75, 100]) {
      cu.eval_time = t;
      const m = fx.path[`fp_${t}`];
      expect(near(loc(), [m[3], m[7], m[11]]), `t ${t}`).toBe(true);
    }
    c.use_curve_follow = true;
    cu.eval_time = 25;
    expect(near(loc(), [1.5, 1, 0])).toBe(true);
    // facing along the path
    const y = new Vector3(0, 1, 0).transformDirection(g.get(e.id)!.world);
    expect(y.x).toBeGreaterThan(0.9);
    c.use_curve_follow = false;
    c.offset = 10;
    cu.eval_time = 50;
    let m = fx.path.fp_off;
    expect(near(loc(), [m[3], m[7], m[11]])).toBe(true);
    c.use_fixed_location = true;
    c.offset_factor = 0.5;
    m = fx.path.fp_fixed;
    expect(near(loc(), [m[3], m[7], m[11]])).toBe(true);
  });

  function armRig(doc: DocumentData) {
    const { ob } = armature(doc, [bone('B1', [0, 0, 0], [0, 1, 0]), bone('B2', [2, 0, 0], [2, 1, 0])], [0, 0, 1]);
    ob.pose!.B1.rotation_euler = [0, 0, Math.PI / 2];
    ob.pose!.B2.location = [0, 0, 1];
    ob.pose!.B1.rotation_mode = 'XYZ';
    return ob;
  }

  it('Armature constraint blends bone deformations (linear and volume preserving)', () => {
    const doc = emptyDocument();
    const arm = armRig(doc);
    // envelopes: the owner lies outside the bone's envelope
    const bones = doc.armatures[arm.data!].bones;
    bones[0].head_radius = bones[0].tail_radius = 0.1;
    bones[0].envelope_distance = 0.25;
    const e = empty(doc, 'E', [1, 0.5, 1]);
    e.rotation_euler = [0.2, 0, 0];
    const c = newConstraint('ARMATURE', 'c');
    c.targets = [
      { target: arm.id, subtarget: 'B1', weight: 0.5 },
      { target: arm.id, subtarget: 'B2', weight: 0.5 },
    ];
    e.constraints.push(c);
    const g = new Depsgraph(doc);
    const run = (key: string) => {
      g.evaluate(doc);
      expectMatrix(g.get(e.id)!.world, fx.armature[key], key);
    };
    run('half');
    const ts = c.targets as { weight: number }[];
    ts[0].weight = 0.3;
    ts[1].weight = 0;
    run('single03');
    ts[0].weight = 1;
    ts[1].weight = 1;
    run('both1');
    ts[0].weight = 0.5;
    ts[1].weight = 0.5;
    c.use_deform_preserve_volume = true;
    run('half_dq');
    c.use_deform_preserve_volume = false;
    ts[1].weight = 0;
    ts[0].weight = 1;
    c.use_bone_envelopes = true;
    run('env');
  });

  it('Action constraint maps a target channel to an action frame', () => {
    const doc = emptyDocument();
    const act = newAction('Act');
    doc.actions[act.id] = act;
    const key = (path: string, i: number, a: number, b: number) => {
      const fc = { data_path: path, array_index: i, keyframe_points: [], extrapolation: 'CONSTANT' as const, modifiers: [] };
      insertKeyframe(fc, 1, a, { interpolation: 'LINEAR' });
      insertKeyframe(fc, 11, b, { interpolation: 'LINEAR' });
      act.fcurves.push(fc);
    };
    key('location', 0, 0, 2);
    key('location', 1, 0, 0);
    key('location', 2, 0, 4);
    key('rotation_euler', 0, 0, 0);
    key('rotation_euler', 1, 0, 0);
    key('rotation_euler', 2, 0, 1);
    const drv = empty(doc, 'Drv', [0.5, 0, 0]);
    const e = empty(doc, 'E2', [1, 1, 1]);
    const c = newConstraint('ACTION', 'c');
    Object.assign(c, { target: drv.id, action: act.id, transform_channel: 'LOCATION_X', min: 0, max: 1, frame_start: 1, frame_end: 11 });
    e.constraints.push(c);
    const g = new Depsgraph(doc);
    for (const mm of ['REPLACE', 'BEFORE_FULL', 'AFTER_FULL', 'AFTER', 'BEFORE_SPLIT']) {
      c.mix_mode = mm;
      g.evaluate(doc);
      expectMatrix(g.get(e.id)!.world, fx.armature[`act_${mm}`], mm);
    }
    c.mix_mode = 'AFTER_FULL';
    drv.rotation_euler = [0, 0, Math.PI / 6];
    Object.assign(c, { transform_channel: 'ROTATION_Z', min: 0, max: 60 });
    g.evaluate(doc);
    expectMatrix(g.get(e.id)!.world, fx.armature.act_rot, 'rotation channel');
    Object.assign(c, { use_eval_time: true, eval_time: 0.25 });
    g.evaluate(doc);
    expectMatrix(g.get(e.id)!.world, fx.armature.act_evaltime, 'eval time');
  });

  it('Geometry Attribute reads positions and instance transforms', () => {
    const doc = emptyDocument();
    const e = empty(doc, 'E', [5, 5, 5]);
    const src = empty(doc, 'S');
    const c = newConstraint('GEOMETRY_ATTRIBUTE', 'c');
    c.target = src.id;
    e.constraints.push(c);
    const g = new Depsgraph(doc);
    g.evaluate(doc);
    // no geometry on the target: the owner is unchanged
    expect(near(new Vector3().setFromMatrixPosition(g.get(e.id)!.world).toArray(), [5, 5, 5])).toBe(true);
  });
});
