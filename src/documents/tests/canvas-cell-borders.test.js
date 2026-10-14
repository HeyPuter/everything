import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphText } from '../src/engine/model.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { cellContext, tableCells, verticalMerges } from '../src/engine/tables.js';
import { checkedCellBorder, effectiveCellBorders } from '../src/engine/cell-borders.js';
import { winningTableBorder, layoutTableBorders } from '../src/engine/table-border-layout.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/cell-borders.docx');
it('resolves shared border definitions by reading order independently of cell shading', () => {
  for (const color of ['4488AA', 'auto', undefined]) {
    const border = { style: 'single', size: 8, color, space: 0 };
    const first = { border, background: '#000000', order: 0 }, second = { border, background: '#FFFFFF', order: 1 };
    const winner = first;
    expect(winningTableBorder(first, second)).toBe(winner);
    expect(winningTableBorder(second, first)).toBe(winner);
    second.background = first.background;
    expect(winningTableBorder(first, second)).toBe(first);
    expect(winningTableBorder(second, first)).toBe(first);
  }
});
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const measure = (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize, descent: style.fontSize / 3 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const paragraph = (doc, text) => doc.paragraphs.find(p => paragraphText(p) === text);
const cell = (doc, text) => cellContext(doc.tables, paragraph(doc, text).cellId).cell;
const select = (doc, text) => { const at = doc.text.indexOf(text); expect(at).toBeGreaterThanOrEqual(0); doc.select(at, at + text.length); };
const border = (style = 'single', size = 8, color = '224466') => checkedCellBorder({ style, size, color });
function sameParts(actual, expected, except = []) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const [name, bytes] of Object.entries(expected)) if (!except.includes(name)) expect(Buffer.from(actual[name]).equals(Buffer.from(bytes)), name).toBe(true);
}
const rewrite = (from, to, path = 'word/document.xml') => {
  const parts = unzipSync(source); expect(strFromU8(parts[path])).toContain(from);
  parts[path] = strToU8(strFromU8(parts[path]).replace(from, to)); return zipSync(parts);
};
const rightNil = '<w:right w:val="nil" w:sz="8" w:color="224466"/>';
const shared = (doc, result, first, second) => {
  const ids = [cell(doc, first).id, cell(doc, second).id];
  return result.tableBorders.filter(stroke => ids.every(id => stroke.cellIds.includes(id)));
};

it('ignores table-wide style cell borders while retaining table borders, direct aliases, nil and themes', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  expect(cell(doc, 'Inherited edges').borders).toEqual({});
  expect(effectiveCellBorders(doc.tables[0], cell(doc, 'Inherited edges'), 0, 0, 1, 1)).toMatchObject({ top: { style: 'double', size: 12 }, left: { style: 'double' }, right: { style: 'single' }, bottom: { style: 'single' } });
  expect(cell(doc, 'Direct edges').borders).toMatchObject({ top: { style: 'double', size: 24, color: 'F79646' }, left: { style: 'single', size: 16, color: '993366' } });
  // Native none controls distinguish colored/nonzero declarations from the
  // default reset. This legacy fixture's label predates that distinction.
  expect(cell(doc, 'None inherits').borders.left).toMatchObject({style:'none',size:8,color:'FF0000'});
  expect(cell(doc, 'None inherits').directBorders.left).toMatchObject({style:'none',size:8,color:'FF0000'});
  expect(cell(doc, 'Nil edge').borders.right.style).toBe('nil');
  sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('resolves shared edges once using nil, width weights and the dotted/dashed exceptions', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc);
  for (const [a, b, expected] of [['Nil edge', 'Heavy single', { style: 'single', size: 32 }], ['Heavy single', 'Double wins', { style: 'double', size: 8 }], ['Dotted loses', 'Thin single', { style: 'single', size: 2 }]]) {
    const strokes = shared(doc, result, a, b); expect(strokes).toHaveLength(1); expect(strokes[0].border).toMatchObject(expected);
  }
  expect(shared(doc, result, 'Nil edge', 'Heavy single')[0].guide).toBe(false);
  expect(result.tableBorders.every(s => s.width > 0 && s.height > 0 && Number.isFinite(s.x + s.y))).toBe(true);
});

it.each([
  ['single', 24, 'double', 8, 'single'], ['dotted', 96, 'dashed', 96, 'dotted'], ['dotDash', 2, 'single', 15, 'dotDash'],
  ['dotDotDash', 2, 'single', 17, 'dotDotDash'], ['triple', 2, 'single', 19, 'triple'], ['dashSmallGap', 2, 'single', 43, 'dashSmallGap'], ['thick', 8, 'single', 15, 'thick'],
])('applies border weight and precedence: %s %s versus %s %s', (a, aw, b, bw, winner) => {
  const first = { border: border(a, aw), background: '#FFFFFF', order: 0 }, second = { border: border(b, bw), background: '#FFFFFF', order: 1 };
  expect(winningTableBorder(first, second).border.style).toBe(winner);
  expect(winningTableBorder(second, first).border.style).toBe(winner);
});

