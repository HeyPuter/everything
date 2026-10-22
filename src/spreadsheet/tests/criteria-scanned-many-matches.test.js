import { expect, it } from 'vitest';
import { FUNCTIONS } from '../src/core/formula/functions.js';

// The cells a text criterion such as "<>"&B2 matches are found by testing the range once and kept for the next
// formula asking the same, up to 100,000 of them. Past that the search was dropped and the function tested every cell
// again itself: COUNTIF(A:A,"<>"&A1) beside a column of 150,000 entries took each formula twice as long as before the
// search was added. The cells found are now this formula's candidates, though not kept.
const ROWS = 120000;
const tally = { reads: 0 };
const values = Array.from({ length: ROWS }, (_, r) => new Proxy([`item ${r}`], {
  get: (t, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) tally.reads++; return t[k]; },
}));
const range = { range: true, values };

it('reads each cell once for a criterion matching more cells than are kept', () => {
  expect(FUNCTIONS.COUNTIF.fn([range, '<>item 1'])).toBe(ROWS - 1);
  for (const [k, fn, args] of [[2, 'COUNTIF', (c) => [range, c]], [3, 'COUNTIFS', (c) => [range, c]], [4, 'SUMIF', (c) => [range, c]]]) {
    tally.reads = 0;
    expect(FUNCTIONS[fn].fn(args(`<>item ${k}`)), fn).toBe(fn === 'SUMIF' ? 0 : ROWS - 1);
    // SUMIF reads the sum range at each cell matched as well, here the same cells: as many reads as without the search.
    expect(tally.reads, fn).toBeLessThanOrEqual(fn === 'SUMIF' ? 2 * ROWS : ROWS);
  }
});
