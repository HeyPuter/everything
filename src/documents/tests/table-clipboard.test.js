import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { tableCells, verticalMerges, documentBlocks, rowGrid } from '../src/engine/tables.js';
import * as T from '../src/engine/table-editing.js';
import { applyTableStyle } from '../src/engine/table-styles.js';
import { tableFragmentHtml, htmlTableFragment, foreignHtmlTable } from '../src/engine/clipboard-fragment.js';
import { StorySession } from '../src/engine/story-session.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const open = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables).arrayBuffer());
/** What a table looks like: grid, style, and each cell's text, span, merge, width, shading and borders. */
const look = (doc, table) => ({ grid: table.grid, width: table.width, layout: table.layout, styleId: table.styleId,
  rows: table.rows.map(row => ({ header: !!row.header, cells: row.cells.map(cell => ({ text: doc.paragraphs.filter(p => p.cellId === cell.id).map(paragraphText).join('/'),
    span: cell.span ?? 1, vMerge: cell.vMerge || null, width: cell.width, shading: cell.shading === 'auto' ? undefined : cell.shading,
    borders: Object.fromEntries(Object.entries(cell.borders || {}).filter(([, b]) => b && !['nil', 'none'].includes(b.style)).map(([side, b]) => [side, [b.style, b.size, b.color]])) })) })) });
