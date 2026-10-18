import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { convertedNoteParagraphs } from '../src/engine/footnotes.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
function noted() {
  const sep = '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>';
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>',
    'word/footnotes.xml': `<w:footnotes xmlns:w="${W}">${sep}<w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> A plain note.</w:t></w:r></w:p></w:footnote></w:footnotes>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Claim</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r></w:p><w:sectPr/></w:body></w:document>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}

it('saves a footnote read from the file after it is converted to an endnote', async () => {
  const pkg = await DocxPackage.open(noted());
  const d = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  const story = pkg.pageStories.stories['word/footnotes.xml#1'];
  expect(story.editable).toBe(true);
  // As Convert does: a new endnote holding the footnote's paragraphs, and the reference switched to it.
  const note = pkg.addEndnote();
  const paragraphs = convertedNoteParagraphs(story.paragraphs, 'endnote');
  expect(paragraphs.every(p => p.pageStory === undefined)).toBe(true);
  for (const p of d.paragraphs) p.runs = p.runs.map(r => r.noteMark?.kind === 'footnoteReference' ? { ...r, noteMark: { ...r.noteMark, kind: 'endnoteReference', id: note.id } } : r);
  const out = new Uint8Array(await pkg.export(d.paragraphs, d.pageSettings, d.numbering, d.styles, d.tables, d.assets, { [note.path]: { paragraphs, tables: [] } }).arrayBuffer());
  expect(strFromU8(unzipSync(out)['word/endnotes.xml'])).toContain('A plain note.');
  expect((await DocxPackage.open(out)).readOnly).toBeFalsy();
});
