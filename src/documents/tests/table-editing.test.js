import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { readFileSync } from 'node:fs';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { tableCells, verticalMerges, rowGrid, documentBlocks } from '../src/engine/tables.js';
import * as T from '../src/engine/table-editing.js';
import { blockFor, ownerPlacements } from '../src/engine/table-selection.js';
import { StorySession } from '../src/engine/story-session.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const open = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
function tableDocument(rows = 3, columns = 3, before = []) {
  const pkg = createDocx([...before.map(text => paragraph(text)), paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = open(pkg);
  doc.select(doc.text.length);
  doc.insertTable(rows, columns, 9000);
  const cells = tableCells(doc.tables.at(-1));
  cells.forEach((cell, i) => { doc.selectCell(cell.id); doc.replace(String.fromCharCode(97 + Math.floor(i / columns)) + (i % columns)); });
  doc.selectCell(cells[0].id);
  return { pkg, doc };
}
/** The table as rows of "text[:span][^|v]" (^ restart, v continue). */
function shape(doc, table = doc.tables.at(-1)) {
  return table.rows.map(row => row.cells.map(cell => {
    const text = doc.paragraphs.filter(p => p.cellId === cell.id).map(paragraphText).join('/');
    return text + ((cell.span ?? 1) > 1 ? `:${cell.span}` : '') + (cell.vMerge === 'restart' ? '^' : cell.vMerge === 'continue' ? 'v' : '');
  }).join(' ') + ((row.gridAfter || 0) ? ` +${row.gridAfter}` : ''));
}
const cellAt = (doc, r, c, table = doc.tables.at(-1)) => rowGrid(table.rows[r]).find(x => x.column <= c && x.end > c).cell;
const at = (doc, r, c) => { doc.selectCell(cellAt(doc, r, c).id); return doc; };
const block = (doc, top, left, bottom = top, right = left + 1) => doc.setCellBlock({ tableId: doc.tables.at(-1).id, top, bottom, left, right });
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables).arrayBuffer());
async function roundTrip(pkg, doc) {
  const bytes = await save(pkg, doc), reopened = await DocxPackage.open(bytes);
  return { reopened: open(reopened), xml: strFromU8(unzipSync(bytes)['word/document.xml']), bytes };
}
const valid = doc => { documentBlocks(doc.paragraphs, doc.tables); for (const t of doc.tables) verticalMerges(t); };

describe('cell blocks', () => {
  it('selects cells, rows, columns and tables as blocks and paints only their cells', () => {
    const { doc } = tableDocument();
    const table = doc.tables[0];
    at(doc, 1, 1);
    const around = T.selectionBlock(doc);
    expect([around.top, around.bottom, around.left, around.right]).toEqual([1, 1, 1, 2]);
    expect(doc.setCellBlock(blockFor(table, around, 'column'))).toBe(true);
    expect(doc.selectedTableCells.map(cell => paragraphText(doc.paragraphs.find(p => p.cellId === cell.id)))).toEqual(['a1', 'b1', 'c1']);
    expect(doc.selectedTableRows).toHaveLength(3);
    doc.select(0);
    expect(doc.activeCellBlock).toBe(null);
    doc.setCellBlock(blockFor(table, around, 'row'));
    // Whole rows are selected as one stretch of text.
    expect(doc.text.slice(...doc.range)).toBe('b0\nb1\nb2');
  });

  it('turns a text selection across cells into the rectangle between its ends', () => {
    const { doc } = tableDocument();
    const start = doc.text.indexOf('a1'), end = doc.text.indexOf('c0') + 1;
    doc.select(start, end);
    const b = T.selectionBlock(doc);
    expect([b.top, b.bottom, b.left, b.right]).toEqual([0, 2, 0, 2]);
  });
});

