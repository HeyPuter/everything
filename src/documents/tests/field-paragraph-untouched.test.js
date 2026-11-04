import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';

// Paragraphs an edit leaves alone are saved from their source XML (docx.js keeps each one while its
// model reads as it did when opened). Any edit rebuilt the field markers of every paragraph holding a
// field in another key order, so each of them read as changed: all were rewritten on every save,
// dropping what the writer does not reproduce (run revision ids, proofing marks, w:t as written).
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PAGE = '<w:p w:rsidR="00A1B2C3" w:rsidRDefault="00A1B2C3"><w:r w:rsidRPr="00D4E5F6"><w:t xml:space="preserve">Page </w:t></w:r><w:proofErr w:type="spellStart"/><w:r><w:t>numbr</w:t></w:r><w:proofErr w:type="spellEnd"/><w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>';
const TOC = [
  '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r w:rsidR="00112233"><w:t>Introduction</w:t></w:r><w:r><w:tab/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
  '<w:p><w:r w:rsidR="00445566"><w:t>Results</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>',
];
const DATE = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> DATE \\@ "yyyy" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>2020</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>';
const SOURCE = [PAGE, ...TOC, DATE];

function docx() {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId2" Type="${R}/styles" Target="styles.xml"/></Relationships>`,
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>`,
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>Edit me</w:t></w:r></w:p>${SOURCE.join('')}<w:p><w:r><w:t>Tail</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
}
const model = p => new TextDocument(p.paragraphs, p.pageSettings, p.numbering, p.styles, p.tables, p.assets);
const save = async (p, d) => unzipSync(new Uint8Array(await p.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets).arrayBuffer()));

for (const [name, edit] of [
  ['typing in another paragraph', d => { d.select(7); d.replace(' now'); }],
  ['typing in the last paragraph', d => { d.select(d.text.length); d.replace('!'); }],
  ['a new paragraph', d => { d.select(7); d.replace('\nAdded'); }],
]) it(`saves the paragraphs holding fields as they were after ${name}`, async () => {
  const p = await DocxPackage.open(docx());
  expect(p.readOnly).toBeFalsy();
  const d = model(p);
  const fields = bodyFieldRanges(d.paragraphs).length;
  edit(d);
  const xml = strFromU8((await save(p, d))['word/document.xml']);
  for (const source of SOURCE) expect(xml).toContain(source);
  const again = model(await DocxPackage.open(zipSync(await save(p, d))));
  expect(again.text).toBe(d.text);
  expect(bodyFieldRanges(again.paragraphs)).toHaveLength(fields);
});

it('still saves an edit inside a field paragraph, with its field', async () => {
  const p = await DocxPackage.open(docx()), d = model(p);
  const at = d.text.indexOf('Results') + 'Results'.length;
  d.select(at); d.replace(' and more');
  const xml = strFromU8((await save(p, d))['word/document.xml']);
  expect(xml).toContain(PAGE); expect(xml).toContain(TOC[0]); expect(xml).toContain(DATE);
  expect(xml).not.toContain(TOC[1]);
  const again = model(await DocxPackage.open(zipSync(await save(p, d))));
  expect(again.text).toContain('Results and more');
  expect(bodyFieldRanges(again.paragraphs).map(r => r.field.type)).toEqual(bodyFieldRanges(d.paragraphs).map(r => r.field.type));
});
