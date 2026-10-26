import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { layoutDocument, caretRect, selectionRects, hitTest } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { paragraphBackgroundRect, paragraphBackgrounds, paintOnParagraphBackground } from '../src/engine/paragraph-backgrounds.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/paragraph-shading.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const measure = (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize, descent: style.fontSize / 3 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const select = (doc, text) => { const at = doc.text.indexOf(text); expect(at).toBeGreaterThanOrEqual(0); doc.select(at, at + text.length); };
const p = (doc, text) => doc.paragraphs.find(p => paragraphText(p) === text);
function equalParts(actual, expected, except = []) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const [name, bytes] of Object.entries(expected)) if (!except.includes(name)) expect(Buffer.from(actual[name]).equals(Buffer.from(bytes)), name).toBe(true);
}
const revise = (from, to, path = 'word/document.xml') => {
  const parts = unzipSync(source); expect(strFromU8(parts[path])).toContain(from);
  parts[path] = strToU8(strFromU8(parts[path]).replace(from, to)); return zipSync(parts);
};
const geometry = result => ({ pages: result.pageCount, lines: [...result.lines, ...result.repeatedLines].map(l => [l.start, l.end, l.page, l.y, l.height, l.baseline, l.stops, ...l.fragments.map(f => [f.text, f.x, f.width])]) });

it('reads default, based-on, table, direct and atomic shading with byte-exact no-edit export', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  for (const [text, fill] of [['Paragraph shading Á😀', 'F4F4F4'], ['Inherited first', 'DDEEFF'], ['Inherited second', 'DDEEFF'], ['Direct override with a first-line indent', '224466'], ['No fill reveals the page', 'auto'], ['Atomic clear without fill', 'auto'], ['Theme background Highlighted Run shaded', 'C2D69B'], ['Solid foreground', '0050C8'], ['Automatic foreground', 'foreground'], ['Other header', 'CCDDEE'], ['Cell no fill', 'auto']]) expect(p(doc, text).format.paragraphShading, text).toBe(fill);
  expect(p(doc, 'Theme background Highlighted Run shaded').runs.find(r => r.text === 'Highlighted').highlight).toBe('yellow');
  equalParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('edits selected paragraphs, removes inherited fills and round-trips with complete undo/redo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Inherited first'); const initial = doc.snapshot();
  doc.setParagraphFormat({ paragraphShading: 'aabbcc' }); select(doc, 'Inherited second'); doc.setParagraphFormat({ paragraphShading: 'auto' });
  select(doc, 'Shaded header'); doc.setParagraphFormat({ paragraphShading: '55AA77' });
  const bytes = await save(pkg, doc), reopened = model(await DocxPackage.open(bytes));
  for (const [text, fill] of [['Inherited first', 'AABBCC'], ['Inherited second', 'auto'], ['Shaded header', '55AA77']]) expect(p(reopened, text).format.paragraphShading).toBe(fill);
  equalParts(unzipSync(bytes), pkg.parts, ['word/document.xml']);
  doc.undo(); doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(initial); equalParts(unzipSync(await save(pkg, doc)), pkg.parts);
  doc.redo(); doc.redo(); doc.redo(); expect(p(doc, 'Shaded header').format.paragraphShading).toBe('55AA77');
});

it('edits paragraph styles atomically, restores inheritance, keeps direct overrides and serializes the right pPr', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  doc.editParagraphStyle('CanvasParagraphBase', { paragraph: { paragraphShading: '112233' } });
  expect(p(doc, 'Inherited first').format.paragraphShading).toBe('112233'); expect(p(doc, 'Shaded header').format.paragraphShading).toBe('112233');
  expect(p(doc, 'Direct override with a first-line indent').format.paragraphShading).toBe('224466');
  doc.editParagraphStyle('CanvasParagraphChild', { paragraph: { paragraphShading: 'auto' } });
  expect(p(doc, 'Inherited first').format.paragraphShading).toBe('auto');
  doc.editParagraphStyle('CanvasParagraphChild', { paragraph: { paragraphShading: null } });
  expect(p(doc, 'Inherited first').format.paragraphShading).toBe('112233');
  doc.editParagraphStyle('CanvasParagraphBase', { paragraph: { paragraphShading: null } });
  expect(p(doc, 'Inherited first').format.paragraphShading).toBe('F4F4F4'); expect(p(doc, 'Shaded header').format.paragraphShading).toBe('CCDDEE');
  const bytes = await save(pkg, doc), reopened = model(await DocxPackage.open(bytes));
  expect(p(reopened, 'Inherited first').format.paragraphShading).toBe('F4F4F4'); equalParts(unzipSync(bytes), pkg.parts, ['word/styles.xml', 'word/document.xml']);
  doc.editParagraphStyle('CanvasParagraphBase', { paragraph: { paragraphShading: 'foreground' } });
  const last = model(await DocxPackage.open(await save(pkg, doc))); expect(p(last, 'Inherited first').format.paragraphShading).toBe('foreground');
});

