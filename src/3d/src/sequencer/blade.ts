// Box blade: cut the strips inside a frame × channel box at both box edges, remove the pieces
// inside it and optionally close the gap left behind. Pure (unit tested).
import type { Strip } from './types';
import { finalStart, finalEnd, splitStrips, inputCount, nextGap, translateStrip, dependentEffects } from './strips';

export interface BoxBladeResult {
  removed: Strip[];
  closed: number;
}

/**
 * `strips` are the candidates (already filtered for locks); those on channels [c0, c1] crossing
 * [f0, f1) are cut. With `removeGaps` the strips after the box move left when nothing else fills it.
 */
export function boxBlade(ed: { strips: Strip[] }, list: Strip[], candidates: Strip[], f0: number, f1: number, c0: number, c1: number, removeGaps: boolean): BoxBladeResult {
  f0 = Math.round(Math.min(f0, f1));
  f1 = Math.round(Math.max(f0, f1));
  if (f1 <= f0) return { removed: [], closed: 0 };
  const inBox = (s: Strip) => s.channel >= Math.min(c0, c1) && s.channel <= Math.max(c0, c1) && !inputCount(s.type) && finalStart(s) < f1 && finalEnd(s) > f0;
  const hit = candidates.filter(inBox);
  if (!hit.length) return { removed: [], closed: 0 };
  const right = splitStrips(ed, list, hit, f0, 'SOFT');
  // the right halves of the first cut are new strips: cut those reaching past the box again
  const pieces = [...hit, ...right].filter((s) => list.includes(s) && inBox(s));
  const right2 = splitStrips(ed, list, pieces, f1, 'SOFT');
  const inside = [...pieces, ...right2].filter((s) => inBox(s) && finalStart(s) >= f0 && finalEnd(s) <= f1);
  const names = new Set(inside.map((s) => s.name));
  const dead = new Set([...inside, ...dependentEffects(list, names).filter((e) => list.includes(e))]);
  for (const s of dead) list.splice(list.indexOf(s), 1);
  let closed = 0;
  if (removeGaps) {
    const gap = nextGap(list, f0);
    if (gap && gap[0] === f0) {
      closed = gap[1] - gap[0];
      for (const s of list) if (finalStart(s) >= gap[1]) translateStrip(s, -closed);
    }
  }
  return { removed: [...dead], closed };
}
