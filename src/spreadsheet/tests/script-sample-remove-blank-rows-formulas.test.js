import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { sampleById } from '../src/core/scripts.js';
import { nodeTransport } from './helpers/script-transport.js';

// The Remove blank rows sample read only the values, and a formula that shows "" reads as empty: a row of such
// formulas (a lookup with nothing to show yet) was deleted as blank, formulas and all.
it('keeps a row of formulas that show nothing, and removes the truly empty one', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Name'); wb.setInput(id, 0, 1, 'Flag');
  wb.setInput(id, 1, 0, 'pear'); wb.setInput(id, 1, 1, '=IF(1>2,"y","")');
  wb.setInput(id, 2, 1, '=IF(1>2,"y","")');
  wb.setInput(id, 4, 0, 'fig');
  const res = await runScript({ wb, transport: nodeTransport(), code: sampleById('remove-blank-rows').code });
  expect(res.error).toBe(null);
  expect(wb.getCell(id, 2, 1)?.f).toBe('IF(1>2,"y","")');
  expect(wb.getValue(id, 3, 0)).toBe('fig'); // the empty row 4 went
});
