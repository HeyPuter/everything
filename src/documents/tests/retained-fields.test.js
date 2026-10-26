import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const complex = (instruction, result) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${instruction} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>${result}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
const cases = {
  'simple SEQ caption': [`<w:r><w:t xml:space="preserve">Figure </w:t></w:r><w:fldSimple w:instr=" SEQ Figure \\* ARABIC "><w:r><w:t>1</w:t></w:r></w:fldSimple><w:r><w:t>: Chart</w:t></w:r>`, 'Figure 1: Chart', /w:instr=" SEQ Figure \\\* ARABIC "/],
  'complex SEQ caption': [`<w:r><w:t xml:space="preserve">Table </w:t></w:r>${complex('SEQ Table \\* ARABIC', '2')}`, 'Table 2', /> SEQ Table \\\* ARABIC </],
  'REF cross-reference': [`<w:r><w:t xml:space="preserve">See </w:t></w:r>${complex('REF _Ref123 \\h', 'Figure 1')}`, 'See Figure 1', /> REF _Ref123 \\h </],
  'DATE with picture switch': [`<w:fldSimple w:instr=" DATE \\@ &quot;MMMM d, yyyy&quot; "><w:r><w:t>October 9, 2026</w:t></w:r></w:fldSimple>`, 'October 9, 2026', /w:instr=" DATE \\@ &quot;MMMM d, yyyy&quot; "/],
  'citation add-in with JSON': [complex('ADDIN ZOTERO_ITEM CSL_CITATION {"citationID":"a1","citationItems":[{"id":1}]}', '(Smith, 2020)'), '(Smith, 2020)', /ADDIN ZOTERO_ITEM CSL_CITATION \{"citationID":"a1"/],
};

it.each(Object.entries(cases))('opens %s for editing and keeps the field through edits', async (_, [body, text, instruction]) => {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p>${body}</w:p><w:p><w:r><w:t>After</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  const pkg = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  expect(pkg.readOnly).toBeFalsy();
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  expect(model.text).toBe(`${text}\nAfter`);
  model.select(model.text.length); model.replace('!');
  const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
  expect(strFromU8(unzipSync(bytes)['word/document.xml'])).toMatch(instruction);
  const again = await DocxPackage.open(bytes);
  expect(new TextDocument(again.paragraphs).text).toBe(`${text}\nAfter!`);
});

it('opens reference-manager citations that carry field data and keeps the data through edits', async () => {
  const data = 'PEVuZE5vdGU+PENpdGU+PEF1dGhvcj5TbWl0aDwvQXV0aG9yPjwvQ2l0ZT48L0VuZE5vdGU+AA==';
  const begin = `<w:r><w:fldChar w:fldCharType="begin"><w:fldData xml:space="preserve">${data}</w:fldData></w:fldChar></w:r>`;
  // The citation's instruction holds a nested data field, both with fldData on their begin delimiters.
  const field = `${begin}<w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE </w:instrText></w:r>${begin}<w:r><w:instrText xml:space="preserve"> ADDIN EN.CITE.DATA </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>(Smith, 2020)</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  const docx = body => zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">As shown </w:t></w:r>${body}</w:p><w:sectPr/></w:body></w:document>`,
  }).map(([k, v]) => [k, strToU8(v)])));
  const pkg = await DocxPackage.open(docx(field), { bestEffort: true });
  expect(pkg.readOnly).toBeFalsy();
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  expect(model.text).toBe('As shown (Smith, 2020)');
  model.select(0, 2); model.replace('Then, as');
  const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
  const main = new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml');
  expect([...main.getElementsByTagNameNS(W, 'fldData')].map(n => [n.parentNode.getAttributeNS(W, 'fldCharType'), n.textContent])).toEqual([['begin', data], ['begin', data]]);
  const again = await DocxPackage.open(bytes);
  expect(new TextDocument(again.paragraphs).text).toBe('Then, as shown (Smith, 2020)');
  // Other delimiter content (form-field data, data on a separator) still opens read-only.
  for (const other of [field.replace('<w:fldData xml:space="preserve">', '<w:ffData><w:name w:val="x"/></w:ffData><w:fldData>'), field.replace('<w:fldChar w:fldCharType="separate"/>', `<w:fldChar w:fldCharType="separate"><w:fldData>${data}</w:fldData></w:fldChar>`)])
    expect((await DocxPackage.open(docx(other), { bestEffort: true })).readOnly).toBe(true);
});
