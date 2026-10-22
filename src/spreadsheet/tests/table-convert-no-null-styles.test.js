import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Converting a table to a range stored its colors in the cells with a key set to null beside them (nativeFill: null,
// the patch's way of saying "no file fill"), which a style applied any other way never stores. The key is now left
// out, as applyStyle leaves it out, unless it resets a fill the cell's row or column carries.
const nulls = (wb, id) => [...wb.sheet(id).cells].filter(([, c]) => c.s && Object.values(c.s).includes(null)).map(([k]) => k);

function setup() {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Item', 'Quantity'], ['Notebook', 3], ['Pencil', 6], ['Folder', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  return { wb, id, tid: wb.addTable(id, parseRange('A1:B4'), { name: 'Purchases', style: 'green' }) };
}

it('stores no null style keys in the cells of a converted table', () => {
  const { wb, id, tid } = setup();
  wb.deleteTable(id, tid);
  expect(nulls(wb, id)).toEqual([]);
  expect([0, 1, 2].map((r) => wb.styleAt(id, r, 0)?.bg ?? null)).toEqual(['#70ad47', '#e2efda', null]);
  expect(wb.styleAt(id, 0, 0)).toMatchObject({ bg: '#70ad47', color: '#ffffff', bold: true });
  const after = wb.toJSON();
  wb.undo(); wb.redo();
  expect(wb.toJSON()).toEqual(after);
});
