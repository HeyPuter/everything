import { describe, expect, it } from 'vitest';
import * as A from '../../src/modes/armature/armkernels';
import type { ArmatureData, Bone } from '../../src/data/types';

function bone(name: string, head: number[], tail: number[], parent: string | null = null, connect = false): Bone {
  return { name, parent, head: [head[0], head[1], head[2]], tail: [tail[0], tail[1], tail[2]], roll: 0, use_connect: connect, use_deform: true, use_inherit_rotation: true, inherit_scale: 'FULL', envelope_distance: 0.25, head_radius: 0.1, tail_radius: 0.05, bbone_segments: 1 };
}
function armature(...bones: Bone[]): ArmatureData {
  return { id: 'ar', name: 'Armature', bones, display_type: 'OCTAHEDRAL', pose_position: 'POSE', show_names: false, show_axes: false };
}
/** A → B → C connected chain going up Z. */
const chain = () => armature(bone('A', [0, 0, 0], [0, 0, 1]), bone('B', [0, 0, 1], [0, 0, 2], 'A', true), bone('C', [0, 0, 2], [0, 1, 3], 'B', true));
const sel = (a: ArmatureData, ...names: string[]) => {
  for (const b of a.bones) A.setBoneSelected(b, names.includes(b.name));
};
const selected = (a: ArmatureData) => a.bones.filter((b) => b.select).map((b) => b.name);

describe('bone names', () => {
  it('flips side markers in many spellings', () => {
    expect(A.flipSideName('Arm.L')).toBe('Arm.R');
    expect(A.flipSideName('arm_r')).toBe('arm_l');
    expect(A.flipSideName('Hand.L.001')).toBe('Hand.R.001');
    expect(A.flipSideName('L.thigh')).toBe('R.thigh');
    expect(A.flipSideName('LeftFoot')).toBe('RightFoot');
    expect(A.flipSideName('upper_left_arm')).toBe('upper_right_arm');
    expect(A.flipSideName('Spine')).toBe('Spine');
    expect(A.flipSideName('Lamp')).toBe('Lamp');
  });

  it('auto-names by axis, keeping centred bones', () => {
    expect(A.autoSideName(bone('Arm', [1, 0, 0], [2, 0, 0]), 'XAXIS')).toBe('Arm.L');
    expect(A.autoSideName(bone('Arm.L', [-1, 0, 0], [-2, 0, 0]), 'XAXIS')).toBe('Arm.R');
    expect(A.autoSideName(bone('Spine', [0, 0, 0], [0, 0, 1]), 'XAXIS')).toBe('Spine');
    expect(A.autoSideName(bone('Toe', [0, -1, 0], [0, -2, 0]), 'YAXIS')).toBe('Toe.Fr');
    expect(A.autoSideName(bone('Head', [0, 0, 2], [0, 0, 3]), 'ZAXIS')).toBe('Head.Top');
  });

  it('renames swapped pairs without collisions and keeps parents', () => {
    const a = armature(bone('Arm.L', [1, 0, 0], [2, 0, 0]), bone('Arm.R', [-1, 0, 0], [-2, 0, 0]), bone('Hand.L', [2, 0, 0], [3, 0, 0], 'Arm.L', true));
    const changes = A.renameBones(a, new Map(a.bones.map((b) => [b, A.flipSideName(b.name)])));
    expect(a.bones.map((b) => b.name)).toEqual(['Arm.R', 'Arm.L', 'Hand.R']);
    expect(a.bones[2].parent).toBe('Arm.R');
    expect(changes.get('Arm.L')).toBe('Arm.R');
  });
});

