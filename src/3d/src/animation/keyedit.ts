// Keyframe editing on lists of F-Curves (selection, delete, duplicate, set
// interpolation/handles/easing/type, snap, mirror, copy/paste, clean, insert).
// Pure document logic shared by the Dope Sheet and Graph Editor operators.
import type { FCurve, Keyframe, KeyHandleType, Interpolation } from '../data/types';
import type { CurveRef } from './channels';
import { calcHandles, sortKeyframes, evaluateFCurve, insertKeyframe, alignHandle } from '../anim/fcurve';

export type SelectAction = 'SELECT' | 'DESELECT' | 'INVERT' | 'TOGGLE';

export const isKeySelected = (k: Keyframe) => !!k.select_control_point;
export const isAnySelected = (k: Keyframe) => !!(k.select_control_point || k.select_left_handle || k.select_right_handle);

export function setKeySelected(k: Keyframe, v: boolean) {
  k.select_control_point = v;
  k.select_left_handle = v;
  k.select_right_handle = v;
}

/** Curves that may be edited (locked curves are skipped). */
export const editable = (curves: CurveRef[]) => curves.filter((r) => !r.fc.lock);

export function anyKeySelected(curves: CurveRef[], handles = false) {
  return curves.some((r) => r.fc.keyframe_points.some(handles ? isAnySelected : isKeySelected));
}

export function selectAll(curves: CurveRef[], action: SelectAction) {
  let act = action;
  if (act === 'TOGGLE') act = anyKeySelected(curves, true) ? 'DESELECT' : 'SELECT';
  for (const { fc } of curves)
    for (const k of fc.keyframe_points) {
      if (act === 'SELECT') setKeySelected(k, true);
      else if (act === 'DESELECT') setKeySelected(k, false);
      else setKeySelected(k, !k.select_control_point);
    }
}

/** Select all keys on the given frames (column select). */
export function selectColumns(curves: CurveRef[], frames: number[], extend = true) {
  if (!extend) selectAll(curves, 'DESELECT');
  for (const { fc } of curves) for (const k of fc.keyframe_points) if (frames.some((f) => Math.abs(k.co[0] - f) < 0.5)) setKeySelected(k, true);
}

export function selectedFrames(curves: CurveRef[]): number[] {
  const s = new Set<number>();
  for (const { fc } of curves) for (const k of fc.keyframe_points) if (k.select_control_point) s.add(Math.round(k.co[0] * 1000) / 1000);
  return [...s].sort((a, b) => a - b);
}

export function selectLeftRight(curves: CurveRef[], side: 'LEFT' | 'RIGHT', frame: number, extend = false) {
  if (!extend) selectAll(curves, 'DESELECT');
  for (const { fc } of curves) for (const k of fc.keyframe_points) if (side === 'LEFT' ? k.co[0] <= frame + 1e-4 : k.co[0] >= frame - 1e-4) setKeySelected(k, true);
}

/** Select every key on curves that already have a selected key. */
export function selectLinked(curves: CurveRef[]) {
  for (const { fc } of curves) if (fc.keyframe_points.some(isAnySelected)) fc.keyframe_points.forEach((k) => setKeySelected(k, true));
}

export function selectMoreLess(curves: CurveRef[], more: boolean) {
  for (const { fc } of curves) {
    const sel = fc.keyframe_points.map(isKeySelected);
    fc.keyframe_points.forEach((k, i) => {
      const prev = sel[i - 1] ?? false,
        next = sel[i + 1] ?? false;
      if (more) {
        if (prev || next) setKeySelected(k, true);
      } else if (sel[i] && (!prev || !next)) setKeySelected(k, false);
    });
  }
}

