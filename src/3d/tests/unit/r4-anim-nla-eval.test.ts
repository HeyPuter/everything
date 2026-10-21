import { describe, it, expect } from 'vitest';
import { startupDocument, newAction, newObject } from '../../src/data/defaults';
import type { ActionData, FCurve, NlaStrip } from '../../src/data/types';
import { insertKeyframe } from '../../src/anim/fcurve';
import { applyAnimData } from '../../src/anim/evaluate';
import { makeStrip } from '../../src/animation/actionops';

function act(name: string, keys: [string, number, [number, number][]][]): ActionData {
  const a = newAction(name);
  for (const [path, idx, ks] of keys) {
    const fc: FCurve = { data_path: path, array_index: idx, keyframe_points: [], extrapolation: 'CONSTANT', modifiers: [] };
    for (const [f, v] of ks) insertKeyframe(fc, f, v, { interpolation: 'LINEAR' });
    a.fcurves.push(fc);
  }
  return a;
}

/** NLA stack evaluation (repeat, hold, add with influence, combine) against reference values. */
describe('NLA evaluation matches the reference', () => {
  it('repeat, add with animated influence, combine', () => {
    const doc = startupDocument();
    const ob = newObject('O', 'EMPTY', null);
    doc.objects[ob.id] = ob;
    doc.object_order.push(ob.id);
    const base = act('Base', [
      ['location', 0, [[1, 0], [11, 10]]],
      ['scale', 0, [[1, 1], [11, 2]]],
      ['rotation_euler', 2, [[1, 0], [11, 1]]],
    ]);
    const add = act('Add', [
      ['location', 0, [[1, 5], [5, 5]]],
      ['scale', 0, [[1, 2], [5, 2]]],
      ['rotation_euler', 2, [[1, 0.5], [5, 0.5]]],
    ]);
    doc.actions[base.id] = base;
    doc.actions[add.id] = add;
    const s1: NlaStrip = { ...makeStrip(base, 1, 'HOLD'), repeat: 2 };
    s1.frame_end = 21;
    const s2: NlaStrip = { ...makeStrip(add, 5, 'NOTHING'), blend_type: 'ADD', influence: 0.5, blend_in: 2 };
    const s3: NlaStrip = { ...makeStrip(add, 12, 'NOTHING'), blend_type: 'COMBINE' };
    ob.animation_data = { action: null, drivers: [], nla_tracks: [s1, s2, s3].map((s, i) => ({ name: `T${i}`, strips: [s], mute: false, is_solo: false })) };
    const expected: Record<number, number[]> = { 1: [0, 1, 0], 3: [2, 1.2, 0.2], 6: [7.5, 2.5, 0.75], 8: [9.5, 2.7, 0.95], 11: [0, 1, 0], 15: [9, 2.8, 0.9], 19: [8, 1.8, 0.8], 21: [10, 2, 1], 25: [10, 2, 1] };
    for (const [f, [x, sx, rz]] of Object.entries(expected)) {
      applyAnimData(doc, ob, ob.animation_data, Number(f));
      expect(ob.location[0], `loc @${f}`).toBeCloseTo(x, 4);
      expect(ob.scale[0], `scale @${f}`).toBeCloseTo(sx, 4);
      expect(ob.rotation_euler[2], `rot @${f}`).toBeCloseTo(rz, 4);
    }
  });

  it('channels of the stack go back to their defaults where no strip drives them', () => {
    const doc = startupDocument();
    const ob = newObject('O', 'EMPTY', null);
    doc.objects[ob.id] = ob;
    const a = act('S', [
      ['location', 1, [[1, 3], [10, 5]]],
      ['scale', 0, [[1, 4]]],
    ]);
    doc.actions[a.id] = a;
    const st = makeStrip(a, 50, 'HOLD_FORWARD');
    ob.animation_data = { action: null, drivers: [], nla_tracks: [{ name: 'T', strips: [st], mute: false, is_solo: false }] };
    ob.location = [7, 7, 7];
    ob.scale = [9, 9, 9];
    applyAnimData(doc, ob, ob.animation_data, 20);
    expect(ob.location).toEqual([7, 0, 7]);
    expect(ob.scale).toEqual([1, 9, 9]);
  });
});
