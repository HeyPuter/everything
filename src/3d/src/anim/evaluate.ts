// Applies actions, NLA strips and drivers to the document for a frame.
import type { ActionData, AnimData, DocumentData, ObjectData, NlaStrip, NlaTrack, TimelineMarker } from '../data/types';
import { evaluateFCurve, hasCurveData } from './fcurve';
import { getValue, setValue } from '../data/rna';
import { evaluateDriver } from './drivers';

/** Map a scene frame (clamped to the strip) to the action frame, honouring scale and repeat. */
export function stripActionFrame(s: NlaStrip, frame: number): number {
  const len = s.frame_end - s.frame_start;
  const actionLen = s.action_frame_end - s.action_frame_start;
  if (len <= 0) return s.action_frame_start;
  const f = Math.max(s.frame_start, Math.min(s.frame_end, frame));
  const repeat = Math.max(1e-3, s.repeat);
  const cycle = ((f - s.frame_start) / len) * repeat;
  let local = cycle - Math.floor(cycle);
  // the very end of the strip shows the end of the (last) cycle rather than wrapping back
  if (f >= s.frame_end - 1e-9 && cycle > 0 && local < 1e-9) local = 1;
  if (cycle >= repeat - 1e-9) local = repeat - Math.floor(repeat - 1e-9);
  return s.action_frame_start + local * actionLen;
}

/**
 * The strip of a track that contributes at `frame` and the frame it is
 * evaluated at: the strip under the frame, otherwise the previous strip when it
 * holds forward, otherwise the first strip when it holds backwards.
 */
export function trackStripAt(track: NlaTrack, frame: number): { strip: NlaStrip; frame: number } | null {
  const strips = track.strips.filter((s) => !s.mute).sort((a, b) => a.frame_start - b.frame_start);
  if (!strips.length) return null;
  for (const s of strips) if (frame >= s.frame_start && frame <= s.frame_end) return { strip: s, frame };
  let prev: NlaStrip | null = null;
  for (const s of strips) if (s.frame_end < frame) prev = s;
  if (prev) return prev.extrapolation === 'NOTHING' ? null : { strip: prev, frame: prev.frame_end };
  const first = strips[0];
  if (frame < first.frame_start && first.extrapolation === 'HOLD') return { strip: first, frame: first.frame_start };
  return null;
}

export function stripInfluence(s: NlaStrip, frame: number) {
  if (s.influence !== undefined) return s.influence;
  let w = 1;
  if (s.blend_in > 0 && frame < s.frame_start + s.blend_in) w = Math.max(0, (frame - s.frame_start) / s.blend_in);
  if (s.blend_out > 0 && frame > s.frame_end - s.blend_out) w = Math.min(w, Math.max(0, (s.frame_end - frame) / s.blend_out));
  return w;
}

/** Rest value used as the base when blending (RNA defaults for transform channels). */
function restValue(path: string, index: number, current: number): number {
  const tail = path.split('.').pop() ?? path;
  if (tail === 'scale' || tail === 'delta_scale') return 1;
  if (tail === 'rotation_quaternion') return index === 0 ? 1 : 0;
  if (tail === 'rotation_axis_angle') return index === 2 ? 1 : 0;
  if (tail === 'location' || tail === 'rotation_euler' || tail === 'delta_location' || tail === 'delta_rotation_euler') return 0;
  if (/key_blocks\[.*\]\.value$/.test(path)) return 0;
  return current;
}

type Accum = Map<string, { path: string; index: number; value: unknown }>;

type Values = Map<string, { path: string; index: number; value: number }>;

/** Raw channel values of an action at a frame. */
function actionValues(action: ActionData, frame: number, out: Values = new Map()): Values {
  for (const fc of action.fcurves) {
    if (fc.mute || !hasCurveData(fc)) continue;
    out.set(`${fc.data_path}|${fc.array_index}`, { path: fc.data_path, index: fc.array_index, value: evaluateFCurve(fc, frame) });
  }
  return out;
}

/** Channel values a strip produces at a scene frame (action clips, meta strips). */
function stripValues(doc: DocumentData, s: NlaStrip, frame: number): Values | null {
  if (s.type === 'META') {
    const inner = stripActionFrame(s, frame);
    const hit = s.strips?.length ? trackStripAt({ name: '', strips: s.strips, mute: false, is_solo: false }, inner) : null;
    if (!hit) return null;
    return hit.strip.type === 'TRANSITION' ? transitionValues(doc, s.strips!, hit.strip, hit.frame) : stripValues(doc, hit.strip, hit.frame);
  }
  if (s.type === 'TRANSITION') return null;
  const action = doc.actions[s.action];
  return action ? actionValues(action, stripActionFrame(s, frame)) : null;
}

/** A transition blends from the end of the strip before it to the start of the strip after it. */
function transitionValues(doc: DocumentData, strips: NlaStrip[], tr: NlaStrip, frame: number): Values | null {
  const sorted = [...strips].sort((a, b) => a.frame_start - b.frame_start);
  const i = sorted.indexOf(tr);
  const prev = sorted[i - 1],
    next = sorted[i + 1];
  if (!prev || !next) return null;
  const a = stripValues(doc, prev, prev.frame_end) ?? new Map(),
    b = stripValues(doc, next, next.frame_start) ?? new Map();
  const len = tr.frame_end - tr.frame_start;
  const t = len > 0 ? Math.max(0, Math.min(1, (frame - tr.frame_start) / len)) : 1;
  const out: Values = new Map();
  for (const [k, va] of a) {
    const vb = b.get(k);
    out.set(k, { ...va, value: vb ? va.value + (vb.value - va.value) * t : va.value });
  }
  for (const [k, vb] of b) if (!out.has(k)) out.set(k, vb);
  return out;
}

