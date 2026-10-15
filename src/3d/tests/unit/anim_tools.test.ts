import { describe, it, expect, beforeEach } from 'vitest';
import { App, setApp } from '../../src/app/app';
import { startupDocument, newAction } from '../../src/data/defaults';
import type { DocumentData, FCurve, ObjectData } from '../../src/data/types';
import { insertKeyframe, evaluateFCurve } from '../../src/anim/fcurve';
import * as K from '../../src/animation/keyedit';
import * as T from '../../src/animation/fcurvetools';
import { moveSelected, moveActionChannels, bakeCurve } from '../../src/animation/channeledit';
import { cameraForFrame } from '../../src/anim/evaluate';
import { groupKey, type CurveRef } from '../../src/animation/channels';
import { transformKeys, type KeyTransformHost } from '../../src/animation/transformkeys';

let doc: DocumentData;
let cube: ObjectData;

function curve(vals: number[], frames?: number[], path = 'location', index = 0): FCurve {
  const fc: FCurve = { data_path: path, array_index: index, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [] };
  vals.forEach((v, i) => insertKeyframe(fc, frames ? frames[i] : 1 + i * 5, v));
  fc.keyframe_points.forEach((k) => K.setKeySelected(k, false));
  return fc;
}
function select(fc: FCurve, idx: number[]) {
  fc.keyframe_points.forEach((k, i) => K.setKeySelected(k, idx.includes(i)));
}
function refs(...fcs: FCurve[]): CurveRef[] {
  const action = newAction('Test');
  action.fcurves = fcs;
  return fcs.map((fc) => ({ ob: cube, action, fc }));
}
const values = (fc: FCurve) => fc.keyframe_points.map((k) => +k.co[1].toFixed(4));

const VALS = [0, 1, 3, 2, 5, 4, 6, 2, 0];
function sample() {
  const fc = curve(VALS);
  select(fc, [2, 3, 4, 5, 6]);
  return fc;
}

beforeEach(() => {
  doc = startupDocument();
  setApp(new App(doc));
  cube = Object.values(doc.objects).find((o) => o.type === 'MESH')!;
});

describe('fcurve tools: segments', () => {
  it('finds runs of selected keys and their neighbours', () => {
    const fc = curve([0, 1, 2, 3, 4, 5]);
    select(fc, [1, 2, 4]);
    const segs = T.curveSegments(fc);
    expect(segs.map((s) => [s.start, s.end])).toEqual([
      [1, 2],
      [4, 4],
    ]);
    const n = T.neighbours(segs[0]);
    expect(n.left.co[1]).toBe(0);
    expect(n.right.co[1]).toBe(3);
  });
});

