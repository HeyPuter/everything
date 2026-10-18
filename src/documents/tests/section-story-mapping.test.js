// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { paragraph } from '../src/engine/model.js';
import { CanvasEditor } from '../src/engine/canvas-editor.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const files = {
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>',
  'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/></Relationships>',
  'word/header1.xml': `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Last header</w:t></w:r></w:p></w:hdr>`,
  '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:pPr><w:sectPr/></w:pPr><w:r><w:t>Middle</w:t></w:r></w:p><w:p><w:r><w:t>Last</w:t></w:r></w:p><w:sectPr><w:headerReference xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" w:type="default" r:id="rIdH"/></w:sectPr></w:body></w:document>`,
};

afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

it('gives a new header to the section shown, after a section break was inserted', async () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    fontKerning: 'auto', getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), measureText: text => ({ width: [...text].length * 8 }),
    setTransform() {}, fillRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {}, rect() {}, clip() {}, moveTo() {}, lineTo() {}, stroke() {}, setLineDash() {}, strokeRect() {}, closePath() {}, fill() {}, arc() {}, translate() {}, scale() {}, rotate() {}, drawImage() {}, clearRect() {},
  });
  const pkg = await DocxPackage.open(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
  const host = document.createElement('div'); document.body.append(host);
  const editor = new CanvasEditor(host, pkg);
  // A section break inside the first section: the body now has three sections, the file two.
  editor.execute(() => { editor.model.select(2); editor.model.insertSectionBreak('nextPage'); });
  expect(editor.pageStories.sections).toHaveLength(3);
  const last = editor.pageStories.sections[2].header.default;
  expect(editor.pageStories.sections.map(s => s.header.default || null)).toEqual([null, null, last]);
  // A header for the second section on screen, which takes its headers from the file's first section.
  const path = pkg.addPageStory('header', { variant: 'default', section: 1 });
  editor.attachPageStory(path, 'header', [paragraph('First header')], { variant: 'default', section: 1 });
  expect(editor.pageStories.sections.map(s => s.header.default || null)).toEqual([path, path, last]);
  editor.destroy();
});
