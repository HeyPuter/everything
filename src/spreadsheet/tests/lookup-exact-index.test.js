import { afterEach, describe, expect, it, vi } from 'vitest';
import { FUNCTIONS, err } from '../src/core/formula/functions.js';
import { Workbook } from '../src/core/workbook.js';

// A range's values array is shared by every formula that reads it within one calculation. From
// its second use, an exact-match lookup (VLOOKUP with FALSE, MATCH with 0, XLOOKUP, XMATCH, HLOOKUP)
// indexes the lookup vector by its values, so two thousand lookups over twenty thousand rows visit
// the rows they name rather than every row, and none copies the column first. The answers are the
// ones a scan gives, whatever the case of the text, exactly for numbers, first or last as asked.
const ROWS = 4000;
const range = (values) => ({ range: true, values });
const keyAt = (r) => (r % 13 === 5 ? r / 10 : r % 17 === 3 ? `Key${r}` : `key${r}`);
const shared = () => {
  const table = range(Array.from({ length: ROWS }, (_, r) => [keyAt(r), r]));
  return { table, keys: range(table.values.map((row) => [row[0]])), values: range(table.values.map((row) => [row[1]])), row: range([table.values.map((row) => row[0])]) };
};
const column = () => range(Array.from({ length: ROWS }, (_, r) => [(r * 7919) % 10007]));

afterEach(() => vi.restoreAllMocks());

/** The same call on shared arrays (indexed from the second use) and on fresh ones (scanned). */
function both(name, args, make) {
  const s = make();
  const indexed = [1, 2, 3, 4].map(() => FUNCTIONS[name].fn(args(s)));
  const scanned = FUNCTIONS[name].fn(args(make()));
  expect(indexed[0]).toEqual(scanned);
  expect(indexed[3]).toEqual(scanned);
  return scanned;
}