export function deleteSelected(curves: CurveRef[], removeEmpty = true): number {
  let n = 0;
  for (const { fc } of editable(curves)) {
    const before = fc.keyframe_points.length;
    fc.keyframe_points = fc.keyframe_points.filter((k) => !k.select_control_point);
    n += before - fc.keyframe_points.length;
    if (before !== fc.keyframe_points.length) calcHandles(fc);
  }
  if (removeEmpty) {
    for (const r of curves) if (!r.fc.keyframe_points.length && !r.fc.sampled_points?.length) r.action.fcurves = r.action.fcurves.filter((f) => f !== r.fc);
  }
  return n;
}

export const cloneKey = (k: Keyframe): Keyframe => ({
  ...k,
  co: [...k.co],
  handle_left: [...k.handle_left],
  handle_right: [...k.handle_right],
});

/** Duplicate selected keys in place; the copies become the selection. */
export function duplicateSelected(curves: CurveRef[]): number {
  let n = 0;
  for (const { fc } of editable(curves)) {
    const out: Keyframe[] = [];
    for (const k of fc.keyframe_points) {
      if (k.select_control_point) {
        const c = cloneKey(k);
        setKeySelected(k, false);
        out.push(k, c);
        n++;
      } else out.push(k);
    }
    fc.keyframe_points = out;
  }
  return n;
}

/** Sort, merge keys that ended up on the same frame (selected wins) and recalc handles. */
export function finalizeCurve(fc: FCurve, merge = true) {
  sortKeyframes(fc);
  if (merge) {
    const out: Keyframe[] = [];
    for (const k of fc.keyframe_points) {
      const last = out[out.length - 1];
      if (last && Math.abs(last.co[0] - k.co[0]) < 0.01) {
        if (k.select_control_point && !last.select_control_point) out[out.length - 1] = k;
        else if (k.select_control_point === last.select_control_point) out[out.length - 1] = k;
        continue;
      }
      out.push(k);
    }
    fc.keyframe_points = out;
  }
  calcHandles(fc);
}

export function finalizeAll(curves: CurveRef[], merge = true) {
  const seen = new Set<FCurve>();
  for (const { fc } of curves) {
    if (seen.has(fc)) continue;
    seen.add(fc);
    finalizeCurve(fc, merge);
  }
}

export function moveKey(k: Keyframe, dx: number, dy: number) {
  k.co[0] += dx;
  k.co[1] += dy;
  k.handle_left[0] += dx;
  k.handle_left[1] += dy;
  k.handle_right[0] += dx;
  k.handle_right[1] += dy;
}

function selectedKeys(curves: CurveRef[]) {
  const out: { fc: FCurve; k: Keyframe }[] = [];
  for (const { fc } of editable(curves)) for (const k of fc.keyframe_points) if (k.select_control_point) out.push({ fc, k });
  return out;
}

function touchedCurves(curves: CurveRef[]) {
  return editable(curves).filter((r) => r.fc.keyframe_points.some(isAnySelected));
}

export function setInterpolation(curves: CurveRef[], type: Interpolation) {
  for (const { fc, k } of selectedKeys(curves)) {
    k.interpolation = type;
    void fc;
  }
  finalizeAll(touchedCurves(curves), false);
}

export function setEasing(curves: CurveRef[], easing: Keyframe['easing']) {
  for (const { k } of selectedKeys(curves)) k.easing = easing;
}

export function setKeyType(curves: CurveRef[], type: Keyframe['type']) {
  for (const { k } of selectedKeys(curves)) k.type = type;
}

/** Set handle types on selected keys (or selected handles in the Graph Editor). */
export function setHandleType(curves: CurveRef[], type: KeyHandleType, handles = true) {
  for (const { fc } of editable(curves)) {
    let changed = false;
    for (const k of fc.keyframe_points) {
      const l = !!k.select_control_point || (handles && !!k.select_left_handle),
        r = !!k.select_control_point || (handles && !!k.select_right_handle);
      if (l) k.handle_left_type = type;
      if (r) k.handle_right_type = type;
      if (l || r) changed = true;
      // aligned pairs: realign the unselected side to the selected one
      if (type === 'ALIGNED' && l && r) alignHandle(k, 'left');
    }
    if (changed) calcHandles(fc);
  }
}

