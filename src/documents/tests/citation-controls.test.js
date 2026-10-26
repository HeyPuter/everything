import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

// Word wraps each citation it inserts in a citation content control (§17.5.2.6 citation) and the
// bibliography list in a bibliography control (§17.5.2.4) inside a "Bibliographies" building block.
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const field = (instruction, result) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${result}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const citation = `<w:p><w:r><w:t xml:space="preserve">As shown </w:t></w:r><w:sdt><w:sdtPr><w:id w:val="-1911887443"/><w:citation/></w:sdtPr><w:sdtContent>${field('CITATION Smi20 \\l 1033', '(Smith, 2020)')}</w:sdtContent></w:sdt><w:r><w:t xml:space="preserve"> before.</w:t></w:r></w:p>`;
const bibliography = '<w:sdt><w:sdtPr><w:id w:val="100"/><w:docPartObj><w:docPartGallery w:val="Bibliographies"/><w:docPartUnique/></w:docPartObj></w:sdtPr><w:sdtContent><w:p><w:r><w:t>References</w:t></w:r></w:p><w:sdt><w:sdtPr><w:id w:val="101"/><w:bibliography/></w:sdtPr><w:sdtContent>'
  + '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> BIBLIOGRAPHY </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>Smith, J. (2020). A study.</w:t></w:r></w:p><w:p><w:r><w:t>Doe, A. (2019). Another.</w:t></w:r></w:p><w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
  + '</w:sdtContent></w:sdt></w:sdtContent></w:sdt>';
const docx = body => zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:p/><w:sectPr/></w:body></w:document>`,
}).map(([k, v]) => [k, strToU8(v)])));

it('opens citation and bibliography controls for editing and keeps them through edits', async () => {
  const source = docx(citation + bibliography);
  const pkg = await DocxPackage.open(source, { bestEffort: true });
  expect(pkg.readOnly).not.toBe(true);
  expect(unzipSync(new Uint8Array(await pkg.export().arrayBuffer()))).toEqual(unzipSync(source));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  expect(doc.text).toBe('As shown (Smith, 2020) before.\nReferences\nSmith, J. (2020). A study.\nDoe, A. (2019). Another.\n\n');
  doc.select(0, 2); doc.replace('Then, as');
  doc.select(doc.text.indexOf('References')); doc.replace('Works Cited / ');
  const saved = unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer()));
  const main = new DOMParser().parseFromString(strFromU8(saved['word/document.xml']), 'application/xml');
  expect(main.getElementsByTagNameNS(W, 'citation')).toHaveLength(1);
  expect(main.getElementsByTagNameNS(W, 'bibliography')).toHaveLength(1);
  expect([...main.getElementsByTagNameNS(W, 'instrText')].map(n => n.textContent.trim())).toEqual(['CITATION Smi20 \\l 1033', 'BIBLIOGRAPHY']);
  const reopened = await DocxPackage.open(zipSync(saved));
  expect(reopened.readOnly).not.toBe(true);
  expect(new TextDocument(reopened.paragraphs).text.split('\n').slice(0, 2)).toEqual(['Then, as shown (Smith, 2020) before.', 'Works Cited / References']);
});
