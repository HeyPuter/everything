import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { zipSync, strToU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument } from '../src/engine/model.js';
import { layoutDocument } from '../src/engine/layout.js';
import { layoutPageStories } from '../src/engine/page-story-layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const measure = (text, style) => ({ width: text.length * style.fontSize * .5, ascent: style.fontSize * .8, descent: style.fontSize * .2 });
const p = text => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

// Independently written: a footer of `footerLines` paragraphs, taller than the half-inch bottom
// margin, and body paragraphs with footnotes of a few lines each.
function docx(footerLines, body, kind = 'footnote') {
  const part = kind === 'footnote' ? 'footnotes' : 'endnotes';
  const ref = id => `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Reference w:id="${id}"/></w:r>`;
  const note = id => `<w:${kind} w:id="${id}"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:${kind}Ref/></w:r><w:r><w:t xml:space="preserve"> Note ${id}.</w:t></w:r></w:p>${p(`Note ${id} second line.`)}${p(`Note ${id} third line.`)}</w:${kind}>`;
  const files = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/${part}.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${part}+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>`,
    '_rels/.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/_rels/document.xml.rels': `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${part}" Target="${part}.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`,
    'word/document.xml': `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body.map(([text, id]) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r>${id ? ref(id) : ''}</w:p>`).join('')}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="720" w:left="1440" w:header="720" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/footer1.xml': `<w:ftr xmlns:w="${W}">${Array.from({ length: footerLines }, (_, i) => p(`Footer line ${i + 1}`)).join('')}</w:ftr>`,
    [`word/${part}.xml`]: `<w:${part} xmlns:w="${W}"><w:${kind} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:${kind}><w:${kind} w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:${kind}>${body.filter(([, id]) => id).map(([, id]) => note(id)).join('')}</w:${part}>`,
  };
  return zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
}
async function laidOut(footerLines, body, kind) {
  const pkg = await DocxPackage.open(docx(footerLines, body, kind)), doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
  const layout = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, pkg.pageStories, { styles: doc.styles });
  const stories = layoutPageStories(layout, pkg.pageStories, [doc.pageSettings], measure, doc.numbering, { styles: doc.styles });
  const storyKind = path => pkg.pageStories.stories[path]?.kind;
  return { layout, stories, footer: stories.lines.filter(l => storyKind(l.pageStory) === 'footer'), notes: stories.lines.filter(l => /^word\/(foot|end)notes\.xml/.test(l.pageStory || '')), body: layout.lines.filter(l => !l.pageStory && !l.virtual) };
}

// A footer taller than the bottom margin pushes the body up (§17.10.3 is silent; Word grows the
// footer upwards). Footnotes belong above it too: they were drawn over the footer's lines.
it.each([
  ['a short body', [['Reference one', '1'], ['After.']]],
  ['a body that fills the page', [['Reference one', '1'], ...Array.from({ length: 80 }, (_, i) => [`Filler ${i}.`]), ['Reference two', '2'], ['Last.']]],
])('keeps footnotes above a footer taller than the bottom margin (%s)', async (_, body) => {
  const { layout, footer, notes, body: lines } = await laidOut(8, body);
  expect(layout.footnoteAreas.length).toBeGreaterThan(0);
  for (const area of layout.footnoteAreas) {
    const footerTop = Math.min(...footer.filter(l => l.page === area.page).map(l => l.y));
    const pageNotes = notes.filter(l => l.page === area.page);
    expect(pageNotes.length).toBeGreaterThan(0);
    for (const line of pageNotes) expect(line.y + line.height, `page ${area.page + 1}`).toBeLessThanOrEqual(footerTop + 1e-6);
    for (const line of lines.filter(l => l.page === area.page)) expect(line.y + line.height).toBeLessThanOrEqual(area.top + 1e-6);
  }
});

it('leaves notes where they were when the footer fits in the bottom margin', async () => {
  const { layout, notes } = await laidOut(1, [['Reference one', '1'], ['After.']]);
  const g = layout.pages[0], end = Math.max(...notes.map(l => l.y + l.height));
  // The notes end at the bottom margin (less the space after the last note line).
  expect(end).toBeLessThanOrEqual(g.height - g.bottom + 1e-6);
  expect(end).toBeGreaterThan(g.height - g.bottom - 16);
});

it.each([
  ['after a short body', [['Reference one', '1'], ['After.']]],
  // The body ends just above the footer: the notes continue on an added page.
  ...[61, 64].map(n => [`after ${n} lines`, [...Array.from({ length: n }, (_, i) => [`Filler ${i}.`]), ['Reference one', '1'], ['Reference two', '2']]]),
])('keeps endnotes above a footer taller than the bottom margin (%s)', async (_, body) => {
  const { layout, footer, notes } = await laidOut(8, body, 'endnote');
  expect(layout.endnoteAreas.length).toBeGreaterThan(0);
  expect(notes.length).toBeGreaterThan(0);
  for (const line of notes) {
    const footerTop = Math.min(...footer.filter(l => l.page === line.page).map(l => l.y));
    expect(line.y + line.height, `page ${line.page + 1}`).toBeLessThanOrEqual(footerTop + 1e-6);
  }
});