it('preserves theme channels on unrelated edits and replaces them only on a fill edit', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Theme background'); doc.setRunFormat({ bold: true });
  let xml = strFromU8(unzipSync(await save(pkg, doc))['word/document.xml']); expect(xml).toContain('w:themeFill="accent3"'); expect(xml).toContain('w:themeFillTint="99"'); expect(xml).toContain('w:themeFillShade="00"');
  doc.setParagraphFormat({ paragraphShading: 'auto' }); xml = strFromU8(unzipSync(await save(pkg, doc))['word/document.xml']); expect(xml).not.toContain('w:themeFill=');
  expect(xml).toContain('w:fill="CCAAEE"'); expect(xml).toContain('w:highlight w:val="yellow"');
});

it('authors shading and carries paragraph formatting through text splitting, merging and undo', async () => {
  const pkg = createDocx([paragraph('ABC')]), doc = model(pkg), initial = unzipSync(await save(pkg, doc));
  doc.setParagraphFormat({ paragraphShading: '224466' }); doc.select(1); doc.replace('\n');
  expect(doc.paragraphs.map(p => p.format.paragraphShading)).toEqual(['224466', '224466']);
  doc.select(1, 2); doc.replace(''); expect(doc.text).toBe('ABC'); expect(doc.paragraphs[0].format.paragraphShading).toBe('224466');
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(reopened.paragraphs[0].format.paragraphShading).toBe('224466');
  doc.undo(); doc.undo(); doc.undo(); equalParts(unzipSync(await save(pkg, doc)), initial);
});

it.each([null, '', 'red', '#GGGGGG', 12, {}, 'FF000000'])('rejects an invalid paragraph fill without changing undo state: %j', value => {
  const doc = new TextDocument([paragraph('Unchanged')]), before = doc.snapshot();
  expect(() => doc.setParagraphFormat({ paragraphShading: value })).toThrow(); expect(doc.snapshot()).toEqual(before); expect(doc.undo()).toBe(false);
});

it.each(['pct13', 'diagStripe', 'unsupported', ''])('rejects unsupported/missing active paragraph patterns before editable open: %s', async value => {
  const markup = value ? `<w:shd w:val="${value}" w:fill="224466"/>` : '<w:shd w:fill="224466"/>';
  await expect(DocxPackage.open(revise('<w:shd w:val="clear" w:fill="224466"/>', markup))).rejects.toThrow(/paragraph shading/);
});

it.each([
  '<w:shd w:val="clear"/><w:shd w:val="solid"/>',
  '<w:shd w:val="clear"><w:t>nested</w:t></w:shd>',
  '<w:shd w:val="clear">stray text</w:shd>',
  '<w:shd w:val="clear"><![CDATA[stray text]]></w:shd>',
  '<w:shd w:val="clear" w:fill="bogus"/>',
  '<w:shd w:val="clear" w:color="bogus" w:fill="224466"/>',
  '<w:shd w:val="clear" w:fill="224466" w:themeFillTint="X1"/>',
  '<w:shd w:val="solid" w:color="auto" w:themeColor="unknown"/>',
  '<w:shd w:val="clear" w:unexpected="true"/>',
])('rejects malformed shading, including inactive channels: %s', async markup => {
  await expect(DocxPackage.open(revise('<w:shd w:val="clear" w:fill="224466"/>', markup))).rejects.toThrow();
});

it('rejects active inherited patterns and retains unsupported unused styles', async () => {
  await expect(DocxPackage.open(revise('w:val="clear" w:fill="DDEEFF"', 'w:val="diagStripe" w:fill="DDEEFF"', 'word/styles.xml'))).rejects.toThrow(/paragraph shading/);
  const bytes = revise('</w:styles>', '<w:style w:type="paragraph" w:styleId="UnusedShade"><w:name w:val="Unused shade"/><w:pPr><w:shd w:val="diagStripe"/></w:pPr></w:style></w:styles>', 'word/styles.xml');
  const pkg = await DocxPackage.open(bytes); expect(pkg.styles.definitions.UnusedShade.error).toMatch(/paragraph shading/); equalParts(unzipSync(await save(pkg, model(pkg))), pkg.parts);
});

