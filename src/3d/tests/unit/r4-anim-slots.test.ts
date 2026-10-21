// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp, app } from '../../src/app/app';
import { startupDocument, newAction, newObject } from '../../src/data/defaults';
import type { DocumentData, NlaStrip, ObjectData } from '../../src/data/types';
import { keyProperty } from '../../src/anim/keyframes';
import { applyAnimData } from '../../src/anim/evaluate';
import { insertKeyframe } from '../../src/anim/fcurve';
import * as S from '../../src/anim/slots';
import { buildChannels, channelState, type ChannelFilter } from '../../src/animation/channels';
import { pushDown } from '../../src/animation/actionops';
import { replaceActionUsers } from '../../src/anim/slots';
import '../../src/animation/slotops';

let doc: DocumentData;
let cube: ObjectData;
let cam: ObjectData;

const filter = (active: ObjectData, over: Partial<ChannelFilter> = {}): ChannelFilter => ({ onlySelected: false, showHidden: true, search: '', isVisible: () => true, activeObject: active, ...over });

function keyX(ob: ObjectData, frames: [number, number][], index = 0) {
  for (const [f, v] of frames) {
    ob.location[index] = v;
    keyProperty(doc, ob, 'location', index, f);
  }
}
const actOf = (ob: ObjectData) => doc.actions[ob.animation_data!.action!];
const play = (ob: ObjectData, frame: number) => {
  applyAnimData(doc, ob, ob.animation_data!, frame);
  return [...ob.location];
};

beforeEach(() => {
  doc = startupDocument();
  setApp(new App(doc));
  cube = Object.values(doc.objects).find((o) => o.type === 'MESH')!;
  cam = Object.values(doc.objects).find((o) => o.type === 'CAMERA')!;
  channelState.expanded.clear();
});

describe('action slots: keying and assignment', () => {
  it('keying creates an action with a slot named after the object', () => {
    keyX(cube, [[1, 0]]);
    const act = actOf(cube);
    expect(act.slots!.map((s) => s.identifier)).toEqual(['OBCube']);
    expect(act.fcurves.every((f) => f.slot === act.slots![0].handle)).toBe(true);
    expect(S.objectSlot(doc, cube)?.identifier).toBe('OBCube');
  });

  it('a second object assigned the action gets no slot until it is keyed, then its own slot', () => {
    keyX(cube, [
      [1, 0],
      [11, 10],
    ]);
    const act = actOf(cube);
    cam.location = [5, 5, 5];
    cam.animation_data = { action: null, nla_tracks: [], drivers: [] };
    S.assignAction(doc, cam, cam.animation_data, act.id);
    expect(S.resolveSlot(act, cam.animation_data, cam)).toBe(null);
    expect(play(cam, 6)[0]).toBe(5); // nothing plays
    keyX(cam, [
      [1, 100],
      [11, 200],
    ]);
    expect(act.slots!.map((s) => s.identifier)).toEqual(['OBCube', 'OBCamera']);
    expect(play(cube, 6)[0]).toBeCloseTo(5, 3);
    expect(play(cam, 6)[0]).toBeCloseTo(150, 3);
    // the cube's curves are untouched by keying the camera
    expect(S.slotCurves(act, act.slots![0].handle).length).toBe(1);
    expect(S.slotCurves(act, act.slots![1].handle).length).toBe(1);
  });

  it('assigning picks the slot last used, then one named after the user, then a never-used single slot', () => {
    const a = newAction('A');
    doc.actions[a.id] = a;
    const own = S.addSlot(a, 'OBJECT', 'Camera');
    S.addSlot(a, 'OBJECT', 'Other');
    expect(S.findSlotFor(a, cam)?.handle).toBe(own.handle);
    expect(S.findSlotFor(a, cam, 'OBOther')?.identifier).toBe('OBOther');
    const b = newAction('B');
    const fresh = S.addSlot(b, 'UNSPECIFIED', 'Slot');
    expect(fresh.identifier).toBe('XXSlot');
    expect(S.findSlotFor(b, cube)).toBe(fresh);
    // assigning a never-used slot gives it the user's type
    cube.animation_data = { action: null, nla_tracks: [], drivers: [] };
    doc.actions[b.id] = b;
    S.assignAction(doc, cube, cube.animation_data, b.id);
    expect(fresh.identifier).toBe('OBSlot');
  });

  it('an unslotted action plays everything, and keying gives every user the first slot', () => {
    const a = newAction('Shared');
    const fc = { data_path: 'location', array_index: 2, keyframe_points: [], extrapolation: 'CONSTANT' as const, modifiers: [] };
    insertKeyframe(fc, 1, 0);
    insertKeyframe(fc, 11, 4);
    a.fcurves.push(fc);
    doc.actions[a.id] = a;
    cube.animation_data = { action: a.id, nla_tracks: [], drivers: [] };
    cam.animation_data = { action: a.id, nla_tracks: [], drivers: [] };
    expect(play(cam, 6)[2]).toBeCloseTo(2, 3);
    keyX(cube, [[1, 0]]);
    expect(a.slots!.length).toBe(1);
    // both users keep playing the same (now slotted) curves
    expect(S.objectSlot(doc, cam)?.handle).toBe(a.slots![0].handle);
    expect(play(cam, 6)[2]).toBeCloseTo(2, 3);
  });

  it('a stale slot handle from another action is not used: the slot is found again by identifier', () => {
    keyX(cube, [[1, 1]]);
    const first = actOf(cube);
    const other = newAction('Other');
    S.addSlot(other, 'OBJECT', 'Zed');
    const mine = S.addSlot(other, 'OBJECT', 'Cube');
    doc.actions[other.id] = other;
    // assigned directly (as importers do), without choosing a slot
    cube.animation_data!.action = other.id;
    expect(S.resolveSlot(other, cube.animation_data!, cube)).toBe(mine.handle);
    expect(first.id).not.toBe(other.id);
  });

  it('removing a slot removes its curves and leaves its users without a slot', () => {
    keyX(cube, [[1, 1]]);
    const act = actOf(cube);
    cam.animation_data = { action: act.id, nla_tracks: [], drivers: [] };
    keyX(cam, [[1, 2]]);
    S.removeSlot(doc, act, act.slots![0]);
    expect(act.slots!.map((s) => s.identifier)).toEqual(['OBCamera']);
    expect(S.objectCurves(doc, cube)).toEqual([]);
    expect(S.objectCurves(doc, cam).length).toBe(1);
  });
});

