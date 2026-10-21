import { describe, it, expect } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { startupDocument } from '../../src/data/defaults';
import type { ArmatureData, Bone, ObjectData } from '../../src/data/types';
import { bboneFrames, bboneShape, bboneIsStraight } from '../../src/eval/bbone';
import { defaultPoseBone, evaluatePose } from '../../src/eval/armature';
import { armatureDeform } from '../../src/eval/mods/skinning';

function bone(over: Partial<Bone> = {}): Bone {
  return { name: 'B', parent: null, head: [0, 0, 0], tail: [0, 0, 4], roll: 0, use_connect: false, use_deform: true, use_inherit_rotation: true, inherit_scale: 'FULL', envelope_distance: 0.25, head_radius: 0.1, tail_radius: 0.05, bbone_segments: 4, ...over };
}

describe('B-Bones', () => {
  it('a straight B-Bone has evenly spaced joints along Y', () => {
    const s = bboneShape(bone(), null, 4);
    expect(bboneIsStraight(s)).toBe(true);
    const f = bboneFrames(s);
    expect(f.length).toBe(5);
    f.forEach((m, k) => expect(new Vector3().setFromMatrixPosition(m).toArray().map((x) => +x.toFixed(6))).toEqual([0, k, 0]));
  });

  it('curve offsets bend the middle, roll and scale interpolate', () => {
    const s = bboneShape(bone({ bbone_curveinx: 1, bbone_curveoutx: 1, bbone_rollout: Math.PI / 2, bbone_scaleout: [3, 1, 3] }), null, 4);
    const f = bboneFrames(s);
    const mid = new Vector3().setFromMatrixPosition(f[2]);
    expect(mid.x).toBeCloseTo(0.75, 6); // 3/8 · 1 + 3/8 · 1
    expect(new Vector3().setFromMatrixPosition(f[0]).length()).toBeCloseTo(0, 6);
    expect(new Vector3().setFromMatrixPosition(f[4]).y).toBeCloseTo(4, 6);
    const sc = new Vector3().setFromMatrixScale(f[4]);
    expect(sc.x).toBeCloseTo(3, 5);
    expect(sc.z).toBeCloseTo(3, 5);
  });

  it('joints match reference values (arc-length spacing, handle directions, roll)', () => {
    const at = (pb: Record<string, number>, k: number) => {
      const m = bboneFrames(bboneShape(bone(), pb as never, 4))[k];
      return new Vector3().setFromMatrixPosition(m);
    };
    const a = at({ bbone_curveinx: 1, bbone_curveoutx: 1 }, 1);
    expect(a.x).toBeCloseTo(0.5395, 3);
    expect(a.y).toBeCloseTo(0.9404, 3);
    const b = at({ bbone_curveinx: 1 }, 2);
    expect(b.x).toBeCloseTo(0.3808, 3);
    expect(b.y).toBeCloseTo(1.9688, 3);
    expect(at({ bbone_easein: 1 }, 1).y).toBeCloseTo(1.0014, 2);
  });

  it('pose curve bends skinned vertices along the bone', () => {
    const doc = startupDocument();
    const arm: ArmatureData = { id: 'ar', name: 'A', bones: [bone()], display_type: 'BBONE', pose_position: 'POSE', show_names: false, show_axes: false };
    const ob = { id: 'ob', pose: { B: { ...defaultPoseBone(), bbone_curveinx: 1, bbone_curveoutx: 1 } } } as unknown as ObjectData;
    const pose = evaluatePose(doc, ob, arm);
    expect(pose.bones.get('B')!.bbone).toBeTruthy();
    const positions = new Float32Array([0, 0, 0, 0, 0, 2, 0, 0, 4]);
    const out = armatureDeform(positions, [{ name: 'B' }], [new Float32Array([1, 1, 1])], arm.bones, pose, new Matrix4(), new Matrix4(), { useGroups: true, useEnvelopes: false, preserveVolume: false });
    // the ends stay, the middle bends sideways (along the bone's X)
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[8]).toBeCloseTo(4, 5);
    expect(Math.abs(out[3])).toBeGreaterThan(0.5);
    expect(out[5]).toBeCloseTo(2, 1);
    // volume-preserving blending bends the same way
    const dq = armatureDeform(positions, [{ name: 'B' }], [new Float32Array([1, 1, 1])], arm.bones, pose, new Matrix4(), new Matrix4(), { useGroups: true, useEnvelopes: false, preserveVolume: true });
    expect(dq[3]).toBeCloseTo(out[3], 4);
  });

  it('envelope multiply drops group weights outside the envelope', () => {
    const doc = startupDocument();
    const arm: ArmatureData = { id: 'ar', name: 'A', bones: [bone({ bbone_segments: 1, envelope_weight: 0.5, use_envelope_multiply: true, head_radius: 1, tail_radius: 1 })], display_type: 'OCTAHEDRAL', pose_position: 'POSE', show_names: false, show_axes: false };
    const ob = { id: 'ob', pose: { B: { ...defaultPoseBone(), location: [0, 1, 0] } } } as unknown as ObjectData;
    const pose = evaluatePose(doc, ob, arm);
    // inside the envelope: follows the bone (+1 along the bone = +Z); far outside: stays
    const positions = new Float32Array([0, 0, 2, 9, 0, 2]);
    const out = armatureDeform(positions, [{ name: 'B' }], [new Float32Array([1, 1])], arm.bones, pose, new Matrix4(), new Matrix4(), { useGroups: true, useEnvelopes: true, preserveVolume: false });
    expect(out[2]).toBeCloseTo(3, 5);
    expect(out[5]).toBeCloseTo(2, 5);
  });
});
