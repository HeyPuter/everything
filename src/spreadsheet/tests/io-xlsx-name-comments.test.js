import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

/** A workbook from Excel whose name Rate carries the comment Excel's Name Manager gave it. */
function excelFile() {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([[0.2]]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<\/sheets>/,
    () => '</sheets><definedNames><definedName name="Rate" comment="Sales &amp; use tax, &quot;2026&quot;">Data!$A$1</definedName></definedNames>'));
  part.size = part.content.length;
  return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
}
const workbookXml = async wb => {
  vi.stubGlobal('Blob', NodeBlob);
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  return new TextDecoder().decode(X.CFB.find(zip, '/xl/workbook.xml').content);
};

// A defined name's comment, written in Excel's Name Manager, was dropped when the file opened, and so lost on save.
it('keeps the comment Excel gave a defined name through opening, editing and saving', async () => {
  const wb = await workbookFromFile(excelFile(), 'names.xlsx');
  expect(wb.names).toEqual([{ name: 'Rate', ref: 'Data!$A$1', comment: 'Sales & use tax, "2026"' }]);
  expect(wb.defineName('Rate', '=Data!$A$1:$A$2')).toBeNull();
  expect(wb.names[0]).toMatchObject({ ref: 'Data!$A$1:$A$2', comment: 'Sales & use tax, "2026"' });
  expect(await workbookXml(wb)).toContain('<definedName name="Rate" comment="Sales &amp; use tax, &quot;2026&quot;">Data!$A$1:$A$2</definedName>');
});
