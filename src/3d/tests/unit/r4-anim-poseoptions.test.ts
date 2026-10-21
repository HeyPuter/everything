// @vitest-environment happy-dom
// Pose Options: X-Axis Mirror (absolute and relative) and Auto IK, compared with values recorded
// from the reference application for the same armature and transforms.
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app, operators } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import '../../src/ops/modes';
import '../../src/modes/index';
import type { ArmatureData, Bone, ObjectData } from '../../src/data/types';
import { newBoneLike } from '../../src/modes/armature/armkernels';
import { defaultPoseBone } from '../../src/eval/armature';
import { poseOptions } from '../../src/modes/armature/poseoptions';
import mirrorRef from '../fixtures/anim/pose_mirror.json';
import ikRef from '../fixtures/anim/auto_ik.json';

type BoneSpec = [string, number[], number[], number, string | null, boolean];
let ob: ObjectData;
let arm: ArmatureData;

function build(specs: BoneSpec[]) {
  setApp(new App(startupDocument()));
  app.run('object.armature_add');
  ob = app.activeObject!;
  arm = app.doc.armatures[ob.data!];
  arm.bones.length = 0;
  for (const [name, head, tail, roll, parent, connect] of specs) {
    const b: Bone = newBoneLike(arm, name, head, tail, parent ? arm.bones.find((x) => x.name === parent)! : null, connect);
    b.roll = roll;
    arm.bones.push(b);
  }
  ob.pose = Object.fromEntries(arm.bones.map((b) => [b.name, { ...defaultPoseBone(), rotation_mode: 'QUATERNION' as const }]));
  app.run('object.mode_set', { mode: 'POSE' });
  app.evaluate();
}

function select(name: string) {
  for (const [n, pb] of Object.entries(ob.pose!)) pb.select = n === name;
  arm.active_bone = name;
  app.evaluate();
}
/** Transform operators (exec, without a 3D view) run on the evaluated pose: evaluate again after each one. */
function run(op: string, props: Record<string, unknown>) {
  const r = operators.get(op)!.exec!({} as never, props);
  app.evaluate();
  return r;
}

const close = (a: number[], b: number[], tol: number, what: string) => a.forEach((x, i) => expect(Math.abs(x - b[i]), `${what}[${i}]: ${a} vs ${b}`).toBeLessThan(tol));

describe('X-Axis Mirror', () => {
  beforeEach(() =>
    build([
      ['Root', [0, 0, 0], [0, 0, 1], 0, null, false],
      ['Arm.L', [0.5, 0, 1.5], [1.5, 0.2, 1.8], 0.3, 'Root', false],
      ['Arm.R', [-0.5, 0, 1.5], [-1.5, 0.2, 1.8], -0.3, 'Root', false],
      ['Odd.L', [0.4, 0, 0.5], [1.0, 0.5, 0.4], 0.2, 'Root', false],
      ['Odd.R', [-0.6, 0.1, 0.5], [-1.2, 0.3, 0.9], -0.7, 'Root', false],
    ]),
  );
  for (const [kase, bone, relative] of [
    ['sym', 'Arm.L', false],
    ['odd', 'Odd.L', false],
    ['oddrel', 'Odd.L', true],
  ] as const) {
    it(`${kase}: the twin gets the mirrored transform`, () => {
      Object.assign(poseOptions(ob), { use_mirror_x: true, use_mirror_relative: relative });
      if (relative) ob.pose!['Odd.R'].location = [0.1, 0.2, 0];
      select(bone);
      // the recorded run rotated by 0.4 with the reference's exec sign (clockwise seen from +Z)
      expect(run('transform.translate', { value: [0.3, 0.2, 0.1], orient_type: 'GLOBAL' })).toBe('FINISHED');
      expect(run('transform.rotate', { value: -0.4, orient_axis: 'Z', orient_type: 'GLOBAL' })).toBe('FINISHED');
      const ref = (mirrorRef as Record<string, Record<string, { loc: number[]; quat: number[]; scale: number[] }>>)[kase];
      const twin = bone.replace('.L', '.R');
      for (const n of [bone, twin]) {
        const pb = ob.pose![n];
        close(pb.location, ref[n].loc, 2e-3, `${n} location`);
        close(pb.rotation_quaternion, ref[n].quat, 2e-3, `${n} rotation`);
      }
      expect(run('transform.resize', { value: [1.2, 1, 0.9], orient_type: 'GLOBAL' })).toBe('FINISHED');
      // the twin's scale always equals the bone's (mirroring keeps scale)
      const s = ob.pose![bone].scale;
      close(ob.pose![twin].scale, s, 1e-9, `${twin} scale`);
    });
  }
  it('is off by default: the twin stays put', () => {
    select('Arm.L');
    run('transform.translate', { value: [0.3, 0.2, 0.1], orient_type: 'GLOBAL' });
    expect(ob.pose!['Arm.R'].location).toEqual([0, 0, 0]);
  });
});

