// Animated strip opacity / volume ("fades"). Keys are [timeline frame, value] pairs, sorted by
// frame, interpolated linearly and held constant outside their range. Pure functions (unit tested).
import type { Strip } from './types';
import { finalStart, finalEnd, inputCount } from './strips';

export type FadeProp = 'blend_alpha' | 'volume';
export type FadeType = 'IN_OUT' | 'IN' | 'OUT' | 'CURSOR_FROM' | 'CURSOR_TO';

/** The property a strip fades: volume for sound, opacity for everything else. */
export function fadeProp(s: Strip): FadeProp {
  return s.type === 'SOUND' ? 'volume' : 'blend_alpha';
}

export function keysOf(s: Strip, prop: FadeProp): [number, number][] | undefined {
  const k = s.keys?.[prop];
  return k && k.length ? k : undefined;
}

/** Linear interpolation through sorted keys. */
export function keyValue(keys: [number, number][], frame: number): number {
  if (frame <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (frame >= last[0]) return last[1];
  for (let i = 1; i < keys.length; i++) {
    const [f1, v1] = keys[i];
    if (frame <= f1) {
      const [f0, v0] = keys[i - 1];
      return f1 === f0 ? v1 : v0 + ((v1 - v0) * (frame - f0)) / (f1 - f0);
    }
  }
  return last[1];
}

/** Value of a strip property at a frame (animated when it has keys). */
export function valueAt(s: Strip, prop: FadeProp, frame: number): number {
  const keys = keysOf(s, prop);
  const base = prop === 'volume' ? (s.volume ?? 1) : s.blend_alpha;
  return keys ? keyValue(keys, frame) : base;
}

function setKey(keys: [number, number][], frame: number, value: number) {
  const i = keys.findIndex((k) => k[0] === frame);
  if (i >= 0) keys[i][1] = value;
  else keys.push([frame, value]);
  keys.sort((a, b) => a[0] - b[0]);
}

/**
 * Add a fade to a strip: `duration` frames at the start (IN), end (OUT) or both, or between the
 * strip edge and the current frame. Keys inside the faded range are replaced.
 */
export function addFade(s: Strip, type: FadeType, duration: number, current: number): boolean {
  if (inputCount(s.type)) return false;
  const prop = fadeProp(s);
  const a = finalStart(s),
    b = finalEnd(s);
  const full = valueAt(s, prop, (a + b) / 2) || (prop === 'volume' ? (s.volume ?? 1) : s.blend_alpha) || 1;
  const keys: [number, number][] = [...(s.keys?.[prop] ?? [])].map((k) => [k[0], k[1]]);
  const ranges: [number, number, number, number][] = []; // from, to, value at from, value at to
  // fading in and out: each half gets at most half of the strip
  const d = Math.max(1, Math.min(Math.round(duration), type === 'IN_OUT' ? Math.floor((b - a) / 2) : b - a));
  if (type === 'IN' || type === 'IN_OUT') ranges.push([a, a + d, 0, full]);
  if (type === 'OUT' || type === 'IN_OUT') ranges.push([b - d, b, full, 0]);
  if (type === 'CURSOR_TO') {
    if (current <= a || current > b) return false;
    ranges.push([a, current, 0, full]);
  }
  if (type === 'CURSOR_FROM') {
    if (current < a || current >= b) return false;
    ranges.push([current, b, full, 0]);
  }
  for (const [f0, f1, v0, v1] of ranges) {
    for (let i = keys.length - 1; i >= 0; i--) if (keys[i][0] >= f0 && keys[i][0] <= f1) keys.splice(i, 1);
    setKey(keys, f0, v0);
    setKey(keys, f1, v1);
  }
  s.keys = { ...s.keys, [prop]: keys };
  return true;
}

/** Remove fade animation (opacity and volume keys) from a strip. */
export function clearFade(s: Strip): boolean {
  if (!s.keys) return false;
  delete s.keys;
  return true;
}

/** Move a strip's keys with it (strip slide). */
export function shiftKeys(s: Strip, df: number) {
  if (!s.keys || !df) return;
  for (const k of Object.values(s.keys)) for (const p of k ?? []) p[0] += df;
}

/**
 * Sound crossfade between the active sound strip and the next/previous overlapping one: the
 * earlier strip fades out and the later one fades in over the overlap. Returns false if they don't overlap.
 */
export function crossfadeSounds(a: Strip, b: Strip): boolean {
  const [first, second] = finalStart(a) <= finalStart(b) ? [a, b] : [b, a];
  const f0 = finalStart(second),
    f1 = Math.min(finalEnd(first), finalEnd(second));
  if (f1 <= f0) return false;
  const v1 = first.volume ?? 1,
    v2 = second.volume ?? 1;
  const put = (s: Strip, k: [number, number][]) => {
    const keys = [...(s.keys?.volume ?? [])].filter((x) => x[0] < f0 || x[0] > f1);
    for (const p of k) setKey(keys, p[0], p[1]);
    s.keys = { ...s.keys, volume: keys };
  };
  put(first, [
    [f0, v1],
    [f1, 0],
  ]);
  put(second, [
    [f0, 0],
    [f1, v2],
  ]);
  return true;
}
