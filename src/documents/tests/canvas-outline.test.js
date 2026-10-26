import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { layoutDocument, caretRect, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const source = readFileSync('public/fixtures/outline-levels.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const parse = bytes => new DOMParser().parseFromString(strFromU8(bytes), 'application/xml');
const measure = (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize * 1.1, descent: style.fontSize / 3 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const select = (doc, text) => { const at = doc.text.indexOf(text); expect(at).toBeGreaterThanOrEqual(0); doc.select(at); };
const headings = doc => doc.outline.map(e => [e.text, e.level]);
const expected = [['Outline levels Á😀', 1], ['Nested Á😀', 3], ['More nested inherited', 3], ['Direct level two', 2], ['Deep heading', 9], ['(Empty heading)', 3], ['Later heading', 1], ['Header heading', 3], ['Cell heading', 5], ['Numbered heading', 3], ['Built-in heading', 1]];
function equalParts(actual, expected, except = []) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const [name, bytes] of Object.entries(expected)) if (!except.includes(name)) expect(Buffer.from(actual[name]).equals(Buffer.from(bytes)), name).toBe(true);
}

it('resolves outline levels through defaults, style chains and direct overrides without inferring from font size or numbering', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  expect(headings(doc)).toEqual(expected);
  select(doc, 'Hidden from outline'); expect(doc.selectedParagraphs[0].runs[0].fontSize).toBe(18); expect(doc.paragraphFormatting.outlineLevel).toBe(9);
  select(doc, 'Numbered heading'); expect(doc.selectedParagraphs[0].list.level).toBe(0); expect(doc.paragraphFormatting.outlineLevel).toBe(2);
  for (const e of doc.outline) { const p = doc.paragraphs.find(p => p.id === e.id); expect(doc.text.slice(e.start, e.end)).toBe(p.runs.map(r => r.text).join('')); }
  equalParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('edits direct levels and clears a body override back to its style with complete undo and package preservation', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Direct body override'); const before = doc.snapshot();
  expect(doc.setOutlineLevel(null)).toBe(true); expect(doc.paragraphFormatting.outlineLevel).toBe(0); expect(doc.setOutlineLevel(null)).toBe(false);
  select(doc, 'Direct level two'); doc.setOutlineLevel(7); const after = doc.snapshot();
  const bytes = await save(pkg, doc), parts = unzipSync(bytes), xml = parse(parts['word/document.xml']);
  const direct = [...xml.getElementsByTagNameNS(W, 'p')].find(p => p.textContent === 'Direct body override'); expect(direct.getElementsByTagNameNS(W, 'outlineLvl')).toHaveLength(0);
  expect(headings(model(await DocxPackage.open(bytes)))).toEqual(headings(doc)); equalParts(parts, pkg.parts, ['word/document.xml']);
  doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(before); equalParts(unzipSync(await save(pkg, doc)), pkg.parts);
  doc.redo(); doc.redo(); expect(doc.snapshot()).toEqual(after);
});

it('inherits non-body document and table defaults while paragraph styles and direct levels take precedence', async () => {
  const parts = unzipSync(source), xml = parse(parts['word/styles.xml']);
  xml.getElementsByTagNameNS(W, 'docDefaults')[0].getElementsByTagNameNS(W, 'outlineLvl')[0].setAttributeNS(W, 'w:val', '6');
  const table = [...xml.getElementsByTagNameNS(W, 'style')].find(n => n.getAttributeNS(W, 'styleId') === 'TableGrid');
  const ppr = table.getElementsByTagNameNS(W, 'pPr')[0], outline = xml.createElementNS(W, 'w:outlineLvl'); outline.setAttributeNS(W, 'w:val', '4'); ppr.append(outline);
  parts['word/styles.xml'] = strToU8(new XMLSerializer().serializeToString(xml));
  const doc = model(await DocxPackage.open(zipSync(parts)));
  for (const [text, level] of [['Body introduction.', 6], ['Table body.', 4], ['Header heading', 2], ['Direct level two', 1], ['Hidden from outline', 9], ['Built-in heading', 0]]) {
    select(doc, text); expect(doc.paragraphFormatting.outlineLevel).toBe(level);
  }
});

it('edits and removes style declarations while retaining direct masking and unused definitions', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  doc.editParagraphStyle('CanvasOutlineChild', { paragraph: { outlineLevel: 5 } });
  expect(headings(doc).filter(([text]) => ['Nested Á😀', 'More nested inherited', 'Header heading', 'Numbered heading'].includes(text)).map(([, level]) => level)).toEqual([6, 6, 6, 6]);
  select(doc, 'Nested Á😀'); doc.setOutlineLevel(9);
  doc.editParagraphStyle('CanvasOutlineChild', { paragraph: { outlineLevel: null } });
  expect(doc.paragraphFormatting.outlineLevel).toBe(9); expect(headings(doc)).toContainEqual(['More nested inherited', 1]);
  const parts = unzipSync(await save(pkg, doc)), xml = parse(parts['word/styles.xml']);
  const child = [...xml.getElementsByTagNameNS(W, 'style')].find(n => n.getAttributeNS(W, 'styleId') === 'CanvasOutlineChild'); expect(child.getElementsByTagNameNS(W, 'outlineLvl')).toHaveLength(0);
  equalParts(parts, pkg.parts, ['word/document.xml', 'word/styles.xml']); expect(headings(model(await DocxPackage.open(await save(pkg, doc))))).toEqual(headings(doc));
  while (doc.history.length) doc.undo(); equalParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('keeps pixels, line geometry, pagination and repeated-header source selection unchanged when outline levels change', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), original = layout(doc), text = doc.text;
  const geometry = result => ({ pages: result.pageCount, lines: [...result.lines, ...result.repeatedLines].map(l => [l.page, l.y, l.height, l.baseline, l.start, l.end, ...l.fragments.map(f => [f.x, f.width, f.text, f.fontSize])]) });
  expect(original.pageCount).toBeGreaterThan(2); const header = doc.outline.find(e => e.text === 'Header heading');
  expect(original.repeatedLines.some(l => l.start === header.start)).toBe(true);
  doc.select(0, doc.text.indexOf('Built-in heading')); doc.setOutlineLevel(8); expect(doc.text).toBe(text); expect(geometry(layout(doc))).toEqual(geometry(original));
  expect(doc.outline.filter(e => e.id === header.id)).toHaveLength(1);
  const copy = original.repeatedLines.find(l => l.start === header.start);
  expect(caretRect(original, header.start, 'forward', copy.page).page).toBe(copy.page); expect(selectionRects(original, header.start, header.end).length).toBeGreaterThan(1);
  doc.undo(); expect(headings(doc)).toEqual(expected);
});

