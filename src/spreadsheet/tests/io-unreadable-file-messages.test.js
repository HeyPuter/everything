import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// A file that could not be read was refused with the library's own words ("Bad compressed size:
// 0 != 358" for a download cut short, "File is password-protected", "Unknown Namespace" for a Word
// document), which say nothing to the person opening it, and which the open screens therefore
// replaced with a bare "Could not open the file". The refusal now says what is wrong, in words
// the app shows as they are, and keeps the library's error as its cause.
const saved = async () => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 'kept' } }]);
  return new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
};

it('says a file cut short may be damaged or incomplete', async () => {
  const bytes = await saved();
  for (const fraction of [0.3, 0.9]) {
    const error = await workbookFromFile(bytes.slice(0, Math.floor(bytes.length * fraction)), 'cut.xlsx').catch((e) => e);
    expect(error).toMatchObject({ code: 'unreadable', message: expect.stringMatching(/could not be read\. It may be damaged or incomplete/) });
    expect(error.cause).toBeInstanceOf(Error);
  }
});

it('says a workbook is protected with a password', async () => {
  const cfb = X.CFB.utils.cfb_new();
  X.CFB.utils.cfb_add(cfb, '/EncryptionInfo', new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0]));
  X.CFB.utils.cfb_add(cfb, '/EncryptedPackage', new Uint8Array(64));
  await expect(workbookFromFile(new Uint8Array(X.CFB.write(cfb, { type: 'array' })), 'secret.xlsx'))
    .rejects.toMatchObject({ code: 'unreadable', message: expect.stringMatching(/protected with a password/) });
});

it('says a zip that is no spreadsheet is not one', async () => {
  const zip = X.CFB.utils.cfb_new();
  X.CFB.utils.cfb_add(zip, '/[Content_Types].xml', new TextEncoder().encode('<Types/>'));
  X.CFB.utils.cfb_add(zip, '/word/document.xml', new TextEncoder().encode('<w:document/>'));
  await expect(workbookFromFile(new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), 'letter.xlsx'))
    .rejects.toMatchObject({ code: 'unreadable', message: expect.stringMatching(/not a spreadsheet/) });
});

it('still opens the whole file', async () => {
  const wb = await workbookFromFile(await saved(), 'whole.xlsx');
  expect(wb.getValue(wb.activeSheetId, 0, 0)).toBe('kept');
});