it.each([['FF0000', '0000FF', 'FF0000'], ['0000FE', '007F00', '0000FE'], ['111111', '222222', '111111']])('breaks equal-style ties by successive brightness measures: %s versus %s', (a, b, winner) => {
  const first = { border: border('single', 8, a), background: '#FFFFFF', order: 0 }, second = { border: border('single', 8, b), background: '#FFFFFF', order: 1 };
  expect(winningTableBorder(first, second).border.color).toBe(winner); expect(winningTableBorder(second, first).border.color).toBe(winner);
});

it('splits a merged edge at a T-junction and honors reading order independently of header-copy insertion', () => {
  const cells = [
    { id: 'right-top', tableId: 't', page: 0, x: 100, y: 0, width: 100, height: 50, borders: { left: border('single', 8, '224466') } },
    { id: 'right-bottom', tableId: 't', page: 0, x: 100, y: 50, width: 100, height: 50, borders: { left: border('double', 8) } },
    { id: 'merged', tableId: 't', page: 0, x: 0, y: 0, width: 100, height: 100, borders: { right: border('single', 8, '224466') } },
  ];
  const result = layoutTableBorders(cells).filter(s => !s.horizontal && s.cellIds.includes('merged') && s.cellIds.length === 2);
  expect(result.map(s => [s.y, s.height, s.border.style])).toEqual([[0, 50, 'single'], [50, 50, 'double']]);
  const first = { border: border(), background: '#FFFFFF', order: 0 }, second = { ...first, order: 1 };
  expect(winningTableBorder(second, first)).toBe(first);
});

it('authors selected sides, removes both logical aliases, preserves unrelated edges and fully undoes source changes', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Inherited edges'); const before = doc.snapshot();
  doc.setCellBorders({ top: border('double', 16, 'AABBCC') }); select(doc, 'Direct edges'); doc.setCellBorders(null);
  let bytes = await save(pkg, doc), reopened = model(await DocxPackage.open(bytes));
  expect(cell(reopened, 'Inherited edges').borders.top).toMatchObject({ style: 'double', size: 16, color: 'AABBCC' });
  expect(cell(reopened, 'Direct edges').directBorders).toMatchObject({ insideH: { color: 'FF0000' }, tl2br: { style: 'nil' } });
  expect(cell(reopened, 'Direct edges').directBorders.left).toBeUndefined(); expect(cell(reopened, 'Direct edges').borders.left).toBeUndefined();
  sameParts(unzipSync(bytes), pkg.parts, ['word/document.xml']);
  doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  doc.redo(); doc.redo(); select(doc, 'None inherits'); doc.setCellBorders({ left: null });
  reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(cell(reopened, 'None inherits').directBorders.left).toBeUndefined();
});

it('updates all vertical-merge members and keeps borders through splitting, row insertion and owner deletion', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Vertical edges'); doc.setCellBorders({ bottom: border('double', 16, 'CC3300') });
  const { table, cell: owner } = doc.tableContext, group = verticalMerges(table).get(owner.id).cells; expect(group).toHaveLength(3);
  expect(group.every(c => c.borders.bottom.style === 'double' && c.borders.bottom.color === 'CC3300')).toBe(true);
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(reopened.tables[1].rows.every(row => row.cells[0].borders.bottom.style === 'double')).toBe(true);
  const before = doc.snapshot(); doc.splitCell(); expect(doc.tables[1].rows.every(row => row.cells[0].borders.bottom.style === 'double')).toBe(true);
  doc.undo(); expect(doc.snapshot()).toEqual(before); doc.deleteTablePart('row'); expect(cell(doc, 'Vertical edges').borders.bottom.style).toBe('double');
  doc.undo(); doc.insertTableRow(); expect(() => layout(doc)).not.toThrow();
});

