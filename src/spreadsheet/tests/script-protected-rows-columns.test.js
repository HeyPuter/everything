import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runScript } from '../src/core/script-run.js';
import { nodeTransport } from './helpers/script-transport.js';

// On a protected sheet the workbook keeps rows and columns as they are, but a script hiding or sizing them was told
// nothing: setRowsHidden, setColumnWidth and the rest finished "ok" having changed nothing.
describe('a script changing rows or columns of a protected sheet', () => {
  for (const call of ["getRange('2:3').setRowsHidden(true)", "getRange('B:B').getFormat().setColumnWidth(300)", "getRange('A1:A4').getFormat().setRowHeight(40)", "getRange('A:B').getFormat().autofitColumns()"]) {
    it(`is refused with a reason: ${call}`, async () => {
      const wb = new Workbook();
      const id = wb.activeSheetId;
      wb.setInput(id, 0, 0, 'x');
      wb.setSheetProtected(id, true);
      const res = await runScript({ wb, transport: nodeTransport(), timeout: 10000, code: `async function main(workbook) { workbook.getActiveWorksheet().${call}; }` });
      expect(res.error?.message).toMatch(/Sheet1 is protected/);
    });
  }
  it('still hides rows of an unprotected sheet', async () => {
    const wb = new Workbook();
    const res = await runScript({ wb, transport: nodeTransport(), timeout: 10000, code: `async function main(workbook) { workbook.getActiveWorksheet().getRange('2:3').setRowsHidden(true); }` });
    expect(res.error).toBe(null);
    expect(wb.sheet(wb.activeSheetId).hiddenRows.has(1)).toBe(true);
  });
});
