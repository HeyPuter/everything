// Selection logic over strands (pure): grow / shrink along curves, ends, linked, random.
import { rng } from './data';

/** Grow (or shrink) a point selection by one point along each curve. */
export function growPoints(sel: ArrayLike<number>, offsets: ArrayLike<number>, grow: boolean): Float32Array {
  const out = Float32Array.from(sel);
  for (let c = 0; c + 1 < offsets.length; c++) {
    const a = offsets[c],
      e = offsets[c + 1];
    for (let i = a; i < e; i++) {
      const prev = i > a ? sel[i - 1] > 0 : grow ? false : true;
      const next = i + 1 < e ? sel[i + 1] > 0 : grow ? false : true;
      if (grow && !(sel[i] > 0) && (prev || next)) out[i] = 1;
      if (!grow && sel[i] > 0 && (!prev || !next)) out[i] = 0;
    }
  }
  return out;
}

/** Select the first `start` and last `end` points of every curve (others deselected). */
export function selectEnds(offsets: ArrayLike<number>, total: number, start: number, end: number): Float32Array {
  const out = new Float32Array(total);
  for (let c = 0; c + 1 < offsets.length; c++) {
    const a = offsets[c],
      e = offsets[c + 1];
    for (let i = a; i < Math.min(e, a + start); i++) out[i] = 1;
    for (let i = Math.max(a, e - end); i < e; i++) out[i] = 1;
  }
  return out;
}

/** Whole curves of any selected point. */
export function linkedPoints(sel: ArrayLike<number>, offsets: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(sel);
  for (let c = 0; c + 1 < offsets.length; c++) {
    let any = false;
    for (let i = offsets[c]; i < offsets[c + 1]; i++) if (sel[i] > 0) any = true;
    if (any) out.fill(1, offsets[c], offsets[c + 1]);
  }
  return out;
}

/** Randomly select / deselect elements. */
export function randomSelect(sel: ArrayLike<number>, probability: number, seed: number, select: boolean): Float32Array {
  const r = rng(seed + 1);
  const out = Float32Array.from(sel);
  for (let i = 0; i < out.length; i++) if (r() < probability) out[i] = select ? 1 : 0;
  return out;
}

export function applyAction(sel: Float32Array, action: string): Float32Array {
  const out = new Float32Array(sel.length);
  let a = action;
  if (a === 'TOGGLE') a = sel.some((x) => x > 0) ? 'DESELECT' : 'SELECT';
  for (let i = 0; i < out.length; i++) out[i] = a === 'SELECT' ? 1 : a === 'DESELECT' ? 0 : sel[i] > 0 ? 0 : 1;
  return out;
}

export function combine(cur: number, hit: number, mode: 'SET' | 'ADD' | 'SUB' | 'AND' | 'XOR'): number {
  const c = cur > 0 ? 1 : 0;
  return mode === 'SET' ? hit : mode === 'ADD' ? c | hit : mode === 'SUB' ? c & (hit ^ 1) : mode === 'AND' ? c & hit : c ^ hit;
}
