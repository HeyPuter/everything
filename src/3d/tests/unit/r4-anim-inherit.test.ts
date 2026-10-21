import { describe, it, expect } from 'vitest';
import { Matrix4 } from 'three';
import { startupDocument } from '../../src/data/defaults';
import type { ArmatureData, Bone, ObjectData } from '../../src/data/types';
import { defaultPoseBone, evaluatePose } from '../../src/eval/armature';
import expected from '../fixtures/anim/inherit_scale.json';

function bone(name: string, head: number[], tail: number[], parent: string | null = null): Bone {
  return { name, parent, head: head as Bone['head'], tail: tail as Bone['tail'], roll: 0, use_connect: false, use_deform: true, use_inherit_rotation: true, inherit_scale: 'FULL', envelope_distance: 0.25, head_radius: 0.1, tail_radius: 0.05, bbone_segments: 1 };
}

/** Child pose matrix (armature space) for one inheritance setup (reference values recorded in the fixture). */
function childMatrix(mode: string): number[][] {
  const doc = startupDocument();
  const c = bone('C', [0, 0.2, 1.2], [1, 0, 1.5], 'P');
  if (mode === 'NOROT') c.use_inherit_rotation = false;
  else if (mode === 'NOLOCAL') c.use_local_location = false;
  else c.inherit_scale = mode as Bone['inherit_scale'];
  const arm: ArmatureData = { id: 'ar', name: 'A', bones: [bone('P', [0, 0, 0], [0, 0, 1]), c], display_type: 'OCTAHEDRAL', pose_position: 'POSE', show_names: false, show_axes: false };
  const p = { ...defaultPoseBone(), scale: [2, 1, 0.5] as [number, number, number], rotation_quaternion: [Math.cos(Math.PI / 12), Math.sin(Math.PI / 12), 0, 0] as [number, number, number, number] };
  const pc = { ...defaultPoseBone(), location: [0.1, 0.2, 0.3] as [number, number, number], rotation_mode: 'XYZ' as const, rotation_euler: [0, 0, (20 * Math.PI) / 180] as [number, number, number] };
  const ob = { id: 'ob', pose: { P: p, C: pc } } as unknown as ObjectData;
  const m: Matrix4 = evaluatePose(doc, ob, arm).bones.get('C')!.pose;
  const e = m.elements;
  return [0, 1, 2, 3].map((r) => [0, 1, 2, 3].map((col) => e[col * 4 + r]));
}

describe('bone inheritance matches the reference', () => {
  for (const mode of Object.keys(expected)) {
    it(mode, () => {
      const got = childMatrix(mode);
      const want = (expected as Record<string, number[][]>)[mode];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) expect(got[r][c], `${mode} [${r}][${c}]`).toBeCloseTo(want[r][c], 4);
    });
  }
});
