import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { MAX_PACKAGE_ITEMS, contentTypeOverride } from '../src/engine/package-part-paths.js';
import { docxWithParagraphs } from './helpers/docx.js';

// Each picture the editor saves is a part of its own. A document saved with a couple of thousand pictures had
// more ZIP items than the 2,000 the editor opened, and could not be opened again ("DOCX expanded size exceeds the
// editor limit", which named the wrong problem). The item limit is now well past what a session builds, the
// archive's bytes stay bounded, and an archive past the limit says so. An archive compressed with a method Word
// documents do not use (bzip2) said "unknown compression type 12"; it now says what is wrong.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

// A document the editor saves with thousands of pictures reopens: tests/browser/many-pictures.spec.js.
it('says an archive with too many items has too many parts', async () => {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Fine' }]));
  for (let i = 0; i <= MAX_PACKAGE_ITEMS; i++) parts[`custom/item${i}.bin`] = new Uint8Array();
  await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow(`This document is made of more than ${MAX_PACKAGE_ITEMS.toLocaleString('en-US')} pictures and other parts, more than this editor opens.`);
});

it('says an archive compressed with another method uses compression Word documents do not use', async () => {
  // The document's items, each marked as compressed with bzip2 (method 12) in its local header and the central directory.
  const zip = zipSync(Object.fromEntries(Object.entries(unzipSync(docxWithParagraphs([{ text: 'Fine' }]))).map(([name, bytes]) => [name, [bytes, { level: 0 }]])));
  const view = new DataView(zip.buffer);
  for (let at = 0; at + 4 <= zip.length; at++) {
    const signature = view.getUint32(at, true);
    if (signature === 0x04034b50) view.setUint16(at + 8, 12, true);
    if (signature === 0x02014b50) view.setUint16(at + 10, 12, true);
  }
  const error = await DocxPackage.open(zip).catch(e => e);
  expect(error.message).toBe('This file stores its contents with a kind of compression Word documents do not use, so it cannot be opened. Save it again as a Word Document (.docx) in the app that made it.');
});

it('finds content type entries added, renamed or removed after the first look-up', () => {
  const types = new DOMParser().parseFromString('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/media/A.png" ContentType="image/png"/></Types>', 'application/xml').documentElement;
  expect(contentTypeOverride(types, 'word/media/a.png')?.getAttribute('ContentType')).toBe('image/png');
  expect(contentTypeOverride(types, 'word/media/b.png')).toBeUndefined();
  const added = types.ownerDocument.createElementNS(types.namespaceURI, 'Override');
  added.setAttribute('PartName', '/word/media/b.png'); added.setAttribute('ContentType', 'image/jpeg'); types.append(added);
  expect(contentTypeOverride(types, 'word/media/B.png')).toBe(added);
  types.firstElementChild.setAttribute('PartName', '/word/media/c.png');
  expect(contentTypeOverride(types, 'word/media/a.png')).toBeUndefined();
  added.remove();
  expect(contentTypeOverride(types, 'word/media/b.png')).toBeUndefined();
});
