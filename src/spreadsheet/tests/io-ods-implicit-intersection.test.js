import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToOds } from '../src/core/io.js';

// The @ operator goes into a file as Excel's _xlfn.SINGLE(), which the reader turns back into @. Renaming the
// functions Excel marks with _xlfn. to LibreOffice's spellings caught SINGLE too (it is in Excel's list), so an
// .ods carried COM.MICROSOFT.SINGLE, which LibreOffice does not know either, and which came back here as a call
// to SINGLE rather than as the @ the formula was written with.
it('keeps the @ operator through an .ods', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['1', '2', '3'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.setInput(id, 1, 1, '=@A1:A3*10');
  expect(wb.getValue(id, 1, 1)).toBe(20);
  const bytes = new Uint8Array(await (await workbookToOds(wb, { settings: false })).arrayBuffer());
  expect(new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content)).not.toContain('COM.MICROSOFT.SINGLE');
  const back = await workbookFromFile(bytes, 'single.ods');
  expect(back.getCell(back.activeSheetId, 1, 1).f).toBe('@A1:A3*10');
  expect(back.getValue(back.activeSheetId, 1, 1)).toBe(20);
});