describe('rows and columns', () => {
  it('inserts rows above and below, as many as selected, and undoes in one step', () => {
    const { doc } = tableDocument();
    at(doc, 1, 0);
    T.insertRows(doc, { above: true });
    expect(shape(doc)).toEqual(['a0 a1 a2', '  ', 'b0 b1 b2', 'c0 c1 c2']);
    block(doc, 2, 0, 3, 3);
    T.insertRows(doc, {});
    expect(shape(doc)).toHaveLength(6);
    expect(shape(doc).slice(4, 6)).toEqual(['  ', '  ']);
    doc.undo(); doc.undo();
    expect(shape(doc)).toEqual(['a0 a1 a2', 'b0 b1 b2', 'c0 c1 c2']);
    valid(doc);
  });

  it('inserts columns left and right, keeping the fixed table width', () => {
    const { doc } = tableDocument();
    const width = doc.tables[0].grid.reduce((a, b) => a + b);
    at(doc, 0, 0); T.insertColumns(doc, { left: true });
    at(doc, 0, 3); T.insertColumns(doc, {});
    expect(shape(doc)).toEqual([' a0 a1 a2 ', ' b0 b1 b2 ', ' c0 c1 c2 ']);
    expect(doc.tables[0].grid.reduce((a, b) => a + b)).toBe(width);
    expect(doc.tables[0].grid).toHaveLength(5);
    valid(doc);
  });

  it('deletes selected rows and columns, and the table when all are selected', () => {
    const { doc } = tableDocument();
    block(doc, 0, 1, 2, 3); T.deleteColumns(doc);
    expect(shape(doc)).toEqual(['a0', 'b0', 'c0']);
    block(doc, 1, 0, 2, 1); T.deleteRows(doc);
    expect(shape(doc)).toEqual(['a0']);
    T.deleteRows(doc);
    expect(doc.tables).toHaveLength(0);
    valid(doc);
  });

  it('keeps a vertical merge’s content when its first row is deleted', () => {
    const { doc } = tableDocument();
    block(doc, 0, 0, 1, 1); T.mergeBlock(doc);
    expect(shape(doc)).toEqual(['a0/b0^ a1 a2', 'v b1 b2', 'c0 c1 c2']);
    at(doc, 0, 1); T.deleteRows(doc);
    expect(shape(doc)).toEqual(['a0/b0 b1 b2', 'c0 c1 c2']);
    valid(doc);
  });
});

describe('cells', () => {
  it('deletes cells shifting left (rows end early) and up', async () => {
    const { pkg, doc } = tableDocument();
    at(doc, 0, 1); T.deleteCells(doc, { shift: 'left' });
    expect(shape(doc)).toEqual(['a0 a2 +1', 'b0 b1 b2', 'c0 c1 c2']);
    const { xml, reopened } = await roundTrip(pkg, doc);
    expect(xml).toContain('<w:gridAfter w:val="1"/>');
    expect(shape(reopened)).toEqual(['a0 a2 +1', 'b0 b1 b2', 'c0 c1 c2']);
    at(doc, 1, 2); T.deleteCells(doc, { shift: 'up' });
    expect(shape(doc)).toEqual(['a0 a2 +1', 'b0 b1 c2', 'c0 c1 ']);
    valid(doc);
  });

  it('inserts cells shifting down (new rows) and right (new grid columns)', () => {
    const { doc } = tableDocument();
    at(doc, 1, 1); T.insertCells(doc, { shift: 'down' });
    expect(shape(doc)).toEqual(['a0 a1 a2', 'b0  b2', 'c0 b1 c2', ' c1 ']);
    at(doc, 0, 0); T.insertCells(doc, { shift: 'right' });
    expect(shape(doc)).toEqual([' a0 a1 a2', 'b0  b2 +1', 'c0 b1 c2 +1', ' c1  +1']);
    expect(doc.tables[0].grid).toHaveLength(4);
    valid(doc);
  });

  it('merges a rectangle into one cell keeping the non-empty contents', async () => {
    const { pkg, doc } = tableDocument();
    block(doc, 0, 1, 1, 3); T.mergeBlock(doc);
    expect(shape(doc)).toEqual(['a0 a1/a2/b1/b2:2^', 'b0 :2v', 'c0 c1 c2']);
    const { reopened, xml } = await roundTrip(pkg, doc);
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
    expect(shape(reopened)).toEqual(['a0 a1/a2/b1/b2:2^', 'b0 :2v', 'c0 c1 c2']);
  });

  it('splits a cell into rows and columns, adding grid lines where needed', async () => {
    const { pkg, doc } = tableDocument();
    at(doc, 1, 1); T.splitCells(doc, { rows: 2, columns: 2 });
    expect(doc.tables[0].grid).toHaveLength(4);
    expect(shape(doc)).toEqual(['a0 a1:2 a2', 'b0^ b1  b2^', 'v   v', 'c0 c1:2 c2']);
    valid(doc);
    const { reopened } = await roundTrip(pkg, doc);
    expect(shape(reopened)).toEqual(shape(doc));
    doc.undo();
    expect(shape(doc)).toEqual(['a0 a1 a2', 'b0 b1 b2', 'c0 c1 c2']);
  });

  it('splits several cells each on its own when asked not to merge them', () => {
    const { doc } = tableDocument();
    block(doc, 0, 0, 1, 2);
    T.splitEachCell(doc, { rows: 1, columns: 2 });
    expect(doc.tables[0].grid).toHaveLength(5);
    expect(shape(doc)).toEqual(['a0  a1  a2', 'b0  b1  b2', 'c0:2 c1:2 c2']);
    valid(doc);
  });

  it('splits a merged cell back along its own grid and rows', () => {
    const { doc } = tableDocument();
    block(doc, 0, 0, 1, 2); T.mergeBlock(doc);
    T.splitCells(doc, { rows: 2, columns: 2 });
    expect(doc.tables[0].grid).toHaveLength(3);
    expect(shape(doc)).toEqual(['a0/a1/b0/b1  a2', '  b2', 'c0 c1 c2']);
    valid(doc);
  });
});

