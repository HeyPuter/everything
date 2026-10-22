import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { buildPivot } from '../src/core/pivot.js';

// A pivot's labels are the ones found when it was built, while its formulas are live. The grand total was
// a live aggregate over the whole source column, so a value typed into the source after the build counted
// towards the total while no category row showed it: the rows stopped adding up to the total, with nothing
// on the sheet to say a category was missing. Every total now reads the category cells it stands under.
const grid = (rows) => rows.flatMap((row, r) => row.map((v, c) => (v == null ? null : { r, c, cell: { v } }))).filter(Boolean);

function pivot(rows, spec) {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Pivot' }] });
  const [data, out] = wb.sheets;
  wb.setCells(data.id, grid(rows), 'Data');
  const range = parseRange(`A1:${String.fromCharCode(65 + rows[0].length - 1)}${rows.length}`);
  wb.addTable(data.id, range, { name: 'T' });
  const built = buildPivot(wb, data.id, { range, colField: null, ...spec });
  wb.setCells(out.id, built.cells, 'Insert pivot table');
  const grab = () => Array.from({ length: built.rows }, (_, r) => Array.from({ length: built.cols }, (_, c) => wb.getValue(out.id, r, c)));
  // Typed cell by cell, so the table takes the new row in and the pivot's live formulas see it.
  const type = (r, values) => values.forEach((v, c) => wb.setInput(data.id, r, c, String(v)));
  return { wb, data: data.id, out: out.id, built, grab, type };
}

const SRC = [['Region', 'Amt'], ['W', 1], ['E', 2], ['W', 4]];

describe('a pivot total covers exactly the categories it stands under', () => {
  it('leaves a value typed into the source after the build out of the sum, as it is out of the rows', () => {
    const { grab, type } = pivot(SRC, { rowField: 0, valueField: 1, agg: 'sum' });
    expect(grab()).toEqual([['Region', 'Sum of Amt'], ['E', 2], ['W', 5], ['Total', 7]]);
    type(4, ['N', 100]);
    expect(grab()).toEqual([['Region', 'Sum of Amt'], ['E', 2], ['W', 5], ['Total', 7]]);
    // A value in a category the pivot does have still flows through, rows and total together.
    type(5, ['E', 3]);
    expect(grab()).toEqual([['Region', 'Sum of Amt'], ['E', 5], ['W', 5], ['Total', 10]]);
  });

  it('counts the same rows in the total as in the categories', () => {
    const { grab, type } = pivot(SRC, { rowField: 0, valueField: 1, agg: 'count' });
    expect(grab()).toEqual([['Region', 'Count of Amt'], ['E', 1], ['W', 2], ['Total', 3]]);
    type(4, ['N', 100]);
    expect(grab()).toEqual([['Region', 'Count of Amt'], ['E', 1], ['W', 2], ['Total', 3]]);
  });

  it('takes the largest and smallest from the category cells', () => {
    for (const [agg, before, after] of [['max', [2, 4, 4], [2, 4, 4]], ['min', [2, 1, 1], [2, 1, 1]]]) {
      const { grab, type } = pivot(SRC, { rowField: 0, valueField: 1, agg });
      expect(grab().slice(1).map((r) => r[1])).toEqual(before);
      type(4, ['N', 100]);
      type(5, ['N', -100]);
      expect(grab().slice(1).map((r) => r[1])).toEqual(after);
    }
  });

  it('keeps both totals of a crossed pivot on its own categories', () => {
    const rows = [['Region', 'Kind', 'Amt'], ['W', 'a', 1], ['E', 'b', 2], ['W', 'b', 4]];
    const { grab, type } = pivot(rows, { rowField: 0, colField: 1, valueField: 2, agg: 'sum' });
    expect(grab()).toEqual([
      ['Region', 'a', 'b', 'Total'],
      ['E', '', 2, 2],
      ['W', 1, 4, 5],
      ['Total', 1, 6, 7],
    ]);
    // A new row category, then a new column category: neither has a cell of its own, so neither counts.
    type(4, ['N', 'a', 100]);
    type(5, ['W', 'z', 50]);
    expect(grab()).toEqual([
      ['Region', 'a', 'b', 'Total'],
      ['E', '', 2, 2],
      ['W', 1, 4, 5],
      ['Total', 1, 6, 7],
    ]);
  });

  it('keeps a filtered pivot adding up', () => {
    const rows = [['Region', 'Kind', 'Amt'], ['W', 'a', 1], ['E', 'b', 2], ['W', 'b', 4]];
    const { grab } = pivot(rows, { rowField: 0, valueField: 2, agg: 'sum', filters: [{ field: 1, value: 'b' }] });
    expect(grab()).toEqual([
      ['Kind', 'b'],
      [null, null],
      ['Region', 'Sum of Amt'],
      ['E', 2],
      ['W', 4],
      ['Total', 6],
    ]);
  });

  it('averages the whole source, which no arithmetic on the category averages gives', () => {
    const { built, grab } = pivot(SRC, { rowField: 0, valueField: 1, agg: 'average' });
    expect(grab()).toEqual([['Region', 'Average of Amt'], ['E', 2], ['W', 2.5], ['Total', 7 / 3]]);
    expect(built.cells.filter((c) => c.cell.f).map((c) => c.cell.f).at(-1)).toBe('AVERAGE(T[Amt])');
  });
});
