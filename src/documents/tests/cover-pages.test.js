import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { insertCoverPage, COVER_DESIGNS, COVER_DEFAULTS } from '../src/engine/cover-pages.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
function documentWith(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return { pkg, doc };
}
const text = { title: 'Annual Plan', subtitle: 'For the year ahead', author: 'Sam Lee', date: 'October 9, 2026' };

it('every design inserts a formatted title page ending in a page break before the existing first heading', async () => {
  for (const design of COVER_DESIGNS) {
    const { pkg, doc } = documentWith(['Introduction', 'Body text.']);
    doc.select(0, 12); doc.setParagraphStyle('Heading1');
    insertCoverPage(doc, design.id, text);
    const expected = design.lines.map(([role], i) => (text[role] ?? COVER_DEFAULTS[role]) + (i === design.lines.length - 1 ? '\f' : ''));
    const n = design.lines.length, titleAt = design.lines.findIndex(([role]) => role === 'title');
    expect(doc.paragraphs.slice(0, n + 1).map(paragraphText), design.id).toEqual([...expected, 'Introduction']);
    expect(doc.paragraphs[0].styleId ?? 'Normal', design.id).toBe('Normal');
    expect(doc.paragraphs[titleAt].runs[0].fontSize).toBeGreaterThanOrEqual(30);
    expect(doc.paragraphs[n].styleId).toBe('Heading1');
    const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
    const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
    expect(reopened.paragraphs.slice(0, n).map(paragraphText), design.id).toEqual(expected);
    expect(reopened.paragraphs[titleAt].runs[0], design.id).toMatchObject({ fontSize: design.lines[titleAt][2].fontSize, color: design.lines[titleAt][2].color });
  }
});

it('every design fits on one Letter page, so the document starts on page 2', async () => {
  const { layoutDocument } = await import('../src/engine/layout.js');
  const { pageGeometry } = await import('../src/engine/page-settings.js');
  const measure = (t, style) => ({ width: t.length * style.fontSize * 0.55, ascent: style.fontSize, descent: style.fontSize / 3 });
  for (const design of COVER_DESIGNS) {
    const { doc } = documentWith(['First page of the document.']);
    insertCoverPage(doc, design.id, text);
    const layout = layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables, undefined, { styles: doc.styles });
    expect(layout.pageCount, design.id).toBe(2);
  }
});

it('refuses a document that starts with a table', () => {
  const { doc } = documentWith(['x']);
  doc.select(0); doc.insertTable(1, 1, 600);
  if (doc.paragraphs[0].cellId) expect(() => insertCoverPage(doc, 'simple', text)).toThrow(/table/);
});

it('marks the cover with a hidden bookmark that survives saving, replaces it with another design and removes it', async () => {
  const { removeCoverPage, coverPageRange } = await import('../src/engine/cover-pages.js');
  const { pkg, doc } = documentWith(['Introduction', 'Body text.']);
  doc.select(0, 12); doc.setParagraphStyle('Heading1');
  insertCoverPage(doc, 'sidebar', text);
  expect(coverPageRange(doc)).toMatchObject({ start: 0 });
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  const reopened = await DocxPackage.open(new Uint8Array(await blob.arrayBuffer()));
  const again = new TextDocument(reopened.paragraphs, reopened.pageSettings, reopened.numbering, reopened.styles, reopened.tables, reopened.assets);
  expect(coverPageRange(again)).not.toBe(null);
  insertCoverPage(again, 'minimal', text);
  expect(again.paragraphs.map(paragraphText).filter(t => t.includes('Annual Plan'))).toHaveLength(1);
  expect(paragraphText(again.paragraphs[COVER_DESIGNS.find(d => d.id === 'minimal').lines.length])).toBe('Introduction');
  expect(removeCoverPage(again)).toBe(true);
  expect(again.paragraphs.map(paragraphText)).toEqual(['Introduction', 'Body text.']);
  expect(again.paragraphs[0].styleId).toBe('Heading1');
  expect(removeCoverPage(again)).toBe(false);
});