describe('action slots: NLA and constraints', () => {
  it('push down keeps the slot; the strip plays it', () => {
    keyX(cube, [
      [1, 0],
      [11, 10],
    ]);
    const act = actOf(cube);
    cam.animation_data = { action: act.id, nla_tracks: [], drivers: [] };
    keyX(cam, [
      [1, 50],
      [11, 60],
    ]);
    const strip = pushDown(doc, cam)!;
    expect(strip.action_slot_handle).toBe(act.slots![1].handle);
    expect(cam.animation_data!.action).toBe(null);
    expect(play(cam, 6)[0]).toBeCloseTo(55, 3);
  });

  it('strip F-Modifiers change every channel the strip produces', () => {
    keyX(cube, [
      [1, 0],
      [11, 10],
    ]);
    const strip = pushDown(doc, cube)!;
    strip.modifiers = [{ type: 'GENERATOR', mute: false, coefficients: [3, 0], use_additive: true } as NonNullable<NlaStrip['modifiers']>[number]];
    expect(play(cube, 6)[0]).toBeCloseTo(8, 3);
    strip.modifiers = [{ type: 'STEPPED', mute: false, frame_step: 5, frame_offset: 1 } as NonNullable<NlaStrip['modifiers']>[number]];
    expect(play(cube, 9)[0]).toBeCloseTo(5, 3);
  });

  it('the Action constraint plays its slot', async () => {
    const { actionMatrix } = await import('../../src/eval/constraints_more');
    keyX(cube, [[1, 3]]);
    const act = actOf(cube);
    cam.animation_data = { action: act.id, nla_tracks: [], drivers: [] };
    keyX(cam, [[1, 7]]);
    const c = { id: 'c', name: 'Action', type: 'ACTION', mute: false, influence: 1, show_expanded: true, action: act.id } as never;
    const m = actionMatrix(act, 1, null, 'XYZ', S.slotCurves(act, S.constraintSlot(act, c, cam)));
    expect(m.elements[12]).toBeCloseTo(7, 5);
    (c as { action_slot_handle: number }).action_slot_handle = act.slots![0].handle;
    expect(actionMatrix(act, 1, null, 'XYZ', S.slotCurves(act, S.constraintSlot(act, c, cam))).elements[12]).toBeCloseTo(3, 5);
  });
});

