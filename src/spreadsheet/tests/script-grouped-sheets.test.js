import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// A script writes on the worksheet it names, as an Office Script does. With the active sheet grouped with another
// (both tabs selected), each value it set and each range it cleared were changed on the other sheet as well, as typing
// into a group is: getActiveWorksheet().getRange('A1').clear() also wiped Notes!A1.
it('writes on the worksheet a script names only, whatever sheets are grouped with it', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Model' }, { name: 'Notes' }] });
  const [model, notes] = wb.sheets.map((s) => s.id);
  wb.setActiveSheet(model);
  wb.setInput(model, 0, 0, '1');
  wb.setInput(notes, 0, 0, 'Mine'); wb.setInput(notes, 4, 3, 'Kept');
  wb.groupSheets([model, notes]);
  const before = JSON.stringify([...wb.sheet(notes).cells]);
  const res = await runScript({ wb, transport: nodeTransport(), timeout: 10000, code: `async function main(workbook) {
    const sheet = workbook.getActiveWorksheet();
    sheet.getRange('F6').setValue('s');
    sheet.getRange('A1').clear();
    sheet.getRange('C1').getFormat().getFont().setBold(true);
  }` });
  expect(res.error).toBe(null);
  expect(wb.getValue(model, 5, 5)).toBe('s');
  expect(wb.getValue(model, 0, 0)).toBe(null);
  expect(JSON.stringify([...wb.sheet(notes).cells])).toBe(before);
});
