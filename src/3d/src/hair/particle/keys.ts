// Hand-edited hair keys of particle systems (pure helpers): building them from generated strands,
// strand subsets, rekeying, subdividing, mirroring, unifying lengths, removing doubles.
import type { EditedHair } from '../../physics/types';
import { resamplePolyline } from '../brushmath';

export const strandCount = (ed: EditedHair) => ed.key_offsets.length - 1;
export const keyCount = (ed: EditedHair) => ed.co.length / 3;

/** Edited hair from strands with `per` points each (e.g. evaluated parents). */
export function editedFromStrands(points: Float32Array, per: number, strands: number): EditedHair {
  const n = strands * per;
  const offs = new Uint32Array(strands + 1);
  for (let i = 0; i <= strands; i++) offs[i] = i * per;
  return { key_offsets: offs, co: points.slice(0, n * 3), weight: new Float32Array(n).fill(1), select: new Uint8Array(n), hide: new Uint8Array(strands) };
}

/** Strand index of each key. */
export function keyStrands(ed: EditedHair): Uint32Array {
  const out = new Uint32Array(keyCount(ed));
  for (let s = 0; s < strandCount(ed); s++) out.fill(s, ed.key_offsets[s], ed.key_offsets[s + 1]);
  return out;
}

/** Strands with any selected key (hidden ones excluded). */
export function selectedStrands(ed: EditedHair): Uint8Array {
  const out = new Uint8Array(strandCount(ed));
  for (let s = 0; s < out.length; s++) {
    if (ed.hide[s]) continue;
    for (let k = ed.key_offsets[s]; k < ed.key_offsets[s + 1]; k++) if (ed.select[k]) out[s] = 1;
  }
  return out;
}

/** Rebuild from per-strand key lists (co xyz, weight, select per key) and hide flags. */
export function fromStrandLists(list: { co: ArrayLike<number>; weight: ArrayLike<number>; select: ArrayLike<number>; hide: number }[]): EditedHair {
  let n = 0;
  for (const s of list) n += s.co.length / 3;
  const ed: EditedHair = { key_offsets: new Uint32Array(list.length + 1), co: new Float32Array(n * 3), weight: new Float32Array(n), select: new Uint8Array(n), hide: new Uint8Array(list.length) };
  let o = 0;
  list.forEach((s, i) => {
    const k = s.co.length / 3;
    ed.co.set(s.co, o * 3);
    ed.weight.set(s.weight, o);
    ed.select.set(s.select, o);
    ed.hide[i] = s.hide;
    o += k;
    ed.key_offsets[i + 1] = o;
  });
  return ed;
}

/** Per-strand key lists (copies). */
export function toStrandLists(ed: EditedHair) {
  const out: { co: Float32Array; weight: Float32Array; select: Uint8Array; hide: number }[] = [];
  for (let s = 0; s < strandCount(ed); s++) {
    const a = ed.key_offsets[s],
      b = ed.key_offsets[s + 1];
    out.push({ co: ed.co.slice(a * 3, b * 3), weight: ed.weight.slice(a, b), select: ed.select.slice(a, b), hide: ed.hide[s] });
  }
  return out;
}

/** Resample the selected strands to `keys` keys (weights interpolated, selection kept on all keys). */
export function rekey(ed: EditedHair, which: ArrayLike<number>, keys: number): EditedHair {
  keys = Math.max(2, Math.round(keys));
  return fromStrandLists(
    toStrandLists(ed).map((s, i) => {
      if (!which[i]) return s;
      const co = resamplePolyline(s.co, keys);
      const w = new Float32Array(keys);
      for (let k = 0; k < keys; k++) {
        const t = (k / (keys - 1)) * (s.weight.length - 1);
        const a = Math.floor(t),
          b = Math.min(s.weight.length - 1, a + 1);
        w[k] = s.weight[a] * (1 - (t - a)) + s.weight[b] * (t - a);
      }
      return { co, weight: w, select: new Uint8Array(keys).fill(1), hide: s.hide };
    }),
  );
}