function sample() {
  const pkg = createDocx([paragraph('Intro'), paragraph('End')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = open(pkg);
  doc.select(doc.paragraphOffset(1)); doc.insertTable(3, 3, 9000);
  const table = doc.tables[0];
  tableCells(table).forEach((cell, i) => { doc.selectCell(cell.id); doc.replace(`c${i}`); });
  doc.selectCell(tableCells(table)[0].id); applyTableStyle(doc, 'DocsTableGridLightBlue');
  doc.setCellBlock({ tableId: table.id, top: 1, bottom: 2, left: 0, right: 1 }); T.mergeBlock(doc);
  doc.selectCell(rowGrid(table.rows[0])[2].cell.id); doc.setCellShading('FFCC00');
  T.applyBorderPreset(doc, 'outside', { style: 'double', size: 6, color: 'C00000' });
  T.setColumnWidths(doc, table, [2000, 3000, 4000], { layout: 'fixed' });
  return { pkg, doc, table };
}
const whole = table => ({ table, tableId: table.id, top: 0, bottom: table.rows.length - 1, left: 0, right: table.grid.length });

describe('copying and pasting whole tables', () => {
  it('pastes a copied table as the same table, with widths, merges, borders, shading and style, in one undo step', async () => {
    const { pkg, doc: body, table } = sample();
    const session = new StorySession(body);
    let doc = session.model;
    const copied = T.copyTableRows(doc, whole(table), { token: 'here' });
    // Through the clipboard's HTML, as a copy and paste go.
    const html = tableFragmentHtml(copied), fragment = htmlTableFragment(html);
    expect(html).toContain('<table'); expect(html).toContain('rowspan="2"'); expect(html).toContain('background-color:#FFCC00');
    doc.select(doc.text.length);
    session.run(() => T.pasteTableRows(doc, fragment, { token: 'here' }));
    doc = session.model;
    expect(doc.tables).toHaveLength(2);
    expect(look(doc, doc.tables[1])).toEqual(look(doc, doc.tables[0]));
    expect(new Set(tableCells(doc.tables[1]).map(c => c.id)).isDisjointFrom(new Set(tableCells(doc.tables[0]).map(c => c.id)))).toBe(true);
    documentBlocks(doc.paragraphs, doc.tables); for (const t of doc.tables) verticalMerges(t);
    const bytes = await save(pkg, doc), reopened = open(await DocxPackage.open(bytes));
    expect(reopened.tables).toHaveLength(2);
    expect(look(reopened, reopened.tables[1])).toEqual(look(reopened, reopened.tables[0]));
    expect(look(reopened, reopened.tables[1]).rows).toEqual(look(doc, doc.tables[1]).rows);
    // The pasted table was split from "End" as Insert Table splits a paragraph: the text stays after it.
    expect(doc.paragraphs.filter(p => !p.cellId).map(paragraphText)).toEqual(['Intro', 'End', '']);
    session.undo(); doc = session.model;
    expect(doc.tables).toHaveLength(1);
    expect(doc.paragraphs.filter(p => !p.cellId).map(paragraphText)).toEqual(['Intro', 'End']);
  });

  it('copies whole rows as a table of those rows, and other blocks, objects and pastes inside tables as text', () => {
    const { doc, table } = sample();
    const rows = T.copyTableRows(doc, { tableId: table.id, top: 0, bottom: 0, left: 0, right: 3, table }, { token: 'here' });
    expect(rows.table.rows).toHaveLength(1);
    // Rows starting inside a merge, part of a row, and a block in a table with Track Changes on: no table copy.
    expect(T.copyTableRows(doc, { tableId: table.id, top: 2, bottom: 2, left: 0, right: 3, table })).toBe(null);
    expect(T.copyTableRows(doc, { tableId: table.id, top: 0, bottom: 0, left: 0, right: 2, table })).toBe(null);
    doc.select(0); doc.trackChanges = true;
    expect(T.pasteTableRows(doc, rows, { token: 'here' })).toBe(false);
    doc.trackChanges = false;
    // Pasted at the start of a paragraph, the table goes before it.
    expect(T.pasteTableRows(doc, rows, { token: 'here' })).toBe(true);
    expect(doc.paragraphs[0].cellId).toBeTruthy();
    expect(paragraphText(doc.paragraphs.find(p => !p.cellId))).toBe('Intro');
  });

  it('pastes copied rows into a table of the same columns above the caret’s row, and others as text', async () => {
    const { pkg, doc: body, table } = sample();
    const session = new StorySession(body);
    let doc = session.model;
    const rows = T.copyTableRows(doc, { table, tableId: table.id, top: 0, bottom: 0, left: 0, right: 3 }, { token: 'here' });
    // The caret in the last row (below the merge): the copied first row goes in above it.
    const target = doc.tables[0];
    doc.selectCell(rowGrid(target.rows[2])[1].cell.id);
    expect(T.pasteTableRows(doc, rows, { token: 'here' })).toBe(false); // the merged cell crosses into that row
    doc.selectCell(rowGrid(target.rows[1])[0].cell.id);
    session.run(() => T.pasteTableRows(doc, rows, { token: 'here' }));
    doc = session.model;
    const texts = doc.tables[0].rows.map(row => row.cells.map(cell => doc.paragraphs.filter(p => p.cellId === cell.id).map(paragraphText).join('/')));
    expect(texts).toEqual([['c0', 'c1', 'c2'], ['c0', 'c1', 'c2'], ['c3/c6', 'c4', 'c5'], ['', 'c7', 'c8']]);
    expect(doc.tables).toHaveLength(1);
    documentBlocks(doc.paragraphs, doc.tables); verticalMerges(doc.tables[0]);
    const reopened = open(await DocxPackage.open(await save(pkg, doc)));
    expect(look(reopened, reopened.tables[0])).toEqual(look(doc, doc.tables[0]));
    session.undo(); doc = session.model;
    expect(doc.tables[0].rows).toHaveLength(3);
    // A table of other columns takes the rows as text.
    doc.select(doc.text.length); doc.insertTable(1, 2, 9000);
    expect(T.pasteTableRows(doc, rows, { token: 'here' })).toBe(false);
  });

  it('pastes another application’s table as a table, with its merges, header row and fills', async () => {
    const html = `<meta charset="utf-8"><table border="1"><thead><tr><th>Item</th><th colspan="2">Amount</th></tr></thead>
      <tbody><tr><td rowspan="2" style="background-color:#ffcc00">Pens<br>blue</td><td>2</td><td>4.00</td></tr>
      <tr><td>
        3</td><td>1.50</td></tr></tbody></table>`;
    const rows = foreignHtmlTable(html);
    expect(rows.map(r => r.map(c => c.lines.join('|')))).toEqual([['Item', 'Amount'], ['Pens|blue', '2', '4.00'], ['3', '1.50']]);
    const pkg = createDocx([paragraph('Intro')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
    const session = new StorySession(open(pkg));
    let doc = session.model;
    doc.select(doc.text.length);
    session.run(() => T.pasteTableRows(doc, T.foreignTableRows(doc, rows)));
    doc = session.model;
    const table = doc.tables[0];
    const shape = t => t.rows.map(row => row.cells.map(cell => doc.paragraphs.filter(p => p.cellId === cell.id).map(paragraphText).join('/') + ((cell.span ?? 1) > 1 ? `:${cell.span}` : '') + (cell.vMerge === 'restart' ? '^' : cell.vMerge === 'continue' ? 'v' : '')));
    expect(shape(table)).toEqual([['Item', 'Amount:2'], ['Pens/blue^', '2', '4.00'], ['v', '3', '1.50']]);
    expect(table.rows.map(row => !!row.header)).toEqual([true, false, false]);
    expect(table.rows[1].cells[0].shading).toBe('FFCC00');
    documentBlocks(doc.paragraphs, doc.tables); verticalMerges(table);
    const reopened = open(await DocxPackage.open(await save(pkg, doc)));
    expect(look(reopened, reopened.tables[0])).toEqual(look(doc, table));
    // Text around a table, or two tables, paste as paragraphs.
    expect(foreignHtmlTable('<p>Before</p><table><tr><td>a</td></tr></table>')).toBe(null);
    expect(foreignHtmlTable('<table><tr><td>a</td></tr></table><table><tr><td>b</td></tr></table>')).toBe(null);
  });
});
