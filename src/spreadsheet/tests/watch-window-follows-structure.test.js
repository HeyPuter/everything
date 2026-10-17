import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Watch Window entries are cell addresses that never followed structural edits: after inserting rows the
// watch showed whatever had moved into the old address, and a deleted cell's watch lived on at a stranger.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Revenue', '100'], ['Cost', '40'], ['Profit', '=B1-B2']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addWatches(id, [{ r: 2, c: 1 }]);
  const other = wb.addSheet('Two').id;
  wb.addWatches(other, [{ r: 2, c: 1 }]);
  wb.setActiveSheet(id);
  return { wb, id, other };
}
const at = (wb, id) => wb.watches.filter(w => w.sheetId === id).map(w => [w.r, w.c]);

describe('watched cells follow structural edits', () => {
  it('follow inserted and deleted rows, and undo puts them back', () => {
    const { wb, id, other } = book();
    const before = wb.toJSON();
    wb.insertRows(id, 0, 2);
    expect(at(wb, id)).toEqual([[4, 1]]);
    expect(wb.getCell(id, 4, 1).f).toBe('B3-B4');
    expect(at(wb, other)).toEqual([[2, 1]]);
    wb.deleteRows(id, 4, 1);
    expect(at(wb, id)).toEqual([]);
    wb.undo();
    expect(at(wb, id)).toEqual([[4, 1]]);
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    wb.redo();
    expect(at(wb, id)).toEqual([[4, 1]]);
  });

  it('follow inserted columns, moved rows and shifted cells', () => {
    const { wb, id } = book();
    wb.insertCols(id, 0, 1);
    expect(at(wb, id)).toEqual([[2, 2]]);
    wb.moveRows(id, 2, 1, 0);
    expect(at(wb, id)).toEqual([[0, 2]]);
    wb.insertCells(id, { r1: 0, c1: 2, r2: 0, c2: 2 }, 'down');
    expect(at(wb, id)).toEqual([[1, 2]]);
    wb.deleteCells(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, 'up');
    expect(at(wb, id)).toEqual([[1, 2]]);
    wb.deleteCells(id, { r1: 1, c1: 2, r2: 1, c2: 2 }, 'left');
    expect(at(wb, id)).toEqual([]);
  });

  // Adding and removing a watch is no undo step: undoing or redoing a structural edit reverses or repeats only
  // what the edit did to the watches, and leaves alone the ones added or removed since.
  it('keeps a watch added after the edit through its undo and redo', () => {
    const { wb, id } = book();
    wb.insertRows(id, 0, 2);
    wb.addWatches(id, [{ r: 0, c: 1 }]);
    wb.undo();
    expect(at(wb, id)).toEqual([[2, 1], [0, 1]]);
    wb.redo();
    expect(at(wb, id)).toEqual([[4, 1], [0, 1]]);
  });

  it('does not bring back a watch removed after the edit', () => {
    const { wb, id } = book();
    wb.insertRows(id, 0, 2);
    wb.removeWatches([{ sheetId: id, r: 4, c: 1 }]);
    wb.undo();
    expect(at(wb, id)).toEqual([]);
    wb.redo();
    expect(at(wb, id)).toEqual([]);
  });

  it('on redo leaves alone a watch added or removed after the undo', () => {
    const { wb, id } = book();
    wb.addWatches(id, [{ r: 0, c: 0 }]);
    wb.insertRows(id, 0, 2);
    expect(at(wb, id)).toEqual([[4, 1], [2, 0]]);
    wb.undo();
    wb.removeWatches([{ sheetId: id, r: 0, c: 0 }]);
    wb.addWatches(id, [{ r: 9, c: 9 }]);
    wb.redo();
    expect(at(wb, id)).toEqual([[4, 1], [9, 9]]);
  });

  it('brings back a watch the edit deleted, keeping one added since', () => {
    const { wb, id } = book();
    wb.addWatches(id, [{ r: 0, c: 0 }]);
    wb.deleteRows(id, 2, 1);
    expect(at(wb, id)).toEqual([[0, 0]]);
    wb.addWatches(id, [{ r: 5, c: 5 }]);
    wb.undo();
    expect(at(wb, id)).toEqual([[2, 1], [0, 0], [5, 5]]);
    wb.redo();
    expect(at(wb, id)).toEqual([[0, 0], [5, 5]]);
  });

  it('reverses only its own moves for several structural steps in one transaction', () => {
    const { wb, id, other } = book();
    wb.transaction('Two edits', () => { wb.insertRows(id, 0, 1); wb.insertCols(id, 0, 1); wb.insertRows(other, 0, 3); });
    expect(at(wb, id)).toEqual([[3, 2]]);
    expect(at(wb, other)).toEqual([[5, 1]]);
    wb.addWatches(id, [{ r: 7, c: 7 }]);
    wb.removeWatches([{ sheetId: other, r: 5, c: 1 }]);
    wb.undo();
    expect(at(wb, id)).toEqual([[2, 1], [7, 7]]);
    expect(at(wb, other)).toEqual([]);
    wb.redo();
    expect(at(wb, id)).toEqual([[3, 2], [7, 7]]);
    expect(at(wb, other)).toEqual([]);
  });
});
