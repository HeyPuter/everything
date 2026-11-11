import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp } from '../../src/app/app';
import { startupDocument, newAction } from '../../src/data/defaults';
import type { ActionData, DocumentData, FCurve, NlaStrip, ObjectData } from '../../src/data/types';
import { insertKeyframe, evaluateFCurve } from '../../src/anim/fcurve';
import { ensureAction, ensureFCurve, keyframeFrames } from '../../src/anim/keyframes';
import { applyAnimData, trackStripAt, stripActionFrame } from '../../src/anim/evaluate';
import { evaluateDriver } from '../../src/anim/drivers';
import * as K from '../../src/animation/keyedit';
import { aggregate } from '../../src/animation/aggregate';
import { buildChannels, channelState, setExpanded, type ChannelFilter, type CurveRef } from '../../src/animation/channels';
import { transformKeys, type KeyTransformHost } from '../../src/animation/transformkeys';
import { pushDown, stashAction, makeStrip, uniqueName } from '../../src/animation/actionops';
import { View2D, frameStep, valueStep } from '../../src/animation/view2d';

let doc: DocumentData;
let cube: ObjectData;

function curve(keys: [number, number][], path = 'location', index = 0): FCurve {
  const fc: FCurve = {
    data_path: path,
    array_index: index,
    keyframe_points: [],
    extrapolation: 'CONSTANT',
    modifiers: [],
  };
  for (const [f, v] of keys) insertKeyframe(fc, f, v);
  fc.keyframe_points.forEach((k) => K.setKeySelected(k, false));
  return fc;
}

function refs(...fcs: FCurve[]): CurveRef[] {
  const action = newAction('Test');
  action.fcurves = fcs;
  return fcs.map((fc) => ({ ob: cube, action, fc }));
}

const frames = (fc: FCurve) => fc.keyframe_points.map((k) => k.co[0]);
const filter = (over: Partial<ChannelFilter> = {}): ChannelFilter => ({
  onlySelected: false,
  showHidden: true,
  search: '',
  isVisible: () => true,
  activeObject: cube,
  ...over,
});

beforeEach(() => {
  doc = startupDocument();
  setApp(new App(doc));
  cube = Object.values(doc.objects).find((o) => o.type === 'MESH')!;
  channelState.expanded.clear();
  channelState.selectedGroups.clear();
});

