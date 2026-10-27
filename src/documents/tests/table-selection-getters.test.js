import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { editableCells, verticalMerges, rowGrid, cellSpan } from '../src/engine/tables.js';

// The toolbar reads the selection's table cells and rows many times after each keystroke or caret move.
// Each answer worked out the merged cells of every table in the document, which was slow beside long tables.
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });

// The getters as they read the document before.
function reference(doc) {
  const block = doc.activeCellBlock;
  const ids = new Set(doc.selectedParagraphs.map(p => p.cellId).filter(Boolean));
  const cells = block ? doc.selectedTableCells : doc.tables.flatMap(table => editableCells(table).filter(cell => ids.has(cell.id)));
  let rows;
  if (block) rows = block.table.rows.slice(block.top, block.bottom + 1);
  else {
    const byOwner = new Map();
    for (const table of doc.tables) for (const [id, owner] of verticalMerges(table)) if (id === owner.cell.id) byOwner.set(id, table.rows.slice(owner.rowIndex, owner.endRow + 1));
    rows = [...new Set(doc.selectedParagraphs.flatMap(p => byOwner.get(p.cellId) || []))];
  }
  const cellIds = new Set(cells.map(cell => cell.id));
  const borders = doc.tables.flatMap(table => {
    const owners = verticalMerges(table);
    return table.rows.flatMap(row => rowGrid(row).filter(({ cell }) => cellIds.has(cell.id)).map(({ cell }) => [cell.id, owners.get(cell.id).endRow - owners.get(cell.id).rowIndex + 1]));
  });
  return { cells: cells.map(c => c.id), rows: rows.map(r => r.cells.map(c => c.id).join()), borders };
}
const current = doc => ({ cells: doc.selectedTableCells.map(c => c.id), rows: doc.selectedTableRows.map(r => r.cells.map(c => c.id).join()), borderCount: doc.cellBorderValues.length });

const fixtures = ['vertical-cells', 'vertical-pages', 'exact-row-heights', 'cell-margins', 'table-headers', 'nested-floating-tables', 'nested-terminal-paragraph', 'table-page-edge'];
it.each(fixtures)('%s: the selection\'s cells and rows are those found by reading every table', async name => {
  const pkg = await DocxPackage.open(readFileSync(`public/fixtures/${name}.docx`));
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  expect(doc.tables.length).toBeGreaterThan(1);
  const starts = []; let at = 0; for (const p of doc.paragraphs) { starts.push(at); at += p.runs.reduce((n, r) => n + r.text.length, 0) + 1; }
  let seed = 11; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % Math.max(1, n); };
  const selections = [...starts.map(s => [s, s]), ...Array.from({ length: 40 }, () => { const a = rnd(at), b = rnd(at); return [Math.min(a, b), Math.max(a, b)]; })];
  let inCells = 0;
  for (const [a, b] of selections) {
    doc.cellBlock = null; doc.select(a, b);
    const want = reference(doc), got = current(doc);
    expect(got.cells).toEqual(want.cells); expect(got.rows).toEqual(want.rows); expect(got.borderCount).toBe(want.borders.length);
    if (got.cells.length) inCells++;
  }
  // Rectangular cell selections in each table.
  for (const table of doc.tables) {
    const width = Math.max(...table.rows.map(row => (row.gridBefore || 0) + row.cells.reduce((n, c) => n + cellSpan(c), 0)));
    if (!doc.setCellBlock({ tableId: table.id, top: 0, bottom: table.rows.length - 1, left: 0, right: width })) continue;
    const want = reference(doc), got = current(doc);
    expect(got.cells).toEqual(want.cells); expect(got.rows).toEqual(want.rows); expect(got.borderCount).toBe(want.borders.length);
  }
  expect(inCells).toBeGreaterThan(0);
});

it('reads only the tables the selection is in', () => {
  const doc = new TextDocument([paragraph('Before'), paragraph('After')]);
  doc.select(0); doc.insertTable(3, 3); doc.select(doc.text.length); doc.insertTable(60, 4);
  const [first, long] = doc.tables;
  let reads = 0;
  const rows = long.rows;
  Object.defineProperty(long, 'rows', { configurable: true, get: () => { reads++; return rows; } });
  // A caret outside every table reads none of them; one in the first table only checks the long one
  // once for each answer.
  const outside = doc.paragraphs.findIndex(p => !p.cellId), inFirst = doc.paragraphs.findIndex(p => p.cellId === first.rows[1].cells[1].id);
  for (const [index, most] of [[outside, 0], [inFirst, 6]]) {
    doc.select(doc.paragraphOffset(index));
    reads = 0;
    void doc.selectedTableCells; void doc.selectedTableRows; void doc.cellBorderValues; void doc.tableRowKeep; void doc.cellShading;
    expect(reads).toBeLessThanOrEqual(most);
  }
  delete long.rows; long.rows = rows;
  doc.selectCell(long.rows[40].cells[2].id);
  expect(doc.selectedTableCells.map(c => c.id)).toEqual([long.rows[40].cells[2].id]);
  expect(doc.selectedTableRows).toEqual([long.rows[40]]);
});
