import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setTableHeaderRow } from '../src/core/table-header-row.js';

// Insert ▸ Cells (shift right) and Delete ▸ Cells (shift left) across a table's rows add or remove table columns,
// but the table's column names did not follow as they do for Insert/Delete Columns. With the Header Row off, the
// names the table keeps on itself stayed in their old order, so =SUM(T[Price]) silently added up the Qty column
// after a column went in, and read #REF! (while T[Qty] read the prices) after the first column went. With a header
// row, the new column's header cell was left blank. The names now follow, as for whole columns.
function setup({ header = true } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Qty', 'Price'], ['a', '1', '2'], ['b', '3', '4']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 2 }, { name: 'T' });
  if (!header) setTableHeaderRow(wb, id, wb.sheet(id).tables[0].id, false);
  wb.setInput(id, 6, 4, '=SUM(T[Price])');
  wb.setInput(id, 7, 4, '=SUM(T[Qty])');
  wb.clearHistory();
  const table = () => wb.sheet(id).tables[0];
  return { wb, id, table, names: () => wb.tableColumns(id, table()), totals: () => [wb.getValue(id, 6, 4), wb.getValue(id, 7, 4)] };
}

describe('table columns through Insert and Delete cells', () => {
  it('names a column shifted into a table without its header row, and keeps the others on their data', () => {
    const { wb, id, table, names, totals } = setup({ header: false });
    expect(totals()).toEqual([6, 4]);
    expect(wb.insertCells(id, { r1: table().range.r1, c1: 1, r2: table().range.r2, c2: 1 }, 'right')).toBe(true);
    expect(names()).toEqual(['Name', 'Column2', 'Qty', 'Price']);
    expect(totals()).toEqual([6, 4]);
    wb.undo();
    expect(names()).toEqual(['Name', 'Qty', 'Price']);
    expect(totals()).toEqual([6, 4]);
  });

  it('takes a deleted column’s name away with it in a table without its header row', () => {
    const { wb, id, table, names, totals } = setup({ header: false });
    expect(wb.deleteCells(id, { r1: table().range.r1, c1: 0, r2: table().range.r2, c2: 0 }, 'left')).toBe(true);
    expect(names()).toEqual(['Qty', 'Price']);
    expect(totals()).toEqual([6, 4]);
  });

  it('writes the new column’s name into the header row', () => {
    const { wb, id, names, totals } = setup();
    expect(wb.insertCells(id, { r1: 0, c1: 1, r2: 2, c2: 2 }, 'right')).toBe(true);
    expect(names()).toEqual(['Name', 'Column2', 'Column3', 'Qty', 'Price']);
    expect([wb.getValue(id, 0, 1), wb.getValue(id, 0, 2)]).toEqual(['Column2', 'Column3']);
    expect(totals()).toEqual([6, 4]);
    wb.undo();
    expect(wb.getCell(id, 0, 1)).toMatchObject({ v: 'Qty' });
  });
});
