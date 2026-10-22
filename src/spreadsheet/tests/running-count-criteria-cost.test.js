import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// =COUNTIF($A$1:A1,A1) filled down, the running count that numbers duplicates, names a range in every row that
// repeats the rows of the one above. Each range was read once, so none was ever indexed, and every row tested its
// whole range: 20,000 rows tested 200 million cells, over a quarter of a minute, whenever the column was worked out
// whole (a save, a sort, a filter). The ranges of such a column now share one index, grown row by row.
const N = 20000;
function book(formula, value = (r) => `item${r % 997}`) {
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
  ['COUNTIF($A$1:A{r},A{r})', 'top down'],
  ['COUNTIF($A$1:A{r},A{r})', 'bottom up'],
  ['SUMIF($A$1:A{r},A{r},$B$1:B{r})', 'top down'],
  ['COUNTIF($B$1:B{r},B{r})', 'top down'],
])('%s down 20,000 rows read %s calculates in moments', (formula, order) => {
  const { wb, id } = book(formula);
  const rows = [...Array(N).keys()];
  if (order === 'bottom up') rows.reverse();
  const got = new Array(N);
  const start = performance.now();
  for (const r of rows) got[r] = wb.getValue(id, r, 2);
  expect(performance.now() - start).toBeLessThan(8000);
  const count = (r) => Math.floor(r / 997) + 1;
  if (formula.startsWith('COUNTIF($A')) expect([got[0], got[996], got[997], got[19999]]).toEqual([1, 1, 2, count(19999)]);
  if (formula.startsWith('COUNTIF($B')) expect([got[0], got[12], got[13], got[19999]]).toEqual([1, 1, 2, Math.floor(19999 / 13) + 1]);
  if (formula.startsWith('SUMIF')) expect(got[1994]).toBe((0 % 13) + (997 % 13) + (1994 % 13));
}, 120000);

it('answers each row of a running count as the range does read on its own', () => {
  const pool = ['apple', 'Apple', 'APPLE', 'pear', '1', '2', 1, 2, 2.0000000000000004, 'a b', '', true, 'é', 'x*y', ' 1', { error: '#N/A' }];
  const rows = 120;
  const value = (r) => pool[(r * 7 + (r >> 3)) % pool.length];
  const formulas = ['COUNTIF($A$1:A{r},A{r})', 'SUMIF($A$1:A{r},A{r},$B$1:B{r})', 'COUNTIFS($A$1:A{r},A{r},$B$1:B{r},">5")',
    'COUNTIF($A$1:A{r},"apple")', 'COUNTIF($A$1:A{r},2)', 'COUNTIF($A$1:B{r},A{r})'];
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

it('leaves out of the shared index a range read while a cell in it was still being calculated', () => {
  // B22 counts the ones down to itself: read while B22 was being calculated, its range held a provisional answer
  // there, and once joined to the family the index kept it, so B23 found no 20 in B22 and counted 0.
  const wb = new Workbook(), id = wb.activeSheetId;
  const cells = [];
  for (let r = 0; r < 20; r++) cells.push({ r, c: 1, cell: { v: 1 } });
  cells.push({ r: 20, c: 1, cell: { f: 'COUNTIF($B$1:B20,3)' } }, { r: 21, c: 1, cell: { f: 'COUNTIF($B$1:B22,1)' } },
    { r: 22, c: 1, cell: { f: 'COUNTIF($B$1:B22,B22)' } });
  wb.setCells(id, cells);
  expect([20, 21, 22].map((r) => wb.getValue(id, r, 1))).toEqual([0, 20, 1]);
});
