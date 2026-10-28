import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { layoutDocument, caretRect, hitTest, selectionRects, imageAtPoint } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { canvasWordSpacing, canvasLetterSpacing, setCanvasTextStyle } from '../src/engine/canvas-text.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/justification.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const measure = (text, style) => ({ width: [...text].length * (style.fontSize * 2 / 3 + canvasLetterSpacing(style)) + (text.match(/[ \u00a0]/g)?.length || 0) * canvasWordSpacing(style), ascent: style.fontSize, descent: style.fontSize / 3 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const find = (doc, text) => doc.paragraphs.find(p => paragraphText(p).startsWith(text));
const select = (doc, text) => doc.select(doc.text.indexOf(text));
const simple = (text, page = {}, format = {}) => new TextDocument([paragraph(text, { format: { alignment: 'both', ...format } })], { width: 5400, left: 720, right: 720, ...page });
const edge = line => line.stops.at(-1).x - (line.hangingRight ? 0 : line.ignoredTrailingWidth);
function sameParts(actual, expected, except = []) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const [name, bytes] of Object.entries(expected)) if (!except.includes(name)) expect(Buffer.from(actual[name]).equals(Buffer.from(bytes)), name).toBe(true);
}
const rewrite = (from, to, path = 'word/document.xml', bytes = source) => {
  const parts = unzipSync(bytes); expect(strFromU8(parts[path])).toContain(from);
  parts[path] = strToU8(strFromU8(parts[path]).replace(from, to)); return zipSync(parts);
};

it('inherits both through named styles, honors direct overrides and preserves every untouched package part', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  for (const text of ['Inherited words', 'Direct both', 'Header justified']) expect(find(doc, text).format.alignment).toBe('both');
  expect(find(doc, 'Direct left').format.alignment).toBe('left');
  sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  select(doc, 'Direct left'); const before = doc.snapshot(); doc.setParagraphFormat({ alignment: 'both' });
  const bytes = await save(pkg, doc), reopened = model(await DocxPackage.open(bytes)); expect(find(reopened, 'Direct left').format.alignment).toBe('both');
  sameParts(unzipSync(bytes), pkg.parts, ['word/document.xml']);
  doc.undo(); expect(doc.snapshot()).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  doc.redo(); expect(find(doc, 'Direct left').format.alignment).toBe('both');
});

it('fills wrapped lines through word spaces only, leaves the final line natural and aligns carets and selection', () => {
  const doc = simple('Alpha beta gamma delta epsilon zeta eta theta iota'); const result = layout(doc), first = result.lines[0];
  expect(first.justificationSpacing).toBeGreaterThan(0); expect(edge(first)).toBeCloseTo(312);
  expect(result.lines.at(-1).justificationSpacing).toBeUndefined(); expect(edge(result.lines.at(-1))).toBeLessThan(312);
  const x = offset => first.stops.find(s => s.offset === offset).x;
  expect(x(2) - x(1)).toBe(8); expect(x(6) - x(5)).toBeCloseTo(8 + first.justificationSpacing);
  const caret = caretRect(result, 6); expect(hitTest(result, caret.page, caret.x, caret.y + caret.height / 2)).toBe(6);
  expect(selectionRects(result, 5, 6)[0].width).toBeCloseTo(x(6) - x(5));
  expect(doc.paragraphs[0].runs.some(r => 'justificationSpacing' in r)).toBe(false);
  expect(layout(simple('X'.repeat(100))).lines.every(l => l.justificationSpacing === undefined)).toBe(true);
});

it.each([false, true])('honors soft-return compatibility without changing wrapping: %s', flag => {
  const doc = simple('Alpha beta\v' + 'Following words '.repeat(10), { doNotExpandShiftReturn: flag });
  const result = layout(doc);
  for (const line of result.lines.filter(l => l.hardBreak === 'line')) expect(!!line.justificationSpacing).toBe(!flag);
  expect(result.lines.some(l => !l.hardBreak && !l.paragraphEnd && l.justificationSpacing > 0)).toBe(true);
  const terminal = layout(simple('Alpha beta\v', { doNotExpandShiftReturn: flag }));
  expect(!!terminal.lines[0].justificationSpacing).toBe(!flag); expect(terminal.lines.at(-1).fragments).toEqual([]);
});

