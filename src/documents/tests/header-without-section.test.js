import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const files = {
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Body</w:t></w:r></w:p></w:body></w:document>`,
};

it('keeps a header added to a document whose body has no section properties', async () => {
  const pkg = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  expect(pkg.readOnly).toBeFalsy();
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const path = pkg.addPageStory('header', { variant: 'default', section: 0 });
  const header = new TextDocument([paragraph('')], d.pageSettings, d.numbering, d.styles, [], d.assets);
  header.replace('My header');
  const out = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, { [path]: { paragraphs: header.paragraphs, tables: [] } }).arrayBuffer());
  const again = await DocxPackage.open(out);
  const reference = again.pageStories?.sections?.[0]?.header?.default;
  expect(reference).toBeTruthy();
  expect(again.pageStories.stories[reference].paragraphs.map(p => p.runs.map(r => r.text).join('')).join('')).toBe('My header');
});
