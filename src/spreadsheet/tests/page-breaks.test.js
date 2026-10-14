// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { normalizePrintSettings } from '../src/core/print-settings.js';
import { printBands, printTitleBands, setPrintBreakAxes, paginatePrintColumns } from '../src/ui/print-pagination.js';
import { buildPrintTable, manualBreaksApply, printBreakAxes } from '../src/ui/print.js';
import { pageBreaks, insertBreaks, removeBreaks, hasBreakAt, moveBreak, moveAreaEdge } from '../src/ui/pagebreaks.js';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

const book = (rows = 60) => {
  const cells = {};
  for (let r = 0; r < rows; r++) cells[`${r},0`] = { v: r + 1 };
  return new Workbook({ sheets: [{ name: 'Data', cells }] });
};

describe('page break model', () => {
  it('keeps breaks sorted, unique and inside the grid, and leaves settings without breaks unchanged', () => {
    expect(normalizePrintSettings({ rowBreaks: [12, 3, 3, 0, -1, 2.5, 'x'], colBreaks: [4] })).toMatchObject({ rowBreaks: [3, 12], colBreaks: [4] });
    const plain = normalizePrintSettings({});
    expect(plain).not.toHaveProperty('rowBreaks');
    expect(plain).not.toHaveProperty('colBreaks');
  });

  it('inserts, removes and resets breaks as one undo step each', () => {
    const wb = book(), id = wb.activeSheetId;
    expect(wb.setPageBreaks(id, insertBreaks({}, { active: { r: 10, c: 3 } }))).toBe(true);
    expect(wb.activeSheet.printSettings).toMatchObject({ rowBreaks: [10], colBreaks: [3] });
    wb.setPageBreaks(id, insertBreaks(wb.activeSheet.printSettings, { active: { r: 20, c: 0 }, wholeRows: true }));
    expect(wb.activeSheet.printSettings).toMatchObject({ rowBreaks: [10, 20], colBreaks: [3] });
    wb.setPageBreaks(id, removeBreaks(wb.activeSheet.printSettings, { active: { r: 10, c: 3 } }));
    expect(wb.activeSheet.printSettings.rowBreaks).toEqual([20]);
    expect(wb.activeSheet.printSettings).not.toHaveProperty('colBreaks');
    wb.undo();
    expect(wb.activeSheet.printSettings).toMatchObject({ rowBreaks: [10, 20], colBreaks: [3] });
    wb.setPageBreaks(id, { rows: [], cols: [] });
    expect(wb.activeSheet.printSettings.rowBreaks).toBeUndefined();
    wb.undo(); wb.undo(); wb.undo();
    expect(wb.activeSheet.printSettings).toBeNull();
  });

  it('a whole-column selection breaks only the columns and a cell in the first row only the columns', () => {
    expect(insertBreaks({}, { active: { r: 5, c: 4 }, wholeCols: true })).toEqual({ rows: [], cols: [4] });
    expect(insertBreaks({}, { active: { r: 0, c: 4 } })).toEqual({ rows: [], cols: [4] });
    expect(insertBreaks({}, { active: { r: 0, c: 0 } })).toEqual({ rows: [], cols: [] });
    expect(hasBreakAt({ rowBreaks: [5] }, { active: { r: 5, c: 2 } })).toBe(true);
    expect(hasBreakAt({ rowBreaks: [5] }, { active: { r: 5, c: 2 }, wholeCols: true })).toBe(false);
  });

  it('follows rows as they are inserted and deleted', () => {
    const wb = book(), id = wb.activeSheetId;
    wb.setPageBreaks(id, { rows: [10, 20], cols: [2] });
    wb.insertRows(id, 5, 3);
    expect(wb.activeSheet.printSettings.rowBreaks).toEqual([13, 23]);
    wb.deleteRows(id, 13, 1);
    // The break's own row went: it now stands above the next row kept.
    expect(wb.activeSheet.printSettings.rowBreaks).toEqual([13, 22]);
    wb.insertCols(id, 0, 1);
    expect(wb.activeSheet.printSettings.colBreaks).toEqual([3]);
  });

  it('moves a dragged break, makes a dragged automatic break manual, and removes one dragged off the area', () => {
    const area = { r1: 0, c1: 0, r2: 50, c2: 5 };
    expect(moveBreak({ rowBreaks: [10] }, area, { axis: 'row', from: 10, to: 14, manual: true })).toEqual([14]);
    expect(moveBreak({ rowBreaks: [10] }, area, { axis: 'row', from: 30, to: 25, manual: false })).toEqual([10, 25]);
    expect(moveBreak({ rowBreaks: [10] }, area, { axis: 'row', from: 10, to: 60, manual: true })).toEqual([]);
    expect(moveBreak({ colBreaks: [3] }, area, { axis: 'col', from: 3, to: 0, manual: true })).toEqual([]);
    expect(moveAreaEdge(area, 'bottom', 30)).toEqual({ r1: 0, c1: 0, r2: 30, c2: 5 });
    expect(moveAreaEdge(area, 'left', 9)).toEqual({ r1: 0, c1: 5, r2: 50, c2: 5 });
  });
});

