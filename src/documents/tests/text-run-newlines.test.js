import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

// A line feed or carriage return inside w:t (§17.3.3.31) is whitespace, not a break: breaks are w:br
// and w:cr (§17.3.3.1, §17.3.3.4). Generators that pretty-print XML or copy multi-line strings into
// w:t write them; Word shows each as a space. Such a document no longer opens read-only.
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
function docx(body) {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document ${W}><w:body>${body}<w:p><w:r><w:t>Last</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, xml]) => [name, strToU8(xml)])));
}
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => unzipSync(new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()));

it.each([
  ['preserved', '<w:p><w:r><w:t xml:space="preserve">line one\nline two</w:t></w:r></w:p>', 'line one line two'],
  ['a carriage return reference', '<w:p><w:r><w:t xml:space="preserve">line one&#13;&#10;line two&#13;three</w:t></w:r></w:p>', 'line one line two three'],
  ['pretty-printed', '<w:p><w:r><w:t>\n      line one\n      line two\n    </w:t></w:r></w:p>', 'line one       line two'],
  ['in a tracked deletion', '<w:p><w:r><w:t xml:space="preserve">kept </w:t></w:r><w:del w:id="1" w:author="A" w:date="2026-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">gone\nalso</w:delText></w:r></w:del></w:p>', 'kept gone also'],
])('opens text with a newline %s for editing, as a space', async (_, body, text) => {
  const bytes = docx(body), pkg = await DocxPackage.open(bytes), doc = model(pkg);
  expect(pkg.readOnly).toBeFalsy();
  expect(doc.paragraphs).toHaveLength(2);
  expect(doc.text).toBe(`${text}\nLast`);
  expect(await save(pkg, doc)).toEqual(unzipSync(bytes));
  // An edit elsewhere keeps the paragraph's XML; an edit inside it saves spaces.
  doc.select(doc.text.length); doc.replace('!');
  const texts = xml => [...new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS('*', 'p')[0].getElementsByTagNameNS('*', '*')].filter(n => ['t', 'delText'].includes(n.localName)).map(n => n.textContent.replace(/\r\n?/g, '\n'));
  // (DOM serialization writes a carriage return reference as the character, which XML reads back as a line feed.)
  expect(texts(strFromU8((await save(pkg, doc))['word/document.xml']))).toEqual(texts(strFromU8(unzipSync(bytes)['word/document.xml'])));
  doc.select(0); doc.replace('Edited ');
  const out = await save(pkg, doc), reopened = model(await DocxPackage.open(zipSync(out)));
  expect(strFromU8(out['word/document.xml'])).not.toMatch(/[\r\n]/);
  expect(reopened.text).toBe(`Edited ${text}\nLast!`);
});