describe('fcurve tools: blend sliders', () => {
  it('breakdown moves keys between the neighbours', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'BREAKDOWN', 0.25);
    expect(values(fc)).toEqual([0, 1, 1.625, 1.625, 1.625, 1.625, 1.625, 2, 0]);
    const fc2 = sample();
    T.applyBlend(refs(fc2), 'BREAKDOWN', -1);
    expect(values(fc2).slice(2, 7)).toEqual([1, 1, 1, 1, 1]);
  });

  it('blends to the right or left neighbour', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'BLEND_TO_NEIGHBOR', 0.5);
    expect(values(fc)).toEqual([0, 1, 2.5, 2, 3.5, 3, 4, 2, 0]);
    const fc2 = sample();
    T.applyBlend(refs(fc2), 'BLEND_TO_NEIGHBOR', -0.5);
    expect(values(fc2)).toEqual([0, 1, 2, 1.5, 3, 2.5, 3.5, 2, 0]);
  });

  it('blends to the default value', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'BLEND_TO_DEFAULT', 0.5);
    expect(values(fc)).toEqual([0, 1, 1.5, 1, 2.5, 2, 3, 2, 0]);
    const sc = curve([1, 3, 5, 1], undefined, 'scale');
    select(sc, [1, 2]);
    T.applyBlend(refs(sc), 'BLEND_TO_DEFAULT', 1);
    expect(values(sc)).toEqual([1, 1, 1, 1]);
  });

  it('push/pull scales away from the line between neighbours', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'PUSH_PULL', 1.5);
    expect(values(fc)).toEqual([0, 1, 3.9167, 2.3333, 6.75, 5.1667, 8.0833, 2, 0]);
  });

  it('blend offset shifts the run onto a neighbour', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'BLEND_OFFSET', 0.5);
    expect(values(fc)).toEqual([0, 1, 1, 0, 3, 2, 4, 2, 0]);
    const fc2 = sample();
    T.applyBlend(refs(fc2), 'BLEND_OFFSET', -0.5);
    expect(values(fc2)).toEqual([0, 1, 2, 1, 4, 3, 5, 2, 0]);
  });

  it('match slope continues the slope beyond the run', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'MATCH_SLOPE', 0.5);
    expect(values(fc)).toEqual([0, 1, 7.5, 6, 6.5, 5, 5, 2, 0]);
    const fc2 = sample();
    T.applyBlend(refs(fc2), 'MATCH_SLOPE', -0.5);
    expect(values(fc2)).toEqual([0, 1, 2.5, 2.5, 4.5, 4.5, 6, 2, 0]);
    // not enough keys on the right
    const fc3 = curve([0, 1, 2]);
    select(fc3, [1]);
    expect(T.applyBlend(refs(fc3), 'MATCH_SLOPE', 0.5).length).toBe(1);
  });

  it('shear tilts the run around a neighbour', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'SHEAR', 0.5);
    expect(values(fc)).toEqual([0, 1, 3.0833, 2.1667, 5.25, 4.3333, 6.4167, 2, 0]);
    const fc2 = sample();
    T.applyBlend(refs(fc2), 'SHEAR', 0.5, { direction: 'FROM_RIGHT' });
    expect(values(fc2)).toEqual([0, 1, 3.4167, 2.3333, 5.25, 4.1667, 6.0833, 2, 0]);
  });

  it('scales around the average and from a neighbour', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'SCALE_AVERAGE', 1.5);
    expect(values(fc)).toEqual([0, 1, 2.5, 1, 5.5, 4, 7, 2, 0]);
    const fc2 = sample();
    T.applyBlend(refs(fc2), 'SCALE_FROM_NEIGHBOR', 0.5, { anchor: 'RIGHT' });
    expect(values(fc2)).toEqual([0, 1, 2.5, 2, 3.5, 3, 4, 2, 0]);
    const fc3 = sample();
    T.applyBlend(refs(fc3), 'SCALE_FROM_NEIGHBOR', 1);
    expect(values(fc3)).toEqual(VALS);
  });

  it('ease follows an S-curve between the neighbours', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'EASE', 0);
    const v = values(fc).slice(2, 7);
    // monotonic, symmetric around the midpoint, within the neighbour range
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThan(v[i - 1]);
    expect(v[2]).toBeCloseTo(1.5, 6);
    expect(v[0] - 1).toBeCloseTo(2 - v[4], 6);
    expect(T.easeCurve(0, 0.5, 2)).toBe(0);
    expect(T.easeCurve(1, -0.5, 2)).toBe(1);
    // a positive shift moves the steep part earlier
    expect(T.easeCurve(0.5, 0.5, 2)).toBeGreaterThan(0.5);
  });

  it('blend to ease blends towards a one-sided ease', () => {
    const fc = sample();
    T.applyBlend(refs(fc), 'BLEND_TO_EASE', 1);
    const v = values(fc).slice(2, 7);
    for (let i = 1; i < v.length; i++) expect(v[i]).toBeGreaterThan(v[i - 1]);
    expect(v[0]).toBeGreaterThan(1.25); // ease-out rises fast
  });

  it('time offset re-samples the curve shifted in time', () => {
    const fc = sample();
    const orig = { ...fc, keyframe_points: fc.keyframe_points.map(K.cloneKey) };
    T.applyBlend(refs(fc), 'TIME_OFFSET', 2);
    expect(fc.keyframe_points[2].co[1]).toBeCloseTo(evaluateFCurve(orig, 13), 6);
    expect(fc.keyframe_points[2].co[0]).toBe(11);
  });
});