describe('table commands', () => {
  it('splits a table above the selected row', async () => {
    const { pkg, doc } = tableDocument(3, 2, ['Intro']);
    at(doc, 1, 0); T.splitTable(doc);
    expect(doc.tables).toHaveLength(2);
    expect(shape(doc, doc.tables[0])).toEqual(['a0 a1']);
    expect(shape(doc, doc.tables[1])).toEqual(['b0 b1', 'c0 c1']);
    expect(documentBlocks(doc.paragraphs, doc.tables).map(b => b.type)).toEqual(['paragraph', 'paragraph', 'table', 'paragraph', 'table', 'paragraph']);
    const { reopened } = await roundTrip(pkg, doc);
    expect(reopened.tables).toHaveLength(2);
  });

  it('sorts rows by number, text and date keys with a header row', () => {
    const { doc } = tableDocument(4, 2);
    const fill = (r, c, text) => { at(doc, r, c); doc.select(...rangeOf(doc, r, c)); doc.replace(text); };
    const rangeOf = (d, r, c) => { const p = d.paragraphs.find(x => x.cellId === cellAt(d, r, c).id); const s = d.paragraphOffset(d.paragraphs.indexOf(p)); return [s, s + paragraphText(p).length]; };
    [['Item', 'Price'], ['Pens', '$1,200.50'], ['Ink', '(30)'], ['Paper', '9']].forEach((row, r) => row.forEach((text, c) => fill(r, c, text)));
    at(doc, 1, 0);
    T.sortTable(doc, { keys: [{ column: 1, type: 'number' }], header: true });
    expect(shape(doc).map(r => r.split(' ')[0])).toEqual(['Item', 'Ink', 'Paper', 'Pens']);
    T.sortTable(doc, { keys: [{ column: 0, type: 'text', descending: true }], header: true });
    expect(shape(doc).map(r => r.split(' ')[0])).toEqual(['Item', 'Pens', 'Paper', 'Ink']);
    expect(T.sortDate('2024-02-01')).toBeLessThan(T.sortDate('March 3, 2024'));
    expect(T.sortDate('3/4/2024')).toBe(Date.UTC(2024, 2, 4));
  });

  it('converts text to a table and back', async () => {
    const pkg = createDocx([paragraph('Name\tQty'), paragraph('Pens\t2'), paragraph('Ink\t1\textra'), paragraph('After')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const doc = open(pkg);
    doc.select(0, doc.text.indexOf('After') - 1);
    expect(T.textTableShape(doc, { separator: 'tab' })).toEqual({ rows: 3, columns: 3 });
    T.convertTextToTable(doc, { separator: 'tab' });
    expect(shape(doc)).toEqual(['Name Qty ', 'Pens 2 ', 'Ink 1 extra']);
    expect(documentBlocks(doc.paragraphs, doc.tables).map(b => b.type)).toEqual(['table', 'paragraph']);
    const { reopened } = await roundTrip(pkg, doc);
    expect(shape(reopened)).toEqual(shape(doc));
    T.convertTableToText(doc, { separator: 'comma' });
    expect(doc.tables).toHaveLength(0);
    expect(doc.paragraphs.map(paragraphText)).toEqual(['Name,Qty,', 'Pens,2,', 'Ink,1,extra', 'After']);
  });

  it('converts text inside a cell into a nested table', async () => {
    const { pkg, doc } = tableDocument(1, 1);
    const cell = doc.tables[0].rows[0].cells[0];
    doc.selectCell(cell.id); doc.select(doc.selection.focus, doc.selection.focus + 2); doc.replace('x\ty'); doc.insertParagraph(); doc.replace('z\tw');
    const start = doc.paragraphOffset(doc.paragraphs.findIndex(p => p.cellId === cell.id));
    doc.select(start, start + 7);
    T.convertTextToTable(doc, { separator: 'tab', availableWidth: 8000 });
    const nested = doc.tables.find(t => t.parentCellId === cell.id);
    expect(nested.rows.map(r => r.cells.length)).toEqual([2, 2]);
    expect(documentBlocks(doc.paragraphs, doc.tables)[1].rows[0].cells[0].content.map(b => b.type)).toEqual(['table', undefined]);
    const { reopened } = await roundTrip(pkg, doc);
    expect(reopened.tables).toHaveLength(2);
  });

  it('converts paragraphs into cells across columns', () => {
    const pkg = createDocx(['one', 'two', 'three', 'four', 'five', ''].map(t => paragraph(t)), undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const doc = open(pkg);
    doc.select(0, doc.text.indexOf('five') + 4);
    T.convertTextToTable(doc, { separator: 'paragraph', columns: 2, autofit: 'window' });
    expect(shape(doc)).toEqual(['one two', 'three four', 'five ']);
    expect(doc.tables[0].width).toEqual({ type: 'pct', value: 5000 });
  });

  it('distributes rows and columns and sets sizes', async () => {
    const { pkg, doc } = tableDocument();
    at(doc, 0, 0);
    T.distributeRows(doc, { heights: [300, 600, 900] });
    expect(doc.tables[0].rows.map(r => r.minHeight)).toEqual([600, 600, 600]);
    T.setSelectedColumnWidth(doc, 1440);
    expect(doc.tables[0].grid[0]).toBe(1440);
    T.distributeColumns(doc);
    const grid = doc.tables[0].grid;
    expect(Math.max(...grid) - Math.min(...grid)).toBeLessThanOrEqual(1);
    T.setSelectedRowHeight(doc, 720, 'exact');
    const { xml } = await roundTrip(pkg, doc);
    expect(xml).toContain('w:hRule="exact"');
  });

  it('AutoFit to contents lets columns grow past their old widths, and the zero grid saves', async () => {
    const { pkg, doc } = tableDocument();
    T.autofitTable(doc, 'contents');
    expect(doc.tables[0]).toMatchObject({ layout: 'autofit', width: { type: 'auto', value: 0 }, grid: [0, 0, 0] });
    const { xml, reopened } = await roundTrip(pkg, doc);
    expect(xml).toContain('<w:gridCol w:w="0"/>');
    expect(reopened.tables[0].layout).toBe('autofit');
    T.autofitTable(doc, 'window');
    expect(doc.tables[0].width).toEqual({ type: 'pct', value: 5000 });
  });

  it('sets text direction, alignment, wrap and preferred cell width and saves them', async () => {
    const { pkg, doc } = tableDocument();
    block(doc, 0, 0, 0, 2);
    expect(T.nextTextDirection(doc)).toBe('tbRl');
    T.setTextDirection(doc, 'btLr');
    T.setCellAlignment(doc, { horizontal: 'center', vertical: 'bottom' });
    T.setCellWrap(doc, false);
    T.setCellPreferredWidth(doc, { type: 'dxa', value: 2000 });
    expect(doc.paragraphs.filter(p => ['a0', 'a1'].includes(paragraphText(p))).map(p => p.format.alignment)).toEqual(['center', 'center']);
    const { xml, reopened } = await roundTrip(pkg, doc);
    expect(xml).toContain('<w:textDirection w:val="btLr"/>');
    expect(xml).toContain('<w:noWrap/>');
    const first = reopened.tables[0].rows[0].cells[0];
    expect([first.textDirection, first.vertical, first.noWrap, first.width]).toEqual(['btLr', 'bottom', true, { type: 'dxa', value: 2000 }]);
  });

  it('applies border presets with the pen and toggles them off', async () => {
    const { pkg, doc } = tableDocument();
    block(doc, 0, 0, 1, 2);
    const pen = { style: 'double', size: 12, color: 'C00000' };
    T.applyBorderPreset(doc, 'outside', pen);
    const table = doc.tables[0], border = (r, c, side) => cellAt(doc, r, c).borders[side];
    expect(border(0, 0, 'top')).toMatchObject({ style: 'double', color: 'C00000' });
    expect(border(1, 1, 'right')).toMatchObject({ style: 'double' });
    expect(border(1, 2, 'left')).toMatchObject({ style: 'double' });
    expect(border(0, 0, 'right')).toEqual(undefined);
    T.applyBorderPreset(doc, 'outside', pen);
    expect(border(0, 0, 'top').style).toBe('nil');
    T.paintCellEdge(doc, { tableId: table.id, cellId: cellAt(doc, 2, 2).id, side: 'top', pen });
    expect(border(1, 2, 'bottom')).toMatchObject({ style: 'double' });
    const { reopened } = await roundTrip(pkg, doc);
    expect(cellAt(reopened, 2, 2).borders.top).toMatchObject({ style: 'double', size: 12, color: 'C00000' });
  });

  it('draws diagonal borders across the selected cells and saves them', async () => {
    const { pkg, doc } = tableDocument();
    block(doc, 1, 1, 1, 3);
    T.applyBorderPreset(doc, 'diagonalDown', { style: 'single', size: 8, color: '0000FF' });
    T.applyBorderPreset(doc, 'diagonalUp', { style: 'dashed', size: 4, color: 'auto' });
    expect(cellAt(doc, 1, 2).borders).toMatchObject({ tl2br: { style: 'single', color: '0000FF' }, tr2bl: { style: 'dashed' } });
    const { xml, reopened } = await roundTrip(pkg, doc);
    expect(xml).toMatch(/<w:tl2br w:val="single" w:sz="8" w:color="0000FF"\/><w:tr2bl w:val="dashed"/);
    expect(cellAt(reopened, 1, 1).borders.tl2br).toMatchObject({ style: 'single', size: 8 });
    T.applyBorderPreset(doc, 'diagonalDown', { style: 'single', size: 8, color: '0000FF' });
    expect(cellAt(doc, 1, 1).borders.tl2br.style).toBe('nil');
  });

  it('saves table alt text pasted with line breaks or control characters as readable XML', async () => {
    const { pkg, doc } = tableDocument(2, 2, ['Lead']);
    T.setTableAltText(doc, { title: 'Prices\u0001', description: 'Prices\u000bby item' });
    const { xml, reopened } = await roundTrip(pkg, doc);
    expect(xml).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect([reopened.tables[0].caption, reopened.tables[0].description]).toEqual(['Prices', 'Prices\nby item']);
  });

  it('saves alt text, text wrapping and default cell margins', async () => {
    const { pkg, doc } = tableDocument(2, 2, ['Lead']);
    T.setTableAltText(doc, { title: 'Prices', description: 'Prices by item' });
    T.setTableWrapping(doc, 'around');
    T.setTableCellMargins(doc, { left: 200, right: 200 });
    expect(cellAt(doc, 0, 0).margins.left).toBe(200);
    const { xml, reopened } = await roundTrip(pkg, doc);
    expect(xml).toContain('<w:tblCaption w:val="Prices"/>');
    expect(xml).toMatch(/<w:tblpPr [^>]*w:horzAnchor="text"/);
    const table = reopened.tables[0];
    expect([table.caption, table.description, !!table.floating, table.margins.left]).toEqual(['Prices', 'Prices by item', true, 200]);
    T.setTablePositioning(doc, { x: 'center', horzAnchor: 'page', y: 720, vertAnchor: 'margin', topFromText: 120, overlap: false });
    const positioned = await roundTrip(pkg, doc);
    expect(positioned.xml).toMatch(/<w:tblpPr [^>]*w:vertAnchor="margin" w:horzAnchor="page" w:tblpXSpec="center" w:tblpY="720"\/>/);
    expect(positioned.xml).toContain('<w:tblOverlap w:val="never"/>');
    expect(positioned.reopened.tables[0].floating).toMatchObject({ tblpXSpec: 'center', horzAnchor: 'page', tblpY: 720, topFromText: 120 });
    T.setTableWrapping(doc, 'none');
    expect((await roundTrip(pkg, doc)).xml).not.toContain('tblpPr');
  });

  it('separates converted cells with plain text when a cell ends in an equation or a note reference', async () => {
    const convert = insert => {
      const { pkg, doc } = tableDocument(2, 2);
      for (const r of [0, 1]) { at(doc, r, 0); doc.select(doc.range[0] + 2); insert(doc); }
      at(doc, 0, 0);
      expect(T.convertTableToText(doc, { separator: 'tab' })).toBe(true);
      const rows = doc.paragraphs.filter(p => p.runs.some(r => r.text.includes('\t')));
      expect(rows.map(paragraphText)).toEqual(['a0\uFFFC\ta1', 'b0\uFFFC\tb1']);
      // Only the object itself is one; each tab is an ordinary run.
      for (const p of rows) for (const run of p.runs) if (run.text === '\t') for (const key of ['math', 'noteMark', 'image', 'field']) expect(run).not.toHaveProperty(key);
      return { pkg, doc };
    };
    const { pkg, doc } = convert(doc => doc.insertMathRun({ xml: '<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>x</m:t></m:r></m:oMath>', text: 'x' }));
    // The document still saves, with one equation per row.
    const { xml } = await roundTrip(pkg, doc);
    expect(xml.match(/<m:oMath\b/g)).toHaveLength(2);
    convert(doc => doc.insertFootnoteReference(1));
  });

  it('draws lines that split cells and erases lines that merge them', () => {
    const { doc } = tableDocument();
    const table = doc.tables[0];
    T.drawLine(doc, { tableId: table.id, orientation: 'horizontal', cellIds: [cellAt(doc, 1, 0).id, cellAt(doc, 1, 1).id] });
    expect(shape(doc)).toEqual(['a0 a1 a2', 'b0 b1 b2^', '  v', 'c0 c1 c2']);
    T.drawLine(doc, { tableId: table.id, orientation: 'vertical', cellIds: [cellAt(doc, 0, 0).id], offset: 1500 });
    expect(table.grid).toHaveLength(4);
    expect(shape(doc)[0]).toBe('a0  a1 a2');
    T.eraseLine(doc, { tableId: table.id, cellIds: [cellAt(doc, 0, 0).id, cellAt(doc, 0, 1).id] });
    expect(shape(doc)[0]).toBe('a0:2 a1 a2');
    valid(doc);
  });
});

describe('cells holding a nested table', () => {
  const withNested = () => {
    const { pkg, doc } = tableDocument(2, 2);
    const outer = doc.tables[0];
    doc.selectCell(outer.rows[0].cells[0].id); doc.select(doc.selection.focus);
    doc.insertTable(2, 2, 3000);
    return { pkg, doc, outer };
  };
  it('clears them, nested table included, with the Delete key', () => {
    const { doc, outer } = withNested();
    doc.setCellBlock({ tableId: outer.id, top: 0, bottom: 0, left: 0, right: 2 });
    expect(T.clearCells(doc)).toBe(true);
    expect(doc.tables).toHaveLength(1);
    expect(() => documentBlocks(doc.paragraphs, doc.tables)).not.toThrow();
    expect(doc.paragraphs.filter(p => p.cellId).map(paragraphText)).toEqual(['', '', 'b0', 'b1']);
  });
  it('deletes them, shifting the cells below up', () => {
    const { pkg, doc, outer } = withNested();
    doc.setCellBlock({ tableId: outer.id, top: 0, bottom: 0, left: 0, right: 2 });
    expect(T.deleteCells(doc, { shift: 'up' })).toBe(true);
    expect(doc.tables).toHaveLength(1);
    expect(doc.paragraphs.filter(p => p.cellId).map(paragraphText)).toEqual(['b0', 'b1', '', '']);
    expect(() => pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables)).not.toThrow();
  });
});

it('gives an inserted row no copy of its neighbour\'s paragraph identifier', async () => {
  // Word writes w14:paraId on rows; an inserted row copies the row it was inserted from.
  const parts = unzipSync(readFileSync('public/fixtures/table-headers.docx'));
  let n = 0x100;
  parts['word/document.xml'] = strToU8(strFromU8(parts['word/document.xml']).replace(/<w:tr>/g, () => `<w:tr w14:paraId="${(n++).toString(16).toUpperCase().padStart(8, '0')}" w14:textId="77777777">`));
  const pkg = await DocxPackage.open(zipSync(parts)), doc = open(pkg);
  doc.setCellBlock({ tableId: doc.tables[0].id, top: 0, bottom: 0, left: 1, right: 3 });
  expect(T.insertRows(doc)).toBe(true);
  const xml = strFromU8(unzipSync(new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables).arrayBuffer()))['word/document.xml']);
  const ids = [...xml.matchAll(/<w:tr [^>]*w14:paraId="([0-9A-F]+)"/g)].map(m => m[1]);
  expect(ids.length).toBe(n - 0x100);
  expect(new Set(ids).size).toBe(ids.length);
});

