import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPivot } from '../src/core/pivot.js';

function source(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v, f: null } }))));
  return { wb, id, range: { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 } };
}

function place(wb, id, spec) {
  const built = buildPivot(wb, id, spec);
  const sheet = wb.addSheet('Pivot');
  wb.setCells(sheet.id, built.cells);
  const at = (r, c) => wb.getValue(sheet.id, r, c);
  return { built, sheet, at, row: (r) => Array.from({ length: built.cols }, (_, c) => at(r, c)) };
}

// MAXIFS / MINIFS over an intersection with no rows is 0, so a Max or Min pivot showed 0 in every empty
// cell, and that 0 then won the row total (a Min over positives, a Max over negatives). Such a cell is
// now blank, as it is in a pivot table, and the totals skip it.
describe('pivot max and min', () => {
  const sales = [
    ['Region', 'Quarter', 'Amount'],
    ['East', 'Q1', 100], ['West', 'Q1', 50], ['East', 'Q2', 25], ['North', 'Q2', 7], ['South', 'Q1', -5], ['South', 'Q2', -9],
  ];

  it('min shows nothing where a row and column share no source rows', () => {
    const { wb, id, range } = source(sales);
    const { row } = place(wb, id, { range, rowField: 0, colField: 1, valueField: 2, agg: 'min' });
    expect(row(0)).toEqual(['Region', 'Q1', 'Q2', 'Total']);
    expect(row(1)).toEqual(['East', 100, 25, 25]);
    expect(row(2)).toEqual(['North', '', 7, 7]);
    expect(row(3)).toEqual(['South', -5, -9, -9]);
    expect(row(4)).toEqual(['West', 50, '', 50]);
    expect(row(5)).toEqual(['Total', -5, -9, -9]);
  });

  it('max shows nothing where a row and column share no source rows', () => {
    const { wb, id, range } = source(sales.map((r, i) => (i && typeof r[2] === 'number' ? [r[0], r[1], -r[2]] : r)));
    const { row } = place(wb, id, { range, rowField: 0, colField: 1, valueField: 2, agg: 'max' });
    expect(row(1)).toEqual(['East', -100, -25, -25]);
    expect(row(2)).toEqual(['North', '', -7, -7]);
    expect(row(3)).toEqual(['South', 5, 9, 9]);
    expect(row(4)).toEqual(['West', -50, '', -50]);
    expect(row(5)).toEqual(['Total', 5, 9, 9]);
  });

  it('shows blank totals for a category a filter leaves no rows', () => {
    const { wb, id, range } = source(sales.map((r, i) => [...r, i ? (i % 2 ? 'a' : 'b') : 'Rep']));
    const { row, sheet } = place(wb, id, { range, rowField: 0, colField: 1, valueField: 2, agg: 'max', filters: [{ field: 3, value: 'a' }] });
    // Filter in row 1, blank row, header in row 3, then the categories and the total.
    expect(row(3)).toEqual(['East', 100, 25, 100]);
    expect(row(4)).toEqual(['North', '', '', '']);
    expect(row(5)).toEqual(['South', -5, '', -5]);
    expect(row(7)).toEqual(['Total', 100, 25, 100]);
    wb.setInput(sheet.id, 0, 1, 'nobody');
    expect(row(3)).toEqual(['East', '', '', '']);
    expect(row(7)).toEqual(['Total', '', '', '']);
  });
});
