import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// =MATCH(A2,$A$1:A2,0) filled down, the check whether a value came before, names a range in every row that repeats
// the rows of the one above. Each range was read once, so none was ever indexed, and every row scanned its whole
// range for a value seen nowhere before it: 20,000 rows of distinct values took nine seconds, 30,000 twenty,
// whenever the column was worked out whole. The ranges of such a column now share one index, grown row by row.
// The column takes about a second on a laptop and eight to ten seconds on a CI runner: the budget sits above
// both, and below the twenty seconds the scan took on a laptop.
const N = 30000;
function book(formula, value = (r) => `item${r}`) {
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < N; r++) {
    entries.push({ r, c: 0, cell: { v: value(r) } }, { r, c: 1, cell: { v: r % 13 } });
    entries.push({ r, c: 2, cell: { f: formula.replaceAll('{r}', String(r + 1)) } });
  }
  wb.setCells(id, entries);
  return { wb, id };
}

it.each([
  ['MATCH(A{r},$A$1:A{r},0)', 'top down'],
  ['MATCH(A{r},$A$1:A{r},0)', 'bottom up'],
  ['VLOOKUP(A{r},$A$1:B{r},2,FALSE)', 'top down'],
  ['XMATCH(A{r},$A$1:A{r},0,-1)', 'top down'],
])('%s down 30,000 rows read %s calculates in moments', (formula, order) => {
  const { wb, id } = book(formula);
  const rows = [...Array(N).keys()];
  if (order === 'bottom up') rows.reverse();
  const got = new Array(N);
  const start = performance.now();
  for (const r of rows) got[r] = wb.getValue(id, r, 2);
  expect(performance.now() - start).toBeLessThan(15000);
  if (formula.startsWith('VLOOKUP')) expect([got[0], got[29999]]).toEqual([0, 29999 % 13]);
  else expect([got[0], got[999], got[29999]]).toEqual([1, 1000, 30000]);
}, 120000);

it('answers each row as the range does read on its own', () => {
  const pool = ['apple', 'Apple', 'pear', '1', 1, 2, 2.0000000000000004, true, false, 'a b', '', 0, 'é', 'x*y', { error: '#N/A' }];
  const rows = 120;
  const value = (r) => pool[(r * 7 + (r >> 2)) % pool.length];
  const formulas = ['MATCH(A{r},$A$1:A{r},0)', 'VLOOKUP(A{r},$A$1:B{r},2,FALSE)', 'XMATCH(A{r},$A$1:A{r},0,-1)',
    'XLOOKUP(A{r},$A$1:A{r},$B$1:B{r},"none",2)', 'MATCH("apple",$A$1:A{r},0)', 'XMATCH(TRUE,$A$1:A{r},0,-1)'];
  const build = (formula, at) => {
    const wb = new Workbook(), id = wb.activeSheetId;
    const entries = [];
    for (let r = 0; r < rows; r++) entries.push({ r, c: 0, cell: { v: value(r) } }, { r, c: 1, cell: { v: r % 9 } });
    for (const r of at) entries.push({ r, c: 2, cell: { f: formula.replaceAll('{r}', String(r + 1)) } });
    wb.setCells(id, entries);
    return { wb, id };
  };
  for (const formula of formulas) {
    const all = build(formula, [...Array(rows).keys()]);
    const column = [...Array(rows).keys()].map((r) => all.wb.getValue(all.id, r, 2));
    for (let r = 0; r < rows; r += 7) {
      const one = build(formula, [r]);
      expect(column[r], `${formula} in row ${r + 1}`).toEqual(one.wb.getValue(one.id, r, 2));
    }
  }
});
