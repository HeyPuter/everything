// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { MAX_ROWS, MAX_COLS } from '../src/core/workbook.js';
import { createLanguagePane } from '../src/ui/language-pane.js';

// Review ▸ Translate takes the text of the selected cells. It read them one address at a time over the whole
// selection, empty cells and all: with the whole sheet selected (Ctrl+A twice, or the corner button) that was
// seventeen billion addresses, and the tab froze for good; a whole column held it for a fifth of a second.
afterEach(() => { document.body.replaceChildren(); });

it('reads the text of a whole-sheet selection from the cells that hold something', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Hello' } }, { r: 4, c: 2, cell: { v: 'World' } }, { r: 9, c: 1, cell: { v: 3 } }]);
  let reads = 0;
  const getCell = wb.getCell.bind(wb);
  wb.getCell = (...args) => { if (++reads > 100_000) throw new Error('read too many cells'); return getCell(...args); };
  const pane = createLanguagePane({ wb, sheetId: () => id, ranges: () => [{ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: MAX_COLS - 1 }],
    active: () => ({ r: 0, c: 0 }), activeCell: () => wb.getCell(id, 0, 0), grid: { focus() {} }, ai: null, translate: null });
  document.body.append(pane.el);
  pane.show('translate', { fromCell: true });
  expect(pane.el.querySelector('.lang-source').value).toBe('Hello\nWorld');
  expect(reads).toBeLessThan(1000);
});

// The used range is a box from A1 to the last row and column holding something: one value far out at the sheet's
// corner made it the whole sheet again, and the whole-sheet selection read its seventeen billion addresses as before.
it('reads a whole-sheet selection quickly when a value sits far out at the corner', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Hello' } }, { r: 4, c: 2, cell: { v: 'World' } }, { r: 2, c: 1, cell: { v: 'Middle' } },
    { r: MAX_ROWS - 1, c: MAX_COLS - 1, cell: { v: 'Corner' } }]);
  let reads = 0;
  const getCell = wb.getCell.bind(wb);
  wb.getCell = (...args) => { if (++reads > 100_000) throw new Error('read too many cells'); return getCell(...args); };
  const pane = createLanguagePane({ wb, sheetId: () => id, ranges: () => [{ r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: MAX_COLS - 1 }],
    active: () => ({ r: 0, c: 0 }), activeCell: () => wb.getCell(id, 0, 0), grid: { focus() {} }, ai: null, translate: null });
  document.body.append(pane.el);
  pane.show('translate', { fromCell: true });
  // In reading order, row by row, as a selection is read.
  expect(pane.el.querySelector('.lang-source').value).toBe('Hello\nMiddle\nWorld\nCorner');
});