it('keeps shaping, pagination, AutoFit, grapheme carets and selection identical under fill edits', async () => {
  const doc = model(await DocxPackage.open(source)), before = layout(doc), at = doc.text.indexOf('Á😀');
  doc.select(0, doc.text.length); doc.setParagraphFormat({ paragraphShading: 'auto' }); const after = layout(doc);
  expect(geometry(after)).toEqual(geometry(before)); expect(after.tableWidths).toEqual(before.tableWidths);
  expect(caretRect(after, at)).toEqual(caretRect(before, at)); expect(selectionRects(after, at, at + 4)).toEqual(selectionRects(before, at, at + 4));
  const rect = caretRect(after, at); expect(hitTest(after, rect.page, rect.x, rect.y + rect.height / 2)).toEqual(hitTest(before, rect.page, rect.x, rect.y + rect.height / 2));
});

it('fills the indented writing area independently of first-line indents, wrapping and alignment', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc);
  const direct = result.lines.find(l => l.paragraphId === p(doc, 'Direct override with a first-line indent').id);
  expect(direct.paragraphBackground).toMatchObject({ x: 94, width: 412, before: 0, after: 0 }); expect(direct.stops[0].x).toBe(120);
  const hanging = result.lines.filter(l => l.paragraphId === doc.paragraphs.find(p => paragraphText(p).startsWith('Hanging paragraph')).id);
  expect(hanging.length).toBeGreaterThan(1); for (const line of hanging) expect(line.paragraphBackground).toMatchObject({ x: 70, width: 412 });
  select(doc, 'Direct override'); doc.setParagraphFormat({ alignment: 'right' }); const moved = layout(doc).lines.find(l => l.paragraphId === direct.paragraphId);
  expect(moved.paragraphBackground).toEqual(direct.paragraphBackground); expect(moved.stops[0].x).toBeGreaterThan(direct.stops[0].x);
  expect(result.lines.find(l => l.paragraphId === p(doc, '').id).paragraphBackground.value).toBe('55AA77');
});

it('uses allocated collapsed/contextual spacing and suppresses fill in automatic page gaps', () => {
  const doc = new TextDocument([paragraph('A', { format: { spaceAfter: 12, paragraphShading: '224466' } }), paragraph('B', { format: { spaceBefore: 9, paragraphShading: '55AA77' } })]);
  let result = layout(doc); expect(result.lines[0].paragraphBackground.after).toBe(16); expect(result.lines[1].paragraphBackground.before).toBe(0);
  doc.select(0); doc.setParagraphFormat({ contextualSpacing: true }); result = layout(doc); expect(result.lines[0].paragraphBackground.after).toBe(0); expect(result.lines[1].paragraphBackground.before).toBe(0);
  const small = layoutDocument([paragraph('A', { format: { lineRule: 'exact', lineSpacing: 36, spaceAfter: 0 } }), paragraph('B C D E', { format: { lineRule: 'exact', lineSpacing: 24, spaceBefore: 18, paragraphShading: '224466' } })], measure, { width: 200, height: 100, top: 10, bottom: 10, left: 10, right: 10 });
  const second = small.lines.find(l => l.start === 2); expect(second.page).toBe(1); expect(second.paragraphBackground.before).toBe(0);
});

it('splits fill at authored page breaks without painting a virtual trailing paragraph mark', () => {
  const result = layoutDocument([paragraph('Before\fAfter\f', { format: { paragraphShading: '224466' } })], measure);
  expect(result.pageCount).toBe(3); expect(result.lines.at(-1).virtual).toBe(true); expect(result.lines.at(-1).paragraphBackground).toBeUndefined();
  expect(result.lines.filter(l => l.paragraphBackground).map(l => l.page)).toEqual([0, 1]);
});

