import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, W } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphFormat } from '../src/engine/model.js';
import { listMarkers } from '../src/engine/numbering.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/clear-paragraph-formatting.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const fixture = async () => { const pkg = await DocxPackage.open(source); return [pkg, model(pkg)]; };
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const sameParts = (actual, expected, except = []) => { expect(Object.keys(actual)).toEqual(Object.keys(expected)); for (const name of Object.keys(expected)) if (!except.includes(name)) expect(Buffer.from(actual[name]).equals(Buffer.from(expected[name])), name).toBe(true); };
const xml = bytes => new DOMParser().parseFromString(strFromU8(unzipSync(bytes)['word/document.xml']), 'application/xml');
const nodes = (doc, tag) => [...doc.getElementsByTagNameNS(W, tag)];
const select = (doc, index) => doc.select(doc.paragraphOffset(index));
const format = (doc, index) => paragraphFormat(doc.paragraphs[index], doc.numbering);
const textState = doc => doc.paragraphs.map(p => ({ runs: p.runs, mark: p.markFormat, markProperties: p.markProperties, markOverrides: p.markOverrides, markStyleId: p.markStyleId, bookmarks: p.bookmarks, cellId: p.cellId, styleId: p.styleId }));
const layout = doc => layoutDocument(doc.paragraphs, (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize, descent: style.fontSize / 3 }), pageGeometry(doc.pageSettings), doc.numbering, doc.tables);

