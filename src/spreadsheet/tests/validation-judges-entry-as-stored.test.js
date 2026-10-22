import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// A typed entry is checked against the cell's rule as the cell will hold it, not as plain text would read.
it('checks an entry by the value its cell format makes of it', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.applyStyle(id, parseRange('A1'), { fmt: 'percent', dec: 0 });
  wb.addValidation(id, { range: parseRange('A1'), type: 'number', min: 0, max: 1, strict: true });
  expect(wb.validateInput(id, 0, 0, '50').ok).toBe(true); // 50%
  expect(wb.validateInput(id, 0, 0, '150').ok).toBe(false);

  wb.applyStyle(id, parseRange('B1'), { fmt: 'text' });
  wb.addValidation(id, { range: parseRange('B1'), type: 'text', min: 5, max: 5, strict: true });
  expect(wb.validateInput(id, 0, 1, '00123').ok).toBe(true);

  wb.applyStyle(id, parseRange('C1'), { fmt: 'custom', code: '# ?/?' });
  wb.addValidation(id, { range: parseRange('C1'), type: 'number', min: 0, max: 1, strict: true });
  expect(wb.validateInput(id, 0, 2, '1/2').ok).toBe(true);

  wb.addValidation(id, { range: parseRange('D1'), type: 'number', min: 0, max: 1, allowBlank: false, strict: true });
  expect(wb.validateInput(id, 0, 3, '').ok).toBe(false);
  expect(wb.validateInput(id, 0, 3, '=5').ok).toBe(true);
});
