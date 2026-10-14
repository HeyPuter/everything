import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { revealFormatting, styleInspection, similarFormattingRanges } from '../src/engine/format-inspection.js';
import { styleUsage, styleRanges, deleteStyle, styleDeletionBlocker, createStyleFromSelection } from '../src/engine/style-management.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
function documentWith(lines) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  lines.forEach((line, i) => { if (i) doc.insertParagraph(); doc.replace(line); });
  return { pkg, doc };
}
const entry = (sections, title, label) => sections.find(s => s.title === title).entries.find(e => e.label === label);
async function save(pkg, doc) {
  const blob = await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets);
  return new Uint8Array(await blob.arrayBuffer());
}

it('reveals effective formatting and tells direct formatting from style formatting', () => {
  const { doc } = documentWith(['Heading words', 'Body with red text']);
  doc.select(0); doc.setParagraphStyle('Heading1');
  doc.select(3);
  let sections = revealFormatting(doc);
  expect(entry(sections, 'Font', 'Style')).toMatchObject({ value: 'Bold', direct: false });
  expect(entry(sections, 'Paragraph', 'Paragraph style').value).toBe('Heading 1');
  const at = doc.text.indexOf('red');
  doc.select(at, at + 3); doc.setRunFormat({ color: 'C00000' }); doc.setParagraphFormat({ alignment: 'center' });
  sections = revealFormatting(doc);
  expect(entry(sections, 'Font', 'Color')).toMatchObject({ value: '#C00000', direct: true, target: 'font' });
  expect(entry(sections, 'Paragraph', 'Alignment')).toMatchObject({ value: 'Centered', direct: true, target: 'paragraph' });
  expect(entry(sections, 'Section', 'Margins').target).toBe('page');
  expect(styleInspection(doc)).toMatchObject({ paragraphStyle: 'Normal', directText: ['color'], directParagraph: ['alignment'] });
});

it('finds every stretch of text with similar formatting', () => {
  const { doc } = documentWith(['one bold two bold', 'three bold']);
  for (const at of [4, 13]) { doc.select(at, at + 4); doc.setRunFormat({ bold: true }); }
  const last = doc.text.lastIndexOf('bold'); doc.select(last, last + 4); doc.setRunFormat({ bold: true });
  doc.select(5);
  expect(similarFormattingRanges(doc).map(m => doc.text.slice(m.start, m.end))).toEqual(['bold', 'bold', 'bold']);
  doc.select(1);
  expect(similarFormattingRanges(doc).map(m => doc.text.slice(m.start, m.end))).toEqual(['one ', ' two ', 'three ']);
});

it('counts style usage, lists instances and deletes a custom style in one undo step', async () => {
  const { pkg, doc } = documentWith(['Quote one', 'Plain', 'Quote two']);
  doc.select(0);
  const id = createStyleFromSelection(doc, 'Pull quote');
  doc.select(doc.text.indexOf('Quote two')); doc.setParagraphStyle(id);
  expect(styleUsage(doc).get(id)).toBe(2);
  expect(styleRanges(doc, id).map(r => doc.text.slice(r.start, r.end))).toEqual(['Quote one', 'Quote two']);
  expect(styleDeletionBlocker(doc, 'Normal')).toMatch(/default/);
  expect(styleDeletionBlocker(doc, 'Heading1')).toMatch(/Built-in/);
  let xml = strFromU8(unzipSync(await save(pkg, doc))['word/styles.xml']);
  expect(xml).toContain('Pull quote');
  expect(deleteStyle(doc, id)).toBe(true);
  expect(doc.styles.definitions[id]).toBeUndefined();
  expect(styleUsage(doc).get(id)).toBeUndefined();
  const bytes = await save(pkg, doc);
  xml = strFromU8(unzipSync(bytes)['word/styles.xml']);
  expect(xml).not.toContain('Pull quote');
  const document = strFromU8(unzipSync(bytes)['word/document.xml']);
  expect(document).not.toContain(`w:val="${id}"`);
  doc.undo();
  expect(styleUsage(doc).get(id)).toBe(2);
});

it('deletes an imported style from the styles part and rebases styles derived from it', async () => {
  const { pkg, doc } = documentWith(['Text']);
  const base = createStyleFromSelection(doc, 'Base custom');
  doc.createParagraphStyle('Derived custom', base);
  const derived = doc.paragraphStyle;
  const reopenedPkg = await DocxPackage.open(await save(pkg, doc));
  const reopened = new TextDocument(reopenedPkg.paragraphs, reopenedPkg.pageSettings, reopenedPkg.numbering, reopenedPkg.styles, reopenedPkg.tables, reopenedPkg.assets);
  expect(reopened.styles.definitions[base]).toBeDefined();
  deleteStyle(reopened, base);
  expect(reopened.styles.definitions[derived].basedOn).toBe('Normal');
  const xml = strFromU8(unzipSync(await save(reopenedPkg, reopened))['word/styles.xml']);
  expect(xml).not.toContain('Base custom');
  expect(xml).toMatch(/Derived custom[\s\S]*<w:basedOn w:val="Normal"\/>/);
});