describe('animation: key editing', () => {
  it('selects all / none / invert / toggle', () => {
    const r = refs(
      curve([
        [1, 0],
        [10, 1],
        [20, 0],
      ]),
    );
    K.selectAll(r, 'SELECT');
    expect(r[0].fc.keyframe_points.every((k) => k.select_control_point && k.select_left_handle)).toBe(true);
    r[0].fc.keyframe_points[1].select_control_point = false;
    K.selectAll(r, 'INVERT');
    expect(r[0].fc.keyframe_points.map((k) => !!k.select_control_point)).toEqual([false, true, false]);
    K.selectAll(r, 'TOGGLE');
    expect(K.anyKeySelected(r)).toBe(false);
  });

  it('keeps a summary key selected when a later key on the same rounded frame is not', () => {
    const act = ensureAction(doc, cube);
    const x = ensureFCurve(act, 'location', 0),
      y = ensureFCurve(act, 'location', 1);
    insertKeyframe(x, 10 + 1 / 3, 0);
    insertKeyframe(y, 10 + 1 / 3, 0);
    K.setKeySelected(x.keyframe_points[0], true);
    K.setKeySelected(y.keyframe_points[0], false);
    expect([...keyframeFrames(doc, [cube])]).toEqual([[10.33, true]]);
  });

  it('deletes selected keys and removes emptied curves', () => {
    const a = curve([
      [1, 0],
      [10, 1],
    ]);
    const b = curve([[5, 2]], 'location', 1);
    const r = refs(a, b);
    a.keyframe_points[0].select_control_point = true;
    b.keyframe_points[0].select_control_point = true;
    expect(K.deleteSelected(r)).toBe(2);
    expect(frames(a)).toEqual([10]);
    expect(r[0].action.fcurves).toEqual([a]);
  });

  it('skips locked curves', () => {
    const a = curve([
      [1, 0],
      [10, 1],
    ]);
    a.lock = true;
    K.selectAll(refs(a), 'SELECT');
    expect(K.deleteSelected(refs(a))).toBe(0);
  });

  it('duplicates and merges overlapping keys after a move', () => {
    const a = curve([
      [1, 0],
      [10, 5],
    ]);
    const r = refs(a);
    a.keyframe_points[0].select_control_point = true;
    K.duplicateSelected(r);
    expect(a.keyframe_points).toHaveLength(3);
    const dup = a.keyframe_points.find((k) => k.select_control_point)!;
    K.moveKey(dup, 9, 3);
    K.finalizeCurve(a);
    // the moved duplicate replaced the key at frame 10
    expect(frames(a)).toEqual([1, 10]);
    expect(a.keyframe_points[1].co[1]).toBe(3);
  });

  it('snaps keys to frames, current frame and markers', () => {
    const a = curve([
      [1.4, 0],
      [10.6, 1],
    ]);
    const r = refs(a);
    K.selectAll(r, 'SELECT');
    K.snapKeys(r, 'NEAREST_FRAME', {
      frame: 0,
      fps: 24,
      markers: [],
      cursorValue: 0,
    });
    expect(frames(a)).toEqual([1, 11]);
    a.keyframe_points[0].select_control_point = false;
    K.snapKeys(r, 'NEAREST_MARKER', {
      frame: 0,
      fps: 24,
      markers: [5, 30],
      cursorValue: 0,
    });
    expect(frames(a)).toEqual([1, 5]);
    K.snapKeys(r, 'NEAREST_SECOND', {
      frame: 0,
      fps: 24,
      markers: [],
      cursorValue: 0,
    });
    expect(frames(a)).toEqual([0, 1]);
  });

  it('flattens handles', () => {
    const a = curve([
      [1, 0],
      [10, 5],
      [20, 0],
    ]);
    const r = refs(a);
    a.keyframe_points[1].select_control_point = true;
    K.snapKeys(r, 'HORIZONTAL', {
      frame: 0,
      fps: 24,
      markers: [],
      cursorValue: 0,
    });
    const k = a.keyframe_points[1];
    expect(k.handle_left[1]).toBe(5);
    expect(k.handle_right[1]).toBe(5);
  });

  it('mirrors over the current frame and over zero value', () => {
    const a = curve([
      [10, 1],
      [14, 3],
    ]);
    const r = refs(a);
    K.selectAll(r, 'SELECT');
    K.mirrorKeys(r, 'CFRA', { frame: 20, cursorValue: 0 });
    expect(frames(a)).toEqual([26, 30]);
    expect(a.keyframe_points.map((k) => k.co[1])).toEqual([3, 1]);
    for (const k of a.keyframe_points) expect(k.handle_left[0]).toBeLessThanOrEqual(k.co[0]);
    K.mirrorKeys(r, 'XAXIS', { frame: 0, cursorValue: 0 });
    expect(a.keyframe_points.map((k) => k.co[1])).toEqual([-3, -1]);
  });

  it('sets interpolation, easing, type and handle types on selected keys', () => {
    const a = curve([
      [1, 0],
      [10, 5],
      [20, 0],
    ]);
    const r = refs(a);
    a.keyframe_points[0].select_control_point = true;
    K.setInterpolation(r, 'LINEAR');
    K.setEasing(r, 'EASE_OUT');
    K.setKeyType(r, 'BREAKDOWN');
    K.setHandleType(r, 'VECTOR');
    const k = a.keyframe_points[0];
    expect([k.interpolation, k.easing, k.type, k.handle_left_type, k.handle_right_type]).toEqual(['LINEAR', 'EASE_OUT', 'BREAKDOWN', 'VECTOR', 'VECTOR']);
    expect(a.keyframe_points[1].interpolation).toBe('BEZIER');
    expect(evaluateFCurve(a, 5.5)).toBeCloseTo(2.5);
  });

  it('dope sheet handle type ignores handle-only selection', () => {
    const a = curve([
      [1, 0],
      [10, 5],
    ]);
    a.keyframe_points[0].select_left_handle = true;
    K.setHandleType(refs(a), 'FREE', false);
    expect(a.keyframe_points[0].handle_left_type).toBe('AUTO_CLAMPED');
    K.setHandleType(refs(a), 'FREE', true);
    expect(a.keyframe_points[0].handle_left_type).toBe('FREE');
  });

  it('sets extrapolation and cyclic modifiers', () => {
    const a = curve([
      [1, 0],
      [11, 10],
    ]);
    a.select = true;
    const r = refs(a);
    K.setExtrapolation(r, 'LINEAR');
    expect(a.extrapolation).toBe('LINEAR');
    K.setExtrapolation(r, 'MAKE_CYCLIC');
    K.setExtrapolation(r, 'MAKE_CYCLIC');
    expect(a.modifiers.filter((m) => m.type === 'CYCLES')).toHaveLength(1);
    expect(evaluateFCurve(a, 16)).toBeCloseTo(evaluateFCurve(a, 6));
    K.setExtrapolation(r, 'CLEAR_CYCLIC');
    expect(a.modifiers).toHaveLength(0);
  });

  it('inserts keys keeping the curve shape', () => {
    const a = curve([
      [1, 0],
      [11, 10],
    ]);
    a.keyframe_points.forEach((k) => (k.interpolation = 'LINEAR'));
    const n = K.insertKeysAt(refs(a), 6, 'EXTREME');
    expect(n).toBe(1);
    const k = a.keyframe_points[1];
    expect(k.co).toEqual([6, 5]);
    expect(k.type).toBe('EXTREME');
    expect(k.select_control_point).toBe(true);
    expect(a.keyframe_points[0].select_control_point).toBe(false);
  });

  it('copies and pastes at the current frame matching channels', () => {
    const a = curve([
      [1, 0],
      [5, 2],
    ]);
    const b = curve([[1, 9]], 'location', 1);
    K.selectAll(refs(a), 'SELECT');
    expect(K.copyKeys(refs(a, b))).toBe(2);
    const r = refs(a, b);
    expect(K.pasteKeys(r, 20)).toBe(2);
    expect(frames(a)).toEqual([1, 5, 20, 24]);
    expect(frames(b)).toEqual([1]);
    // overwrite-all replaces existing keys
    K.pasteKeys(r, 100, 'START', 'OVER_ALL');
    expect(frames(a)).toEqual([100, 104]);
    // flipped negates values
    K.pasteKeys(r, 200, 'START', 'MIX', true);
    expect(a.keyframe_points.find((k) => k.co[0] === 204)!.co[1]).toBe(-2);
  });

  it('Frame Relative pastes keep the offset to the frame they were copied on', () => {
    const a = curve([
      [5, 0],
      [15, 2],
    ]);
    K.selectAll(refs(a), 'SELECT');
    K.copyKeys(refs(a), 10);
    const b = curve([[1, 1]], 'location', 0);
    K.pasteKeys(refs(b), 30, 'RELATIVE');
    expect(frames(b)).toEqual([1, 25, 35]);
    const c = curve([[1, 1]], 'location', 0);
    K.pasteKeys(refs(c), 30, 'NONE');
    expect(frames(c)).toEqual([1, 5, 15]);
  });

  it('pastes a single copied curve into the selected channel when paths differ', () => {
    const a = curve([
      [1, 0],
      [5, 2],
    ]);
    K.selectAll(refs(a), 'SELECT');
    K.copyKeys(refs(a));
    const other = curve([[1, 1]], 'scale', 2);
    other.select = true;
    expect(K.pasteKeys(refs(other), 10)).toBe(2);
    expect(frames(other)).toEqual([1, 10, 14]);
  });

  it('cleans redundant keys', () => {
    const a = curve([
      [1, 0],
      [5, 0],
      [10, 0],
      [15, 3],
    ]);
    K.selectAll(refs(a), 'SELECT');
    expect(K.cleanKeys(refs(a))).toBe(1);
    expect(frames(a)).toEqual([1, 10, 15]);
  });

  it('selects columns, left/right, linked, more/less', () => {
    const a = curve([
      [1, 0],
      [5, 1],
      [10, 0],
      [15, 1],
    ]);
    const b = curve(
      [
        [5, 0],
        [20, 1],
      ],
      'location',
      1,
    );
    const r = refs(a, b);
    K.selectColumns(r, [5], false);
    expect(K.selectedFrames(r)).toEqual([5]);
    expect(b.keyframe_points[0].select_control_point).toBe(true);
    K.selectLeftRight(r, 'RIGHT', 10);
    expect(K.selectedFrames(r)).toEqual([10, 15, 20]);
    K.selectAll(r, 'DESELECT');
    a.keyframe_points[1].select_control_point = true;
    K.selectMoreLess(r, true);
    expect(a.keyframe_points.map((k) => !!k.select_control_point)).toEqual([true, true, true, false]);
    K.selectMoreLess(r, false);
    // island ends (including the curve's first key) are deselected
    expect(a.keyframe_points.map((k) => !!k.select_control_point)).toEqual([false, true, false, false]);
    K.selectLinked(r);
    expect(a.keyframe_points.every((k) => k.select_control_point)).toBe(true);
    expect(b.keyframe_points.some((k) => k.select_control_point)).toBe(false);
  });

  it('finds holds between identical keys', () => {
    const a = curve([
      [1, 0],
      [5, 0],
      [10, 3],
    ]);
    expect(K.holdSegments(a)).toEqual([[1, 5]]);
  });
});

