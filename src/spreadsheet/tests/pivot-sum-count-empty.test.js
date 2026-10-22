import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPivot } from '../src/core/pivot.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

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
  const row = (r, book = wb, sid = sheet.id) => Array.from({ length: built.cols }, (_, c) => book.getValue(sid, r, c));
  return { built, sheet, row };
}

// SUMIFS and COUNTIFS over an intersection with no rows are 0, so a Sum or Count pivot showed 0 where
// a row and a column share no records, while Average, Max and Min already showed nothing there, as a
// pivot table does. Such a cell is now blank for Sum and Count too, and a total over only blank cells
// (a filter leaving a category no rows) is blank as well. A zero the records add up to stays 0.
describe('pivot sum and count', () => {
  const sales = [
    ['Region', 'Quarter', 'Amount', 'Rep'],
    ['East', 'Q1', 100, 'a'], ['West', 'Q1', 50, 'b'], ['East', 'Q2', 25, 'a'], ['North', 'Q2', 7, 'b'], ['South', 'Q1', 5, 'a'], ['South', 'Q1', -5, 'a'],
  ];

  it('sum shows nothing where a row and column share no records', async () => {
    const { wb, id, range } = source(sales);
    const { row, sheet } = place(wb, id, { range, rowField: 0, colField: 1, valueField: 2, agg: 'sum' });
    expect(row(0)).toEqual(['Region', 'Q1', 'Q2', 'Total']);
    expect(row(1)).toEqual(['East', 100, 25, 125]);
    expect(row(2)).toEqual(['North', '', 7, 7]);
    expect(row(3)).toEqual(['South', 0, '', 0]);
    expect(row(4)).toEqual(['West', 50, '', 50]);
    expect(row(5)).toEqual(['Total', 150, 32, 182]);
    // Saved and opened again, the empty cells stay empty and stay live.
    const back = await workbookFromFile(await workbookToXlsx(wb), 'pivot.xlsx');
    const pivot = back.sheetByName(sheet.name);
    expect(row(2, back, pivot.id)).toEqual(['North', '', 7, 7]);
    back.setInput(back.sheets[0].id, 4, 1, 'Q1');
    expect(row(2, back, pivot.id)).toEqual(['North', 7, '', 7]);
  });

  it('count shows nothing where a row and column share no records', () => {
    const { wb, id, range } = source(sales);
    const { row } = place(wb, id, { range, rowField: 0, colField: 1, valueField: 2, agg: 'count' });
    expect(row(2)).toEqual(['North', '', 1, 1]);
    expect(row(3)).toEqual(['South', 2, '', 2]);
    expect(row(5)).toEqual(['Total', 4, 2, 6]);
  });

  it('shows blank totals for a category a filter leaves no rows', () => {
    const { wb, id, range } = source(sales);
    const { row, sheet } = place(wb, id, { range, rowField: 0, colField: 1, valueField: 2, agg: 'sum', filters: [{ field: 3, value: 'a' }] });
    expect(row(3)).toEqual(['East', 100, 25, 125]);
    expect(row(4)).toEqual(['North', '', '', '']);
    expect(row(7)).toEqual(['Total', 100, 25, 125]);
    wb.setInput(sheet.id, 0, 1, 'nobody');
    expect(row(7)).toEqual(['Total', '', '', '']);
  });
});
