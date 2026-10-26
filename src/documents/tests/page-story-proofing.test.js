import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const T = 'application/vnd.openxmlformats-officedocument.wordprocessingml.', R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
// Independently written: a header whose misspelled company name carries Word's cached spelling marks.
function docx(header) {
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="${T}document.main+xml"/><Override PartName="/word/header1.xml" ContentType="${T}header+xml"/></Types>`,
    '_rels/.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="${R}/header" Target="header1.xml"/></Relationships>`,
    'word/header1.xml': `<w:hdr xmlns:w="${W}">${header}</w:hdr>`,
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p><w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  }).map(([k, v]) => [k, strToU8(v)])));
}

it('opens a document whose header carries spelling marks for editing, and edits that header', async () => {
  const source = docx('<w:p><w:proofErr w:type="spellStart"/><w:r><w:t>Acmee</w:t></w:r><w:proofErr w:type="spellEnd"/><w:r><w:t xml:space="preserve"> Corp</w:t></w:r></w:p>');
  const pkg = await DocxPackage.open(source, { bestEffort: true });
  expect(pkg.readOnly).not.toBe(true);
  const story = pkg.pageStories.stories['word/header1.xml'];
  expect(story.paragraphs.map(p => p.runs.map(r => r.text).join(''))).toEqual(['Acmee Corp']);
  expect(unzipSync(new Uint8Array(await pkg.export().arrayBuffer()))).toEqual(unzipSync(source));
  const header = new TextDocument(story.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, story.tables, pkg.assets);
  header.select(0, 5); header.replace('Acme');
  const saved = unzipSync(new Uint8Array(await pkg.export(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets, { 'word/header1.xml': { paragraphs: header.paragraphs, tables: header.tables } }).arrayBuffer()));
  const xml = new DOMParser().parseFromString(strFromU8(saved['word/header1.xml']), 'application/xml');
  expect(xml.documentElement.textContent).toBe('Acme Corp');
  const reopened = await DocxPackage.open(zipSync(saved));
  expect(reopened.readOnly).not.toBe(true);
  expect(reopened.pageStories.stories['word/header1.xml'].paragraphs[0].runs.map(r => r.text).join('')).toBe('Acme Corp');
});