describe('animation: aggregation', () => {
  it('merges keys of several curves into columns', () => {
    const a = curve([
      [1, 0],
      [10, 0],
    ]);
    const b = curve(
      [
        [10, 0],
        [20, 1],
      ],
      'location',
      1,
    );
    b.keyframe_points[0].select_control_point = true;
    b.keyframe_points[0].type = 'BREAKDOWN';
    const agg = aggregate([a, b]);
    expect(agg.keys.map((k) => k.frame)).toEqual([1, 10, 20]);
    expect(agg.keys[1].selected).toBe(true);
    expect(agg.keys[1].type).toBe('KEYFRAME'); // mixed types → keyframe
    // a holds 1..10, b is outside its range there → summary hold; 10..20 b changes → no hold
    expect(agg.holds.map((h) => [h.a, h.b])).toEqual([[1, 10]]);
  });

  it('reports non-Bézier interpolation spans', () => {
    const a = curve([
      [1, 0],
      [10, 5],
    ]);
    a.keyframe_points[0].interpolation = 'CONSTANT';
    expect(aggregate([a]).interps).toEqual([{ a: 1, b: 10, selected: false, interp: 'CONSTANT' }]);
  });
});

describe('animation: channels', () => {
  function keyCube() {
    const act = ensureAction(doc, cube);
    insertKeyframe(ensureFCurve(act, 'location', 0), 1, 0);
    insertKeyframe(ensureFCurve(act, 'location', 1), 1, 0);
    insertKeyframe(ensureFCurve(act, 'hide_viewport', 0), 1, 0);
    return act;
  }

  it('builds Summary ▸ Object ▸ Action ▸ Group ▸ F-Curve rows', () => {
    const act = keyCube();
    expect(act.name).toBe('CubeAction');
    let list = buildChannels(doc, 'DOPESHEET', filter());
    expect(list.rows.map((r) => r.kind)).toEqual(['SUMMARY', 'OBJECT', 'ACTION']);
    expect(list.curves).toHaveLength(3);
    setExpanded(`act:${cube.id}:${act.id}`, true);
    list = buildChannels(doc, 'DOPESHEET', filter());
    expect(list.rows.map((r) => r.label)).toEqual(['Summary', 'Cube', 'CubeAction', 'Object Transforms', 'X Location', 'Y Location', 'Hide Viewport']);
    expect(list.rows[0].curves).toHaveLength(3);
    expect(list.rows[3].curves).toHaveLength(2);
  });

  it('filters by selection and search', () => {
    keyCube();
    cube.select = false;
    expect(buildChannels(doc, 'DOPESHEET', filter({ onlySelected: true })).curves).toHaveLength(0);
    cube.select = true;
    const l = buildChannels(doc, 'GRAPH', filter({ search: 'x loc' }));
    expect(l.curves.map((r) => r.fc.data_path + r.fc.array_index)).toEqual(['location0']);
    expect(l.rows.map((r) => r.kind)).toEqual(['OBJECT', 'ACTION', 'GROUP', 'FCURVE']);
  });

  it('lists the active action in the Action Editor and NLA rows top-down', () => {
    const act = keyCube();
    const l = buildChannels(doc, 'ACTION', filter());
    expect(l.rows[0].kind).toBe('SUMMARY');
    expect(l.curves).toHaveLength(3);
    pushDown(doc, cube);
    cube.animation_data!.nla_tracks.push({
      name: 'Top',
      strips: [],
      mute: false,
      is_solo: false,
    });
    cube.animation_data!.action = act.id;
    const n = buildChannels(doc, 'NLA', filter());
    expect(n.rows.map((r) => `${r.kind}:${r.label}`)).toEqual(['OBJECT:Cube', 'NLA_ACTION:CubeAction', 'NLA_TRACK:Top', 'NLA_TRACK:NlaTrack']);
  });

  it('lists drivers', () => {
    cube.animation_data = {
      action: null,
      nla_tracks: [],
      drivers: [
        {
          data_path: 'location',
          array_index: 2,
          type: 'SCRIPTED',
          expression: 'frame',
          variables: [],
        },
      ],
    };
    const l = buildChannels(doc, 'DRIVERS', filter());
    expect(l.rows.map((r) => r.label)).toEqual(['Cube', 'Drivers', 'Z Location']);
  });
});

