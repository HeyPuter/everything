// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { armatureDeform, envelopeWeight } from '../../src/eval/mods/skinning';
import type { Bone } from '../../src/data/types';
import type { PoseResult } from '../../src/eval/armature';

const bone = (name: string, head: number[], tail: number[]): Bone => ({ name, parent: null, head: head as never, tail: tail as never, roll: 0, use_connect: false, use_deform: true, use_inherit_rotation: true, inherit_scale: 'FULL', envelope_distance: 0.25, head_radius: 0.1, tail_radius: 0.05, bbone_segments: 1 });
const poseOf = (deforms: Record<string, Matrix4>): PoseResult => ({ bones: new Map(Object.entries(deforms).map(([name, deform]) => [name, { name, deform, rest: new Matrix4(), restInv: new Matrix4(), pose: deform, length: 1, parent: null }])), order: Object.keys(deforms), signature: '' });
const I = new Matrix4();

describe('Armature deformation', () => {
  it('weights envelopes by distance to the bone', () => {
    const b = bone('B', [0, 0, 0], [0, 0, 1]);
    expect(envelopeWeight(b, new Vector3(0, 0.05, 0.5))).toBe(1);
    expect(envelopeWeight(b, new Vector3(0, 0.2, 0.5))).toBeGreaterThan(0);
    expect(envelopeWeight(b, new Vector3(0, 1, 0.5))).toBe(0);
  });

  it('binds unweighted vertices with envelopes and keeps volume with dual quaternions', () => {
    const b1 = bone('A', [0, 0, 0], [0, 0, 1]),
      b2 = bone('B', [0, 0, 1], [0, 0, 2]);
    // B turned half a turn around Y about its head
    const rot = new Matrix4().makeTranslation(0, 0, 1).multiply(new Matrix4().makeRotationY(Math.PI / 2)).multiply(new Matrix4().makeTranslation(0, 0, -1));
    const pose = poseOf({ A: I, B: rot });
    const P = Float32Array.from([0.05, 0, 1, 0, 0, 1.5]);
    const groups = [{ name: 'A' }, { name: 'B' }];
    const weights = [Float32Array.from([0.5, 0]), Float32Array.from([0.5, 0])];
    const lin = armatureDeform(P, groups, weights, [b1, b2], pose, I, I, { useGroups: true, useEnvelopes: true, preserveVolume: false });
    // the second vertex has no group weight: its envelope (bone B) carries it
    expect(new Vector3(lin[3], lin[4], lin[5]).distanceTo(new Vector3(0.5, 0, 1))).toBeLessThan(1e-5);
    const dq = armatureDeform(P, groups, weights, [b1, b2], pose, I, I, { useGroups: true, useEnvelopes: false, preserveVolume: true });
    // halfway blend of no rotation and a quarter turn: a 45° turn keeps the distance from the joint
    const d = new Vector3(dq[0], dq[1], dq[2]).distanceTo(new Vector3(0, 0, 1));
    expect(d).toBeCloseTo(0.05, 4);
    const ld = new Vector3(lin[0], lin[1], lin[2]).distanceTo(new Vector3(0, 0, 1));
    expect(ld).toBeLessThan(0.05);
    void Quaternion;
  });
});
