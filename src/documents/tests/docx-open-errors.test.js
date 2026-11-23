import { it, expect } from 'vitest';
import { DocxPackage } from '../src/engine/docx.js';

// A password-protected .docx is not a ZIP package: Office stores the encrypted package in an OLE
// compound file ([MS-OFFCRYPTO] §2.3.4.4, the EncryptedPackage stream), as it stores a Word 97–2003
// document ([MS-CFB] §2.2 header signature, [MS-DOC] WordDocument stream). Both used to fail with
// "Could not read this DOCX archive: invalid zip data", which tells the user nothing they can act on.
function compoundFile(streams) {
  const bytes = new Uint8Array(4096);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  // Directory entries hold their names in UTF-16LE (MS-CFB §2.6.1); one per 128-byte slot.
  streams.forEach((name, i) => { for (let c = 0; c < name.length; c++) bytes[1024 + i * 128 + c * 2] = name.charCodeAt(c); });
  return bytes;
}

it('says a password-protected document must have its password removed', async () => {
  const error = await DocxPackage.open(compoundFile(['Root Entry', 'EncryptedInfo', 'EncryptedPackage', '\u0006DataSpaces'])).catch(e => e);
  expect(error.message).toMatch(/password/i);
  expect(error.message).not.toMatch(/invalid zip data/);
});

it('says a Word 97–2003 document saved with a .docx name must be saved as .docx first', async () => {
  const error = await DocxPackage.open(compoundFile(['Root Entry', 'WordDocument', '1Table', '\u0005SummaryInformation'])).catch(e => e);
  expect(error.message).toMatch(/Word 97/);
  expect(error.message).not.toMatch(/invalid zip data/);
});

// An empty file (an upload or copy that never finished), a Rich Text Format document and a web page under a .docx
// name were all "Could not read this DOCX archive: invalid zip data".
it('says what an empty file, a Rich Text Format document or a web page named .docx is', async () => {
  const message = async text => (await DocxPackage.open(new TextEncoder().encode(text)).catch(e => e)).message;
  expect(await message('')).toMatch(/^This file is empty/);
  expect(await message('{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Times;}} Hello}')).toMatch(/^This is a Rich Text Format document \(\.rtf\)/);
  expect(await message('\ufeff  <!DOCTYPE html><html><body><p>Hi</p></body></html>')).toMatch(/^This is a web page with a \.docx name\. Rename it to end in \.html/);
  expect(await message('<?xml version="1.0"?>\n<!-- saved --><html xmlns="http://www.w3.org/1999/xhtml"><body/></html>')).toMatch(/^This is a web page/);
});

it('still reports other unreadable files as damaged archives', async () => {
  await expect(DocxPackage.open(new TextEncoder().encode('not a zip'))).rejects.toThrow('Could not read this DOCX archive');
});

// A package of another kind, picked under "All files", was "not a supported DOCX document", which says nothing to do.
it('names an OpenDocument text, a spreadsheet or a presentation picked instead of a Word document', async () => {
  const { zipSync, strToU8 } = await import('fflate');
  const odf = type => zipSync({ mimetype: [strToU8(type), { level: 0 }], 'content.xml': strToU8('<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"/>') });
  const message = async bytes => (await DocxPackage.open(bytes).catch(e => e)).message;
  expect(await message(odf('application/vnd.oasis.opendocument.text'))).toMatch(/OpenDocument text file \(\.odt\).*Save it as a Word Document \(\.docx\)/);
  expect(await message(odf('application/vnd.oasis.opendocument.spreadsheet'))).toBe('This is a spreadsheet, not a Word document. Open it in a spreadsheet app.');
  expect(await message(zipSync({ '[Content_Types].xml': strToU8('<Types/>'), 'ppt/presentation.xml': strToU8('<p/>') }))).toBe('This is a presentation, not a Word document. Open it in a presentation app.');
  expect(await message(zipSync({ 'xl/workbook.xml': strToU8('<w/>') }))).toMatch(/^This is a spreadsheet/);
  // Any other archive is still not a DOCX document.
  expect(await message(zipSync({ 'notes.txt': strToU8('hello') }))).toBe('This file is not a supported DOCX document.');
});