it('imports independent direct, opaque and inherited paragraph declarations without rewriting the package', async () => {
  const [pkg, doc] = await fixture(); expect(format(doc, 1)).toMatchObject({ alignment: 'right', lineRule: 'exact', lineSpacing: 30, indentLeft: 720, firstLine: -216, outlineLevel: 9, pageBreakBefore: true });
  expect(doc.paragraphs[4].hasDirectParagraphProperties).toBe(true); expect(doc.paragraphs[5].hasDirectParagraphProperties).toBe(false);
  expect(doc.paragraphs[6].list).toBeNull(); expect(doc.paragraphs[7].list).toMatchObject({ numId: '5', direct: true }); expect(doc.paragraphs[9].list).toMatchObject({ numId: '5', direct: false });
  sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('resets the caret paragraph to inherited geometry, spacing, decoration and pagination while retaining text and mark formatting', async () => {
  const [pkg, doc] = await fixture(); select(doc, 1); doc.setRunFormat({ underline: true }); const before = doc.snapshot(), text = structuredClone(textState(doc));
  expect(doc.clearDirectParagraphFormatting()).toBe(true); expect(doc.history).toHaveLength(1); expect(doc.selection).toEqual(before.selection); expect(doc.typingFormat).toEqual(before.typingFormat); expect(textState(doc)).toEqual(text);
  expect(format(doc, 1)).toMatchObject({ alignment: 'left', lineRule: 'auto', lineSpacing: 1.25, indentLeft: 216, firstLine: 144, spaceBefore: 4, spaceAfter: 6, outlineLevel: 2, pageBreakBefore: false, widowControl: true, keepNext: false, paragraphShading: 'EEF2FF', contextualSpacing: false });
  expect(format(doc, 1).tabs).toEqual([{ position: 2160, alignment: 'center', leader: 'dot' }]); expect(format(doc, 1).paragraphBorders.bottom).toMatchObject({ style: 'single', color: '224488' });
  const out = model(await DocxPackage.open(await save(pkg, doc))); expect(format(out, 1)).toEqual(format(doc, 1)); expect(out.paragraphs[1].markFormat).toEqual(doc.paragraphs[1].markFormat);
  doc.undo(); expect(doc.snapshot()).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts); doc.redo(); expect(format(doc, 1).lineSpacing).toBe(1.25);
});

it('resets a backward range in one step and excludes the paragraph at the final start boundary', async () => {
  const [, doc] = await fixture(); const third = structuredClone(doc.paragraphs[3]); doc.select(doc.paragraphOffset(3), doc.paragraphOffset(1) + 2); const before = doc.snapshot();
  doc.clearDirectParagraphFormatting(); expect(doc.history).toHaveLength(1); expect(doc.selection).toEqual(before.selection); expect(format(doc, 1).alignment).toBe('left'); expect(format(doc, 2).alignment).toBe('left'); expect(doc.paragraphs[3]).toEqual(third);
  doc.undo(); expect(doc.snapshot()).toEqual(before);
});

it('restores style numbering, removes direct lists and retains counters and inherited geometry after reopening', async () => {
  const [pkg, doc] = await fixture(); doc.select(doc.paragraphOffset(6), doc.paragraphOffset(10)); doc.clearDirectParagraphFormatting();
  expect(doc.paragraphs[6].list).toMatchObject({ numId: '5', direct: false }); expect(doc.paragraphs[7].list).toBeNull(); expect(doc.paragraphs[8].list).toMatchObject({ numId: '5', direct: false });
  expect(listMarkers(doc.paragraphs, doc.numbering).slice(6, 10).map(m => m?.text ?? null)).toEqual(['1.', null, '2.', '3.']);
  // The numbering style supersedes ancestor indents (reference list-style-indents
  // cases A02/A10); clearing direct formatting restores that list geometry.
  expect(format(doc, 8)).toMatchObject({indentLeft:360,firstLine:-360});
  const bytes = await save(pkg, doc); expect(nodes(xml(bytes), 'p').slice(6, 10).flatMap(p => nodes(p, 'numPr'))).toHaveLength(0);
  const reopened = model(await DocxPackage.open(bytes)); expect(reopened.paragraphs.slice(6, 10).map(p => p.list)).toEqual(doc.paragraphs.slice(6, 10).map(p => p.list)); sameParts(unzipSync(bytes), pkg.parts, ['word/document.xml']);
});

it('removes all selected paragraph overrides without changing run/mark XML, styles, links, bookmarks, tables or image assets', async () => {
  const [pkg, doc] = await fixture(); doc.select(0, doc.text.length); const before = doc.snapshot(), text = structuredClone(textState(doc));
  doc.clearDirectParagraphFormatting(); expect(doc.history).toHaveLength(1); expect(textState(doc)).toEqual(text); expect(doc.tables).toEqual(before.tables); expect(doc.styles).toEqual(before.styles); expect(doc.numbering).toEqual(before.numbering);
  const bytes = await save(pkg, doc); sameParts(unzipSync(bytes), pkg.parts, ['word/document.xml']);
  for (const props of nodes(xml(bytes), 'pPr')) expect([...props.children].every(n => ['pStyle', 'rPr', 'sectPr'].includes(n.localName))).toBe(true);
  const out = model(await DocxPackage.open(bytes)); expect(out.text).toBe(doc.text); expect(out.paragraphs.map(p => p.markProperties)).toEqual(doc.paragraphs.map(p => p.markProperties));
  doc.undo(); expect(doc.snapshot()).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('keeps reset paragraphs responsive to later based-on style changes after save/reopen', async () => {
  const [pkg, doc] = await fixture(); select(doc, 1); doc.clearDirectParagraphFormatting(); const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  reopened.editParagraphStyle('ParagraphResetBase', { paragraph: { alignment: 'center', lineRule: 'auto', lineSpacing: 1.5, indentLeft: 432 } });
  expect(format(reopened, 1)).toMatchObject({ alignment: 'center', lineSpacing: 1.5, indentLeft: 432 }); expect(format(reopened, 2).lineSpacing).toBe(2);
});

it('does not freeze inherited numbering into a fresh paragraph when saving a reset or style-only paragraph', async () => {
  const [pkg] = await fixture(), p = paragraph('Fresh styled paragraph', { styleId: 'ParagraphResetNumbered', styleChanged: true, format: { alignment: 'right' } });
  const doc = new TextDocument([p], pkg.pageSettings, pkg.numbering, pkg.styles); doc.clearDirectParagraphFormatting(); doc.createParagraphStyle('Child list', 'ParagraphResetNumbered'); const id = doc.paragraphStyle;
  const bytes = await save(pkg, doc); expect(nodes(xml(bytes), 'numPr')).toHaveLength(0);
  const reopened = model(await DocxPackage.open(bytes)); expect(reopened.paragraphs[0].list).toMatchObject({ numId: '5', direct: false }); reopened.editParagraphStyle(id, { basedOn: 'Normal' }); expect(reopened.paragraphs[0].list).toBeNull();
  // The same serializer rule applies before any reset, when the style alone supplies the list.
  const inherited = new TextDocument([paragraph('Style-only new paragraph', { styleId: 'ParagraphResetNumbered', styleChanged: true })], pkg.pageSettings, pkg.numbering, pkg.styles);
  expect(inherited.clearDirectParagraphFormatting()).toBe(false); expect(nodes(xml(await save(pkg, inherited)), 'numPr')).toHaveLength(0);
});

it('keeps empty paragraph marks and future text formatting intact when clearing paragraph geometry', async () => {
  const [pkg, doc] = await fixture(); select(doc, 3); const mark = structuredClone(doc.paragraphs[3].markFormat); doc.clearDirectParagraphFormatting();
  expect(format(doc, 3).indentLeft).toBe(216); expect(doc.paragraphs[3].markFormat).toEqual(mark); expect(doc.runFormatting.fontSize).toBe(22);
  doc.replace('Empty Á😀'); doc.insertParagraph(); doc.replace('Second'); const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  for (let i = 3; i < 5; i++) { expect(format(reopened, i).indentLeft).toBe(216); expect(reopened.paragraphs[i].runs[0].fontSize).toBe(22); }
});

it('preserves redo and document bytes for style-only paragraphs but clears opaque direct paragraph declarations', async () => {
  const [pkg, doc] = await fixture(); select(doc, 1); doc.clearDirectParagraphFormatting(); doc.undo(); select(doc, 5); const before = doc.snapshot();
  expect(doc.clearDirectParagraphFormatting()).toBe(false); expect(doc.snapshot()).toEqual(before); expect(doc.future).toHaveLength(1); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  select(doc, 9); expect(doc.clearDirectParagraphFormatting()).toBe(false); select(doc, 4); const visible = format(doc, 4); expect(visible.suppressLineNumbers).toBe(true); expect(doc.clearDirectParagraphFormatting()).toBe(true); expect(format(doc, 4)).toEqual({ ...visible, suppressLineNumbers: false });
  expect(nodes(nodes(xml(await save(pkg, doc)), 'p')[4], 'suppressLineNumbers')).toHaveLength(0); expect(doc.clearDirectParagraphFormatting()).toBe(false);
});

it('removes explicit values equal to inheritance and permits later direct edits without reviving removed declarations', async () => {
  const [pkg, doc] = await fixture(); select(doc, 2); doc.setParagraphFormat({ lineRule: 'auto', lineSpacing: 1.25 }); doc.clearDirectParagraphFormatting(); doc.setParagraphFormat({ alignment: 'right' });
  const bytes = await save(pkg, doc), p = nodes(xml(bytes), 'p')[2]; expect(nodes(p, 'spacing')).toHaveLength(0); expect(nodes(p, 'jc')[0].getAttributeNS(W, 'val')).toBe('right');
  const reopened = model(await DocxPackage.open(bytes)); reopened.editParagraphStyle('ParagraphResetBase', { paragraph: { lineRule: 'auto', lineSpacing: 1.5 } }); expect(format(reopened, 2)).toMatchObject({ alignment: 'right', lineSpacing: 1.5 });
});

it('reflows body and continued tables, retaining source-based caret and repeated-header hit geometry', async () => {
  const [, doc] = await fixture(), before = layout(doc); doc.select(0, doc.text.length); doc.clearDirectParagraphFormatting(); const after = layout(doc); expect(after.pageCount).toBeLessThan(before.pageCount); expect(after.repeatedLines.length).toBeGreaterThan(0);
  const at = doc.text.indexOf('Á😀'), caret = caretRect(after, at); expect(hitTest(after, caret.page, caret.x, caret.y + 1)).toBe(at); expect(selectionRects(after, at, at + 4).length).toBeGreaterThan(0);
  const header = after.repeatedLines[0]; expect(hitTest(after, header.page, header.stops[0].x, header.y + header.height / 2)).toBe(header.start); doc.undo(); expect(layout(doc)).toEqual(before);
});

it('preflights all selected paragraphs before a reset exposes invalid inherited spacing', async () => {
  const [pkg] = await fixture(), styles = structuredClone(pkg.styles); styles.definitions.ParagraphResetBase.properties.spacing = { line: '1201', lineRule: 'auto' };
  const doc = new TextDocument([structuredClone(pkg.paragraphs[4]), structuredClone(pkg.paragraphs[2])], pkg.pageSettings, pkg.numbering, styles); doc.select(0, doc.text.length); const before = doc.snapshot();
  expect(() => doc.clearDirectParagraphFormatting()).toThrow(/spacing/); expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
});

it('resets built-in headings to their fixed outline and engine-only paragraphs to defaults', async () => {
  const pkg = createDocx([paragraph('Heading')]), doc = model(pkg); doc.setParagraphStyle('Heading1'); doc.setParagraphFormat({ alignment: 'right', indentLeft: 720 }); doc.clearDirectParagraphFormatting();
  expect(doc.paragraphStyle).toBe('Heading1'); expect(doc.paragraphFormatting).toMatchObject({ alignment: 'left', indentLeft: 0, outlineLevel: 0, keepNext: true }); expect(doc.runFormatting.bold).toBe(true);
  const bare = new TextDocument([paragraph('Plain', { format: { alignment: 'right', spaceAfter: 30 }, markFormat: { fontSize: 18 } })]); bare.clearDirectParagraphFormatting(); expect(bare.paragraphFormatting).toMatchObject({ alignment: 'left', spaceAfter: 9 }); expect(bare.paragraphs[0].markFormat.fontSize).toBe(18); expect(bare.clearDirectParagraphFormatting()).toBe(false);
});