/** Insert a key between every pair of neighbouring selected keys. */
export function subdivideKeys(ed: EditedHair): EditedHair {
  return fromStrandLists(
    toStrandLists(ed).map((s) => {
      const n = s.weight.length;
      const co: number[] = [],
        w: number[] = [],
        sel: number[] = [];
      for (let k = 0; k < n; k++) {
        co.push(s.co[k * 3], s.co[k * 3 + 1], s.co[k * 3 + 2]);
        w.push(s.weight[k]);
        sel.push(s.select[k]);
        if (k + 1 < n && s.select[k] && s.select[k + 1] && !s.hide) {
          co.push((s.co[k * 3] + s.co[k * 3 + 3]) / 2, (s.co[k * 3 + 1] + s.co[k * 3 + 4]) / 2, (s.co[k * 3 + 2] + s.co[k * 3 + 5]) / 2);
          w.push((s.weight[k] + s.weight[k + 1]) / 2);
          sel.push(1);
        }
      }
      return { co, weight: w, select: sel, hide: s.hide };
    }),
  );
}

/** Remove strands whose roots lie closer than `threshold` to an earlier strand's root. */
export function removeDoubles(ed: EditedHair, threshold: number, onlySelected: ArrayLike<number> | null): { ed: EditedHair; removed: number } {
  const lists = toStrandLists(ed);
  const keep: typeof lists = [];
  let removed = 0;
  for (let i = 0; i < lists.length; i++) {
    const s = lists[i];
    const dup = (!onlySelected || onlySelected[i]) && keep.some((k) => Math.hypot(k.co[0] - s.co[0], k.co[1] - s.co[1], k.co[2] - s.co[2]) <= threshold);
    if (dup) removed++;
    else keep.push(s);
  }
  return { ed: removed ? fromStrandLists(keep) : ed, removed };
}

/** Mirrored copies (across the local X axis) of the selected strands, appended. */
export function mirrorStrands(ed: EditedHair, which: ArrayLike<number>): EditedHair {
  const lists = toStrandLists(ed);
  const add = lists
    .filter((_, i) => which[i])
    .map((s) => {
      const co = s.co.slice();
      for (let k = 0; k < co.length; k += 3) co[k] = -co[k];
      return { ...s, co, select: s.select.slice() };
    });
  return fromStrandLists([...lists, ...add]);
}

/** Scale the selected strands (around their roots) to their average length. */
export function unifyLength(ed: EditedHair, which: ArrayLike<number>): EditedHair {
  const out: EditedHair = { ...ed, co: ed.co.slice() };
  const lens: number[] = [];
  const len = (s: number) => {
    let l = 0;
    for (let k = ed.key_offsets[s] + 1; k < ed.key_offsets[s + 1]; k++) l += Math.hypot(ed.co[k * 3] - ed.co[k * 3 - 3], ed.co[k * 3 + 1] - ed.co[k * 3 - 2], ed.co[k * 3 + 2] - ed.co[k * 3 - 1]);
    return l;
  };
  for (let s = 0; s < strandCount(ed); s++) if (which[s]) lens.push(len(s));
  if (!lens.length) return ed;
  const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
  for (let s = 0; s < strandCount(ed); s++) {
    if (!which[s]) continue;
    const l = len(s);
    if (l <= 0) continue;
    const f = avg / l;
    const a = ed.key_offsets[s];
    for (let k = a + 1; k < ed.key_offsets[s + 1]; k++) for (let j = 0; j < 3; j++) out.co[k * 3 + j] = ed.co[a * 3 + j] + (ed.co[k * 3 + j] - ed.co[a * 3 + j]) * f;
  }
  return out;
}

/** Remove strands (mask) or keys (mask per key; strands left with fewer than two keys go too). */
export function deleteStrands(ed: EditedHair, strandMask: ArrayLike<number>): EditedHair {
  return fromStrandLists(toStrandLists(ed).filter((_, i) => !strandMask[i]));
}

export function deleteKeys(ed: EditedHair, keyMask: ArrayLike<number>): EditedHair {
  const out: ReturnType<typeof toStrandLists> = [];
  toStrandLists(ed).forEach((s, i) => {
    const a = ed.key_offsets[i];
    const co: number[] = [],
      w: number[] = [],
      sel: number[] = [];
    for (let k = 0; k < s.weight.length; k++) {
      if (keyMask[a + k]) continue;
      co.push(s.co[k * 3], s.co[k * 3 + 1], s.co[k * 3 + 2]);
      w.push(s.weight[k]);
      sel.push(0);
    }
    if (w.length >= 2) out.push({ co: Float32Array.from(co), weight: Float32Array.from(w), select: Uint8Array.from(sel), hide: s.hide });
  });
  return fromStrandLists(out);
}
