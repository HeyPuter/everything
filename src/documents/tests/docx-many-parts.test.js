import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { MAX_PACKAGE_ITEMS, contentTypeOverride } from '../src/engine/package-part-paths.js';
import { docxWithParagraphs } from './helpers/docx.js';

// Each picture the editor saves is a part of its own. A document saved with a couple of thousand pictures had
// more ZIP items than the 2,000 the editor opened, and could not be opened again ("DOCX expanded size exceeds the
// editor limit", which named the wrong problem). The item limit is now well past what a session builds, the
// archive's bytes stay bounded, and an archive past the limit says so.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

// A document the editor saves with thousands of pictures reopens: tests/browser/many-pictures.spec.js.
it('says an archive with too many items has too many parts', async () => {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Fine' }]));
  for (let i = 0; i <= MAX_PACKAGE_ITEMS; i++) parts[`custom/item${i}.bin`] = new Uint8Array();
  await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow(`This document is made of more than ${MAX_PACKAGE_ITEMS.toLocaleString('en-US')} pictures and other parts, more than this editor opens.`);
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
