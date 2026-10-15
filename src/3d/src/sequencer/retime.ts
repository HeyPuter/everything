// Retiming: speed changes inside a strip. Keys map timeline frames (offsets from frame_start) to
// content frames; between keys the content plays at a constant speed, or eases from the speed
// before to the speed after (transition segments). Freeze frames are segments of speed 0.
// With keys, `frame_duration` is the timeline length of the whole content. Pure (unit tested).
import type { RetimingKey, Strip } from './types';
import { inputCount, isStill, clampOffsets, finalStart, finalEnd } from './strips';

export function retimable(s: Strip) {
  return !inputCount(s.type) && !isStill(s) && s.type !== 'META';
}

export function hasRetiming(s: Strip): boolean {
  return (s.retiming_keys?.length ?? 0) >= 2;
}

/** Number of source frames of the strip's content. */
export function contentLength(s: Strip): number {
  return hasRetiming(s) ? s.retiming_keys![s.retiming_keys!.length - 1].content : s.frame_duration;
}

/** The keys, created as a single speed-1 segment when the strip has none. */
export function ensureKeys(s: Strip): RetimingKey[] {
  if (!hasRetiming(s))
    s.retiming_keys = [
      { frame: 0, content: 0 },
      { frame: s.frame_duration, content: s.frame_duration },
    ];
  return s.retiming_keys!;
}

export function segmentSpeed(keys: RetimingKey[], i: number): number {
  const a = keys[Math.max(0, Math.min(keys.length - 2, i))],
    b = keys[Math.max(1, Math.min(keys.length - 1, i + 1))];
  return b.frame === a.frame ? 0 : (b.content - a.content) / (b.frame - a.frame);
}

/** Index of the segment containing a timeline offset (clamped to the first / last). */
export function segmentAt(keys: RetimingKey[], local: number): number {
  for (let i = 0; i < keys.length - 1; i++) if (local < keys[i + 1].frame) return i;
  return keys.length - 2;
}

/** Content frame offset (fractional) shown at a timeline offset from frame_start. */
export function mapContent(s: Strip, local: number): number {
  if (!hasRetiming(s)) return local;
  const k = s.retiming_keys!;
  const i = segmentAt(k, local);
  const a = k[i],
    b = k[i + 1];
  const d = b.frame - a.frame;
  if (d <= 0) return b.content;
  const u = Math.max(0, Math.min(1, (local - a.frame) / d));
  if (!a.transition) return a.content + (b.content - a.content) * u;
  // eased: cubic through both keys with the neighbouring segments' speeds as slopes
  const v0 = i > 0 ? segmentSpeed(k, i - 1) : (b.content - a.content) / d;
  const v1 = i + 1 < k.length - 1 ? segmentSpeed(k, i + 1) : (b.content - a.content) / d;
  const u2 = u * u,
    u3 = u2 * u;
  return (2 * u3 - 3 * u2 + 1) * a.content + (u3 - 2 * u2 + u) * d * v0 + (-2 * u3 + 3 * u2) * b.content + (u3 - u2) * d * v1;
}

/** Speed (content frames per timeline frame) at a timeline offset. */
export function speedAt(s: Strip, local: number): number {
  if (!hasRetiming(s)) return 1;
  const k = s.retiming_keys!;
  const i = segmentAt(k, local);
  if (!k[i].transition) return segmentSpeed(k, i);
  return (mapContent(s, local + 0.5) - mapContent(s, local - 0.5)) / 1;
}

function commit(s: Strip) {
  const k = s.retiming_keys!;
  s.frame_duration = Math.max(1, Math.round(k[k.length - 1].frame));
  clampOffsets(s);
}

/** Shift keys from index `from` on by `df` timeline frames (later content moves). */
function shiftFrom(k: RetimingKey[], from: number, df: number) {
  for (let j = from; j < k.length; j++) k[j].frame += df;
}

/** Add a key at a timeline offset; returns its index (-1 if not possible). */
export function addKey(s: Strip, local: number): number {
  if (!retimable(s)) return -1;
  const k = ensureKeys(s);
  local = Math.round(local);
  const at = k.findIndex((x) => x.frame === local);
  if (at >= 0) return at;
  if (local <= 0 || local >= k[k.length - 1].frame) return -1;
  const i = segmentAt(k, local);
  if (k[i].transition) return -1;
  k.splice(i + 1, 0, { frame: local, content: mapContent(s, local) });
  return i + 1;
}

/** Set the speed of segment `i` (1 = normal); later content shifts, the strip length changes. */
export function setSegmentSpeed(s: Strip, i: number, speed: number): boolean {
  if (!retimable(s) || speed <= 0) return false;
  const k = ensureKeys(s);
  if (i < 0 || i >= k.length - 1 || k[i].transition) return false;
  const a = k[i],
    b = k[i + 1];
  // frozen segments have no content to speed up
  if (b.content === a.content) return false;
  // exact (possibly fractional) length so the segment shows the requested speed
  const nd = Math.max(1, (b.content - a.content) / speed);
  shiftFrom(k, i + 1, a.frame + nd - b.frame);
  commit(s);
  return true;
}

