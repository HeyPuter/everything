import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { UnsupportedDocumentError } from '../src/engine/errors.js';
import { docxWithParagraphs } from './helpers/docx.js';

// A style or list definition that cannot be read keeps its reason as text and reports it again when a
// paragraph uses it. The reason was wrapped a second time, so the read-only notice listed
// "This document contains This document contains …, which this first editor version cannot edit yet.
// The original file has not been changed., which …" instead of the feature.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function styledPackage() {
  const parts = unzipSync(docxWithParagraphs([{ text: 'Styled' }]));
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:p>', '<w:p><w:pPr><w:pStyle w:val="Struck"/></w:pPr>'));
  parts['word/styles.xml'] = strToU8(`<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Struck"><w:name w:val="Struck"/><w:rPr><w:strike/><w:dstrike/></w:rPr></w:style></w:styles>`);
  parts['word/_rels/document.xml.rels'] = strToU8(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`);
  return zipSync(parts);
}

it('names an unsupported feature of a used style once', async () => {
  const error = await DocxPackage.open(styledPackage()).catch(e => e);
  expect(error).toBeInstanceOf(UnsupportedDocumentError);
  expect(error.feature).toBe('strike and dstrike both on in the same property set');
  expect(error.message.match(/This document contains/g)).toHaveLength(1);
  const preview = await DocxPackage.open(styledPackage(), { bestEffort: true });
  expect(preview.readOnly).toBe(true);
  expect(preview.previewIssues).toContain('strike and dstrike both on in the same property set');
  expect(preview.previewIssues.some(issue => issue.includes('This document contains'))).toBe(false);
});

it('keeps a reason that is not already a full notice as it is', () => {
  expect(new UnsupportedDocumentError('smartTag').feature).toBe('smartTag');
  expect(new UnsupportedDocumentError(new UnsupportedDocumentError('bdo').message).feature).toBe('bdo');
});