describe('action slots: channel lists', () => {
  it('the Action Editor shows one row per slot; the Dope Sheet shows each object its own slot', () => {
    keyX(cube, [[1, 0]]);
    const act = actOf(cube);
    cam.animation_data = { action: act.id, nla_tracks: [], drivers: [] };
    keyX(cam, [[1, 2]], 1);
    const al = buildChannels(doc, 'ACTION', filter(cube));
    expect(al.rows.filter((r) => r.kind === 'SLOT').map((r) => r.label)).toEqual(['Cube', 'Camera']);
    expect(al.curves.length).toBe(2);
    const slotRow = al.rows.find((r) => r.kind === 'SLOT' && r.label === 'Camera')!;
    expect(slotRow.ob).toBe(cam);
    const ds = buildChannels(doc, 'DOPESHEET', filter(cube));
    const camRow = ds.rows.find((r) => r.kind === 'OBJECT' && r.ob === cam)!;
    expect(camRow.curves.map((r) => r.fc.array_index)).toEqual([1]);
    const cubeRow = ds.rows.find((r) => r.kind === 'OBJECT' && r.ob === cube)!;
    expect(cubeRow.curves.map((r) => r.fc.array_index)).toEqual([0]);
  });
});

describe('action slots: operators', () => {
  const select = (...obs: ObjectData[]) => {
    for (const o of Object.values(doc.objects)) o.select = obs.includes(o);
    app.activeObject = obs[0];
  };

  it('merge, separate and move slots to a new action', () => {
    keyX(cube, [
      [1, 0],
      [11, 10],
    ]);
    keyX(cam, [
      [1, 20],
      [11, 30],
    ]);
    const camAct = actOf(cam);
    select(cube, cam);
    expect(app.run('anim.merge_animation')).toBe('FINISHED');
    const merged = actOf(cube);
    expect(actOf(cam)).toBe(merged);
    expect(merged.slots!.map((s) => s.identifier)).toEqual(['OBCube', 'OBCamera']);
    expect(camAct.fcurves.length).toBe(0);
    expect(play(cam, 6)[0]).toBeCloseTo(25, 3);
    expect(play(cube, 6)[0]).toBeCloseTo(5, 3);

    // move the camera's slot out again
    merged.slots![1].select = true;
    expect(app.run('anim.slot_channels_move_to_new_action')).toBe('FINISHED');
    expect(actOf(cam)).not.toBe(merged);
    expect(actOf(cam).name).toBe('CameraAction.001');
    expect(play(cam, 6)[0]).toBeCloseTo(25, 3);

    // separate: every slot gets an action of its own
    select(cam, cube);
    expect(app.run('anim.merge_animation')).toBe('FINISHED');
    const both = actOf(cam);
    expect(app.run('anim.separate_slots')).toBe('FINISHED');
    expect(actOf(cam)).not.toBe(both);
    expect(actOf(cube)).not.toBe(both);
    expect(actOf(cube)).not.toBe(actOf(cam));
    expect(both.slots!.length).toBe(0);
    expect(play(cube, 6)[0]).toBeCloseTo(5, 3);
    expect(play(cam, 6)[0]).toBeCloseTo(25, 3);
  });

  it('new slot / unassign slot for the active object', () => {
    keyX(cube, [[1, 4]]);
    select(cube);
    expect(app.run('anim.slot_unassign_from_id')).toBe('FINISHED');
    expect(S.objectSlot(doc, cube)).toBeUndefined();
    expect(S.objectCurves(doc, cube)).toEqual([]);
    expect(app.run('anim.slot_new_for_id')).toBe('FINISHED');
    expect(S.objectSlot(doc, cube)?.identifier).toBe('OBCube.001');
  });

  it('replace action keeps users on their slots by identifier', () => {
    keyX(cube, [[1, 4]]);
    const old = actOf(cube);
    const next = newAction('Next');
    S.addSlot(next, 'OBJECT', 'Other');
    const mine = S.addSlot(next, 'OBJECT', 'Cube');
    doc.actions[next.id] = next;
    replaceActionUsers(doc, old, next);
    expect(actOf(cube)).toBe(next);
    expect(S.objectSlot(doc, cube)).toBe(mine);
    select(cube);
    expect(app.run('anim.replace_action_new')).toBe('FINISHED');
    const fresh = actOf(cube);
    expect(fresh.fcurves.length).toBe(0);
    expect(fresh.slots!.map((s) => s.identifier)).toEqual(['OBOther', 'OBCube']);
    expect(S.objectSlot(doc, cube)?.identifier).toBe('OBCube');
  });

  it('a new object works with the defaults (no animation data)', () => {
    const ob = newObject('Empty', 'EMPTY', null);
    doc.objects[ob.id] = ob;
    expect(S.objectCurves(doc, ob)).toEqual([]);
  });
});
