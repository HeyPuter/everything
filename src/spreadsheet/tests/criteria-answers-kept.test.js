import { afterEach, expect, it } from 'vitest';
import { FUNCTIONS } from '../src/core/formula/functions.js';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';

// SUMIFS(C:C,B:B,B2) filled down a list of 20,000 rows in five categories added up 4,000 amounts for every row, 80
// million additions for five distinct answers: about a second whenever the column was worked out, growing with the
// square of the rows. An answer is now kept beside the values it was worked out from, for the next formula asking
// the same of them in the same calculation.
afterEach(() => setLocale('en-US'));

const counted = (values, tally) => ({ range: true, values: values.map((row) => new Proxy(row, {
  get: (t, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) tally.reads++; return t[k]; },
})) });

it('answers the same question of the same values without reading them again', () => {
  const tally = { reads: 0 };
  const labels = { range: true, values: Array.from({ length: 2000 }, (_, r) => [`k${r % 13}`]) };
  const amounts = counted(Array.from({ length: 2000 }, (_, r) => [r]), tally);
  const sum = [...Array(2000).keys()].filter((r) => r % 13 === 5).reduce((a, b) => a + b, 0);
  for (const [name, args, answer] of [
    ['SUMIFS', [amounts, labels, 'k5'], sum],
    ['SUMIF', [labels, 'k5', amounts], sum],
    ['AVERAGEIF', [labels, 'k5', amounts], sum / 154],
    ['AVERAGEIFS', [amounts, labels, 'k5'], sum / 154],
    ['MAXIFS', [amounts, labels, 'k5'], 1994],
    ['MINIFS', [amounts, labels, 'k5'], 5],
  ]) {
    expect(FUNCTIONS[name].fn(args), name).toBe(answer);
    tally.reads = 0;
    expect(FUNCTIONS[name].fn(args), name).toBe(answer);
    expect(FUNCTIONS[name].fn([...args]), name).toBe(answer);
    expect(tally.reads, name).toBe(0);
  }
  // Another criterion, or other values, is worked out afresh.
  tally.reads = 0;
  expect(FUNCTIONS.SUMIFS.fn([amounts, labels, 'k6'])).toBe([...Array(2000).keys()].filter((r) => r % 13 === 6).reduce((a, b) => a + b, 0));
  expect(tally.reads).toBeGreaterThan(0);
  const fresh = { range: true, values: amounts.values.map((row) => [row[0] * 2]) };
  expect(FUNCTIONS.SUMIFS.fn([fresh, labels, 'k5'])).toBe(sum * 2);
});

it('answers by the regional settings in force', () => {
  const values = [['1,5'], ['1.5'], [1.5], ['15'], ['1.234,5'], ['1,234.5']];
  const cells = { range: true, values };
  const asked = (locale) => {
    setLocale(locale);
    return [FUNCTIONS.COUNTIFS.fn([cells, '1,5']), FUNCTIONS.COUNTIFS.fn([{ range: true, values: values.map((row) => [...row]) }, '1,5'])];
  };
  for (const locale of ['en-US', 'de-DE', 'en-US', 'de-DE']) {
    const [kept, fresh] = asked(locale);
    expect(kept, locale).toBe(fresh);
  }
  expect(asked('en-US')[0]).not.toBe(asked('de-DE')[0]);
});

it('keeps a column of category totals right through edits', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const n = 500;
  const entries = [];
  for (let r = 0; r < n; r++) {
    entries.push({ r, c: 0, cell: { v: `c${r % 5}` } }, { r, c: 1, cell: { v: r } });
    entries.push({ r, c: 2, cell: { f: `SUMIFS(B:B,A:A,A${r + 1})` } }, { r, c: 3, cell: { f: `AVERAGEIF(A:A,A${r + 1},B:B)` } });
  }
  wb.setCells(id, entries);
  const total = (k) => [...Array(n).keys()].filter((r) => r % 5 === k).reduce((a, b) => a + b, 0);
  const column = (c) => Array.from({ length: n }, (_, r) => wb.getValue(id, r, c));
  expect(column(2)).toEqual(Array.from({ length: n }, (_, r) => total(r % 5)));
  expect(column(3)).toEqual(Array.from({ length: n }, (_, r) => total(r % 5) / 100));
  wb.setInput(id, 7, 1, '1007');
  expect(wb.getValue(id, 2, 2)).toBe(total(2) + 1000);
  expect(wb.getValue(id, 497, 2)).toBe(total(2) + 1000);
  expect(wb.getValue(id, 1, 2)).toBe(total(1));
  wb.setInput(id, 7, 0, 'c1');
  expect(wb.getValue(id, 2, 2)).toBe(total(2) - 7);
  expect(wb.getValue(id, 1, 2)).toBe(total(1) + 1007);
  wb.undo(); wb.undo();
  expect(column(2)).toEqual(Array.from({ length: n }, (_, r) => total(r % 5)));
});
