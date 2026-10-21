import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A file saved while scrolled freezes rows and columns that start further down and right than A1 (its sheetView's
// topLeftCell). Inserting or deleting lines went by the frozen count alone, as if the pane started at A1: lines
// put in above the pane left it where it was, over other content, and lines put in inside it were not frozen.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'Data', frozenRows: 2, frozenCols: 1, frozenOrigin: { r: 10, c: 3 } }] });
  const id = wb.activeSheetId;
  wb.setInput(id, 10, 3, 'Title');
  wb.setInput(id, 11, 3, 'Header');
  wb.clearHistory();
  const pane = () => { const s = wb.sheet(id); return { rows: s.frozenRows, cols: s.frozenCols, origin: s.frozenOrigin || null }; };
  return { wb, id, pane };
}

it('moves a pane that starts lower down with its content, and grows it over lines inserted inside it', () => {
  const { wb, id, pane } = book();
  wb.insertRows(id, 4, 2); // above the pane
  expect(pane()).toEqual({ rows: 2, cols: 1, origin: { r: 12, c: 3 } });
  expect(wb.getValue(id, 12, 3)).toBe('Title');
  wb.insertRows(id, 13, 1); // between its two rows
  expect(pane()).toEqual({ rows: 3, cols: 1, origin: { r: 12, c: 3 } });
  wb.insertRows(id, 15, 4); // below it
  expect(pane()).toEqual({ rows: 3, cols: 1, origin: { r: 12, c: 3 } });
  wb.insertCols(id, 0, 1); // left of it
  expect(pane()).toEqual({ rows: 3, cols: 1, origin: { r: 12, c: 4 } });
  wb.insertCols(id, 4, 1); // at its column
  expect(pane()).toEqual({ rows: 3, cols: 2, origin: { r: 12, c: 4 } });
  wb.undo(); wb.undo(); wb.undo(); wb.undo(); wb.undo();
  expect(pane()).toEqual({ rows: 2, cols: 1, origin: { r: 10, c: 3 } });
});

it('moves a pane that starts lower down up when lines above it are deleted, and shrinks it by its own', () => {
  const { wb, id, pane } = book();
  wb.deleteRows(id, 2, 3);
  expect(pane()).toEqual({ rows: 2, cols: 1, origin: { r: 7, c: 3 } });
  expect(wb.getValue(id, 7, 3)).toBe('Title');
  wb.deleteRows(id, 6, 2); // the row above it and its first row
  expect(pane()).toEqual({ rows: 1, cols: 1, origin: { r: 6, c: 3 } });
  expect(wb.getValue(id, 6, 3)).toBe('Header');
  wb.deleteCols(id, 1, 3); // two columns left of it and its own
  expect(pane()).toEqual({ rows: 1, cols: 0, origin: { r: 6, c: 0 } });
});