it('reserves compound header border height while preserving wrapping, Unicode carets and undo', async () => {
  const doc = model(await DocxPackage.open(source)), before = layout(doc); expect(before.pageCount).toBeGreaterThan(3);
  const at = doc.text.indexOf('Á😀', doc.text.indexOf('Theme')), caret = caretRect(before, at);
  select(doc, 'Header edges'); doc.setCellBorders({ bottom: border('triple', 16, '8855CC') });
  const after = layout(doc), header = cell(doc, 'Header edges').id;
  const textGeometry = result => result.lines.map(line => [line.paragraphId, line.start, line.end, line.height, line.stops,
    line.fragments.map(fragment => [fragment.text, fragment.x, fragment.width, fragment.ascent, fragment.descent])]);
  expect(textGeometry(after)).toEqual(textGeometry(before)); expect(after.tableWidths).toEqual(before.tableWidths);
  expect(after.cells.find(box => box.id === header).height).toBeGreaterThan(before.cells.find(box => box.id === header).height);
  expect(caretRect(after, at)).toEqual(caret); expect(hitTest(after, caret.page, caret.x, caret.y + caret.height / 2)).toBe(at); expect(selectionRects(after, at, at + 4)).toEqual(selectionRects(before, at, at + 4));
  const strokes = after.tableBorders.filter(s => s.cellIds.includes(cell(doc, 'Header edges').id) && s.border?.color === '8855CC' && s.border.style === 'triple');
  expect(new Set(strokes.map(s => s.page)).size).toBeGreaterThan(2);
  doc.undo(); expect(layout(doc)).toEqual(before);
});

it('round trips every authored pattern on a fresh table and handles mixed multi-cell clearing', async () => {
  const pkg = createDocx(), doc = model(pkg); doc.insertTable(1, 2);
  const first = doc.tableContext.cell, other = tableCells(doc.tables[0])[1];
  doc.setCellBorders({ top: border('double'), left: border('thick'), bottom: border('dotDash'), right: border('nil', 0) });
  doc.replace('First');
  doc.selectCell(other.id); doc.setCellBorders({ top: border('triple'), left: border('dashed'), bottom: border('dotDotDash'), right: border('dotted') });
  doc.replace('Second');
  const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  expect(tableCells(reopened.tables[0]).map(c => Object.values(c.directBorders).map(b => b.style))).toEqual([['double','thick','dotDash','nil'], ['triple','dashed','dotDotDash','dotted']]);
  doc.selectCell(first.id); const start = doc.range[0]; doc.selectCell(other.id); doc.select(start, doc.range[0] + 6); doc.setCellBorders(Object.fromEntries(['top','left','bottom','right'].map(side => [side, border('nil', 0)])));
  expect(doc.selectedTableCells).toHaveLength(2); expect(doc.cellBorderValues.every(v => Object.values(v).every(b => b.style === 'nil'))).toBe(true);
});

it.each(['', 'w:sz="0"', 'w:sz="1"', 'w:sz="100"'])('uses the zero default and normalizes out-of-range positive widths: %s', async size => {
  const doc = model(await DocxPackage.open(rewrite(rightNil, `<w:right w:val="single" ${size}/>`)));
  expect(cell(doc, 'Nil edge').borders.right.size).toBe(size === 'w:sz="1"' ? 2 : size === 'w:sz="100"' ? 96 : 0);
});

it.each(['<w:right/>', '<w:right w:val="wave"/>', '<w:right w:val="single" w:sz="-1"/>', '<w:right w:val="single" w:sz="1.5"/>', '<w:right w:val="single" w:space="1"/>', '<w:right w:val="single" w:shadow="1"/>', '<w:right w:val="single" w:frame="bad"/>', '<w:right w:val="single" w:color="bad"/>', '<w:right w:val="single" w:themeColor="unknown"/>', '<w:right w:val="single" w:themeTint="XYZ"/>', '<w:right w:val="single" w:unknown="1"/>', '<w:right w:val="single">text</w:right>', '<w:right w:val="single"><w:top/></w:right>', '<w:right w:val="single"/><w:right w:val="nil"/>'])('rejects unsupported active borders before editable import: %s', async markup => {
  await expect(DocxPackage.open(rewrite(rightNil, markup))).rejects.toThrow();
});

it('imports active diagonal cell borders and keeps them through editing', async () => {
  const pkg = await DocxPackage.open(rewrite(rightNil, '<w:tr2bl w:val="single" w:sz="8" w:color="C00000"/>')), doc = model(pkg);
  expect(cell(doc, 'Nil edge').borders.tr2bl).toMatchObject({ style: 'single', size: 8, color: 'C00000' });
  select(doc, 'Nil edge'); doc.replace('Diagonal edge');
  const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  expect(cell(reopened, 'Diagonal edge').borders.tr2bl).toMatchObject({ style: 'single', size: 8, color: 'C00000' });
});

it('rejects invalid edits atomically and leaves cells untouched outside table selections', async () => {
  const doc = model(await DocxPackage.open(source)); expect(doc.setCellBorders(null)).toBe(false); select(doc, 'Inherited edges'); const before = doc.snapshot();
  for (const patch of [{ between: border() }, { top: { style: 'single', size: 1 } }, { top: { style: 'single', size: 8, space: 1 } }, { top: { style: 'wave', size: 8 } }, undefined, []]) expect(() => doc.setCellBorders(patch)).toThrow();
  expect(doc.snapshot()).toEqual(before);
});
