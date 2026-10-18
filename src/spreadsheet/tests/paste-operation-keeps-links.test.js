import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Paste Special's Add, Subtract, Multiply and Divide with numbers copied from another app rewrote each cell with
// its new number and its format alone, so a linked cell lost its link; the same paste of cells copied here
// already kept it.
it('keeps the links of the cells it changes', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '10');
  wb.setLink(id, 0, 0, 'https://example.com/a', 10);
  wb.setInput(id, 1, 0, '4');
  wb.setLink(id, 1, 0, 'https://example.com/b', 4);
  expect(wb.pasteOperation(id, [[2], [0]], 0, 0, 'div')).toBe(2);
  expect(wb.getValue(id, 0, 0)).toBe(5);
  expect(wb.linkAt(id, 0, 0)?.url).toBe('https://example.com/a');
  expect(wb.getValue(id, 1, 0)).toEqual({ error: '#DIV/0!' });
  expect(wb.linkAt(id, 1, 0)?.url).toBe('https://example.com/b');
});
