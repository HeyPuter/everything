import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import { isSpreadsheetFile, workbookToXlsx } from '../src/core/io.js';
import { memoryStorage } from './helpers/memory-storage.js';
import { installMockPuter } from './helpers/mock-puter.js';

// An Excel template (.xltx, or .xltm with macros) was not a file the app opened: dropping one or
// opening it from the drive said it was not a spreadsheet. It now opens, and like Excel the first
// save makes a new workbook (an .xlsx beside it) and leaves the template as it was.
let mock;
beforeAll(async () => { await Doc.blank().toXlsxBlob(); });
beforeEach(() => { Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true }); mock = installMockPuter(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); delete globalThis.puter; });

async function templateBytes() {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 'Invoice no.' } }]);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const types = X.CFB.find(zip, '/[Content_Types].xml');
  types.content = new TextEncoder().encode(new TextDecoder().decode(types.content)
    .replace('spreadsheetml.sheet.main+xml', 'spreadsheetml.template.main+xml'));
  types.size = types.content.length;
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}

it('counts Excel templates as spreadsheets', () => {
  expect(isSpreadsheetFile('Invoice.xltx')).toBe(true);
  expect(isSpreadsheetFile('Macros.XLTM')).toBe(true);
});

it('opens a template and saves the work as a new .xlsx beside it', async () => {
  const bytes = await templateBytes();
  const blob = new Blob([bytes]);
  mock.fs.set('/nj/Desktop/Invoice.xltx', { blob, size: blob.size, modified: 1 });
  const doc = await Doc.fromPath('/nj/Desktop/Invoice.xltx');
  try {
    expect(doc.wb.getValue(doc.wb.activeSheetId, 0, 0)).toBe('Invoice no.');
    doc.wb.setInput(doc.wb.activeSheetId, 0, 1, '1042');
    expect(await doc.save()).toBe(true);
    expect(doc.path).toBe('/nj/Desktop/Invoice.xlsx');
    expect(new Uint8Array(await mock.fs.get('/nj/Desktop/Invoice.xltx').blob.arrayBuffer())).toEqual(bytes);
  } finally { doc.destroy(); }
});
