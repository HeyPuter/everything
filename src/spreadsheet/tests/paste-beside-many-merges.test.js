import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Pasting a block of merged rows tested every pasted cell against every merge on the sheet that stays, to keep its
// covered cells clear: 8,000 merged rows pasted beside the 8,000 they came from took 740 ms in the app, and the work
// grew with the square of the rows. Only the merges near each cell's row are asked now.

function sheetOfMergedRows(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < rows; r++) wb.setInput(id, r, 0, `row ${r}`);
  wb.mergeBlocks(id, Array.from({ length: rows }, (_, r) => ({ r1: r, c1: 0, r2: r, c2: 2 })));
  wb.clearHistory();
  const range = { r1: 0, c1: 0, r2: rows - 1, c2: 2 };
  return { wb, id, cells: wb.copyRange(id, range), merges: wb.mergesIn(id, range) };
}

it('keeps the cells under a merge that stays clear, and pastes the merges beside the others', () => {
  const { wb, id, cells, merges } = sheetOfMergedRows(40);
  wb.mergeCells(id, { r1: 50, c1: 5, r2: 50, c2: 6 }); // F51:G51 stays: what lands on G51 is dropped
  wb.setInput(id, 50, 5, 'kept');
  wb.pasteCells(id, cells, 0, 4, { r: 0, c: 0 }, null, { merges });
  wb.pasteCells(id, [[{ v: 'x' }, { v: 'y' }, { v: 'z' }]], 50, 4);
  expect(wb.getValue(id, 7, 4)).toBe('row 7');
  expect(wb.mergeAt(id, 7, 5)).toEqual({ r1: 7, c1: 4, r2: 7, c2: 6 });
  expect(wb.sheet(id).merges).toHaveLength(81);
  expect([wb.getValue(id, 50, 4), wb.getValue(id, 50, 5), wb.getValue(id, 50, 6)]).toEqual(['x', 'y', null]);
});

it('pastes thousands of merged rows beside thousands more in time that grows with the rows', () => {
  const time = (rows) => {
    const { wb, id, cells, merges } = sheetOfMergedRows(rows);
    const start = performance.now();
    wb.pasteCells(id, cells, 0, 4, { r: 0, c: 0 }, null, { merges });
    const ms = performance.now() - start;
    expect(wb.sheet(id).merges).toHaveLength(2 * rows);
    return ms;
  };
  time(200);
  const few = time(400), many = time(16000);
  // Forty times the rows took some two hundred times as long (2 s of processor time).
  expect(many).toBeLessThan(Math.max(40 * few, 600));
});