export type ExtrapolationMode = 'CONSTANT' | 'LINEAR' | 'MAKE_CYCLIC' | 'CLEAR_CYCLIC';

/** Curves targeted by channel-level operations: selected curves, or curves with selected keys. */
export function targetCurves(curves: CurveRef[]) {
  const sel = editable(curves).filter((r) => r.fc.select || r.fc.keyframe_points.some(isAnySelected));
  return sel;
}

export function setExtrapolation(curves: CurveRef[], mode: ExtrapolationMode) {
  for (const { fc } of targetCurves(curves)) {
    if (mode === 'CONSTANT' || mode === 'LINEAR') fc.extrapolation = mode;
    else if (mode === 'MAKE_CYCLIC') {
      if (!fc.modifiers.some((m) => m.type === 'CYCLES'))
        fc.modifiers.unshift({
          type: 'CYCLES',
          mode_before: 'REPEAT',
          mode_after: 'REPEAT',
        });
    } else fc.modifiers = fc.modifiers.filter((m) => m.type !== 'CYCLES');
  }
}

export interface SnapContext {
  frame: number;
  fps: number;
  markers: number[];
  cursorValue: number;
}

export type SnapMode = 'CFRA' | 'NEAREST_FRAME' | 'NEAREST_SECOND' | 'NEAREST_MARKER' | 'VALUE' | 'HORIZONTAL';

export function snapKeys(curves: CurveRef[], mode: SnapMode, c: SnapContext) {
  for (const { k } of selectedKeys(curves)) {
    const f = k.co[0];
    let tf = f;
    if (mode === 'CFRA') tf = c.frame;
    else if (mode === 'NEAREST_FRAME') tf = Math.round(f);
    else if (mode === 'NEAREST_SECOND') tf = Math.round(f / c.fps) * c.fps;
    else if (mode === 'NEAREST_MARKER' && c.markers.length) tf = c.markers.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a));
    if (mode === 'VALUE') moveKey(k, 0, c.cursorValue - k.co[1]);
    else if (mode === 'HORIZONTAL') {
      k.handle_left[1] = k.co[1];
      k.handle_right[1] = k.co[1];
      if (k.handle_left_type === 'AUTO' || k.handle_left_type === 'AUTO_CLAMPED' || k.handle_left_type === 'VECTOR') k.handle_left_type = 'ALIGNED';
      if (k.handle_right_type === 'AUTO' || k.handle_right_type === 'AUTO_CLAMPED' || k.handle_right_type === 'VECTOR') k.handle_right_type = 'ALIGNED';
    } else moveKey(k, tf - f, 0);
  }
  finalizeAll(touchedCurves(curves));
}

export type MirrorMode = 'CFRA' | 'VALUE' | 'YAXIS' | 'XAXIS' | 'MARKER';

export function mirrorKeys(curves: CurveRef[], mode: MirrorMode, c: { frame: number; cursorValue: number; marker?: number }) {
  for (const { k } of selectedKeys(curves)) {
    if (mode === 'CFRA' || mode === 'YAXIS' || mode === 'MARKER') {
      const center = mode === 'CFRA' ? c.frame : mode === 'MARKER' ? (c.marker ?? c.frame) : 0;
      const m = (x: number) => 2 * center - x;
      const hl: [number, number] = [m(k.handle_right[0]), k.handle_right[1]];
      const hr: [number, number] = [m(k.handle_left[0]), k.handle_left[1]];
      k.co[0] = m(k.co[0]);
      k.handle_left = hl;
      k.handle_right = hr;
      const t = k.handle_left_type;
      k.handle_left_type = k.handle_right_type;
      k.handle_right_type = t;
    } else {
      const center = mode === 'VALUE' ? c.cursorValue : 0;
      const m = (y: number) => 2 * center - y;
      k.co[1] = m(k.co[1]);
      k.handle_left[1] = m(k.handle_left[1]);
      k.handle_right[1] = m(k.handle_right[1]);
    }
  }
  finalizeAll(touchedCurves(curves));
}

