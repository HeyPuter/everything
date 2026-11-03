import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { docxWithParagraphs } from './helpers/docx.js';
import { previewFeatureLabels } from '../src/views/preview-notice.js';

// A document saved from Word as "Strict Open XML Document" uses the ISO/IEC 29500 Strict namespaces
// (http://purl.oclc.org/ooxml/…). It opens as a text preview, and its notice said only "A different
// OOXML namespace", which tells the user neither what the file is nor what to do.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

function strict() {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Strict text' }]));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml'])
    .replace('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main')
    .replace('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'));
  parts['_rels/.rels'] = strToU8(strFromU8(parts['_rels/.rels']).replace('http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument'));
  return zipSync(parts);
}

it('names a Strict Open XML document and says how to edit it', async () => {
  const pkg = await DocxPackage.open(strict(), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(pkg.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['Strict text']);
  expect(previewFeatureLabels(pkg.previewIssues)).toEqual(['Strict Open XML markup, shown as text only; in Word, save it as a Word Document (.docx) to edit it here']);
});
