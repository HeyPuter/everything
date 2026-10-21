// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';

(globalThis as unknown as { requestAnimationFrame: (f: () => void) => number }).requestAnimationFrame = (f) => setTimeout(f, 0) as unknown as number;

import { App, setApp, app } from '../../src/app/app';
import { startupDocument } from '../../src/data/defaults';
import '../../src/ops/object';
import '../../src/ops/modes';
import '../../src/modes/index';
import { flipPoseAction } from '../../src/modes/armature/poselibops';
import { poseToAction, applyPoseAsset } from '../../src/assets/poselib';
import type { ArmatureData, ObjectData } from '../../src/data/types';
import { defaultPoseBone } from '../../src/eval/armature';

let ob: ObjectData;
let arm: ArmatureData;

beforeEach(() => {
  setApp(new App(startupDocument()));
  app.run('object.armature_add');
  ob = app.activeObject!;
  arm = app.doc.armatures[ob.data!];
  app.run('object.mode_set', { mode: 'EDIT' });
});

const names = () => arm.bones.map((b) => b.name);

describe('armature edit operators', () => {
  it('extrude makes a connected zero-length child at the selected tail', () => {
    const b = arm.bones[0];
    b.select = b.select_head = false;
    b.select_tail = true;
    expect(app.run('armature.extrude', { forked: false })).toBe('FINISHED');
    expect(names()).toEqual(['Bone', 'Bone.001']);
    const c = arm.bones[1];
    expect(c.parent).toBe('Bone');
    expect(c.use_connect).toBe(true);
    expect(c.head).toEqual(b.tail);
    expect(c.select_tail).toBe(true);
    // forked: a .L / .R pair
    expect(app.run('armature.extrude', { forked: true })).toBe('FINISHED');
    expect(names()).toEqual(['Bone', 'Bone.001', 'Bone.L', 'Bone.R']);
  });

  it('duplicate and rename replaces text in the copies’ names and keeps their hierarchy', () => {
    arm.bones[0].name = 'Arm.L';
    arm.active_bone = 'Arm.L';
    const b = arm.bones[0];
    b.select = b.select_head = b.select_tail = true;
    app.run('armature.extrude', { forked: false });
    arm.bones[1].name = 'Hand.L';
    arm.bones[1].parent = 'Arm.L';
    for (const x of arm.bones) x.select = x.select_head = x.select_tail = true;
    expect(app.run('armature.duplicate_rename', { search: '', replace: '', do_flip_names: true })).toBe('FINISHED');
    expect(names()).toEqual(['Arm.L', 'Hand.L', 'Arm.R', 'Hand.R']);
    expect(arm.bones[3].parent).toBe('Arm.R');
    expect(app.run('armature.duplicate_rename', { search: 'Arm', replace: 'Leg', do_flip_names: false })).toBe('FINISHED');
    expect(names().slice(4)).toEqual(['Leg.R', 'Hand.R.001']);
  });

  it('removes a named bone from a named collection', () => {
    arm.collections = [{ name: 'Bones', is_visible: true }];
    arm.bones[0].collections = ['Bones'];
    expect(app.run('armature.collection_unassign_named', { name: 'Bones', bone_name: 'Bone' })).toBe('FINISHED');
    expect(arm.bones[0].collections).toEqual([]);
    expect(app.run('armature.collection_unassign_named', { name: 'Bones', bone_name: 'Bone' })).toBe('CANCELLED');
  });
});

describe('pose library', () => {
  it('a flipped pose swaps sides and mirrors sideways motion', () => {
    app.run('object.mode_set', { mode: 'POSE' });
    ob.pose = { 'Arm.L': { ...defaultPoseBone(), location: [1, 2, 3], rotation_quaternion: [1, 0.1, 0.2, 0.3] }, 'Arm.R': defaultPoseBone() };
    const act = poseToAction(ob, 'P')!;
    const flipped = flipPoseAction(act);
    ob.pose['Arm.L'] = defaultPoseBone();
    applyPoseAsset(app.doc, ob, flipped, 1);
    expect(ob.pose['Arm.R'].location).toEqual([-1, 2, 3]);
    expect(ob.pose['Arm.R'].rotation_quaternion).toEqual([1, 0.1, -0.2, -0.3]);
    expect(ob.pose['Arm.L'].location).toEqual([0, 0, 0]);
  });

  it('copy as asset and paste as a new asset', () => {
    app.run('object.mode_set', { mode: 'POSE' });
    ob.pose!['Bone'].location = [0, 0, 1];
    expect(app.run('poselib.copy_as_asset')).toBe('FINISHED');
    expect(app.run('poselib.paste_asset')).toBe('FINISHED');
    const a = Object.values(app.doc.actions).find((x) => (x as { asset_data?: unknown }).asset_data)!;
    expect(a.name).toBe('ArmaturePose');
    expect(a.fcurves.some((f) => f.data_path === 'pose.bones["Bone"].location' && f.array_index === 2 && f.keyframe_points[0].co[1] === 1)).toBe(true);
    // edit it as the armature's action, then go back
    expect(app.run('poselib.edit_pose_asset', { asset: a.id })).toBe('FINISHED');
    expect(ob.animation_data!.action).toBe(a.id);
    expect(app.run('poselib.restore_previous_action')).toBe('FINISHED');
    expect(ob.animation_data!.action).toBe(null);
  });
});

describe('bone colours', () => {
  it('copy colours to selected bones; scripts set palettes', async () => {
    const { runJavaScript } = await import('../../src/scripting/runner');
    const { effectiveColorSet, BONE_COLOR_SETS } = await import('../../src/modes/armature/bonecolors');
    const b = arm.bones[0];
    b.select = b.select_head = false;
    b.select_tail = true;
    app.run('armature.extrude', { forked: false });
    arm.active_bone = 'Bone';
    arm.bones[0].color = { palette: 'THEME04' };
    arm.bones[1].select = true;
    expect(app.run('armature.copy_bone_color_to_selected', { bone_type: 'EDIT' })).toBe('FINISHED');
    expect(arm.bones[1].color!.palette).toBe('THEME04');
    expect(effectiveColorSet(arm.bones[1], undefined, false)).toBe(BONE_COLOR_SETS[3]);
    app.run('object.mode_set', { mode: 'POSE' });
    const r = runJavaScript(`D.objects['${ob.name}'].pose.bones['Bone.001'].color.palette = 'THEME09';`);
    expect(r.ok).toBe(true);
    // the pose bone colour wins over the bone's while posed
    expect(effectiveColorSet(arm.bones[1], ob.pose!['Bone.001'], true)).toBe(BONE_COLOR_SETS[8]);
  });
});