/** Insert keys at `frame` on curves (value from `valueOf`, e.g. the current property value, else from the curve). */
export function insertKeysAt(curves: CurveRef[], frame: number, type: Keyframe['type'] = 'KEYFRAME', valueOf?: (r: CurveRef) => number | undefined): number {
  let n = 0;
  for (const r of editable(curves)) {
    const fc = r.fc;
    const cur = valueOf?.(r);
    const v = cur !== undefined && Number.isFinite(cur) ? cur : fc.keyframe_points.length ? evaluateFCurve(fc, frame) : 0;
    for (const k of fc.keyframe_points) setKeySelected(k, false);
    const k = insertKeyframe(fc, frame, v, { type });
    setKeySelected(k, true);
    n++;
  }
  return n;
}

/** Remove redundant keys (value equal to both neighbours within threshold). */
export function cleanKeys(curves: CurveRef[], threshold = 0.001, onlySelected = true): number {
  let n = 0;
  for (const { fc } of editable(curves)) {
    const k = fc.keyframe_points;
    if (k.length < 2) continue;
    const keep: Keyframe[] = [];
    for (let i = 0; i < k.length; i++) {
      const cur = k[i];
      const prev = keep[keep.length - 1],
        next = k[i + 1];
      const eligible = !onlySelected || cur.select_control_point;
      const flatPrev = prev && Math.abs(prev.co[1] - cur.co[1]) <= threshold;
      const flatNext = !next || Math.abs(next.co[1] - cur.co[1]) <= threshold;
      if (eligible && prev && flatPrev && flatNext && (!next || prev.interpolation !== 'BEZIER' || isFlat(prev))) {
        n++;
        continue;
      }
      keep.push(cur);
    }
    if (keep.length !== k.length) {
      fc.keyframe_points = keep;
      calcHandles(fc);
    }
  }
  return n;
}

const isFlat = (k: Keyframe) => Math.abs(k.handle_right[1] - k.co[1]) < 1e-6 || k.handle_right_type === 'AUTO_CLAMPED';

// ---------------------------------------------------------------------------
// Copy / paste

export interface ClipEntry {
  obName: string;
  data_path: string;
  array_index: number;
  keys: Keyframe[];
}
export interface KeyClipboard {
  entries: ClipEntry[];
  first: number;
  last: number;
}

export let keyClipboard: KeyClipboard | null = null;

export function copyKeys(curves: CurveRef[]): number {
  const entries: ClipEntry[] = [];
  let first = Infinity,
    last = -Infinity;
  for (const r of curves) {
    const keys = r.fc.keyframe_points.filter((k) => k.select_control_point).map(cloneKey);
    if (!keys.length) continue;
    entries.push({
      obName: r.ob.name,
      data_path: r.fc.data_path,
      array_index: r.fc.array_index,
      keys,
    });
    for (const k of keys) {
      first = Math.min(first, k.co[0]);
      last = Math.max(last, k.co[0]);
    }
  }
  if (!entries.length) return 0;
  keyClipboard = { entries, first, last };
  return entries.reduce((a, e) => a + e.keys.length, 0);
}

export type PasteOffset = 'START' | 'END' | 'RELATIVE' | 'NONE';
export type PasteMerge = 'MIX' | 'OVER_ALL' | 'OVER_RANGE';