it('handles interior and terminal page breaks and their paragraph-mark compatibility', () => {
  expect(layout(simple('Alpha beta\fAfter page')).lines[0].justificationSpacing).toBeGreaterThan(0);
  expect(layout(simple('Alpha beta\f')).lines[0].justificationSpacing).toBeUndefined();
  expect(layout(simple('Alpha beta\f', { splitPgBreakAndParaMark: true })).lines[0].justificationSpacing).toBeGreaterThan(0);
});

it.each([false, true])('keeps leading/trailing spaces natural and narrow nonbreaking spaces fixed: wrapTrailSpaces=%s', wrapTrailSpaces => {
  const doc = simple('  A\u00a0B C\u202fD   \vFinal', { wrapTrailSpaces }); const first = layout(doc).lines[0];
  const advance = offset => first.stops.find(s => s.offset === offset + 1).x - first.stops.find(s => s.offset === offset).x;
  expect(advance(0)).toBe(8); expect(advance(1)).toBe(8);
  expect(advance(3)).toBeCloseTo(8 + first.justificationSpacing); expect(advance(5)).toBeCloseTo(8 + first.justificationSpacing);
  expect(advance(7)).toBe(8); expect(edge(first)).toBeCloseTo(312);
  if (wrapTrailSpaces) expect(advance(10)).toBe(8);
  for (const text of ['', '   ', 'A\u0301😀']) expect(layout(simple(text)).lines.every(l => l.justificationSpacing === undefined)).toBe(true);
});