/** Hold the content frame at a timeline offset for `duration` frames. */
export function addFreezeFrame(s: Strip, local: number, duration: number): boolean {
  duration = Math.round(duration);
  if (duration < 1) return false;
  const i = addKey(s, local);
  if (i < 0) return false;
  const k = s.retiming_keys!;
  if (i === k.length - 1) return false;
  const key = k[i];
  shiftFrom(k, i + 1, duration);
  k.splice(i + 1, 0, { frame: key.frame + duration, content: key.content });
  commit(s);
  return true;
}

/** Replace an inner key with an eased transition of `duration` frames centred on it. */
export function addTransition(s: Strip, i: number, duration: number): boolean {
  const k = s.retiming_keys;
  if (!k || i <= 0 || i >= k.length - 1) return false;
  if (k[i - 1].transition || k[i].transition) return false;
  const half = Math.max(1, Math.floor(duration / 2));
  const f = k[i].frame;
  if (f - half <= k[i - 1].frame || f + half >= k[i + 1].frame) return false;
  const a: RetimingKey = { frame: f - half, content: mapContent(s, f - half), transition: true };
  const b: RetimingKey = { frame: f + half, content: mapContent(s, f + half) };
  k.splice(i, 1, a, b);
  return true;
}

/** Remove keys (the first and last stay); a strip back at a single speed-1 segment drops its keys. */
export function deleteKeys(s: Strip, indices: number[]): boolean {
  const k = s.retiming_keys;
  if (!k) return false;
  const drop = new Set(indices.filter((i) => i > 0 && i < k.length - 1));
  if (!drop.size) return false;
  for (let i = k.length - 1; i >= 0; i--)
    if (drop.has(i)) {
      // a transition loses its ease when one of its keys goes
      if (k[i - 1]?.transition) k[i - 1].transition = false;
      k.splice(i, 1);
    }
  for (const x of k) if (x.transition && k.indexOf(x) === k.length - 1) x.transition = false;
  if (k.length === 2 && Math.abs(segmentSpeed(k, 0) - 1) < 1e-9) delete s.retiming_keys;
  else commit(s);
  return true;
}

/** Move key `i` by `df` timeline frames: the segment before it changes speed, later content follows. */
export function moveKey(s: Strip, i: number, df: number): boolean {
  const k = s.retiming_keys;
  if (!k || i <= 0) return false;
  const min = k[i - 1].frame + 1;
  const to = Math.max(min, Math.round(k[i].frame + df));
  if (to === k[i].frame) return false;
  shiftFrom(k, i, to - k[i].frame);
  commit(s);
  return true;
}

/** Back to normal speed everywhere. */
export function resetRetiming(s: Strip): boolean {
  if (!s.retiming_keys) return false;
  const len = contentLength(s);
  const a = finalStart(s);
  delete s.retiming_keys;
  s.frame_duration = Math.max(1, Math.round(len));
  // keep the left handle where it was
  s.frame_offset_start = Math.max(0, Math.min(a - s.frame_start, s.frame_duration - 1));
  clampOffsets(s);
  return true;
}

/** Selected key indices of a strip. */
export function selectedKeys(s: Strip): number[] {
  return (s.retiming_keys ?? []).map((k, i) => (k.select ? i : -1)).filter((i) => i >= 0);
}

/** Pieces of a retimed sound for playback in [from, to): constant-rate parts of the visible range. */
export function retimedPieces(s: Strip, from: number, to: number): { start: number; end: number; content: number; rate: number }[] {
  const a = Math.max(finalStart(s), from),
    b = Math.min(finalEnd(s), to);
  if (b <= a) return [];
  const k = s.retiming_keys!;
  const cuts = new Set<number>([a, b]);
  for (let i = 0; i < k.length; i++) {
    const f = s.frame_start + k[i].frame;
    if (f > a && f < b) cuts.add(f);
    // transitions are approximated by short constant-rate steps
    if (k[i].transition && i + 1 < k.length) for (let j = 1; j < 8; j++) {
      const g = s.frame_start + k[i].frame + ((k[i + 1].frame - k[i].frame) * j) / 8;
      if (g > a && g < b) cuts.add(g);
    }
  }
  const pts = [...cuts].sort((x, y) => x - y);
  const out: { start: number; end: number; content: number; rate: number }[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const c0 = mapContent(s, pts[i] - s.frame_start),
      c1 = mapContent(s, pts[i + 1] - s.frame_start);
    out.push({ start: pts[i], end: pts[i + 1], content: c0, rate: (c1 - c0) / (pts[i + 1] - pts[i]) });
  }
  return out;
}
