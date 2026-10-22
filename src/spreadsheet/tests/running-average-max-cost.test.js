import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// =SUM($B$1:B1) filled down keeps the total so far for every row of its column (see running-total-sums), but a
// running average, maximum or minimum, =AVERAGE($B$1:B1), went over its whole range again in every row: twice to
// four times the time of the running total over 30,000 rows, growing with the column. They now keep their count,
// largest and smallest so far the same way, and cost what the running total does.
const N = 30000;
function book(formula, value = (r) => ((r * 37) % 101) - 50) {
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < N; r++) entries.push({ r, c: 0, cell: { v: value(r) } }, { r, c: 1, cell: { f: formula.replaceAll('{r}', String(r + 1)) } });
  wb.setCells(id, entries);
  return { wb, id };
}

/** The quicker of two full calculations of column B, read in `order`. */
function timed(formula, order) {
  const { wb, id } = book(formula);
  const rows = [...Array(N).keys()];
  if (order === 'bottom up') rows.reverse();
  let best = Infinity;
  for (let pass = 0; pass < 2; pass++) {
    wb.recalculate();
    const start = performance.now();
    for (const r of rows) wb.getValue(id, r, 1);
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

it.each([['MAX', 'top down'], ['AVERAGE', 'bottom up'], ['MIN', 'top down']])('a running %s read %s costs what a running total does', (fn, order) => {
  const total = timed('SUM($A$1:A{r})', order);
  expect(timed(`${fn}($A$1:A{r})`, order)).toBeLessThan(total * 1.6 + 300);
}, 120000);

it('answers every row as the range does on its own', () => {
  const values = [3, 'x', -0, 7, true, -2, '', 7, 1e308, -1e308, 4];
  const formulas = ['MAX($A$1:A{r})', 'MIN($A$1:A{r})', 'AVERAGE($A$1:A{r})', 'MAX($A$5:A{r})'];
  const rows = 80;
  for (const formula of formulas) {
    const all = new Workbook(), id = all.activeSheetId;
    const cells = [];
    for (let r = 0; r < rows; r++) cells.push({ r, c: 0, cell: { v: values[r % values.length] } });
    all.setCells(id, [...cells, ...[...Array(rows).keys()].map((r) => ({ r, c: 1, cell: { f: formula.replaceAll('{r}', String(r + 1)) } }))]);
    const column = [...Array(rows).keys()].map((r) => all.getValue(id, r, 1));
    for (let r = 0; r < rows; r += 3) {
      const one = new Workbook(), oid = one.activeSheetId;
      one.setCells(oid, [...cells, { r, c: 1, cell: { f: formula.replaceAll('{r}', String(r + 1)) } }]);
      expect(column[r], `${formula} in row ${r + 1}`).toEqual(one.getValue(oid, r, 1));
    }
  }
  const { wb, id } = book('MAX($A$1:A{r})');
  wb.setCells(id, [{ r: 10, c: 0, cell: { f: '1/0' } }]);
  expect([wb.getValue(id, 9, 1), wb.getValue(id, 10, 1), wb.getValue(id, 20000, 1)]).toEqual([44, { error: '#DIV/0!' }, { error: '#DIV/0!' }]);
});