function blendValues(doc: DocumentData, ob: ObjectData, acc: Accum, values: Values, blend: NlaStrip['blend_type'], influence: number) {
  for (const [key, e] of values) {
    const v = e.value;
    const prev = acc.get(key);
    if (blend === 'REPLACE' && influence >= 1) {
      acc.set(key, { path: e.path, index: e.index, value: v });
      continue;
    }
    let cur: number;
    if (prev && typeof prev.value === 'number') cur = prev.value;
    else {
      const raw = getValue(doc, ob, e.path, e.index);
      if (typeof raw !== 'number' && typeof raw !== 'boolean') {
        acc.set(key, { path: e.path, index: e.index, value: v });
        continue;
      }
      cur = restValue(e.path, e.index, Number(raw));
    }
    let target = v;
    const tail = e.path.split('.').pop();
    if (blend === 'ADD') target = cur + v;
    else if (blend === 'COMBINE') target = tail === 'scale' ? cur * v : cur + v;
    else if (blend === 'SUBTRACT') target = cur - v;
    else if (blend === 'MULTIPLY') target = cur * v;
    acc.set(key, { path: e.path, index: e.index, value: cur + (target - cur) * influence });
  }
}

function blendAction(doc: DocumentData, ob: ObjectData, acc: Accum, action: ActionData, frame: number, blend: NlaStrip['blend_type'], influence: number) {
  blendValues(doc, ob, acc, actionValues(action, frame), blend, influence);
}

/** last animation result written per object property (see applyAnimData) */
const lastWritten = new Map<string, { frame: number; anim: number }>();

export function applyAnimData(doc: DocumentData, ob: ObjectData, ad: AnimData, frame: number) {
  const acc: Accum = new Map();
  const solo = ad.nla_tracks.some((t) => t.is_solo);
  const tw = ad.tweak;
  const tweakStrip = tw ? ad.nla_tracks[tw.track]?.strips[tw.strip] : undefined;
  for (let ti = 0; ti < ad.nla_tracks.length; ti++) {
    const track = ad.nla_tracks[ti];
    if (tw && tweakStrip && ti === tw.track) {
      // tweak mode: the edited strip's action is evaluated through the strip's time mapping
      const action = doc.actions[tweakStrip.action];
      if (action) blendAction(doc, ob, acc, action, stripActionFrame(tweakStrip, frame), tweakStrip.blend_type, tweakStrip.influence ?? 1);
      continue;
    }
    if (track.mute || (solo && !track.is_solo)) continue;
    // tracks above the edited one only count with full-stack evaluation
    if (tw && tweakStrip && ti > tw.track && !tw.upper) continue;
    const hit = trackStripAt(track, frame);
    if (!hit) continue;
    const s = hit.strip;
    const values = s.type === 'TRANSITION' ? transitionValues(doc, track.strips, s, hit.frame) : stripValues(doc, s, hit.frame);
    if (values) blendValues(doc, ob, acc, values, s.blend_type, stripInfluence(s, hit.frame));
  }
  if (!(tw && tweakStrip) && ad.action && !solo) {
    // a soloed track disables the active action as well
    const action = doc.actions[ad.action];
    if (action) blendAction(doc, ob, acc, action, frame, ad.action_blend_type ?? 'REPLACE', ad.action_influence ?? 1);
  }
  for (const e of acc.values()) {
    // A manual edit of an animated property stays until the
    // frame changes or the animation itself changes (it is not overwritten on every update).
    const k = `${ob.id}|${e.path}|${e.index}`;
    const last = lastWritten.get(k);
    if (typeof e.value === 'number' && last && last.frame === frame && Math.abs(last.anim - e.value) < 1e-9) {
      const cur = getValue(doc, ob, e.path, e.index);
      if (typeof cur === 'number' && Math.abs(cur - e.value) > 1e-9) continue;
    }
    setValue(doc, ob, e.path, e.index, e.value);
    if (typeof e.value === 'number') lastWritten.set(k, { frame, anim: e.value });
  }
  for (const drv of ad.drivers) {
    try {
      const v = evaluateDriver(doc, ob, drv, frame);
      if (Number.isFinite(v)) setValue(doc, ob, drv.data_path, drv.array_index, v);
    } catch {
      // invalid drivers are reported in the Drivers editor; evaluation continues
    }
  }
}

/** Camera bound to the last marker at or before `frame` (markers with cameras switch the scene camera). */
export function cameraForFrame(list: TimelineMarker[], frame: number): string | null {
  let best: TimelineMarker | null = null;
  for (const m of list) if (m.camera && m.frame <= frame && (!best || m.frame >= best.frame)) best = m;
  if (best) return best.camera!;
  // before the first bound marker the earliest bound camera is used
  let first: TimelineMarker | null = null;
  for (const m of list) if (m.camera && (!first || m.frame < first.frame)) first = m;
  return first?.camera ?? null;
}

export function applyAnimation(doc: DocumentData, frame: number) {
  const cam = cameraForFrame(doc.scene.timeline_markers, frame);
  if (cam && doc.objects[cam]) doc.scene.camera = cam;
  for (const id of doc.object_order) {
    const ob = doc.objects[id];
    if (ob?.animation_data) applyAnimData(doc, ob, ob.animation_data, frame);
  }
}

/** Whether a property (path/index) is animated for the object. */
export function fcurveFor(doc: DocumentData, ob: ObjectData, path: string, index: number) {
  const ad = ob.animation_data;
  if (!ad?.action) return undefined;
  return doc.actions[ad.action]?.fcurves.find((f) => f.data_path === path && (f.array_index === index || index < 0));
}
