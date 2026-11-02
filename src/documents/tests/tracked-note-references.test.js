import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { revisionView } from '../src/engine/revisions.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const measure = (text, style) => ({ width: text.length * style.fontSize * .6, ascent: style.fontSize * .8, descent: style.fontSize * .2 });

const ref = id => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
const note = (id, text) => `<w:footnote w:id="${id}"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${text}</w:t></w:r></w:p></w:footnote>`;
function docx(body, notes, settings = '') {
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/></Relationships>',
    'word/settings.xml': `<w:settings xmlns:w="${W}">${settings}</w:settings>`,
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}</w:body></w:document>`,
    'word/footnotes.xml': `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${notes}</w:footnotes>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
const open = async bytes => { const pkg = await DocxPackage.open(bytes); return { pkg, model: new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets) }; };
const layout = (pkg, d) => layoutDocument(d.paragraphs, measure, pageGeometry(d.pageSettings), d.numbering, d.tables, pkg.pageStories, { styles: d.styles });
const shown = placed => (placed.footnoteAreas || []).flatMap(a => a.notes.map(n => n.display));

// Simple Markup and No Markup show the document as if every change were accepted, Original as if every change
// were rejected: a reference the view hides takes no note and no number. Both notes were shown and numbered.
it('leaves a note whose reference the revision view hides out of the page, renumbering the rest', async () => {
  const tracked = (type, id) => `<w:${type} w:id="9${id}" w:author="A" w:date="2020-01-01T00:00:00Z"><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r></w:${type}>`;
  const body = `<w:p><w:r><w:t>One</w:t></w:r>${tracked('del', 1)}<w:r><w:t> two</w:t></w:r>${ref(2)}<w:r><w:t> three</w:t></w:r>${tracked('ins', 3)}</w:p><w:sectPr/>`;
  const { pkg, model } = await open(docx(body, note(1, 'Deleted') + note(2, 'Kept') + note(3, 'Added')));
  expect(pkg.readOnly).toBeFalsy();
  const notes = () => layout(pkg, model).footnoteAreas.flatMap(a => a.notes.map(n => [n.id, n.display]));
  expect(notes()).toEqual([['1', '1'], ['2', '2'], ['3', '3']]);
  const mode = revisionView.mode;
  try {
    revisionView.mode = 'none';
    expect(notes()).toEqual([['2', '1'], ['3', '2']]);
    revisionView.mode = 'original';
    expect(notes()).toEqual([['1', '1'], ['2', '2']]);
  } finally { revisionView.mode = mode; }
  // Saving keeps every note a reference still names, whatever the view.
  const saved = strFromU8(unzipSync(new Uint8Array(await pkg.export(model.paragraphs, model.pageSettings, model.numbering, model.styles, model.tables, model.assets).arrayBuffer()))['word/footnotes.xml']);
  expect(['Deleted', 'Kept', 'Added'].every(text => saved.includes(text))).toBe(true);
});
