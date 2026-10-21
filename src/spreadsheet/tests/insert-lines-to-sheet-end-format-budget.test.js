import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Inserted lines take the formatting of the line before them, stored cell by cell. Rows selected from under a
// formatted list to the sheet's end (Ctrl+Shift+Down from a row header) and inserted lent the list's last row to
// every one of a million new rows: five million styled empty cells, minutes with the page frozen and a gigabyte
// of memory, then every save carrying them. The lent formatting now goes only as far as formatting a range stores
// empty cells (50,000), as for Insert cells; past that the new lines are left plain.
function list() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 50; r++) for (let c = 0; c < 5; c++) wb.setInput(id, r, c, String(r * c));
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 49, c2: 4 }, { bold: true, bg: '#eeeeee' });
  wb.clearHistory();
  return { wb, id };
}

describe('formatting lent to inserted lines', () => {
  it('stays quick and stores nothing for a million rows inserted under a formatted row', () => {
    const { wb, id } = list();
    const started = performance.now();
    expect(wb.insertRows(id, 50, 1048576 - 50)).toBe(true);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(wb.sheet(id).cells.size).toBe(250);
    expect(wb.getCell(id, 51, 0)).toBeUndefined();
    wb.undo();
    expect(wb.sheet(id).rows).toBeLessThan(1048576);
  });

  it('is left out of cells inserted by the hundred thousand, too', () => {
    const { wb, id } = list();
    expect(wb.insertCells(id, { r1: 50, c1: 0, r2: 200049, c2: 4 }, 'down')).toBe(true);
    expect(wb.sheet(id).cells.size).toBe(250);
  });

  it('still reaches every new line of an ordinary insertion', () => {
    const { wb, id } = list();
    expect(wb.insertRows(id, 10, 100)).toBe(true);
    for (const r of [10, 60, 109]) expect(wb.getCell(id, r, 4)).toEqual({ v: null, f: null, s: { bold: true, bg: '#eeeeee' } });
    expect(wb.insertCols(id, 2, 3)).toBe(true);
    expect(wb.getCell(id, 0, 4)).toEqual({ v: null, f: null, s: { bold: true, bg: '#eeeeee' } });
  });
});

// A whole row's own format (rows 1:50 formatted from their headers) was lent to each of a million rows inserted
// under it as well: a million line formats that every later save, insertion and undo wrote out again, each taking
// half a minute. Lent line formats now stop at the same budget.
describe('whole-line formats lent to inserted lines', () => {
  it('are not stored for a million rows inserted under a formatted row, and later edits stay quick', () => {
    const { wb, id } = list();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 49, c2: 16383 }, { bg: '#eeeeee' });
    expect(wb.sheet(id).rowStyles.size).toBe(50);
    expect(wb.insertRows(id, 50, 1048576 - 50)).toBe(true);
    expect(wb.sheet(id).rowStyles.size).toBe(50);
    const started = performance.now();
    expect(JSON.stringify(wb.toJSON()).length).toBeLessThan(200000);
    expect(wb.insertRows(id, 5, 1)).toBe(true);
    wb.undo();
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('are still lent to the rows of an ordinary insertion', () => {
    const { wb, id } = list();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 49, c2: 16383 }, { bg: '#eeeeee' });
    expect(wb.insertRows(id, 50, 20)).toBe(true);
    expect(wb.styleAt(id, 69, 300)?.bg).toBe('#eeeeee');
    expect(wb.styleAt(id, 70, 300)?.bg).toBeUndefined();
  });
});
