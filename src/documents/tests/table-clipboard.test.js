import { beforeAll, afterAll, it, expect, describe } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { tableCells, verticalMerges, documentBlocks, rowGrid } from '../src/engine/tables.js';
import * as T from '../src/engine/table-editing.js';
import { applyTableStyle } from '../src/engine/table-styles.js';
import { tableFragmentHtml, htmlTableFragment } from '../src/engine/clipboard-fragment.js';
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
    doc.selectCell(tableCells(table)[1].id);
    expect(T.pasteTableRows(doc, rows, { token: 'here' })).toBe(false);
    doc.select(0); doc.trackChanges = true;
    expect(T.pasteTableRows(doc, rows, { token: 'here' })).toBe(false);
    doc.trackChanges = false;
    // Pasted at the start of a paragraph, the table goes before it.
    expect(T.pasteTableRows(doc, rows, { token: 'here' })).toBe(true);
    expect(doc.paragraphs[0].cellId).toBeTruthy();
    expect(paragraphText(doc.paragraphs.find(p => !p.cellId))).toBe('Intro');
  });
});
