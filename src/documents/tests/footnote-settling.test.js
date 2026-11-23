import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const measure = (text, style) => ({ width: text.length * style.fontSize * .5, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const words = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
/** `count` paragraphs of `bodyWords(i)` words, each ending in a reference to a note of `noteWords(i)` words. */
function notesDocx(count, bodyWords, noteWords) {
  const ref = id => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
  const body = Array.from({ length: count }, (_, i) => `<w:p><w:r><w:t xml:space="preserve">${words(bodyWords(i + 1))} </w:t></w:r>${ref(i + 1)}<w:r><w:t xml:space="preserve"> tail</w:t></w:r></w:p>`).join('');
  const notes = Array.from({ length: count }, (_, i) => `<w:footnote w:id="${i + 1}"><w:p><w:r><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${words(noteWords(i + 1))}</w:t></w:r></w:p></w:footnote>`).join('');
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults></w:styles>`,
    'word/footnotes.xml': `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${notes}</w:footnotes>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
// A page's notes and the body above them settle by laying the body out again with each page's reservation. Here
// the reservations alternate (a reference line pushed on by its note's room comes back once that room is
// gone) until the union of two states is taken; that union moves references again, and a page could end up
// holding notes taller than its reservation, drawn over its last lines of text.
it('never draws a page\'s notes over its body text when the reservations do not settle', async () => {
  const pkg = await DocxPackage.open(notesDocx(40, i => 20 + (i * 6) % 60, i => (i * 7) % 50));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
  const layout = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, pkg.pageStories, { styles: doc.styles });
  const body = layout.lines.filter(l => !l.pageStory && !l.virtual), text = doc.text;
  for (const area of layout.footnoteAreas) {
    const bottom = Math.max(...body.filter(l => l.page === area.page).map(l => l.y + l.height));
    expect(bottom, `page ${area.page + 1}`).toBeLessThanOrEqual(area.top + 1e-6);
  }
  // Every note is shown once, on the page of its reference.
  const shown = layout.footnoteAreas.flatMap(area => area.notes.map(note => [note.id, area.page]));
  expect(shown.map(([id]) => Number(id)).sort((a, b) => a - b)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
  const refs = doc.paragraphs.map((p, i) => [String(i + 1), body.find(l => l.paragraphId === p.id && text.slice(l.start, l.end).includes('\uFFFC'))?.page]);
  for (const [id, page] of shown) expect(page, `note ${id}`).toBe(Object.fromEntries(refs)[id]);
});
