import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { paragraphText } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const cell = text => `<w:tc><w:tcPr><w:tcW w:w="4680" w:type="dxa"/></w:tcPr><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:tc>`;
const table = (rows, label) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="4680"/><w:gridCol w:w="4680"/></w:tblGrid>${
  Array.from({ length: rows }, (_, r) => `<w:tr>${cell(`${label} ${r} a`)}${cell(`${label} ${r} b`)}</w:tr>`).join('')}</w:tbl>`;
function docx(body) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr/></w:body></w:document>`,
  };
  return { bytes: zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)]))), size: files['word/document.xml'].length };
}

// A table past the editing limit of 1,000 rows opens as a read-only preview with a paragraph per
// cell. Each of those paragraphs once kept a copy of the whole table's XML, so opening took time and
// memory in the square of the table's size and a large table failed with "Invalid string length".
it('opens a body table past the row limit read-only without a copy of the table per cell', async () => {
  const { bytes, size } = docx(`<w:p><w:r><w:t>Before</w:t></w:r></w:p>${table(1001, 'Row')}<w:p><w:r><w:t>After</w:t></w:r></w:p>`);
  await expect(DocxPackage.open(bytes)).rejects.toThrow('missing or excessive rows');
  const pkg = await DocxPackage.open(bytes, { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  expect(pkg.previewIssues.join(' ')).toMatch(/excessive rows/);
  const texts = pkg.paragraphs.map(paragraphText);
  expect(texts[0]).toBe('Before'); expect(texts.at(-1)).toBe('After');
  expect(texts).toContain('Row 0 a'); expect(texts).toContain('Row 1000 b');
  expect(pkg.paragraphs.filter(p => p.storySource)).toEqual([]);
  // The opening snapshot holds the text once, not the table once per cell.
  expect(pkg.initial.length).toBeLessThan(size * 4);
  expect(() => pkg.export()).toThrow('read-only');
});

it('still gives recovered cell content its block source for the table reader', async () => {
  const outer = `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="9360"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="9360" w:type="dxa"/></w:tcPr>${table(1001, 'Inner')}<w:p/></w:tc></w:tr></w:tbl>`;
  const pkg = await DocxPackage.open(docx(`${outer}<w:p/>`).bytes, { bestEffort: true });
  expect(pkg.readOnly).toBe(true);
  const recovered = pkg.paragraphs.filter(p => paragraphText(p).startsWith('Inner'));
  expect(recovered).toHaveLength(2002);
  // One serialization shared by every recovered paragraph of the block.
  expect(new Set(recovered.map(p => p.storySource)).size).toBe(1);
  expect(recovered[0].storySource).toContain('Inner 1000 b');
});
