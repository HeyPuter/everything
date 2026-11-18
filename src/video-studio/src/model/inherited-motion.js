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
  for (const key of ['name', 'in', 'speed', 'speedCurve', 'freeze', 'clockOnly', 'motionOffset', 'duration', 'transform', 'opacity', 'volume', 'fadeIn', 'fadeOut', 'animIn', 'animOut', 'animLoop', 'keyframes', 'inherited', 'timing']) {
    if (parent[key] !== undefined) state[key] = structuredClone(parent[key]);
  }
  Object.assign(state, { type: 'compound', start: 0, blend: 'normal', muted: false });
  (copy.inherited ||= []).push({ offset: copy.start - parent.start, source, parent: state });
}

/** Changing media changes its source coordinates, but keeps the existing motion in time. */
export function preserveMotionClock(clip, change) {
  if (!clip.inherited?.length && !clip.timing && !clip.transitionSlices?.length) return change();
  const before = { start: clip.start, clockOnly: true };
  for (const key of ['in', 'speed', 'speedCurve', 'freeze', 'motionOffset', 'duration', 'inherited']) if (clip[key] !== undefined) before[key] = clip[key];
  const timing = clip.timing;
  const slices = clip.transitionSlices;
  const result = change();
  if (before.inherited?.length) {
    delete clip.inherited;
    retainMotion(clip, before);
  }
  if (timing) {
    clip.timing = {};
    for (const [field, saved] of Object.entries(timing)) {
      const holder = { ...clip, inherited: undefined };
      retainMotion(holder, { ...before, inherited: saved.clock });
      clip.timing[field] = { duration: saved.duration, clock: holder.inherited };
    }
  }
  if (slices?.length) clip.transitionSlices = slices.map(slice => {
    const holder = { ...clip, inherited: undefined };
    retainMotion(holder, { ...before, inherited: slice.clock });
    const retained = { ...slice, clock: holder.inherited };
    if (slice.inherited?.length) {
      const wrapper = { ...clip, inherited: undefined };
      retainMotion(wrapper, { ...before, inherited: slice.inherited });
      retained.inherited = wrapper.inherited;
    }
    return retained;
  });
  return result;
}

export const TIMING_FIELDS = ['animIn', 'animOut', 'animLoop', 'fadeIn', 'fadeOut', 'effects', 'intrinsic', 'trackEffect'];

/** Keep only clocks: the visible clip's animation, effect and fade controls stay authoritative. */
export function retainContentTiming(clip) {
  const fields = TIMING_FIELDS.filter(field => {
    if (field === 'effects') return clip.effects?.length || clip.stylize;
    if (field === 'intrinsic') return clip.type === 'sticker' || clip.type === 'avatar';
    if (field === 'trackEffect') return clip.type === 'effect';
    return Boolean(clip[field]);
  });
  if (!fields.length) return;
  const holder = { ...clip, inherited: undefined };
  retainMotion(holder, { start: clip.start, duration: clip.duration, clockOnly: true });
  clip.timing ||= {};
  for (const field of fields) clip.timing[field] ||= { duration: clip.duration, clock: holder.inherited };
}

export function clockTime(clip, local, clock) {
  for (let record = clock?.[0]; record; record = clip.inherited?.[0]) {
    local = inheritedTime(record, clip, local);
    clip = record.parent;
  }
  return local;
}

export function clockLocal(clip, time, clock) {
  const frames = [];
  let owner = clip, records = clock;
  while (records?.length) {
    const record = records[0]; frames.push({ owner, record });
    owner = record.parent; records = owner.inherited;
  }
  for (let i = frames.length - 1; i >= 0; i--) time = inheritedLocal(frames[i].record, frames[i].owner, time);
  return time;
}

export function captureClock(clip) {
  const holder = { ...clip, inherited: undefined };
  retainMotion(holder, { start: clip.start, duration: clip.duration, clockOnly: true });
  return holder.inherited;
}

export function contentTime(clip, local, field) {
  const saved = clip.timing?.[field];
  return saved ? { local: clockTime(clip, local, saved.clock), duration: saved.duration } : { local, duration: clip.duration };
}

/** Explicit replacement of a setting starts its new timing at the current clip's boundaries. */
export function resetContentTiming(clip, field) {
  if (!clip.timing) return;
  delete clip.timing[field];
  if (!Object.keys(clip.timing).length) delete clip.timing;
}

export function normalizeTiming(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const field of TIMING_FIELDS) {
    const saved = raw[field];
    if (!saved || !Number.isFinite(saved.duration) || saved.duration <= 0) continue;
    const clock = normalizeInherited(saved.clock, p => ({
      type: 'compound', start: 0, clockOnly: true,
      in: Number.isFinite(p.in) ? p.in : 0, motionOffset: Number.isFinite(p.motionOffset) ? p.motionOffset : 0,
      duration: Number.isFinite(p.duration) && p.duration > 0 ? p.duration : saved.duration,
      speed: Number.isFinite(p.speed) && p.speed > 0 ? p.speed : 1,
      ...(p.speedCurve ? { speedCurve: normalizeCurve(p.speedCurve) } : {}), freeze: p.freeze === true,
    }));
    if (clock) out[field] = { duration: saved.duration, clock };
  }
  return Object.keys(out).length ? out : null;
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