describe('animation: transforms', () => {
  const host = (graph: boolean): KeyTransformHost => ({
    transformCurves: () => current,
    graph,
    ppf: () => 10,
    ppv: () => 10,
    toDisp: (_fc, v) => v,
    fromDisp: (_fc, d) => d,
    screen: (x, d) => ({ x: x * 10, y: -d * 10 }),
    autoSnap: true,
    handlesVisible: () => true,
  });
  let current: CurveRef[] = [];

  it('moves keys in time and merges overlaps', () => {
    const a = curve([
      [1, 0],
      [10, 1],
      [20, 2],
    ]);
    current = refs(a);
    a.keyframe_points[0].select_control_point = true;
    expect(
      transformKeys(host(false), {
        mode: 'TIME_TRANSLATE',
        value: [9, 0],
        constraint: 'NONE',
      }),
    ).toBe(1);
    expect(frames(a)).toEqual([10, 20]);
    expect(a.keyframe_points[0].co[1]).toBe(0);
  });

  it('scales key times around the current frame', () => {
    doc.scene.frame_current = 10;
    const a = curve([
      [0, 0],
      [20, 1],
    ]);
    current = refs(a);
    K.selectAll(current, 'SELECT');
    transformKeys(host(false), {
      mode: 'TIME_SCALE',
      value: [0.5, 1],
      constraint: 'NONE',
    });
    expect(frames(a)).toEqual([5, 15]);
  });

  it('extends only keys on one side of the current frame', () => {
    doc.scene.frame_current = 10;
    const a = curve([
      [0, 0],
      [20, 1],
    ]);
    current = refs(a);
    K.selectAll(current, 'SELECT');
    transformKeys(host(false), {
      mode: 'TIME_EXTEND',
      value: [5, 0],
      constraint: 'NONE',
      side: 'RIGHT',
    });
    expect(frames(a)).toEqual([0, 25]);
  });

  it('moves graph keys with an axis constraint', () => {
    const a = curve([
      [1, 0],
      [10, 1],
    ]);
    current = refs(a);
    a.keyframe_points[1].select_control_point = true;
    transformKeys(host(true), {
      mode: 'TRANSLATION',
      value: [3, 2],
      constraint: 'Y',
    });
    expect(a.keyframe_points[1].co).toEqual([10, 3]);
  });

  it('editing an auto handle converts it to aligned', () => {
    const a = curve([
      [1, 0],
      [10, 1],
      [20, 0],
    ]);
    current = refs(a);
    const k = a.keyframe_points[1];
    k.select_right_handle = true;
    const before = [...k.handle_right];
    transformKeys(host(true), {
      mode: 'TRANSLATION',
      value: [0, 1],
      constraint: 'NONE',
    });
    expect(k.handle_right_type).toBe('ALIGNED');
    expect(k.handle_left_type).toBe('ALIGNED');
    expect(k.handle_right[1]).toBeCloseTo(before[1] + 1);
    // left handle stays collinear
    const sl = (k.co[1] - k.handle_left[1]) / (k.co[0] - k.handle_left[0]);
    const sr = (k.handle_right[1] - k.co[1]) / (k.handle_right[0] - k.co[0]);
    expect(sl).toBeCloseTo(sr);
  });

  it('rotates keys around the bounding box center', () => {
    const a = curve([
      [0, 0],
      [10, 0],
    ]);
    current = refs(a);
    K.selectAll(current, 'SELECT');
    transformKeys(host(true), {
      mode: 'ROTATION',
      value: [Math.PI / 4, 0],
      constraint: 'NONE',
    });
    const [k0, k1] = a.keyframe_points;
    expect(k0.co[0]).toBeCloseTo(5 - 5 * Math.SQRT1_2);
    expect(k1.co[0]).toBeCloseTo(5 + 5 * Math.SQRT1_2);
    expect(k1.co[1] - k0.co[1]).toBeCloseTo(10 * Math.SQRT1_2);
  });
});

