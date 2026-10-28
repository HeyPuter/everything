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

it('still reports other unreadable files as damaged archives', async () => {
  await expect(DocxPackage.open(new TextEncoder().encode('not a zip'))).rejects.toThrow('Could not read this DOCX archive');
});
