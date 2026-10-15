// Pure selection rules of the timeline (unit tested): neighbours, handles, linked chains,
// channel sides, matching time ranges and shape hit tests.
import type { Strip } from './types';
import { finalStart, finalEnd, inputCount } from './strips';

/** The strip on the same channel whose edge touches `s` on the given side. */
export function neighbor(list: Strip[], s: Strip, side: 'LEFT' | 'RIGHT'): Strip | null {
  const a = finalStart(s),
    b = finalEnd(s);
  for (const o of list) {
    if (o === s || o.channel !== s.channel) continue;
    if (side === 'LEFT' && finalEnd(o) === a) return o;
    if (side === 'RIGHT' && finalStart(o) === b) return o;
  }
  return null;
}

export type HandleSide = 'BOTH' | 'LEFT' | 'RIGHT' | 'BOTH_NEIGHBORS' | 'LEFT_NEIGHBOR' | 'RIGHT_NEIGHBOR';

/** Select handles of the selected strips (or the touching handles of their neighbours). */
export function selectHandles(list: Strip[], side: HandleSide): boolean {
  const sel = list.filter((s) => s.select && !inputCount(s.type));
  if (!sel.length) return false;
  for (const s of sel) {
    switch (side) {
      case 'LEFT':
        s.select_left_handle = true;
        s.select_right_handle = false;
        break;
      case 'RIGHT':
        s.select_left_handle = false;
        s.select_right_handle = true;
        break;
      case 'BOTH':
        s.select_left_handle = s.select_right_handle = true;
        break;
      default: {
        // the shared edit point: this strip's edge and the neighbour's touching edge
        s.select_left_handle = s.select_right_handle = false;
        if (side !== 'RIGHT_NEIGHBOR') {
          const l = neighbor(list, s, 'LEFT');
          if (l) {
            l.select = true;
            l.select_right_handle = true;
            s.select_left_handle = true;
          }
        }
        if (side !== 'LEFT_NEIGHBOR') {
          const r = neighbor(list, s, 'RIGHT');
          if (r) {
            r.select = true;
            r.select_left_handle = true;
            s.select_right_handle = true;
          }
        }
      }
    }
  }
  return true;
}

/** Select every strip of the selection's channels lying on one side of the selected ones. */
export function selectChannelSide(list: Strip[], side: 'LEFT' | 'RIGHT' | 'BOTH'): boolean {
  const sel = list.filter((s) => s.select);
  if (!sel.length) return false;
  const ranges = new Map<number, [number, number]>();
  for (const s of sel) {
    const r = ranges.get(s.channel);
    ranges.set(s.channel, r ? [Math.min(r[0], finalStart(s)), Math.max(r[1], finalEnd(s))] : [finalStart(s), finalEnd(s)]);
  }
  for (const o of list) {
    const r = ranges.get(o.channel);
    if (!r) continue;
    if ((side !== 'RIGHT' && finalEnd(o) <= r[0]) || (side !== 'LEFT' && finalStart(o) >= r[1])) {
      o.select = true;
      o.select_left_handle = o.select_right_handle = false;
    }
  }
  return true;
}

/** Grow (more) or shrink (less) the selection by touching neighbours on the same channel. */
export function selectMoreLess(list: Strip[], more: boolean): boolean {
  const flip: Strip[] = [];
  for (const s of list) {
    if (s.select !== more) continue;
    const touching = [neighbor(list, s, 'LEFT'), neighbor(list, s, 'RIGHT')].filter((n): n is Strip => !!n);
    for (const n of touching) if (n.select !== more) flip.push(n);
  }
  for (const s of flip) {
    s.select = more;
    if (!more) s.select_left_handle = s.select_right_handle = false;
  }
  return flip.length > 0;
}

/** Every strip connected to `seed` through a chain of touching neighbours. */
export function linkedChain(list: Strip[], seed: Strip): Strip[] {
  const out = new Set<Strip>([seed]);
  const todo = [seed];
  while (todo.length) {
    const s = todo.pop()!;
    for (const side of ['LEFT', 'RIGHT'] as const) {
      const n = neighbor(list, s, side);
      if (n && !out.has(n)) {
        out.add(n);
        todo.push(n);
      }
    }
  }
  return [...out];
}

/** Strips on other channels covering exactly the same range as `s`. */
export function sameTime(list: Strip[], s: Strip): Strip[] {
  return list.filter((o) => o !== s && o.channel !== s.channel && finalStart(o) === finalStart(s) && finalEnd(o) === finalEnd(s));
}

/** Box selection decision with "include handles": whole strip, one handle, or nothing. */
export function boxHit(x0: number, x1: number, rx0: number, rx1: number, handleW: number): 'STRIP' | 'LEFT' | 'RIGHT' | null {
  if (rx1 < x0 || rx0 > x1) return null;
  const left = rx0 <= x0 + handleW && rx1 >= x0;
  const right = rx0 <= x1 && rx1 >= x1 - handleW;
  if (left && right) return 'STRIP';
  if (left) return 'LEFT';
  if (right) return 'RIGHT';
  return 'STRIP';
}

export function pointInPolygon(x: number, y: number, poly: [number, number][]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i],
      [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside;
  }
  return inside;
}

/** Whether a rectangle touches a circle. */
export function rectCircle(r: { x0: number; y0: number; x1: number; y1: number }, cx: number, cy: number, rad: number) {
  const nx = Math.max(r.x0, Math.min(r.x1, cx)),
    ny = Math.max(r.y0, Math.min(r.y1, cy));
  return Math.hypot(nx - cx, ny - cy) <= rad;
}

/** Whether a rectangle overlaps a lasso polygon (centre or a corner inside, or a lasso point inside the rectangle). */
export function rectLasso(r: { x0: number; y0: number; x1: number; y1: number }, poly: [number, number][]) {
  if (poly.length < 3) return false;
  const pts: [number, number][] = [
    [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2],
    [r.x0, r.y0],
    [r.x1, r.y0],
    [r.x1, r.y1],
    [r.x0, r.y1],
  ];
  if (pts.some(([x, y]) => pointInPolygon(x, y, poly))) return true;
  return poly.some(([x, y]) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
}
