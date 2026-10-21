import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

/** A sheet as Excel saves it, its first view's attributes given. */
function excelFile(view) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([[0, 5]]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const part = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheetViews>[\s\S]*?<\/sheetViews>|(?=<sheetFormatPr|<sheetData)/,
    () => `<sheetViews><sheetView workbookViewId="0"${view}/></sheetViews>`));
  part.size = part.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}

// Excel's "Show a zero in cells that have zero value", turned off for a sheet, is saved as showZeros="0" on its
// view. Opening such a file ignored it, so the zeros the sheet hides showed, and saving wrote them back on.
it('opens a sheet whose zero values Excel hides with its zeros hidden, and keeps them hidden through a save', async () => {
  vi.stubGlobal('Blob', NodeBlob);
  const wb = await workbookFromFile(excelFile(' showZeros="0"'), 'zeros.xlsx'), id = wb.activeSheetId;
  expect(wb.activeSheet.zeros).toBe(false);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  expect(new TextDecoder().decode(X.CFB.find(zip, '/xl/worksheets/sheet1.xml').content)).toMatch(/<sheetView\b[^>]*showZeros="0"/);
  expect(wb.getValue(id, 0, 0)).toBe(0);
});

it('shows zeros where the file says nothing, or says to show them', async () => {
  for (const view of ['', ' showZeros="1"', ' showZeros="true"']) expect((await workbookFromFile(excelFile(view), 'zeros.xlsx')).activeSheet.zeros).toBe(true);
});
