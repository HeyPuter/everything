// Keyframes on strip properties (position, rotation, scale, opacity, volume). Keys live on the
// strip (`keys`, timeline frames, linear) and move with it; fades are keys on opacity / volume.
// Pure (unit tested): the app applies them on frame changes and renders evaluate per frame.
import type { Strip, StripKeyPath } from './types';
import { keyValue } from './fades';

export const KEY_PATHS: StripKeyPath[] = ['transform.offset_x', 'transform.offset_y', 'transform.rotation', 'transform.scale_x', 'transform.scale_y', 'blend_alpha', 'volume'];

export type KeyingSet = 'TRANSFORM' | 'LOCATION' | 'ROTATION' | 'SCALE' | 'OPACITY' | 'VOLUME' | 'ALL';

/** Properties a keying set keys on a strip. */
export function keyingPaths(s: Strip, set: KeyingSet): StripKeyPath[] {
  const sound = s.type === 'SOUND';
  switch (set) {
    case 'LOCATION':
      return sound ? [] : ['transform.offset_x', 'transform.offset_y'];
    case 'ROTATION':
      return sound ? [] : ['transform.rotation'];
    case 'SCALE':
      return sound ? [] : ['transform.scale_x', 'transform.scale_y'];
    case 'TRANSFORM':
      return sound ? [] : ['transform.offset_x', 'transform.offset_y', 'transform.rotation', 'transform.scale_x', 'transform.scale_y'];
    case 'OPACITY':
      return sound ? [] : ['blend_alpha'];
    case 'VOLUME':
      return sound ? ['volume'] : [];
    default:
      return sound ? ['volume'] : ['transform.offset_x', 'transform.offset_y', 'transform.rotation', 'transform.scale_x', 'transform.scale_y', 'blend_alpha'];
  }
}

export function getPath(s: Strip, path: StripKeyPath): number {
  if (path === 'volume') return s.volume ?? 1;
  if (path === 'blend_alpha') return s.blend_alpha;
  return s.transform[path.slice(10) as 'offset_x'];
}

export function setPath(s: Strip, path: StripKeyPath, v: number) {
  if (path === 'volume') s.volume = v;
  else if (path === 'blend_alpha') s.blend_alpha = v;
  else s.transform[path.slice(10) as 'offset_x'] = v;
}

/** Key the current values of the paths at a frame (replacing keys there). */
export function insertKeys(s: Strip, paths: StripKeyPath[], frame: number): number {
  let n = 0;
  for (const p of paths) {
    const keys = [...(s.keys?.[p] ?? [])].filter((k) => k[0] !== frame);
    keys.push([frame, getPath(s, p)]);
    keys.sort((a, b) => a[0] - b[0]);
    s.keys = { ...s.keys, [p]: keys };
    n++;
  }
  return n;
}

/** Remove keys at a frame; returns how many. */
export function deleteKeysAt(s: Strip, frame: number, paths: StripKeyPath[] = KEY_PATHS): number {
  if (!s.keys) return 0;
  let n = 0;
  for (const p of paths) {
    const k = s.keys[p];
    if (!k) continue;
    const kept = k.filter((x) => x[0] !== frame);
    n += k.length - kept.length;
    if (kept.length) s.keys[p] = kept;
    else delete s.keys[p];
  }
  if (!Object.keys(s.keys).length) delete s.keys;
  return n;
}

/** Remove all keys of the paths. */
export function clearKeys(s: Strip, paths: StripKeyPath[] = KEY_PATHS): boolean {
  if (!s.keys) return false;
  let any = false;
  for (const p of paths)
    if (s.keys[p]) {
      delete s.keys[p];
      any = true;
    }
  if (!Object.keys(s.keys).length) delete s.keys;
  return any;
}

/** Write animated values for a frame into the strip. */
export function applyKeys(s: Strip, frame: number): boolean {
  if (!s.keys) return false;
  let any = false;
  for (const [p, k] of Object.entries(s.keys) as [StripKeyPath, [number, number][]][]) {
    if (!k?.length) continue;
    setPath(s, p, keyValue(k, frame));
    any = true;
  }
  return any;
}

/** A copy of the strip with its animated values at a frame (renders of any frame). */
export function animatedStrip(s: Strip, frame: number): Strip {
  if (!s.keys) return s;
  const c: Strip = { ...s, transform: { ...s.transform, origin: [...s.transform.origin] as [number, number] } };
  applyKeys(c, frame);
  return c;
}

/** Frames that have a key on any property (sorted). */
export function keyFrames(s: Strip, paths: StripKeyPath[] = KEY_PATHS): number[] {
  const out = new Set<number>();
  for (const p of paths) for (const k of s.keys?.[p] ?? []) out.add(k[0]);
  return [...out].sort((a, b) => a - b);
}
