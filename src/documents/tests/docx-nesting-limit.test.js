import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { parseXml, xmlDepthExceeds, MAX_XML_DEPTH } from '../src/engine/docx-xml.js';
import { UnsupportedDocumentError } from '../src/engine/errors.js';
import { documentText } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const nest = (depth, open, close, inner) => open.repeat(depth) + inner + close.repeat(depth);
const P = text => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const docx = body => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${P('Before')}${body}${P('After')}<w:sectPr/></w:body></w:document>`,
}).map(([name, xml]) => [name, strToU8(xml)])));

it('measures nesting without walking the tree recursively', () => {
  const chain = depth => `<a>${nest(depth - 1, '<b>', '</b>', '')}</a>`;
  expect(xmlDepthExceeds(parseXml(chain(MAX_XML_DEPTH)).documentElement)).toBe(false);
  expect(() => parseXml(chain(MAX_XML_DEPTH + 1))).toThrow(UnsupportedDocumentError);
  expect(() => parseXml(chain(MAX_XML_DEPTH + 1))).toThrow(`content nested more than ${MAX_XML_DEPTH} levels deep`);
  // Siblings and later branches are measured too, not only the first path.
  const wide = parseXml(`<a><b/><c><d/></c>${'<e/>'.repeat(5)}<f><g><h/></g></f></a>`).documentElement;
  expect([3, 4].map(limit => xmlDepthExceeds(wide, limit))).toEqual([true, false]);
  expect(parseXml(chain(MAX_XML_DEPTH + 1), { depthLimit: Infinity }).documentElement.localName).toBe('a');
});

it('opens a document nested beyond the limit as a read-only text preview of every paragraph', async () => {
  const body = `<w:p>${nest(MAX_XML_DEPTH, '<w:hyperlink w:anchor="a">', '</w:hyperlink>', '<w:r><w:t>inner</w:t></w:r><w:r><w:tab/><w:t>text</w:t></w:r>')}</w:p>`
    + nest(5, '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>', '</w:tc></w:tr></w:tbl>', `${P('cell')}<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`);
  const pkg = await DocxPackage.open(docx(body), { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(pkg.previewIssues).toContain(`content nested more than ${MAX_XML_DEPTH} levels deep`);
  expect(documentText(pkg.paragraphs)).toBe('Before\ninner\ttext\ncell\n\nAfter');
  await expect(DocxPackage.open(docx(body))).rejects.toThrow(`This document contains content nested more than ${MAX_XML_DEPTH} levels deep`);
});