export function pasteKeys(curves: CurveRef[], frame: number, offset: PasteOffset = 'START', merge: PasteMerge = 'MIX', flipped = false, clip: KeyClipboard | null = keyClipboard): number {
  if (!clip) return 0;
  const targets = editable(curves);
  const dx = offset === 'START' ? frame - clip.first : offset === 'END' ? frame - clip.last : offset === 'RELATIVE' ? frame - clip.first : 0;
  const shift = offset === 'RELATIVE' ? 0 : dx;
  let n = 0;
  const selectedTargets = targets.filter((t) => t.fc.select);
  for (const t of targets) t.fc.keyframe_points.forEach((k) => setKeySelected(k, false));
  for (const e of clip.entries) {
    let match = targets.filter((t) => t.fc.data_path === e.data_path && t.fc.array_index === e.array_index);
    const sameOb = match.filter((t) => t.ob.name === e.obName);
    if (sameOb.length) match = sameOb;
    if (!match.length && clip.entries.length === 1) match = selectedTargets;
    for (const t of match) {
      const fc = t.fc;
      const lo = Math.min(...e.keys.map((k) => k.co[0])) + shift,
        hi = Math.max(...e.keys.map((k) => k.co[0])) + shift;
      if (merge === 'OVER_ALL') fc.keyframe_points = [];
      else if (merge === 'OVER_RANGE') fc.keyframe_points = fc.keyframe_points.filter((k) => k.co[0] < lo - 1e-4 || k.co[0] > hi + 1e-4);
      for (const src of e.keys) {
        const k = cloneKey(src);
        moveKey(k, shift, 0);
        if (flipped) {
          const m = (y: number) => -y;
          k.co[1] = m(k.co[1]);
          k.handle_left[1] = m(k.handle_left[1]);
          k.handle_right[1] = m(k.handle_right[1]);
        }
        setKeySelected(k, true);
        fc.keyframe_points = fc.keyframe_points.filter((o) => Math.abs(o.co[0] - k.co[0]) >= 0.01);
        fc.keyframe_points.push(k);
        n++;
      }
      finalizeCurve(fc);
    }
  }
  return n;
}

/** Frame/value bounds of keys (selected only if `selected`). */
export function keyBounds(curves: CurveRef[], selected: boolean, includeHandles = false): { x0: number; x1: number; y0: number; y1: number } | null {
  let x0 = Infinity,
    x1 = -Infinity,
    y0 = Infinity,
    y1 = -Infinity;
  for (const { fc } of curves)
    for (const k of fc.keyframe_points) {
      if (selected && !isAnySelected(k)) continue;
      x0 = Math.min(x0, k.co[0]);
      x1 = Math.max(x1, k.co[0]);
      y0 = Math.min(y0, k.co[1]);
      y1 = Math.max(y1, k.co[1]);
      if (includeHandles && k.interpolation === 'BEZIER') {
        y0 = Math.min(y0, k.handle_left[1], k.handle_right[1]);
        y1 = Math.max(y1, k.handle_left[1], k.handle_right[1]);
      }
    }
  return x0 === Infinity ? null : { x0, x1, y0, y1 };
}

/** Per-curve hold segments: pairs of consecutive keys with identical values and flat handles. */
export function holdSegments(fc: FCurve): [number, number][] {
  const out: [number, number][] = [];
  const k = fc.keyframe_points;
  for (let i = 0; i + 1 < k.length; i++) {
    const a = k[i],
      b = k[i + 1];
    if (Math.abs(a.co[1] - b.co[1]) > 1e-5) continue;
    if (a.interpolation === 'BEZIER' && (Math.abs(a.handle_right[1] - a.co[1]) > 1e-5 || Math.abs(b.handle_left[1] - b.co[1]) > 1e-5)) continue;
    out.push([a.co[0], b.co[0]]);
  }
  return out;
}

/** Default (rest) value of an animatable property, used by Clean Channels and NLA blending. */
export function propertyDefault(path: string, index: number): number {
  const tail = path.split('.').pop() ?? path;
  if (tail === 'scale' || tail === 'delta_scale') return 1;
  if (tail === 'rotation_quaternion') return index === 0 ? 1 : 0;
  if (tail === 'rotation_axis_angle') return index === 2 ? 1 : 0;
  return 0;
}
