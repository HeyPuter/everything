import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { docxWithParagraphs } from './helpers/docx.js';
import { zipSync, strToU8 } from 'fflate';

// Saving after an edit drops the page-break hints Word caches in the text (w:lastRenderedPageBreak, §17.3.3.13),
// paragraphs left alone included. Word writes a hint in a run of its own, which was left behind as an empty run.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

it('drops a run that held only a page-break hint with the hint, and keeps the rest of each run', async () => {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Edit me' }]));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:sectPr/>',
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:lastRenderedPageBreak/></w:r><w:r><w:t>Next page</w:t></w:r></w:p><w:p><w:r><w:t>Before</w:t><w:lastRenderedPageBreak/><w:t xml:space="preserve"> after</w:t></w:r></w:p><w:sectPr/>'));
  const pkg = await DocxPackage.open(zipSync(parts));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(7); doc.replace(' now');
  const xml = strFromU8(unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()))['word/document.xml']);
  expect(xml).not.toContain('lastRenderedPageBreak');
  expect(xml).toContain('<w:p><w:r><w:t>Next page</w:t></w:r></w:p>');
  expect(xml).toContain('<w:p><w:r><w:t>Before</w:t><w:t xml:space="preserve"> after</w:t></w:r></w:p>');
  expect(xml).not.toMatch(/<w:r\/>|<w:r><w:rPr><w:b\/><\/w:rPr><\/w:r>/);
});