it('tracks Unicode source positions through typing, paragraph splits, following styles and deletion undo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), initial = headings(doc);
  select(doc, 'Nested Á😀'); doc.select(doc.selection.focus + 'Nested Á😀'.length); doc.replace(' edited');
  expect(headings(doc)).toContainEqual(['Nested Á😀 edited', 3]);
  select(doc, 'Outline levels Á😀'); doc.select('Outline levels Á😀'.length); doc.insertParagraph();
  expect(doc.selectedParagraphs[0].styleId).toBe('Normal'); expect(doc.paragraphFormatting.outlineLevel).toBe(9);
  select(doc, 'Deep heading'); const at = doc.selection.focus; doc.select(at, at + 'Deep heading'.length); doc.replace(''); expect(headings(doc)).toContainEqual(['(Empty heading)', 9]);
  doc.undo(); doc.undo(); doc.undo(); expect(headings(doc)).toEqual(initial); equalParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('authors built-in heading outlines, mixed selections, explicit body text and a new inherited style', async () => {
  const pkg = createDocx([paragraph('First'), paragraph('Second'), paragraph('Body')]), doc = model(pkg);
  doc.select(0); doc.setParagraphStyle('Heading1'); select(doc, 'Second'); doc.setParagraphStyle('Heading2');
  expect(headings(doc)).toEqual([['First', 1], ['Second', 2]]);
  doc.select(0, doc.text.indexOf('Body')); expect(doc.paragraphFormatting.outlineLevel).toBeNull();
  expect(doc.canSetOutlineLevel).toBe(false); expect(() => doc.setOutlineLevel(3)).toThrow(/fixed outline/);
  expect(() => doc.editParagraphStyle('Heading1', { paragraph: { outlineLevel: 9 } })).toThrow(/fixed outline/);
  doc.select(0); doc.createParagraphStyle('Custom first', 'Heading1'); select(doc, 'Second'); doc.createParagraphStyle('Custom second', 'Heading2');
  doc.select(0, doc.text.indexOf('Body')); expect(doc.canSetOutlineLevel).toBe(true); doc.setOutlineLevel(3);
  expect(headings(doc)).toEqual([['First', 4], ['Second', 4]]); select(doc, 'Second'); doc.setOutlineLevel(null); expect(doc.paragraphFormatting.outlineLevel).toBe(1);
  select(doc, 'Body'); doc.createParagraphStyle('Custom section', 'Heading1'); expect(doc.paragraphFormatting.outlineLevel).toBe(0);
  const bytes = await save(pkg, doc), reopened = model(await DocxPackage.open(bytes)); expect(headings(reopened)).toEqual(headings(doc));
  const unstyled = new TextDocument([paragraph('Legacy', { format: { alignment: 'center', outlineLevel: 1 } })]);
  expect(unstyled.setOutlineLevel(null)).toBe(true); expect(unstyled.paragraphFormatting).toMatchObject({ outlineLevel: 9, alignment: 'center' });
  unstyled.setOutlineLevel(4); unstyled.setOutlineLevel(null); expect(unstyled.outline).toEqual([]);
});

it('rejects invalid levels and malformed active declarations before changing history or allowing editable import', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Nested Á😀');
  for (const level of [-1, 10, 1.5, NaN, Infinity, '1', undefined, true]) {
    const before = doc.snapshot(), count = doc.history.length;
    expect(() => doc.setOutlineLevel(level)).toThrow(/outline/); expect(() => doc.editParagraphStyle('CanvasOutlineBase', { paragraph: { outlineLevel: level } })).toThrow(/outline/);
    expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(count);
  }
  for (const mutation of [n => n.setAttributeNS(W, 'w:val', '-1'), n => n.setAttributeNS(W, 'w:val', '10'), n => n.setAttributeNS(W, 'w:val', '1.5'), n => n.removeAttributeNS(W, 'val'), n => n.parentNode.append(n.cloneNode(true)), n => n.append(n.ownerDocument.createElementNS(W, 'w:b'))]) {
    const parts = unzipSync(source), xml = parse(parts['word/document.xml']); mutation(xml.getElementsByTagNameNS(W, 'outlineLvl')[0]); parts['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(xml));
    await expect(DocxPackage.open(zipSync(parts))).rejects.toThrow(/outline/);
  }
});

it('names a heading without the object characters of its note references, fields and equations', () => {
  const doc = new TextDocument([paragraph('History'), paragraph('Body')]);
  doc.select(0, 7); doc.setOutlineLevel(1);
  doc.select(7); doc.insertFootnoteReference('1', 'footnote');
  doc.select(0); doc.insertMathRun({ xml: '<m:oMath/>', text: 'x²' }); doc.replace(' ');
  expect(doc.text.split('\n')[0]).toBe('￼ History￼');
  expect(headings(doc)).toEqual([['x² History', 2]]);
});
