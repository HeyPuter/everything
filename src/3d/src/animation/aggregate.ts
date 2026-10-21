// Aggregation of keyframes of several F-Curves into one Dope Sheet row
// (summary/object/action/group rows): columns, holds and interpolation spans.
import type { FCurve, Keyframe, KeyHandleType, Interpolation } from '../data/types';
import { holdSegments } from './keyedit';

export interface AggKey {
  frame: number;
  selected: boolean;
  type: Keyframe['type'];
  handle: KeyHandleType | 'MIXED';
  interp: Interpolation | 'MIXED';
  /** the key is a turning point of the value (higher / lower than both neighbours) */
  extreme?: 'MAX' | 'MIN' | 'BOTH';
}

export interface AggSpan {
  a: number;
  b: number;
  selected: boolean;
}

export interface AggRow {
  keys: AggKey[];
  holds: AggSpan[];
  interps: (AggSpan & { interp: Interpolation })[];
}

const q = (f: number) => Math.round(f * 1000) / 1000;

/** Handle types from the least to the most automatic (columns show the first present). */
const HANDLE_ORDER = ['FREE', 'AUTO', 'VECTOR', 'ALIGNED', 'AUTO_CLAMPED'];
const handleRank = (h: string) => {
  const i = HANDLE_ORDER.indexOf(h);
  return i < 0 ? -1 : i;
};

export function aggregate(curves: FCurve[]): AggRow {
  const map = new Map<number, AggKey>();
  for (const fc of curves)
    for (const k of fc.keyframe_points) {
      const f = q(k.co[0]);
      const handle: KeyHandleType | 'MIXED' = k.handle_left_type === k.handle_right_type ? k.handle_left_type : 'MIXED';
      const cur = map.get(f);
      if (!cur)
        map.set(f, {
          frame: f,
          selected: !!k.select_control_point,
          type: k.type,
          handle,
          interp: k.interpolation,
        });
      else {
        cur.selected ||= !!k.select_control_point;
        if (cur.type !== k.type) cur.type = 'KEYFRAME';
        // a column shows the least smooth handle type among its keys
        if (cur.handle !== handle) cur.handle = handleRank(handle) < handleRank(cur.handle) ? handle : cur.handle;
        if (cur.interp !== k.interpolation) cur.interp = 'MIXED';
      }
    }
  // turning points of each curve, merged per column
  for (const fc of curves) {
    const ks = fc.keyframe_points;
    for (let i = 1; i + 1 < ks.length; i++) {
      const v = ks[i].co[1],
        a = ks[i - 1].co[1],
        b = ks[i + 1].co[1];
      const eps = 1e-6 * Math.max(1, Math.abs(v));
      const kind = v > a + eps && v > b + eps ? 'MAX' : v < a - eps && v < b - eps ? 'MIN' : null;
      if (!kind) continue;
      const cur = map.get(q(ks[i].co[0]));
      if (cur) cur.extreme = cur.extreme && cur.extreme !== kind ? 'BOTH' : kind;
    }
  }
  const keys = [...map.values()].sort((a, b) => a.frame - b.frame);
  const holds: AggSpan[] = [];
  const interps: AggRow['interps'] = [];
  const keyed = curves.filter((c) => c.keyframe_points.length > 0);
  const segs = keyed.map((c) => (c.keyframe_points.length === 1 ? null : holdSegments(c)));
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i].frame,
      b = keys[i + 1].frame;
    let anyReal = false;
    const allHold =
      keyed.length > 0 &&
      segs.every((s, ci) => {
        if (!s) return true; // single key: constant
        const c = keyed[ci];
        const first = c.keyframe_points[0].co[0],
          last = c.keyframe_points[c.keyframe_points.length - 1].co[0];
        if (b <= first + 1e-4 || a >= last - 1e-4) return true; // outside the curve's keyed range (constant extrapolation)
        const covered = s.some(([s0, s1]) => s0 <= a + 1e-4 && s1 >= b - 1e-4);
        anyReal ||= covered;
        return covered;
      });
    const sel = keys[i].selected && keys[i + 1].selected;
    if (allHold && anyReal) holds.push({ a, b, selected: sel });
    // interpolation display: a curve keyed at `a` interpolates without Bézier handles
    let mode: Interpolation | null = null;
    for (const c of keyed) {
      const k = c.keyframe_points.find((kk) => Math.abs(kk.co[0] - a) < 1e-3);
      if (k && k.interpolation !== 'BEZIER') {
        mode = k.interpolation;
        break;
      }
    }
    if (mode) interps.push({ a, b, selected: sel, interp: mode });
  }
  return { keys, holds, interps };
}