it.each(['row', 'column', 'table'])('deletes a comment anchored in a deleted %s, keeping the others', kind => {
  const { doc } = tableDocument(2, 2, ['Before']);
  const keep = doc.text.indexOf('Before');
  doc.select(keep, keep + 6); doc.addComment({ author: 'C', text: 'about before' });
  const at = doc.text.indexOf('b1');
  doc.select(at, at + 2); const id = doc.addComment({ author: 'C', text: 'about b1' });
  doc.replyToComment(id, { author: 'D', text: 'reply' });
  doc.select(at + 1);
  expect(doc.deleteTablePart(kind)).toBe(true);
  expect(doc.comments.map(c => c.text)).toEqual(['about before']);
  expect(doc.commentList.every(c => c.start !== null)).toBe(true);
});

// The Table Layout tab, the table pointer and Delete Cells use the table-editing commands.
it.each([
  ['Delete Rows', doc => T.deleteRows(doc)], ['Delete Columns', doc => T.deleteColumns(doc)], ['Delete Table', doc => T.deleteTable(doc)],
  ['Delete Cells, shifting left', doc => T.deleteCells(doc, { shift: 'left' })], ['Delete Cells, shifting up', doc => T.deleteCells(doc, { shift: 'up' })],
  ['clearing the cells', doc => T.clearCells(doc)],
])('deletes a comment anchored in the cells %s removes, keeping the others', (name, command) => {
  const { doc } = tableDocument(2, 2, ['Before']);
  const keep = doc.text.indexOf('Before');
  doc.select(keep, keep + 6); doc.addComment({ author: 'C', text: 'about before' });
  const at = doc.text.indexOf('b1');
  doc.select(at, at + 2); const id = doc.addComment({ author: 'C', text: 'about b1' });
  doc.replyToComment(id, { author: 'D', text: 'reply' });
  doc.select(at + 1);
  expect(command(doc)).toBe(true);
  expect(doc.comments.map(c => c.text)).toEqual(['about before']);
  expect(doc.commentList.every(c => c.start !== null)).toBe(true);
  // Undo brings the comment back with its cell.
  doc.undo();
  expect(doc.commentList.map(c => [c.text, doc.text.slice(c.start, c.end)])).toEqual([['about before', 'Before'], ['about b1', 'b1'], ['reply', 'b1']]);
});

