/** Motion kept from a former compound, timed against the separated clip's source. */
import { sourceOffset, localAtSource, normalizeCurve } from './speed-curve.js';

const timed = c => ['video', 'audio', 'compound'].includes(c.type) && !c.freeze;
const origin = (c, media) => media ? c.in || 0 : c.motionOffset || 0;

export function inheritedTime(record, clip, local) {
  return record.offset + localAtSource(record.source, origin(clip, record.source.media) + (record.source.media ? sourceOffset(clip, local) : local) - record.source.in);
}

/** Inverse mapping for navigating to a retained parent's keyframe. */
export function inheritedLocal(record, clip, parentTime) {
  const offset = sourceOffset(record.source, parentTime - record.offset) + record.source.in - origin(clip, record.source.media);
  return record.source.media ? localAtSource(clip, offset) : offset;
}

/** Parents in the order their motion applies, with time local to each parent. */
export function* inheritedParents(clip, local) {
  if (!clip.inherited?.length) return;
  const stack = [{ clip, local, index: 0 }];
  while (stack.length) {
    const frame = stack.at(-1);
    const record = frame.clip.inherited?.[frame.index++];
    if (!record) { stack.pop(); continue; }
    const time = inheritedTime(record, frame.clip, frame.local);
    yield { parent: record.parent, local: time };
    if (record.parent.inherited?.length) stack.push({ clip: record.parent, local: time, index: 0 });
  }
}

export function retainMotion(copy, parent) {
  const media = timed(copy);
  const source = { in: origin(copy, media), duration: copy.duration, speed: media ? copy.speed || 1 : 1, media };
  if (media && copy.speedCurve) source.speedCurve = structuredClone(copy.speedCurve);
  const state = {};
  for (const key of ['name', 'in', 'speed', 'speedCurve', 'freeze', 'clockOnly', 'motionOffset', 'duration', 'transform', 'opacity', 'volume', 'fadeIn', 'fadeOut', 'animIn', 'animOut', 'animLoop', 'keyframes', 'inherited']) {
    if (parent[key] !== undefined) state[key] = structuredClone(parent[key]);
  }
  Object.assign(state, { type: 'compound', start: 0, blend: 'normal', muted: false });
  (copy.inherited ||= []).push({ offset: copy.start - parent.start, source, parent: state });
}

/** Changing media changes its source coordinates, but keeps the existing motion in time. */
export function preserveMotionClock(clip, change) {
  if (!clip.inherited?.length) return change();
  const clock = { start: clip.start, clockOnly: true };
  for (const key of ['in', 'speed', 'speedCurve', 'freeze', 'motionOffset', 'duration', 'inherited']) if (clip[key] !== undefined) clock[key] = clip[key];
  const result = change();
  delete clip.inherited;
  retainMotion(clip, clock);
  return result;
}

/** Iterative normalization avoids recursion limits in repeatedly flattened motion. */
export function normalizeInherited(raw, normalizeParent) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const pending = [{ raw, out }];
  const seen = new WeakSet();
  while (pending.length) {
    const frame = pending.pop();
    for (const record of frame.raw) {
      if (!record || typeof record !== 'object' || seen.has(record) || !record.parent || !record.source) continue;
      seen.add(record);
      const r = record.source;
      if (![record.offset, r.in, r.duration, r.speed].every(Number.isFinite) || r.duration <= 0 || r.speed <= 0) continue;
      const source = { in: r.in, duration: r.duration, speed: r.speed, media: r.media === true };
      const curve = normalizeCurve(r.speedCurve);
      if (curve) source.speedCurve = curve;
      const parent = normalizeParent(record.parent);
      frame.out.push({ offset: record.offset, source, parent });
      if (Array.isArray(record.parent.inherited) && record.parent.inherited.length) {
        parent.inherited = [];
        pending.push({ raw: record.parent.inherited, out: parent.inherited });
      }
    }
  }
  return out.length ? out : null;
}