it('shares expanded advances across mixed runs, decorations, scripts, small caps, width scaling and graphemes', () => {
  const doc = simple('Alpha beta gamma delta epsilon zeta eta theta iota');
  doc.select(0, doc.text.length); doc.setRunFormat({ underline: true, strikethrough: 'single', highlight: 'yellow' });
  doc.select(6, 10); doc.setRunFormat({ color: 'CC0000', verticalAlign: 'superscript', textScale: 130, characterSpacing: 1 });
  doc.select(11, 16); doc.setRunFormat({ capitalization: 'smallCaps' }); const result = layout(doc), first = result.lines[0];
  expect(edge(first)).toBeCloseTo(312); expect(first.backgrounds.length).toBeGreaterThan(0);
  expect(Math.max(...first.underlines.map(u => u.x + u.width))).toBeCloseTo(312);
  expect(Math.max(...first.strikes.map(u => u.x + u.width))).toBeCloseTo(312);
  expect(first.fragments.some(f => f.verticalAlign === 'superscript' && f.justificationSpacing > 0)).toBe(true);
  const unicode = layout(simple('A\u0301😀 one two\vFinal')).lines[0]; expect(unicode.stops.map(s => s.offset)).toEqual([0, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
});

it('anchors earlier tab fields and leaves lines ending in a non-left tab field natural', () => {
  const doc = simple('One two\tA B\vFinal', {}, { tabs: [{ position: 1800, alignment: 'left' }] }); const first = layout(doc).lines[0];
  expect(first.stops.find(s => s.offset === 4).x).toBe(80); expect(first.stops.find(s => s.offset === 8).x).toBe(168); expect(edge(first)).toBeCloseTo(312);
  // After a center, right or decimal tab the line keeps its natural spacing: the aligned field stays on
  // its stop rather than the document being refused.
  for (const alignment of ['center', 'right', 'decimal']) {
    const natural = layout(simple('Label\tA B\vFinal', {}, { alignment: 'left', tabs: [{ position: 1800, alignment }] })).lines[0];
    const line = layout(simple('Label\tA B\vFinal', {}, { tabs: [{ position: 1800, alignment }] })).lines[0];
    expect(line.justificationSpacing).toBeUndefined();
    expect(line.stops.map(s => s.x)).toEqual(natural.stops.map(s => s.x));
  }
  expect(() => layout(simple('Label\tA B', {}, { tabs: [{ position: 1800, alignment: 'right' }] }))).not.toThrow();
});

it('restores native omitted leading space advances across format and small-caps fragments', () => {
  const native = (text, style) => ({ ...measure(text, style), width: measure(text, style).width - (/^[ \u00a0]/.test(text) ? canvasWordSpacing(style) : 0) });
  for (const capitalization of ['normal', 'smallCaps']) {
    const doc = simple('Alpha beta gamma\vFinal'); doc.select(0, doc.text.length); doc.setRunFormat({ capitalization }); doc.select(5, 10); doc.setRunFormat({ bold: true });
    const result = layoutDocument(doc.paragraphs, native, pageGeometry(doc.pageSettings)), expected = layout(doc);
    expect(result.lines[0].stops.map(s => s.x)).toEqual(expected.lines[0].stops.map(s => s.x));
    expect(edge(result.lines[0])).toBeCloseTo(312);
    if (capitalization === 'normal') expect(result.lines[0].fragments.find(f => f.bold).textOffsetX).toBeGreaterThan(0);
  }
});

it('corrects native rounding of added spacing without allowing table overflow', () => {
  const native = (text, style) => { const metrics = measure(text, style); if (style.justificationSpacing) metrics.width = Math.ceil(metrics.width * 65536) / 65536; return metrics; };
  const doc = simple('Alpha beta gamma delta epsilon zeta eta theta iota', { width: 5017 }); doc.select(0, doc.text.length); doc.setRunFormat({ textScale: 115 });
  const result = layoutDocument(doc.paragraphs, native, pageGeometry(doc.pageSettings));
  for (const line of result.lines.filter(l => l.justificationSpacing)) { expect(edge(line)).toBeLessThanOrEqual((5017 - 720) / 15 + 1e-6); expect(edge(line)).toBeCloseTo((5017 - 720) / 15, 3); }
});

it('preserves line breaks, marker positions, table geometry and repeated-header hit targets', async () => {
  const doc = model(await DocxPackage.open(source)), justified = layout(doc);
  doc.select(0, doc.text.length); doc.setParagraphFormat({ alignment: 'left' }); const left = layout(doc);
  expect(justified.tableWidths).toEqual(left.tableWidths); expect(justified.pageCount).toBe(left.pageCount);
  expect(justified.lines.map(l => [l.start, l.end, l.page, l.y])).toEqual(left.lines.map(l => [l.start, l.end, l.page, l.y]));
  expect(justified.lines.filter(l => l.marker).map(l => l.marker)).toEqual(left.lines.filter(l => l.marker).map(l => l.marker));
  expect(justified.repeatedLines.length).toBeGreaterThan(0);
  for (const line of [...justified.lines, ...justified.repeatedLines].filter(l => l.cellId && l.justificationSpacing)) {
    const box = justified.cells.find(c => c.id === line.cellId && c.page === line.page);
    expect(edge(line)).toBeCloseTo(box.x + box.width - 7.2);
    const stop = line.stops[1], caret = caretRect(justified, stop.offset, 'forward', line.page);
    expect(hitTest(justified, line.page, caret.x, caret.y + caret.height / 2)).toBe(stop.offset);
  }
  doc.undo(); expect(layout(doc)).toEqual(justified);
});

it('moves inline images with expanded word spacing and keeps image hit boxes aligned', async () => {
  const doc = model(await DocxPackage.open(readFileSync('public/fixtures/inline-images.docx')));
  const index = doc.paragraphs.findIndex(p => !p.cellId && p.runs.some(r => r.image)); const p = doc.paragraphs[index];
  doc.select(doc.paragraphOffset(index)); doc.replace('Words before '); doc.setParagraphFormat({ alignment: 'both' });
  doc.select(doc.paragraphOffset(index) + paragraphText(doc.paragraphs[index]).length); doc.replace('\vAfter image'); const result = layout(doc);
  const line = result.lines.find(l => l.paragraphId === p.id && l.fragments.some(f => f.image)), image = line.fragments.find(f => f.image);
  expect(line.justificationSpacing).toBeGreaterThan(0); expect(imageAtPoint(result, line.page, image.x + image.width / 2, line.baseline - image.ascent / 2)).toBe(image);
});

it('edits a shared style, preserves direct alignment overrides, and splits/merges justified paragraphs', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  doc.editParagraphStyle('CanvasJustified', { paragraph: { alignment: 'right' } });
  expect(find(doc, 'Inherited words').format.alignment).toBe('right'); expect(find(doc, 'Direct both').format.alignment).toBe('both'); expect(find(doc, 'Direct left').format.alignment).toBe('left');
  doc.undo(); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  const fresh = createDocx(), newDoc = model(fresh); newDoc.replace('Alpha beta'); newDoc.setParagraphFormat({ alignment: 'both' }); newDoc.select(6); newDoc.replace('\n');
  expect(newDoc.paragraphs.map(p => p.format.alignment)).toEqual(['both', 'both']); newDoc.select(6, 7); newDoc.replace('');
  expect(newDoc.text).toBe('Alpha beta'); expect(model(await DocxPackage.open(await save(fresh, newDoc))).paragraphs[0].format.alignment).toBe('both');
});

it.each(['<w:jc/>', '<w:jc w:val=""/>', '<w:jc w:val="both"/><w:jc w:val="left"/>', '<w:jc w:val="both">text</w:jc>', '<w:jc w:val="both" w:other="1"/>', '<w:jc w:val="both"><w:jc/></w:jc>', '<w:jc w:val="thaiDistribute"/>'])('rejects malformed or unsupported active alignment: %s', async markup => {
  await expect(DocxPackage.open(rewrite('<w:jc w:val="both"/>', markup))).rejects.toThrow();
});

it('justifies Arabic by its word spaces instead of refusing it, without kashida', async () => {
  // Kashida elongation is not drawn: Arabic lines are filled by widening their spaces, as Latin text.
  const pkg = await DocxPackage.open(rewrite('Direct both ', 'Direct both العربية '));
  expect(model(pkg).paragraphs.some(p => paragraphText(p).includes('العربية'))).toBe(true);
  const arabic = 'هذا نص عربي طويل يلتف عبر عدة أسطر للتأكد من أن التخطيط يعمل بشكل صحيح في المحرر';
  const result = layout(simple(arabic)), lines = result.lines;
  expect(lines.length).toBeGreaterThan(1);
  for (const line of lines.slice(0, -1)) { expect(line.justificationSpacing).toBeGreaterThan(0); expect(edge(line)).toBeCloseTo(312); }
  expect(lines.at(-1).justificationSpacing).toBeUndefined();
  expect(lines.flatMap(l => l.fragments).every(f => !f.text.includes('\u0640'))).toBe(true);
  const typed = simple('Alpha beta gamma delta epsilon zeta eta theta iota'); typed.select(6); typed.replace('العربية ');
  expect(() => layout(typed)).not.toThrow();
  const doc = simple('One two'); for (const alignment of ['justify', 'thaiDistribute', 'lowKashida']) expect(() => doc.setParagraphFormat({ alignment })).toThrow();
  expect(doc.undo()).toBe(false);
});

it.each([['true', true], ['1', true], ['on', true], ['false', false], ['0', false], ['off', false]])('reads and preserves the source compatibility lexical value %s', async (value, expected) => {
  const bytes = readFileSync('public/fixtures/justification-soft-breaks.docx');
  const pkg = await DocxPackage.open(rewrite('<w:doNotExpandShiftReturn/>', `<w:doNotExpandShiftReturn w:val="${value}"/>`, 'word/settings.xml', bytes)), doc = model(pkg);
  expect(doc.pageSettings.doNotExpandShiftReturn).toBe(expected); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  expect(() => doc.setPageSettings({ doNotExpandShiftReturn: !expected })).toThrow(/retained/);
  expect(() => pkg.export(doc.paragraphs, { ...doc.pageSettings, doNotExpandShiftReturn: !expected })).toThrow(/retained/);
});

it.each(['<w:doNotExpandShiftReturn w:val="bad"/>', '<w:doNotExpandShiftReturn/><w:doNotExpandShiftReturn/>', '<w:doNotExpandShiftReturn>text</w:doNotExpandShiftReturn>', '<w:doNotExpandShiftReturn w:unknown="1"/>'])('rejects malformed compatibility flags: %s', async markup => {
  await expect(DocxPackage.open(rewrite('<w:compat>', '<w:compat>' + markup, 'word/settings.xml', readFileSync('public/fixtures/justification-soft-breaks.docx')))).rejects.toThrow();
});

it('serializes the soft-return flag in fresh packages and resets native word spacing between paint styles', async () => {
  const pkg = createDocx([paragraph('Alpha beta\vFinal', { format: { alignment: 'both' } })], { doNotExpandShiftReturn: true });
  const reopened = await DocxPackage.open(await save(pkg, model(pkg))); expect(reopened.pageSettings.doNotExpandShiftReturn).toBe(true);
  expect(layout(model(reopened)).lines[0].justificationSpacing).toBeUndefined();
  const context = { fontKerning: 'auto', wordSpacing: '0px' }; setCanvasTextStyle(context, { justificationSpacing: 4, textScale: 50 }); expect(context.wordSpacing).toBe('8px');
  setCanvasTextStyle(context, {}); expect(context.wordSpacing).toBe('0px'); expect(() => setCanvasTextStyle({ fontKerning: 'auto' }, { justificationSpacing: 1 })).toThrow(/word-spacing/);
});