describe('Auto IK', () => {
  beforeEach(() =>
    build([
      ['Root', [0, 0, 0], [0, 0, 1], 0, null, false],
      ['B1', [0, 0, 1], [0, 0.2, 2], 0, 'Root', true],
      ['B2', [0, 0.2, 2], [0, 0, 3], 0, 'B1', true],
      ['D', [1, 0, 1], [1, 0, 2], 0, 'Root', false],
      ['E', [1, 0, 2], [1, 0.3, 2.8], 0, 'D', true],
    ]),
  );
  const tailOf = (n: string) => {
    const be = app.graph.get(ob.id)!.pose!.bones.get(n)!;
    const e = be.pose.elements;
    // tail = pose · (0, length, 0)
    return [e[12] + e[4] * be.length, e[13] + e[5] * be.length, e[14] + e[6] * be.length];
  };
  for (const [kase, chain, still] of [
    ['B2', ['B2', 'B1', 'Root'], ['D', 'E']],
    ['E', ['E', 'D'], ['Root', 'B1', 'B2']],
  ] as const) {
    it(`grabbing ${kase} bends its connected chain so the tail follows`, () => {
      poseOptions(ob).use_auto_ik = true;
      select(kase);
      expect(run('transform.translate', { value: [0.5, 0.3, -0.4], orient_type: 'GLOBAL' })).toBe('FINISHED');
      const ref = (ikRef as Record<string, Record<string, { loc: number[]; quat: number[]; tail: number[] }>>)[kase];
      close(tailOf(kase), ref[kase].tail, 1e-3, `${kase} tail`);
      for (const n of chain) {
        expect(ob.pose![n].location).toEqual([0, 0, 0]);
        expect(ob.pose![n].rotation_quaternion[0]).toBeLessThan(0.99999);
      }
      for (const n of still) expect(ob.pose![n].rotation_quaternion).toEqual([1, 0, 0, 0]);
    });
  }
  it('an unconnected bone still translates', () => {
    poseOptions(ob).use_auto_ik = true;
    select('D');
    run('transform.translate', { value: [0.5, 0.3, -0.4], orient_type: 'GLOBAL' });
    // bone-local location (Y along the bone): same as the reference
    close(ob.pose!['D'].location, (ikRef as Record<string, Record<string, { loc: number[] }>>).D.D.loc, 1e-4, 'D location');
  });
  it('the scripting API exposes the options', async () => {
    await import('../../src/scripting/api_ext');
    const { wrapId } = await import('../../src/scripting/api');
    const pose = (wrapId('objects', ob.id) as unknown as { pose: { use_auto_ik: boolean; use_mirror_x: boolean } }).pose;
    pose.use_mirror_x = true;
    expect(poseOptions(ob).use_mirror_x).toBe(true);
    expect(pose.use_auto_ik).toBe(false);
  });
});

describe('Pose Mode parenting', () => {
  it('Ctrl P ▸ Bone parents the selected objects to the active bone without moving them', () => {
    build([['Bone', [0, 0, 0], [0, 0, 1], 0, null, false]]);
    const cube = Object.values(app.doc.objects).find((o) => o.name === 'Cube')!;
    const before = app.graph.get(cube.id)!.world.clone();
    cube.select = true;
    ob.select = true;
    arm.active_bone = 'Bone';
    expect(app.run('object.parent_set', { type: 'BONE' }, { invoke: false })).toBe('FINISHED');
    app.evaluate();
    expect([cube.parent, cube.parent_type, cube.parent_bone]).toEqual([ob.id, 'BONE', 'Bone']);
    const after = app.graph.get(cube.id)!.world;
    after.elements.forEach((x, i) => expect(x).toBeCloseTo(before.elements[i], 6));
  });
});