describe('indexed exact lookups', () => {
  it('find text whatever its case, and the first of several, as a scan does', () => {
    expect(both('VLOOKUP', (s) => ['KEY20', s.table, 2, false], shared)).toBe(20);
    expect(both('VLOOKUP', (s) => ['key3', s.table, 2, false], shared)).toBe(3);
    expect(both('VLOOKUP', (s) => ['nowhere', s.table, 2, false], shared)).toEqual(err('#N/A'));
    expect(both('MATCH', (s) => ['key3', s.table, 0], shared)).toEqual(err('#N/A')); // a two-column range is no vector
    expect(both('MATCH', (s) => ['KEY3', s.keys, 0], shared)).toBe(4);
    expect(both('XLOOKUP', (s) => ['Key3', s.keys, s.values], shared)).toBe(3);
    expect(both('XMATCH', (s) => ['key3999', s.keys], shared)).toBe(4000);
    expect(both('HLOOKUP', (s) => ['KEY7', s.row, 1, false], shared)).toBe('key7');
    expect(both('MATCH', (s) => ['key3999', s.row, 0], shared)).toBe(4000);
    expect(both('XMATCH', (s) => ['key20', s.row, 0, -1], shared)).toBe(21);
  });

  it('match stored numbers exactly and never a number to its text, as a scan does', () => {
    const nums = () => range([[0.3], [1], ['2'], [true], [1e15 + 2], [-0], [1 / 3], [2], [null]]);
    expect(both('MATCH', (t) => [0.1 + 0.2, t, 0], nums)).toEqual(err('#N/A'));
    expect(both('MATCH', (t) => [2, t, 0], nums)).toBe(8);
    expect(both('MATCH', (t) => ['2', t, 0], nums)).toBe(3);
    expect(both('MATCH', (t) => [true, t, 0], nums)).toBe(4);
    expect(both('MATCH', (t) => [0, t, 0], nums)).toBe(6);
    expect(both('MATCH', (t) => [1e15 + 3, t, 0], nums)).toEqual(err('#N/A')); // = considers these equal; exact lookups distinguish them
    expect(both('MATCH', (t) => [1 / 3 + 1e-17, t, 0], nums)).toBe(7);
    expect(both('MATCH', (t) => [1.5, t, 0], nums)).toEqual(err('#N/A'));
    expect(both('MATCH', (t) => [null, t, 0], nums)).toEqual(err('#N/A'));
    expect(both('MATCH', (t) => [2, t, 0], column)).toEqual(err('#N/A'));
    expect(both('VLOOKUP', (t) => [7919, t, 1, false], column)).toBe(7919);
    expect(both('MATCH', (t) => [(3 * 7919) % 10007, t, 0], column)).toBe(4);
    expect(both('VLOOKUP', (s) => [4.4, s.table, 2, false], shared)).toBe(44);
    expect(both('VLOOKUP', (s) => ['4.4', s.table, 2, false], shared)).toEqual(err('#N/A'));
  });

  it('answer the last match when XLOOKUP and XMATCH search from the end, and leave wildcards to the scan', () => {
    const dup = () => range([['a'], ['b'], ['A'], ['b'], [7], ['x*'], [7]]);
    expect(both('XMATCH', (t) => ['a', t], dup)).toBe(1);
    expect(both('XMATCH', (t) => ['a', t, 0, -1], dup)).toBe(3);
    expect(both('XMATCH', (t) => [7, t, 0, -1], dup)).toBe(7);
    expect(both('XLOOKUP', (t) => ['B', t, t, 'none', 0, -1], dup)).toBe('b');
    expect(both('XMATCH', (t) => ['x*', t, 0], dup)).toBe(6); // exact mode: the star is a character
    expect(both('XMATCH', (t) => ['?', t, 2], dup)).toBe(1); // wildcard mode: any one character
    expect(both('MATCH', (t) => ['x~*', t, 0], dup)).toBe(6);
    expect(both('MATCH', (t) => ['*', t, 0], dup)).toBe(1);
  });

  it('leave the sorted, approximate and binary searches as they were', () => {
    const sorted = () => range(Array.from({ length: 50 }, (_, i) => [i * 3]));
    expect(both('VLOOKUP', (t) => [10, t, 1], sorted)).toBe(9);
    expect(both('MATCH', (t) => [10, t, 1], sorted)).toBe(4);
    expect(both('MATCH', (t) => [10, t, -1], sorted)).toEqual(err('#N/A'));
    expect(both('XMATCH', (t) => [10, t, 1, 2], sorted)).toBe(5);
    expect(both('XMATCH', (t) => [10, t, -1, 2], sorted)).toBe(4);
    expect(both('XLOOKUP', (t) => [10, t, t, 'none', -1, 1], sorted)).toBe(9);
    expect(both('XLOOKUP', (t) => [10, t, t, 'none', 1, -1], sorted)).toBe(12);
    expect(both('LOOKUP', (t) => [10, t], sorted)).toBe(9);
  });

  it('answer an error lookup value with that error, as a scan does', () => {
    const e = err('#N/A');
    const withErrors = () => range([['a'], [e], [err('#N/A')]]);
    expect(both('MATCH', (t) => [e, t, 0], withErrors)).toEqual(err('#N/A')); // MATCH(#N/A,...) is #N/A, never a position
    expect(both('MATCH', (t) => [err('#N/A'), t, 0], withErrors)).toEqual(err('#N/A'));
  });

  it('follow an edit through the sheet, since the index lives with the values it describes', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 50; r++) { wb.setInput(id, r, 0, `k${r}`); wb.setInput(id, r, 1, String(r * 2)); }
    for (let r = 0; r < 5; r++) { wb.setInput(id, r, 3, `=VLOOKUP("K${r + 10}",A:B,2,FALSE)`); wb.setInput(id, r, 4, `=MATCH("k${r + 10}",A:A,0)+XMATCH("k${r + 10}",A1:A50,0,-1)`); }
    const read = () => Array.from({ length: 5 }, (_, r) => [wb.getValue(id, r, 3), wb.getValue(id, r, 4)]);
    expect(read()).toEqual(Array.from({ length: 5 }, (_, r) => [(r + 10) * 2, 2 * (r + 11)]));
    wb.setInput(id, 10, 0, 'k11'); // k10 is gone; k11 now stands in rows 11 and 12, the first with 20 beside it
    expect(read()).toEqual([[err('#N/A'), err('#N/A')], [20, 11 + 12], [24, 26], [26, 28], [28, 30]]);
  });

  it('visit the rows a lookup names instead of every row, once the vector is indexed', () => {
    const s = shared();
    const keys = Array.from({ length: 300 }, (_, i) => `key${(i * 13) % ROWS}`);
    FUNCTIONS.VLOOKUP.fn([keys[0], s.table, 2, false]); // the first use of a vector is scanned
    FUNCTIONS.XMATCH.fn([keys[0], s.keys, 0, -1]);
    const lower = vi.spyOn(String.prototype, 'toLowerCase');
    let hits = 0;
    for (const key of keys) { if (FUNCTIONS.VLOOKUP.fn([key, s.table, 2, false]) !== null) hits++; }
    for (const key of keys) if (FUNCTIONS.XMATCH.fn([key, s.keys, 0, -1]) > 0) hits++;
    const calls = lower.mock.calls.length;
    lower.mockRestore();
    expect(hits).toBe(600);
    // Building the two indexes lowers each text once; a scan would lower every text for every lookup, 600 x 4000 times.
    expect(calls).toBeLessThan(ROWS * 3);
  });
});
