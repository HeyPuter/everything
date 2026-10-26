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
const p = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

/** Independently written: `before` body paragraphs, then one paragraph per note referencing it, then 30 more; each note has `lines[i]` paragraphs. */
function notesDocx(before, lines) {
  const ref = id => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
  const note = (id, count) => `<w:footnote w:id="${id}"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Note ${id}.</w:t></w:r></w:p>${Array.from({ length: count }, (_, i) => p(`Note ${id} line ${i}.`)).join('')}</w:footnote>`;
  const body = [...Array.from({ length: before }, (_, i) => p(`Body ${i}.`)), ...lines.map((_, i) => `<w:p><w:r><w:t xml:space="preserve">Reference ${i + 1}</w:t></w:r>${ref(i + 1)}</w:p>`), ...Array.from({ length: 30 }, (_, i) => p(`After ${i}.`))].join('');
  const files = {
    '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>',
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>',
    // Letter paper with one-inch margins: 864 px of writing height.
    'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/footnotes.xml': `<w:footnotes xmlns:w="${W}"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>${lines.map((count, i) => note(i + 1, count)).join('')}</w:footnotes>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
async function laidOut(before, lines) {
  const pkg = await DocxPackage.open(notesDocx(before, lines)), doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
  const layout = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, pkg.pageStories, { styles: doc.styles });
  const body = layout.lines.filter(l => !l.pageStory && !l.virtual), text = doc.text;
  const refLine = id => body.find(l => text.slice(l.start, l.end).startsWith(`Reference ${id}`)), refPage = id => refLine(id).page;
  return { layout, body, refLine, refPage };
}
// Every page holds body text, no note area starts above the page's text or over its body, and each note sits on its reference's page.
function expectSound({ layout, body, refPage }, count) {
  const g = layout.page;
  for (let page = 0; page < layout.pageCount; page++) expect(body.some(l => l.page === page), `page ${page + 1} has body text`).toBe(true);
  for (const area of layout.footnoteAreas) {
    expect(area.top).toBeGreaterThanOrEqual(g.top - 1e-6);
    for (const line of body.filter(l => l.page === area.page)) expect(line.y + line.height, `page ${area.page + 1}`).toBeLessThanOrEqual(area.top + 1e-6);
  }
  const shown = layout.footnoteAreas.flatMap(area => area.notes.map(note => [note.id, area.page]));
  expect(shown.map(([id]) => id).sort()).toEqual(Array.from({ length: count }, (_, i) => String(i + 1)).sort());
  for (const [id, page] of shown) expect(page, `note ${id}`).toBe(refPage(id));
}

it('keeps notes on their reference pages when one page cannot hold all of them, without emptying pages', async () => {
  // Six notes of about a quarter of a page each, referenced from consecutive paragraphs.
  const result = await laidOut(3, [8, 8, 8, 8, 8, 8]);
  expectSound(result, 6);
  expect(new Set(result.layout.footnoteAreas.map(a => a.page)).size).toBeGreaterThan(1);
  expectSound(await laidOut(10, [12, 3, 20, 2]), 4);
});

it.each([[0], [6], [30]])('starts a note too tall to fit beneath its reference on any page right below the reference (%i paragraphs before)', async before => {
  // 846 px: shorter than the 864 px writing height, taller than it less the reference line and separator.
  const { layout, body, refLine, refPage } = await laidOut(before, [37]);
  expectSound({ layout, body, refPage }, 1);
  const area = layout.footnoteAreas[0], line = refLine('1');
  expect(area.top - (line.y + line.height)).toBeLessThan(2);
  // Away from the top of the first page, the reference line starts a page, where its note has the most room.
  if (before) expect(line.y).toBe(layout.page.top);
});

it('still moves a reference and its note to the next page when the note fits there', async () => {
  const { layout, body, refLine, refPage } = await laidOut(30, [15]);
  expectSound({ layout, body, refPage }, 1);
  expect(refPage('1')).toBe(1);
  expect(layout.footnoteAreas[0].top).toBeGreaterThan(refLine('1').y + 300);
});