describe('animation: NLA', () => {
  function act(name: string, keys: [number, number][]): ActionData {
    const a = newAction(name);
    a.fcurves = [curve(keys)];
    a.fcurves[0].keyframe_points.forEach((k) => (k.interpolation = 'LINEAR'));
    doc.actions[a.id] = a;
    return a;
  }

  it('pushes the active action down into a new track', () => {
    const a = act('Walk', [
      [1, 0],
      [21, 10],
    ]);
    cube.animation_data = { action: a.id, nla_tracks: [], drivers: [] };
    const s = pushDown(doc, cube)!;
    expect(cube.animation_data.action).toBeNull();
    expect(cube.animation_data.nla_tracks).toHaveLength(1);
    expect([s.frame_start, s.frame_end, s.extrapolation]).toEqual([1, 21, 'HOLD']);
    // evaluation through the strip equals the action
    applyAnimData(doc, cube, cube.animation_data, 11);
    expect(cube.location[0]).toBeCloseTo(5);
  });

  it('stashes the action into a muted track', () => {
    const a = act('Idle', [
      [1, 0],
      [5, 1],
    ]);
    cube.animation_data = { action: a.id, nla_tracks: [], drivers: [] };
    expect(stashAction(doc, cube)).toBe(true);
    const t = cube.animation_data.nla_tracks[0];
    expect([t.name, t.mute, a.use_fake_user]).toEqual(['[Action Stash]', true, true]);
  });

  it('only the previous strip holds forward; later strips do not override earlier ones', () => {
    const a = act('A', [
      [1, 1],
      [11, 1],
    ]);
    const b = act('B', [
      [1, 2],
      [11, 2],
    ]);
    const s1: NlaStrip = { ...makeStrip(a, 1, 'HOLD'), select: false };
    const s2: NlaStrip = { ...makeStrip(b, 30, 'HOLD'), select: false };
    const track = { name: 'T', strips: [s1, s2], mute: false, is_solo: false };
    expect(trackStripAt(track, 5)!.strip).toBe(s1);
    expect(trackStripAt(track, 20)).toEqual({ strip: s1, frame: s1.frame_end });
    expect(trackStripAt(track, 35)!.strip).toBe(s2);
    expect(trackStripAt(track, -5)).toEqual({ strip: s1, frame: 1 });
    s1.extrapolation = 'NOTHING';
    expect(trackStripAt(track, 20)).toBeNull();
    expect(trackStripAt(track, -5)).toBeNull();
  });

  it('maps strip time with scale and repeat', () => {
    const s: NlaStrip = {
      name: 's',
      action: 'x',
      frame_start: 10,
      frame_end: 50,
      action_frame_start: 1,
      action_frame_end: 21,
      scale: 1,
      repeat: 2,
      blend_type: 'REPLACE',
      blend_in: 0,
      blend_out: 0,
      mute: false,
      extrapolation: 'HOLD',
    };
    expect(stripActionFrame(s, 10)).toBe(1);
    expect(stripActionFrame(s, 20)).toBe(11);
    expect(stripActionFrame(s, 30)).toBe(1);
    expect(stripActionFrame(s, 50)).toBe(21);
    expect(stripActionFrame(s, 80)).toBe(21);
  });

  it('additive strips blend from the rest value without drifting', () => {
    const a = act('Base', [
      [1, 2],
      [11, 2],
    ]);
    const add = act('Add', [
      [1, 1],
      [11, 1],
    ]);
    cube.animation_data = {
      action: null,
      drivers: [],
      nla_tracks: [
        {
          name: 'T1',
          strips: [makeStrip(a, 1, 'HOLD')],
          mute: false,
          is_solo: false,
        },
        {
          name: 'T2',
          strips: [{ ...makeStrip(add, 1, 'HOLD'), blend_type: 'ADD' }],
          mute: false,
          is_solo: false,
        },
      ],
    };
    applyAnimData(doc, cube, cube.animation_data, 5);
    applyAnimData(doc, cube, cube.animation_data, 5);
    expect(cube.location[0]).toBeCloseTo(3);
    // without the base track the additive strip adds onto the rest value (0)
    cube.animation_data.nla_tracks[0].mute = true;
    applyAnimData(doc, cube, cube.animation_data, 5);
    applyAnimData(doc, cube, cube.animation_data, 5);
    expect(cube.location[0]).toBeCloseTo(1);
  });

  it('solo disables the other tracks and the active action', () => {
    const a = act('A', [
      [1, 5],
      [11, 5],
    ]);
    const b = act('B', [
      [1, 7],
      [11, 7],
    ]);
    cube.animation_data = {
      action: b.id,
      drivers: [],
      nla_tracks: [
        {
          name: 'T',
          strips: [makeStrip(a, 1, 'HOLD')],
          mute: false,
          is_solo: false,
        },
      ],
    };
    applyAnimData(doc, cube, cube.animation_data, 5);
    expect(cube.location[0]).toBe(7);
    cube.animation_data.nla_tracks[0].is_solo = true;
    applyAnimData(doc, cube, cube.animation_data, 5);
    expect(cube.location[0]).toBe(5);
  });

  it('names new data-blocks uniquely', () => {
    expect(uniqueName('CubeAction', ['CubeAction', 'CubeAction.001'])).toBe('CubeAction.002');
    ensureAction(doc, cube);
    cube.animation_data!.action = null;
    expect(ensureAction(doc, cube).name).toBe('CubeAction.001');
  });
});

