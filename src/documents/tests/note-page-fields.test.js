import { beforeAll, afterAll, it, expect } from 'vitest';
import { ParagraphMeasureCache } from '../src/engine/paragraph-measure-cache.js';
import { JSDOM } from 'jsdom';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';

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
const noteText = (stories, path) => stories.lines.filter(l => l.pageStory === path).map(l => l.fragments.map(f => f.text).join('')).join('');

// A PAGE or NUMPAGES field in a footnote shows the page the note is on and the page count (§17.16.5.43, .40), as
// in a header: notes were measured as if on page 1 of 1, so "On page 2 of 3" read "On page 1 of 1".
it('shows the page a footnote is on in a PAGE field inside the note, and the page count in NUMPAGES', async () => {
  const field = '<w:fldSimple w:instr=" PAGE \\* roman "><w:r><w:t>9</w:t></w:r></w:fldSimple>', count = '<w:fldSimple w:instr=" NUMPAGES "><w:r><w:t>9</w:t></w:r></w:fldSimple>';
  const pageNote = `<w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> On page </w:t></w:r>${field}<w:r><w:t xml:space="preserve"> of </w:t></w:r>${count}</w:p></w:footnote>`;
  const body = `<w:p><w:r><w:t>First page</w:t></w:r></w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Second</w:t></w:r>${ref(1)}</w:p><w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>Third</w:t></w:r></w:p><w:sectPr/>`;
  const { pkg, model } = await open(docx(body, pageNote));
  expect(pkg.readOnly).toBeFalsy();
  const placed = layout(pkg, model);
  expect(placed.footnoteAreas.map(a => a.page)).toEqual([1]);
  const plain = layoutPageStories(placed, pkg.pageStories, [model.pageSettings], measure, model.numbering, { styles: model.styles });
  expect(noteText(plain, 'word/footnotes.xml#1')).toContain('On page ii of 3');
  // A measurer that remembers stories keys the note by its page.
  const remembering = Object.assign((text, style) => measure(text, style), { paragraphCache: () => cache });
  const cache = new ParagraphMeasureCache();
  const cached = layoutPageStories(placed, pkg.pageStories, [model.pageSettings], remembering, model.numbering, { styles: model.styles });
  expect(noteText(cached, 'word/footnotes.xml#1')).toContain('On page ii of 3');
});