describe('deleting a selection around tables', () => {
  const tableBetween = () => {
    const { pkg, doc } = tableDocument(2, 2, ['Before']);
    doc.select(doc.text.length); doc.replace('After');
    return { pkg, doc };
  };
  it('removes a table the selection encloses together with text around it', async () => {
    const { pkg, doc } = tableDocument(2, 2, ['Before']);
    doc.select(doc.text.length); doc.replace('After');
    expect(doc.text).toBe('Before\n\na0\na1\nb0\nb1\nAfter');
    // From inside the paragraph before to inside the one after: the two ends join.
    doc.select(3, doc.text.length - 2);
    expect(doc.replace('')).toBe(true);
    expect(doc.text).toBe('Befer');
    expect(doc.tables).toEqual([]);
    expect(doc.range).toEqual([3, 3]);
    const { reopened, xml } = await roundTrip(pkg, doc);
    expect(xml).not.toContain('<w:tbl>');
    expect(reopened.text).toBe('Befer');
    // Select All and typing replaces everything, tables too.
    const other = tableBetween().doc;
    other.select(0, other.text.length); other.replace('X');
    expect([other.text, other.tables.length]).toEqual(['X', 0]);
    // A selection from the end of the paragraph before to the start of the one after takes just the table.
    const exact = tableBetween().doc;
    exact.select(exact.text.indexOf('\na0'), exact.text.indexOf('After'));
    exact.replace('');
    expect([exact.text, exact.tables.length]).toEqual(['Before\nAfter', 0]);
  });

  it('clears the cells of a table the selection only reaches into, or covers exactly', () => {
    const { doc } = tableBetween();
    doc.select(3, doc.text.indexOf('a1') + 1);
    doc.replace('');
    expect(doc.tables).toHaveLength(1);
    expect(shape(doc)).toEqual([' 1', 'b0 b1']);
    const exact = tableBetween().doc, cells = [exact.text.indexOf('a0'), exact.text.indexOf('b1') + 2];
    exact.select(...cells);
    exact.replace('');
    expect(shape(exact)).toEqual([' ', ' ']);
  });

  it('removes a nested table enclosed in its cell, keeping the outer table, and the comments inside', () => {
    const { doc } = tableDocument(1, 2);
    at(doc, 0, 0); doc.select(doc.range[0] + 2); doc.replace('\n');
    doc.insertTable(1, 2, 3000);
    const inner = doc.tables[1];
    doc.selectCell(tableCells(inner)[0].id); doc.select(doc.range[0], doc.range[0] + 1); doc.replace('n');
    doc.select(doc.range[0] - 1, doc.range[0]);
    doc.addComment({ author: 'Ann', text: 'Inside' });
    expect(doc.comments).toHaveLength(1);
    // From inside the outer cell's text to its last paragraph: the nested table is wholly selected.
    const outerCell = cellAt(doc, 0, 0, doc.tables[0]).id, own = doc.paragraphs.filter(p => p.cellId === outerCell);
    const start = doc.paragraphOffset(doc.paragraphs.indexOf(own[0])) + 1, end = doc.paragraphOffset(doc.paragraphs.indexOf(own.at(-1)));
    doc.select(start, end);
    doc.replace('');
    expect(doc.tables).toHaveLength(1);
    expect(shape(doc)).toEqual(['a a1']);
    expect(doc.comments).toEqual([]);
    valid(doc);
  });
});

