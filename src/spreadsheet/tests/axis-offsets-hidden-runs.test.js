import { describe, expect, it } from 'vitest';
import { AxisOffsets } from '../src/ui/axis-offsets.js';

// Rows hidden from under a list to the sheet's end (select below the data, Ctrl+Shift+Down, Hide) are a million
// lines of no height, and the grid laid the rows out with an entry per hidden row, sorted on every change to the
// sheet: about 450 ms of processor time each time a row was inserted or deleted, a sheet renamed or an edit undone.
// Neighbouring lines of one size are now one run, and a long list of them is read in order rather than sorted.

/** The dense layout: one running sum per line. */
function dense(n, d, sizes) {
  const out = [0];
  for (let i = 0; i < n; i++) out.push(out[i] + (sizes.has(i) ? sizes.get(i) : d));
  return out;
}

/** The first line whose end passes pos, never a line of no size, the last line past the end. */
function denseIndexAt(offsets, pos) {
  let lo = 0;
  let hi = offsets.length - 2;
  if (pos < 0) pos = 0;
  if (pos >= offsets[hi + 1]) return hi;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function check(n, d, entries, hidden) {
  const o = new AxisOffsets().build(n, d, entries, hidden);
  const sizes = new Map();
  for (const [i, s] of entries) if (i >= 0 && i < n) sizes.set(i, s);
  for (const lines of hidden) for (const i of lines) if (i >= 0 && i < n) sizes.set(i, 0);
  const want = dense(n, d, sizes);
  for (let i = 0; i <= n; i++) expect(o.at(i)).toBe(want[i]);
  for (let p = -3; p <= want[n] + 3; p++) expect(o.indexAt(p)).toBe(denseIndexAt(want, p));
  for (let a = 0; a < n; a += 7) expect(o.overridesIn(a, a + 9)).toEqual([...sizes].filter(([i, s]) => i >= a && i <= a + 9 && s !== d).sort((x, y) => x[0] - y[0]));
  return o;
}

describe('laying out runs of hidden and resized lines', () => {
  it('lays the rows hidden to the end of the sheet out as one run', () => {
    const hidden = new Set();
    for (let r = 210; r < 1048576; r++) hidden.add(r);
    const o = new AxisOffsets().build(1048576, 20, [[3, 40]], [hidden, new Set()]);
    expect(o.keys).toEqual([3, 210]);
    expect(o.total()).toBe(210 * 20 + 20);
    expect(o.at(210)).toBe(o.total());
    expect(o.indexAt(o.total() - 1)).toBe(209);
    expect(o.indexAt(o.total() + 500)).toBe(1048575);
  });

  it('places every line as the dense running sum does, however the runs fall', () => {
    let seed = 7;
    const rand = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    for (let t = 0; t < 40; t++) {
      const n = 1 + rand(60);
      const entries = Array.from({ length: rand(30) }, () => [rand(n + 4) - 2, [0, 5, 20, 31][rand(4)]]);
      const hidden = [new Set(Array.from({ length: rand(20) }, () => rand(n))), Array.from({ length: rand(8) }, () => rand(n))];
      check(n, 20, entries, hidden);
    }
  });

  it('reads a long list of lines in order and lays it out alike', () => {
    const n = 9000;
    const entries = [];
    for (let i = 0; i < n; i += 2) entries.push([i, i % 6 ? 25 : 0]);
    const hidden = new Set();
    for (let i = 5000; i < 7000; i++) hidden.add(i);
    const o = check(n, 20, entries, [hidden]);
    expect(o.keys.length).toBeLessThan(entries.length);
  });
});