describe('pagination with manual breaks', () => {
  it('starts a page at each forced line whatever room is left', () => {
    const sizes = Array(10).fill(20);
    expect(printBands(sizes, 1000).bands.map(b => [b.start, b.end])).toEqual([[0, 10]]);
    expect(printBands(sizes, 1000, 0, new Set([3, 7])).bands.map(b => [b.start, b.end])).toEqual([[0, 3], [3, 7], [7, 10]]);
    // Automatic breaks still fall inside a long manual page.
    expect(printBands(sizes, 50, 0, new Set([5])).bands.map(b => [b.start, b.end])).toEqual([[0, 2], [2, 4], [4, 5], [5, 7], [7, 9], [9, 10]]);
    // A forced break inside the repeated heading is ignored.
    expect(printBands(sizes, 1000, 2, new Set([1, 4])).bands.map(b => [b.start, b.end])).toEqual([[2, 4], [4, 10]]);
    expect(printTitleBands(sizes, 1000, {}, new Set([6])).length).toBe(2);
  });

  it('fit to pages ignores the breaks on the axes it fits', () => {
    expect(manualBreaksApply({ fit: 'actual' })).toEqual({ rows: true, cols: true });
    expect(manualBreaksApply({ fit: 'width' })).toEqual({ rows: true, cols: false });
    expect(manualBreaksApply({ fit: 'pages', fitWidth: 1, fitHeight: 0 })).toEqual({ rows: true, cols: false });
    expect(manualBreaksApply({ fit: 'pages', fitWidth: 1, fitHeight: 2 })).toEqual({ rows: false, cols: false });
  });

  it('Page Break Preview reports manual and automatic breaks along each axis', () => {
    const wb = book(120), id = wb.activeSheetId;
    wb.setPageBreaks(id, { rows: [5] });
    const breaks = pageBreaks(wb, id);
    expect(breaks.rowBreaks[0]).toEqual({ at: 5, manual: true });
    expect(breaks.rows[0]).toEqual([0, 4]);
    expect(breaks.rowBreaks.slice(1).every(b => !b.manual)).toBe(true);
    expect(breaks.rowBreaks.length).toBeGreaterThan(1);
  });

  it('maps breaks to the print table\'s own line indices, past hidden rows and the heading row', () => {
    // Rows 8 is hidden: the printed lines are 0-7, 9-29. A break above row 8 starts the page at row 9.
    const rows = [...Array(30).keys()].filter(r => r !== 8), cols = [0, 1, 2];
    const axes = printBreakAxes(rows, cols, { r1: 0, c1: 0, r2: 29, c2: 2 }, { fit: 'actual', rowBreaks: [8, 12, 0], colBreaks: [2] }, 1);
    expect([...axes.rows]).toEqual([8 + 1, 11 + 1]);
    expect([...axes.cols]).toEqual([2 + 1]);
    // Fit to page width leaves the columns to the fit.
    expect([...printBreakAxes(rows, cols, { r1: 0, c1: 0, r2: 29, c2: 2 }, { fit: 'width', rowBreaks: [], colBreaks: [2] }, 0)?.cols || []]).toEqual([]);
    const wb = book(30), id = wb.activeSheetId;
    wb.setHidden(id, 'row', [8], true);
    expect(buildPrintTable(wb, id, { fit: 'actual', rowBreaks: [8], colBreaks: [] }).rows.length).toBe(29);
  });

  it('paginates explicitly at the breaks the table records', () => {
    const sheet = document.createElement('div'); sheet.className = 'print-sheet';
    const table = document.createElement('table'); table.className = 'print-table'; sheet.append(table); document.body.append(sheet);
    const colgroup = document.createElement('colgroup'); table.append(colgroup);
    const col = document.createElement('col'); colgroup.append(col);
    const tbody = document.createElement('tbody'); table.append(tbody);
    const rect = (node, x, y, w, h) => vi.spyOn(node, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, w, h));
    rect(table, 0, 0, 100, 200); rect(col, 0, 0, 100, 200);
    for (let r = 0; r < 10; r++) {
      const row = document.createElement('tr'), cell = document.createElement('td');
      cell.dataset.cell = String(r); row.append(cell); tbody.append(row);
      rect(row, 0, r * 20, 100, 20); rect(cell, 0, r * 20, 100, 20);
    }
    setPrintBreakAxes(table, { rows: new Set([4]), cols: new Set() });
    const pages = paginatePrintColumns(sheet, { width: 600, height: 800 });
    expect(pages).toHaveLength(2);
    expect([...pages[0].querySelectorAll('[data-cell]')].map(n => n.dataset.cell)).toEqual(['0', '1', '2', '3']);
    expect([...pages[1].querySelectorAll('[data-cell]')].map(n => n.dataset.cell)).toEqual(['4', '5', '6', '7', '8', '9']);
  });
});