describe('fcurve tools: smoothing and density', () => {
  it('smooths interior keys of a run with a 5-tap average', () => {
    const fc = curve([0, 0, 0, 10, 0, 0, 0]);
    select(fc, [0, 1, 2, 3, 4, 5, 6]);
    T.smoothKeys(refs(fc));
    const v = values(fc);
    expect(v[0]).toBe(0);
    expect(v[6]).toBe(0);
    expect(v[3]).toBeCloseTo(10 / 6, 3);
    expect(v[2]).toBeCloseTo(2.5, 3);
    expect(v[1]).toBeCloseTo(10 / 6, 3);
  });

  it('builds a normalized Gaussian kernel', () => {
    const k = T.gaussianKernel(0.33, 6);
    expect(k.length).toBe(13);
    expect(k.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    expect(k[6]).toBeCloseTo(0.20167, 4);
    expect(k[7]).toBeCloseTo(0.17752, 4);
  });

  it('gaussian smooth spreads a spike over neighbouring frames', () => {
    const vals = new Array(21).fill(0);
    vals[10] = 10;
    const fc = curve(
      vals,
      vals.map((_, i) => i + 1),
    );
    select(
      fc,
      vals.map((_, i) => i),
    );
    T.gaussianSmooth(refs(fc), 1, 0.33, 6);
    const v = values(fc);
    expect(v[10]).toBeCloseTo(2.0167, 3);
    expect(v[9]).toBeCloseTo(1.7752, 3);
    expect(v[3]).toBe(0);
  });

  it('butterworth smoothing removes jitter but keeps the ends', () => {
    const vals = Array.from({ length: 41 }, (_, i) => Math.sin(i / 6) + (i % 2 ? 0.3 : -0.3));
    const fc = curve(
      vals,
      vals.map((_, i) => i + 1),
    );
    select(
      fc,
      vals.map((_, i) => i),
    );
    const roughBefore = vals.slice(1).reduce((a, v, i) => a + Math.abs(v - vals[i]), 0);
    T.butterworthSmooth(refs(fc), { cutoff: 3, order: 4, fps: 24 });
    const out = values(fc);
    const roughAfter = out.slice(1).reduce((a, v, i) => a + Math.abs(v - out[i]), 0);
    expect(roughAfter).toBeLessThan(roughBefore / 3);
    expect(out[0]).toBeCloseTo(vals[0], 4);
    expect(out[40]).toBeCloseTo(vals[40], 4);
  });

  it('decimates by ratio and by error margin', () => {
    const vals = Array.from({ length: 21 }, (_, i) => Math.sin(i * 0.4) * 3);
    const mk = () => {
      const fc = curve(
        vals,
        vals.map((_, i) => i + 1),
      );
      select(
        fc,
        vals.map((_, i) => i),
      );
      return fc;
    };
    const a = mk();
    expect(T.decimateKeys(refs(a), 'RATIO', 0.5)).toBe(10);
    expect(a.keyframe_points.length).toBe(11);
    expect(a.keyframe_points[0].co[0]).toBe(1);
    expect(a.keyframe_points[10].co[0]).toBe(21);
    const b = mk();
    T.decimateKeys(refs(b), 'ERROR', 0, 0.1);
    expect(b.keyframe_points.length).toBeLessThan(21);
    for (let f = 1; f <= 21; f += 0.5) expect(Math.abs(evaluateFCurve(b, f) - Math.sin((f - 1) * 0.4) * 3)).toBeLessThan(0.35);
  });

  it('bakes a key on every frame of the selected range', () => {
    const fc = curve(VALS);
    select(fc, [2, 3, 4]);
    const orig = { ...fc, keyframe_points: fc.keyframe_points.map(K.cloneKey) };
    const n = T.bakeKeys(refs(fc));
    expect(n).toBe(8);
    const frames = fc.keyframe_points.map((k) => k.co[0]);
    for (let f = 11; f <= 21; f++) expect(frames).toContain(f);
    expect(fc.keyframe_points.find((k) => k.co[0] === 13)!.co[1]).toBeCloseTo(evaluateFCurve(orig, 13), 6);
    expect(fc.keyframe_points.filter((k) => k.select_control_point).length).toBe(11);
  });
});

describe('fcurve tools: euler filter, handles, selection', () => {
  it('removes full-turn jumps from Euler curves', () => {
    const fc = curve([0, 3, -3, 0.2], undefined, 'rotation_euler', 2);
    fc.select = true;
    expect(T.eulerFilter(refs(fc))).toBe(1);
    const v = values(fc);
    expect(v[2]).toBeCloseTo(-3 + 2 * Math.PI, 3);
    expect(v[3]).toBeCloseTo(0.2, 3); // the jump back is unwrapped too
    const loc = curve([0, 3, -3], undefined, 'location');
    expect(T.eulerFilter(refs(loc))).toBe(0);
  });

  it('equalizes handle lengths', () => {
    const fc = curve([0, 2, 4]);
    select(fc, [1]);
    T.equalizeHandles(refs(fc), 'LEFT', 5);
    const k = fc.keyframe_points[1];
    expect(Math.hypot(k.handle_left[0] - k.co[0], k.handle_left[1] - k.co[1])).toBeCloseTo(5, 6);
    expect(k.handle_left_type).toBe('ALIGNED');
    T.equalizeHandles(refs(fc), 'BOTH', 2, true);
    expect(k.handle_left).toEqual([k.co[0] - 2, k.co[1]]);
    expect(k.handle_right).toEqual([k.co[0] + 2, k.co[1]]);
  });

  it('selects handles or key points', () => {
    const fc = curve([0, 2, 4]);
    select(fc, [1]);
    T.selectKeyHandles(refs(fc), 'SELECT', 'SELECT', 'DESELECT');
    const k = fc.keyframe_points[1];
    expect([k.select_control_point, k.select_left_handle, k.select_right_handle]).toEqual([false, true, true]);
    T.selectKeyHandles(refs(fc), 'DESELECT', 'DESELECT', 'SELECT');
    expect([k.select_control_point, k.select_left_handle, k.select_right_handle]).toEqual([true, false, false]);
  });
});

describe('channel tools', () => {
  it('moves selected list items', () => {
    const l = ['a', 'B', 'c', 'D'];
    const sel = (s: string) => s === s.toUpperCase();
    moveSelected(l, sel, 'UP');
    expect(l).toEqual(['B', 'a', 'D', 'c']);
    moveSelected(l, sel, 'BOTTOM');
    expect(l).toEqual(['a', 'c', 'B', 'D']);
    moveSelected(l, sel, 'TOP');
    expect(l).toEqual(['B', 'D', 'a', 'c']);
    moveSelected(l, sel, 'DOWN');
    expect(l).toEqual(['a', 'B', 'D', 'c']);
  });

  it('reorders channels within groups and groups within the action', () => {
    const act = newAction('A');
    const mk = (path: string, i: number, group?: string): FCurve => ({ data_path: path, array_index: i, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [], group });
    act.fcurves = [mk('location', 0, 'G1'), mk('location', 1, 'G1'), mk('scale', 0, 'G2'), mk('scale', 1, 'G2')];
    act.fcurves[1].select = true;
    moveActionChannels(act, 'UP', new Set());
    expect(act.fcurves.map((f) => f.array_index + f.data_path)).toEqual(['1location', '0location', '0scale', '1scale']);
    act.fcurves.forEach((f) => (f.select = false));
    moveActionChannels(act, 'TOP', new Set([groupKey(act, 'G2')]));
    expect(act.fcurves.map((f) => f.group)).toEqual(['G2', 'G2', 'G1', 'G1']);
  });

  it('bakes a channel to samples, optionally baking modifiers', () => {
    const fc = curve([0, 10], [1, 11]);
    fc.modifiers.push({ type: 'LIMITS', use_max_y: true, max_y: 5 });
    bakeCurve(fc, { start: 1, end: 11, step: 2, removeOutside: false, interpolation: 'LINEAR', bakeModifiers: true });
    expect(fc.keyframe_points.map((k) => k.co[0])).toEqual([1, 3, 5, 7, 9, 11]);
    expect(fc.keyframe_points.every((k) => k.co[1] <= 5 + 1e-9)).toBe(true);
    expect(fc.modifiers.length).toBe(0);
  });
});

describe('markers', () => {
  it('switches cameras at bound markers', () => {
    const m = [
      { name: 'a', frame: 10, select: false, camera: 'camA' },
      { name: 'b', frame: 20, select: false, camera: 'camB' },
      { name: 'c', frame: 15, select: false },
    ];
    expect(cameraForFrame(m, 5)).toBe('camA');
    expect(cameraForFrame(m, 15)).toBe('camA');
    expect(cameraForFrame(m, 20)).toBe('camB');
    expect(cameraForFrame([{ name: 'x', frame: 1, select: false }], 3)).toBeNull();
  });
});

describe('time slide', () => {
  it('slides the inner keys towards an end of the selected range', () => {
    const fc = curve([0, 1, 2, 3, 4], [0, 10, 20, 30, 40]);
    select(fc, [0, 1, 2, 3, 4]);
    const host: KeyTransformHost = {
      transformCurves: () => refs(fc),
      graph: false,
      ppf: () => 10,
      ppv: () => 1,
      toDisp: (_f, v) => v,
      fromDisp: (_f, d) => d,
      screen: (x) => ({ x: x * 10, y: 0 }),
      autoSnap: false,
      handlesVisible: () => true,
    };
    transformKeys(host, { mode: 'TIME_SLIDE', value: [0.5, 0], constraint: 'NONE' });
    expect(fc.keyframe_points.map((k) => k.co[0])).toEqual([0, 25, 30, 35, 40]);
  });
});

import { flipSideName, autosideName, slideValue, propagateCurve } from '../../src/modes/armature/posemath';

describe('pose tools', () => {
  it('flips side names in the common conventions', () => {
    const cases: [string, string][] = [
      ['Hand.L', 'Hand.R'],
      ['hand_l', 'hand_r'],
      ['L_Hand', 'R_Hand'],
      ['l.hand', 'r.hand'],
      ['HandLeft', 'HandRight'],
      ['Left Hand', 'Right Hand'],
      ['left_hand', 'right_hand'],
      ['Hand.R.001', 'Hand.L.001'],
      ['HandRIGHT', 'HandLEFT'],
      ['Hand-L', 'Hand-R'],
      ['Hand L', 'Hand R'],
      ['Bone', 'Bone'],
      ['Lhand', 'Lhand'],
      ['R.Hand', 'L.Hand'],
    ];
    for (const [a, b] of cases) expect(flipSideName(a)).toBe(b);
    expect(flipSideName('Hand.L.003', true)).toBe('Hand.R');
  });

  it('names bones by axis', () => {
    expect(autosideName('Arm', 1, 'XAXIS')).toBe('Arm.L');
    expect(autosideName('Arm.001', -1, 'XAXIS')).toBe('Arm.001.R');
    expect(autosideName('Spine', 0, 'XAXIS')).toBe('Spine');
    expect(autosideName('Leg', 1, 'YAXIS')).toBe('Leg.Bk');
    expect(autosideName('Foot', -1, 'YAXIS')).toBe('Foot.Fr');
    expect(autosideName('Arm.L', 1, 'ZAXIS')).toBe('Arm.Top');
    expect(autosideName('Tail', -1, 'ZAXIS')).toBe('Tail.Bot');
  });

  it('computes in-between values', () => {
    // prev 0, next 4, current frame halfway (breakdown 2), current value 5
    expect(slideValue('PUSH', 5, 0, 4, 0.5, 0.5, 0)).toBe(6.5);
    expect(slideValue('RELAX', 5, 0, 4, 0.5, 0.5, 0)).toBe(3.5);
    expect(slideValue('BREAKDOWN', 5, 0, 4, 0.5, 0.25, 0)).toBe(1);
    expect(slideValue('BLEND_TO_NEIGHBOR', 5, 0, 4, 0.5, 0.25, 0)).toBe(2.5);
    expect(slideValue('BLEND_TO_NEIGHBOR', 5, 0, 4, 0.5, 0.75, 0)).toBe(4.5);
    expect(slideValue('BLEND_TO_NEIGHBOR', 5, 0, 4, 0.5, 0.5, 0)).toBe(5);
    expect(slideValue('BLEND_WITH_REST', 5, 0, 4, 0.5, 0.5, 1)).toBe(3);
  });

  it('propagates a value to later keys', () => {
    const mk = () => curve([1, 2, 3, 4], [1, 10, 20, 30]);
    const a = mk();
    expect(propagateCurve(a, 9, 5, 'NEXT_KEY', 0, [])).toBe(1);
    expect(values(a)).toEqual([1, 9, 3, 4]);
    const b = mk();
    propagateCurve(b, 9, 5, 'LAST_KEY', 0, []);
    expect(values(b)).toEqual([1, 2, 3, 9]);
    const c = mk();
    propagateCurve(c, 9, 5, 'BEFORE_FRAME', 25, []);
    expect(values(c)).toEqual([1, 9, 9, 4]);
    const d = mk();
    propagateCurve(d, 9, 5, 'BEFORE_END', 0, []);
    expect(values(d)).toEqual([1, 9, 9, 9]);
    const e = mk();
    propagateCurve(e, 9, 5, 'SELECTED_MARKERS', 0, [20]);
    expect(values(e)).toEqual([1, 2, 9, 4]);
  });
});

import type { NlaStrip, NlaTrack } from '../../src/data/types';
import { makeStrip } from '../../src/animation/actionops';
import { applyAnimData } from '../../src/anim/evaluate';
import { makeMetas, removeMetas, addTransitions, swapStrips, applyStripScale, alignActionToStrip, enterTweak, exitTweak, actionUsers } from '../../src/animation/nlaedit';

function constAction(name: string, value: number, a = 1, b = 11) {
  const act = newAction(name);
  act.fcurves = [curve([value, value], [a, b])];
  doc.actions[act.id] = act;
  return act;
}
const track = (strips: NlaStrip[]): NlaTrack => ({ name: 'T', strips, mute: false, is_solo: false });

describe('NLA editing', () => {
  it('blends across a transition between two strips', () => {
    const a = constAction('A', 2),
      b = constAction('B', 10);
    const s1 = { ...makeStrip(a, 1, 'HOLD'), select: true };
    const s2 = { ...makeStrip(b, 31, 'HOLD_FORWARD'), select: true };
    const t = track([s1, s2]);
    expect(addTransitions(t)).toBe(1);
    expect(t.strips.map((s) => s.type ?? 'CLIP')).toEqual(['CLIP', 'TRANSITION', 'CLIP']);
    cube.animation_data = { action: null, nla_tracks: [t], drivers: [] };
    applyAnimData(doc, cube, cube.animation_data, 21);
    expect(cube.location[0]).toBeCloseTo(6, 5);
    applyAnimData(doc, cube, cube.animation_data, 5);
    expect(cube.location[0]).toBeCloseTo(2, 5);
  });

  it('groups strips into a meta strip that keeps playing them, and ungroups again', () => {
    const a = constAction('A', 2),
      b = constAction('B', 10);
    const s1 = { ...makeStrip(a, 1, 'HOLD'), select: true };
    const s2 = { ...makeStrip(b, 11, 'HOLD_FORWARD'), select: true };
    const t = track([s1, s2]);
    expect(makeMetas(t)).toBe(1);
    expect(t.strips.length).toBe(1);
    const meta = t.strips[0];
    expect([meta.type, meta.frame_start, meta.frame_end]).toEqual(['META', 1, 21]);
    // move the meta: its strips follow
    meta.frame_start += 100;
    meta.frame_end += 100;
    cube.animation_data = { action: null, nla_tracks: [t], drivers: [] };
    applyAnimData(doc, cube, cube.animation_data, 115);
    expect(cube.location[0]).toBeCloseTo(10, 5);
    applyAnimData(doc, cube, cube.animation_data, 105);
    expect(cube.location[0]).toBeCloseTo(2, 5);
    expect(removeMetas(t)).toBe(1);
    expect(t.strips.map((s) => [s.frame_start, s.frame_end])).toEqual([
      [101, 111],
      [111, 121],
    ]);
  });

  it('swaps two strips and bakes strip scale into the action', () => {
    const a = constAction('A', 2),
      b = constAction('B', 10, 1, 5);
    const s1 = { ...makeStrip(a, 1), select: true };
    const s2 = { ...makeStrip(b, 20), select: true };
    const t = track([s1, s2]);
    expect(swapStrips(t)).toBe(true);
    expect(t.strips[0]).toBe(s2);
    expect([s2.frame_start, s1.frame_end]).toEqual([1, 24]);
    s1.scale = 2;
    s1.frame_end = s1.frame_start + 20;
    expect(applyStripScale(s1, a)).toBe(true);
    expect(a.fcurves[0].keyframe_points.map((k) => k.co[0])).toEqual([1, 21]);
    expect([s1.scale, s1.action_frame_end]).toEqual([1, 21]);
  });

  it('enters and leaves tweak mode, lining the action up with the strip', () => {
    const a = constAction('A', 2);
    const s = { ...makeStrip(a, 50), select: true };
    cube.animation_data = { action: null, nla_tracks: [track([s])], drivers: [] };
    expect(actionUsers(doc, a.id)).toBe(1);
    expect(enterTweak(doc, cube.animation_data, 0, 0, false, true)).toBe(true);
    expect(cube.animation_data.action).toBe(a.id);
    expect(a.fcurves[0].keyframe_points[0].co[0]).toBe(50);
    expect([s.action_frame_start, s.frame_start]).toEqual([50, 50]);
    expect(cube.animation_data.nla_tracks[0].is_solo).toBe(true);
    applyAnimData(doc, cube, cube.animation_data, 55);
    expect(cube.location[0]).toBeCloseTo(2, 5);
    expect(exitTweak(cube.animation_data, true)).toBe(true);
    expect(cube.animation_data.action).toBe(null);
    expect(cube.animation_data.nla_tracks[0].is_solo).toBe(false);
    // already aligned: nothing to move
    expect(alignActionToStrip(doc, s)).toBe(false);
  });
});

import { insertUserKeyingSet } from '../../src/anim/keyframes';

describe('keying sets', () => {
  it('keys every path of a user keying set', () => {
    doc.scene.keying_sets = [
      {
        name: 'KS',
        paths: [
          { id: cube.id, data_path: 'location', index: 2 },
          { id: cube.id, data_path: 'scale', index: -1 },
          { id: 'missing', data_path: 'location', index: -1 },
        ],
      },
    ];
    expect(insertUserKeyingSet(doc, 'KS')).toBe(2);
    const act = doc.actions[cube.animation_data!.action!];
    expect(act.fcurves.map((f) => `${f.data_path}${f.array_index}`).sort()).toEqual(['location2', 'scale0', 'scale1', 'scale2']);
  });
});

describe('samples', () => {
  it('bakes keys to samples and back, evaluating the same', () => {
    const fc = curve([0, 4, 1], [1, 5, 9]);
    const before = [1, 2.5, 5, 7, 9].map((f) => evaluateFCurve(fc, f));
    expect(T.keysToSamples(fc)).toBe(true);
    expect(fc.keyframe_points.length).toBe(0);
    expect(fc.sampled_points!.length).toBe(9);
    // integer frames match exactly, in-between frames interpolate linearly
    expect(evaluateFCurve(fc, 5)).toBeCloseTo(before[2], 6);
    expect(evaluateFCurve(fc, 7)).toBeCloseTo(before[3], 6);
    expect(evaluateFCurve(fc, 0)).toBe(0);
    expect(evaluateFCurve(fc, 20)).toBeCloseTo(1, 6);
    expect(T.samplesToKeys(fc)).toBe(true);
    expect(fc.keyframe_points.length).toBe(9);
    expect(fc.sampled_points).toBeUndefined();
  });
});
