import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { measureRows } from '../src/core/row-height.js';

// A blank cell in a larger font grows its row (b6264b5d1), so a refit of a sheet's automatic rows, which the grid
// makes on opening it and after every column resize, came to read the whole style and the merge of every formatted
// blank: a file's 5,000 rows of 100 bordered blank cells took a column resize from 65ms a frame to 200ms. A file's
// blank carries its own size, which is all the blank is asked for; its merge only when it would grow the row.
it('reads a formatted blank cell by its own size, and asks for its merge only when it would grow the row', () => {
  const cells = {};
  for (let r = 0; r < 50; r++) for (let c = 0; c < 20; c++) cells[`${r},${c}`] = c === 0 ? { v: `row ${r}` } : { s: { bb: 'thin', size: 13 } };
  cells['3,5'] = { s: { bb: 'thin', size: 28 * 4 / 3 } };
  const wb = new Workbook({ sheets: [{ rows: 50, cols: 20, cells }] });
  const id = wb.activeSheetId;
  let styles = 0, merges = 0;
  const heights = measureRows(wb, id, 0, 49, {
    force: true, automatic: true, textWidth: (text) => text.length * 7,
    styleAt: (sheet, r, c) => { styles++; return wb.styleAt(sheet.id, r, c); },
    mergeAt: (r, c) => { merges++; return wb.mergeAt(id, r, c); },
  });
  expect(heights.get(3)).toBe(Math.ceil(28 * 4 / 3 * 1.3) + 2.5); // the blank in 28 point still grows its row
  expect(heights.get(4)).toBe(19.5);
  expect(styles).toBe(50); // the text cells', not the 950 blanks'
  expect(merges).toBe(2 * 50 + 1); // twice for each text cell, once for the blank that grows its row
});
