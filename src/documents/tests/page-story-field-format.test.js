import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const T = 'application/vnd.openxmlformats-officedocument.wordprocessingml.', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// Independently written: a "Page 1 of 2" footer with a complex PAGE field and a simple NUMPAGES field.
const footer = `<w:ftr xmlns:w="${W}"><w:p><w:r><w:t xml:space="preserve">Page </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve"> of </w:t></w:r><w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>2</w:t></w:r></w:fldSimple></w:p></w:ftr>`;
const source = zipSync(Object.fromEntries(Object.entries({
  '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${T}document.main+xml"/><Override PartName="/word/footer1.xml" ContentType="${T}footer+xml"/></Types>`,
  '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdF" Type="${R}/footer" Target="footer1.xml"/></Relationships>`,
  'word/footer1.xml': footer,
  'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr><w:footerReference w:type="default" r:id="rIdF"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
}).map(([k, v]) => [k, strToU8(v)])));

it('saves character formatting applied over page fields in a footer', async () => {
  const pkg = await DocxPackage.open(source);
  const story = pkg.pageStories.stories['word/footer1.xml'];
  const doc = new TextDocument(story.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, story.tables, pkg.assets);
  doc.select(0, doc.text.length); doc.toggleBold(); doc.setRunFormat({ color: 'C00000' });
  const saved = unzipSync(new Uint8Array(await pkg.export(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { 'word/footer1.xml': { paragraphs: doc.paragraphs, tables: doc.tables } }).arrayBuffer()));
  const xml = new DOMParser().parseFromString(strFromU8(saved['word/footer1.xml']), 'application/xml');
  // Every run of both fields carries the formatting, delimiters and instruction included.
  const runs = [...xml.getElementsByTagNameNS(W, 'r')];
  expect(runs).toHaveLength(8);
  for (const r of runs) expect([...r.getElementsByTagNameNS(W, 'b')].map(b => b.getAttributeNS(W, 'val'))).toEqual(['1']);
  expect(xml.getElementsByTagNameNS(W, 'instrText')[0].textContent).toBe(' PAGE ');
  const reopened = await DocxPackage.open(zipSync(saved));
  expect(reopened.pageStories.stories['word/footer1.xml'].paragraphs[0].runs.map(r => [r.text === '￼' ? 'field' : r.text, r.bold, r.color])).toEqual([['Page ', true, 'C00000'], ['field', true, 'C00000'], [' of ', true, 'C00000'], ['field', true, 'C00000']]);
});
