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

it('opens pictures pasted from web pages (INCLUDEPICTURE fields) for editing and keeps field and picture', async () => {
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  const drawing = '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Picture 1" descr="https://example.com/logo.png"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Picture 1"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdPic"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>';
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdPic" Type="${R}/image" Target="media/image1.png"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t xml:space="preserve">Logo: </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> INCLUDEPICTURE "https://example.com/logo.png" \\* MERGEFORMATINET </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${drawing}<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  const parts = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])); parts['word/media/image1.png'] = png;
  const pkg = await DocxPackage.open(zipSync(parts), { bestEffort: true });
  expect(pkg.readOnly).toBeFalsy();
  const model = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  model.select(0, 4); model.replace('Brand');
  const bytes = new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer());
  const main = new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml');
  expect(main.getElementsByTagNameNS(W, 'instrText')[0].textContent).toContain('INCLUDEPICTURE "https://example.com/logo.png"');
  expect(main.getElementsByTagNameNS(W, 'drawing')).toHaveLength(1);
  const again = await DocxPackage.open(bytes);
  expect(again.paragraphs[0].runs.filter(r => r.image)).toHaveLength(1);
  expect(new TextDocument(again.paragraphs).text.startsWith('Brand: ')).toBe(true);
  // In a header the field is shown by its result text alone, so a picture result keeps the read-only preview, picture shown.
  const header = { ...parts };
  header['word/header1.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace(/^<w:document/, '<w:hdr').replace('<w:body>', '').replace('<w:sectPr/></w:body></w:document>', '</w:hdr>'));
  header['word/_rels/header1.xml.rels'] = parts['word/_rels/document.xml.rels'];
  header['word/_rels/document.xml.rels'] = strToU8(strFromU8(parts['word/_rels/document.xml.rels']).replace('</Relationships>', `<Relationship Id="rIdH" Type="${R}/header" Target="header1.xml"/></Relationships>`));
  header['[Content_Types].xml'] = strToU8(strFromU8(parts['[Content_Types].xml']).replace('</Types>', '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'));
  header['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace('<w:sectPr/>', '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/></w:sectPr>'));
  const preview = await DocxPackage.open(zipSync(header), { bestEffort: true });
  expect(preview.readOnly).toBe(true);
  expect(preview.pageStories.stories['word/header1.xml'].paragraphs[0].runs.filter(r => r.image)).toHaveLength(1);
});