describe('bone selection', () => {
  it('more / less walk the hierarchy', () => {
    const a = chain();
    sel(a, 'A');
    A.selectMore(a);
    expect(selected(a)).toEqual(['A', 'B']);
    A.selectLess(a);
    // B borders the unselected C; the root A has no unselected neighbour
    expect(selected(a)).toEqual(['A']);
    sel(a, 'A', 'B', 'C');
    A.selectLess(a);
    expect(selected(a)).toEqual(['A', 'B', 'C']);
  });

  it('mirror, similar and path', () => {
    const a = armature(bone('Root', [0, 0, 0], [0, 0, 1]), bone('Leg.L', [0.5, 0, 0], [0.5, 0, -1], 'Root'), bone('Leg.R', [-0.5, 0, 0], [-0.5, 0, -1], 'Root'), bone('Foot.L', [0.5, 0, -1], [0.5, -0.5, -1], 'Leg.L', true));
    sel(a, 'Leg.L');
    a.active_bone = 'Leg.L';
    A.selectMirror(a, false);
    expect(selected(a)).toEqual(['Leg.R']);
    expect(a.active_bone).toBe('Leg.R');
    sel(a, 'Leg.L');
    a.active_bone = 'Leg.L';
    A.selectSimilar(a, 'LENGTH', 0.01);
    expect(selected(a)).toEqual(['Root', 'Leg.L', 'Leg.R']);
    sel(a, 'Leg.L');
    A.selectSimilar(a, 'SIBLINGS', 0);
    expect(selected(a)).toEqual(['Leg.L', 'Leg.R']);
    expect(A.bonePath(a, a.bones[3], a.bones[2]).map((b) => b.name)).toEqual(['Foot.L', 'Leg.L', 'Root', 'Leg.R']);
    expect([...A.linkedBones(a, [a.bones[1]])].map((b) => b.name).sort()).toEqual(['Foot.L', 'Leg.L']);
  });
});

describe('bone topology', () => {
  it('fills between two joints, connected to the tail owner', () => {
    const a = armature(bone('X', [1, 0, 0], [1, 0, 1]), bone('Y', [3, 0, 0], [3, 0, 1]));
    for (const b of a.bones) A.setBoneSelected(b, false);
    a.bones[0].select_tail = true;
    a.bones[1].select_head = true;
    const nb = A.fillJoints(a, [0, 0, 0])!;
    expect(nb.parent).toBe('X');
    expect(nb.use_connect).toBe(true);
    expect(nb.head).toEqual([1, 0, 1]);
    expect(nb.tail).toEqual([3, 0, 0]);
    // one joint: to the cursor
    for (const b of a.bones) A.setBoneSelected(b, false);
    a.bones[0].select_tail = true;
    const nb2 = A.fillJoints(a, [0, 0, 0])!;
    expect(nb2.head).toEqual([1, 0, 1]);
    expect(nb2.tail).toEqual([0, 0, 0]);
    expect(nb2.parent).toBe(null);
  });

  it('dissolve merges selected bones with their connected child', () => {
    let a = chain();
    sel(a, 'B');
    A.dissolveBones(a);
    expect(a.bones.map((b) => [b.name, b.tail])).toEqual([
      ['A', [0, 0, 1]],
      ['B', [0, 1, 3]],
    ]);
    a = chain();
    sel(a, 'A');
    A.dissolveBones(a);
    expect(a.bones.map((b) => b.name)).toEqual(['A', 'C']);
    expect(a.bones[1].parent).toBe('A');
    a = chain();
    sel(a, 'A', 'B', 'C');
    A.dissolveBones(a);
    expect(a.bones.map((b) => [b.name, b.tail])).toEqual([['A', [0, 1, 3]]]);
  });

  it('split cuts links across the selection border', () => {
    const a = chain();
    sel(a, 'B');
    A.splitBones(a);
    expect(a.bones.map((b) => b.parent)).toEqual([null, null, null]);
  });
});

describe('bone collections', () => {
  it('visibility, solo, rename and removal', () => {
    const a = chain();
    const c1 = A.addCollection(a, 'Bones');
    const c2 = A.addCollection(a, 'Bones');
    expect(c2.name).toBe('Bones.001');
    A.assignBone(a.bones[0], c1.name);
    A.assignBone(a.bones[1], c2.name);
    expect(a.bones.map((b) => A.boneVisible(a, b))).toEqual([true, true, true]);
    c1.is_visible = false;
    expect(a.bones.map((b) => A.boneVisible(a, b))).toEqual([false, true, true]);
    c2.is_solo = true;
    expect(a.bones.map((b) => A.boneVisible(a, b))).toEqual([false, true, false]);
    A.renameCollection(a, 1, 'Deform');
    expect(a.bones[1].collections).toEqual(['Deform']);
    A.removeCollection(a, 1);
    expect(a.bones[1].collections).toEqual([]);
    expect(a.collections!.map((c) => c.name)).toEqual(['Bones']);
  });

  it('new bones join the parent collections', () => {
    const a = chain();
    A.addCollection(a, 'Arm');
    a.bones[0].collections = ['Arm'];
    const nb = A.newBoneLike(a, 'A', [0, 0, 1], [0, 0, 2], a.bones[0], true);
    expect(nb.name).toBe('A.001');
    expect(nb.collections).toEqual(['Arm']);
  });
});