describe('inserting columns into an AutoFit table', () => {
  it('gives a new column to the right a real width, from the toolbar and the engine API, and saves no zero-width grid column', async () => {
    for (const insert of [doc => T.insertColumns(doc, {}), doc => doc.insertTableColumn()]) for (const column of [0, 2]) {
      const { pkg, doc } = tableDocument(2, 3);
      at(doc, 0, 0); T.autofitTable(doc, 'window');
      at(doc, 0, column); insert(doc);
      const table = doc.tables[0];
      expect(table.grid).toHaveLength(4);
      // The new column is as wide as the one it follows; the others keep their widths.
      expect(table.grid).toEqual([3120, 3120, 3120, 3120]);
      // The table stays AutoFit to the window: the cells keep automatic widths.
      expect([table.layout, table.width]).toEqual(['autofit', { type: 'pct', value: 5000 }]);
      expect(tableCells(table).every(cell => cell.width?.type === 'auto')).toBe(true);
      const { xml } = await roundTrip(pkg, doc);
      expect(xml).not.toContain('<w:gridCol w:w="0"/>');
    }
  });
});

it('explains that text holding a picture text wraps around cannot become a table yet', async () => {
  const pkg = await DocxPackage.open(readFileSync('public/fixtures/square-wrap-flow.docx')), doc = open(pkg);
  const at = doc.text.indexOf('CASE left');
  doc.select(at, doc.text.indexOf('Following paragraph') + 5);
  expect(doc.selectedParagraphs.some(p => p.runs.some(r => r.image?.anchor?.wrap === 'square'))).toBe(true);
  const before = doc.text;
  expect(() => T.convertTextToTable(doc, { separator: 'tab' })).toThrow(/picture or shape that text wraps around.*In Line with Text/);
  expect([doc.text, doc.tables.length]).toEqual([before, 0]);
});

describe('clearing a block of cells with Track Changes on', () => {
  it('marks each cell’s text as deleted, keeping the cells, in one undo step', async () => {
    const { pkg, doc } = tableDocument(2, 3);
    doc.trackChanges = true;
    block(doc, 0, 1, 1, 2);
    const session = new StorySession(doc), before = JSON.stringify(doc.paragraphs);
    expect(session.run(() => T.clearCells(doc))).toBe(true);
    const runs = doc.paragraphs.filter(p => p.cellId).flatMap(p => p.runs.map(r => [r.text, r.revision?.type ?? null]));
    expect(runs).toEqual([['a0', null], ['a1', 'del'], ['a2', null], ['b0', null], ['b1', 'del'], ['b2', null]]);
    expect(doc.activeCellBlock).toMatchObject({ top: 0, bottom: 1, left: 1, right: 2 });
    const { reopened } = await roundTrip(pkg, doc);
    reopened.resolveRevisions(true);
    expect(shape(reopened)).toEqual(['a0  a2', 'b0  b2']);
    // Clearing again finds nothing left to delete.
    expect(T.clearCells(doc)).toBe(false);
    session.undo();
    expect(JSON.stringify(doc.paragraphs)).toBe(before);
  });
});