it('bounds long paragraphs, exact lines, cell fills and repeated-header copies on every page', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc);
  expect(result.pageCount).toBeGreaterThan(2); expect(result.repeatedLines.length).toBeGreaterThan(0);
  for (const line of [...result.lines, ...result.repeatedLines]) {
    const cell = result.cells.find(c => c.id === line.cellId && c.page === line.page), rect = paragraphBackgroundRect(line, result.page, cell);
    if (!rect) continue;
    expect(rect.y).toBeGreaterThanOrEqual(result.page.top); expect(rect.y + rect.height).toBeLessThanOrEqual(result.page.height - result.page.bottom + 1e-6);
    if (cell) { expect(rect.x).toBeGreaterThanOrEqual(cell.x); expect(rect.x + rect.width).toBeLessThanOrEqual(cell.x + cell.width); expect(rect.y).toBeGreaterThanOrEqual(cell.y); expect(rect.y + rect.height).toBeLessThanOrEqual(cell.y + cell.height + 1e-6); }
  }
  const exact = result.lines.find(l => l.paragraphId === p(doc, 'Exact clipped line').id); expect(exact.clip).toBe(true); expect(exact.height).toBeCloseTo(8 * 4 / 3);
  for (const l of result.repeatedLines.filter(l => l.paragraphId === p(doc, 'Shaded header').id)) expect(l.paragraphBackground.value).toBe('DDEEFF');
  const line = result.lines.find(l => l.paragraphId === p(doc, 'Cell automatic foreground').id), cell = result.cells.find(c => c.id === line.cellId && c.page === line.page);
  expect(paragraphBackgroundRect(line, result.page, cell).color).toBe('#000000');
});

it('uses separate inside/outside paint clips for automatic contrast and glyph overhangs', () => {
  const calls = [], ctx = Object.fromEntries(['save', 'restore', 'beginPath', 'rect', 'clip'].map(key => [key, (...args) => calls.push([key, ...args])]));
  const rect = { x: 20, y: 30, width: 100, height: 15, color: '#224466' };
  paintOnParagraphBackground(ctx, rect, { width: 200, height: 300 }, '#FFFFFF', color => calls.push(['draw', color]));
  expect(calls.filter(c => c[0] === 'draw')).toEqual([['draw', '#FFFFFF'], ['draw', '#224466']]);
  expect(calls).toContainEqual(['clip', 'evenodd']); expect(calls.filter(c => c[0] === 'rect' && c[1] === 20)).toHaveLength(2);
});

it('unifies wrapped paragraph bands for foreground contrast without crossing page boundaries', () => {
  const doc = new TextDocument([paragraph('Tall wrapped paragraph. '.repeat(50), { format: { paragraphShading: '224466' } })]);
  const result = layoutDocument(doc.paragraphs, measure, { width: 200, height: 120, left: 10, right: 10, top: 10, bottom: 10 }, doc.numbering);
  const bands = paragraphBackgrounds(result.lines, result.page, []);
  expect(result.pageCount).toBeGreaterThan(1);
  const first = bands.get(result.lines[0]).rect;
  for (const line of result.lines.filter(l => l.page === 0)) expect(bands.get(line).rect).toBe(first);
  const next = result.lines.find(l => l.page === 1); expect(bands.get(next).rect).not.toBe(first);
  expect(first.height).toBeGreaterThan(result.lines[0].height); expect(first.y + first.height).toBeLessThanOrEqual(110);
});

it('finds each line\'s cell once per page, however long the table', () => {
  // A page of a long table: every line looks up its own cell fragment among thousands.
  const cells = Array.from({ length: 3000 }, (_, i) => ({ id: `cell${i % 1500}`, page: i < 1500 ? 0 : 1, column: undefined, x: 10, y: i, width: 50, height: 1, fill: i === 1501 ? '#FF0000' : undefined }));
  const lines = Array.from({ length: 1500 }, (_, i) => ({ cellId: `cell${i}`, page: 1, y: i, height: 1, paragraphId: `p${i}` }));
  let reads = 0;
  const counted = new Proxy(cells, { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) reads++; return Reflect.get(target, key, receiver); } });
  const result = paragraphBackgrounds(lines, { width: 200, height: 2000, top: 0, bottom: 0 }, counted);
  expect(reads).toBeLessThanOrEqual(cells.length);
  // Each line still sits on its own page's fragment of its cell.
  expect(result.get(lines[1]).base).toBe('#FF0000');
  expect(result.get(lines[2]).base).toBe('#FFFFFF');
});

it('shades an outdented list label without changing list geometry or source text', () => {
  const doc = new TextDocument([paragraph('Numbered paragraph')]); doc.toggleList('number');
  const before = layout(doc); doc.setParagraphFormat({ paragraphShading: '224466' }); const after = layout(doc);
  expect(geometry(after)).toEqual(geometry(before)); const line = after.lines[0];
  expect(line.paragraphBackground.x).toBeLessThanOrEqual(line.marker.x); expect(line.paragraphBackground.x + line.paragraphBackground.width).toBeGreaterThanOrEqual(line.marker.x + line.marker.width);
  expect(doc.text).toBe('Numbered paragraph');
});