describe('animation: drivers & view', () => {
  it('evaluates rotational difference', () => {
    const cam = Object.values(doc.objects).find((o) => o.type === 'CAMERA')!;
    cube.rotation_euler = [0, 0, 0];
    cam.rotation_euler = [0, 0, Math.PI / 2];
    const v = evaluateDriver(
      doc,
      cube,
      {
        data_path: 'location',
        array_index: 0,
        type: 'SUM',
        expression: '',
        variables: [
          {
            name: 'r',
            type: 'ROTATION_DIFF',
            targets: [
              { id: cube.id, data_path: '' },
              { id: cam.id, data_path: '' },
            ],
          },
        ],
      },
      1,
    );
    expect(v).toBeCloseTo(Math.PI / 2);
  });

  it('maps frames/values and zooms around an anchor', () => {
    const v = new View2D();
    v.width = 400;
    v.height = 200;
    v.fitX(0, 100, 0);
    expect(v.fx(0)).toBeCloseTo(0);
    expect(v.fx(100)).toBeCloseTo(400);
    const f = v.xf(123);
    v.zoomX(2, 123);
    expect(v.xf(123)).toBeCloseTo(f);
    v.fitY(-1, 1, 0);
    expect(v.vy(-1)).toBeCloseTo(200);
    expect(v.yv(0)).toBeCloseTo(1);
    expect(frameStep(4, 24)).toBe(24);
    expect(valueStep(100)).toBeCloseTo(0.5);
  });
});
