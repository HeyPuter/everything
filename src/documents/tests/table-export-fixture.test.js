// Writes a DOCX that exercises every table feature to test-results/, for schema validation
// (tools/check-docx-schema.py) and for opening in other word processors.
import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { tableCells, rowGrid } from '../src/engine/tables.js';
import * as T from '../src/engine/table-editing.js';
import { applyTableStyle, setTableLook, saveTableStyle } from '../src/engine/table-styles.js';
import { insertFormula } from '../src/engine/table-formula.js';
import { insertQuickTable } from '../src/engine/quick-tables.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

it('exports every table feature into one valid package', async () => {
  const pkg = createDocx([paragraph('Tables'), paragraph('Name\tQty'), paragraph('Pens\t2'), paragraph('End')], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
  doc.select(doc.text.indexOf('Name'), doc.text.indexOf('End') - 1);
  T.convertTextToTable(doc, { separator: 'tab' });
  doc.select(doc.text.length);
  doc.insertTable(4, 4, 9000);
  const table = doc.tables.at(-1), cell = (r, c) => rowGrid(table.rows[r]).find(x => x.column <= c && x.end > c).cell;
  tableCells(table).forEach((c, i) => { doc.selectCell(c.id); doc.replace(String(i + 1)); });
  applyTableStyle(doc, 'DocsTableGridBandedTeal');
  setTableLook(doc, { lastRow: true, noVBand: false });
  doc.selectCell(cell(3, 3).id); insertFormula(doc, '=SUM(ABOVE)', '#,##0.00');
  doc.cellBlock = { tableId: table.id, top: 0, bottom: 1, left: 1, right: 3 }; T.mergeBlock(doc);
  doc.selectCell(cell(2, 0).id); T.splitCells(doc, { rows: 2, columns: 2 });
  doc.cellBlock = { tableId: table.id, top: 0, bottom: 0, left: 0, right: table.grid.length };
  T.applyBorderPreset(doc, 'outside', { style: 'double', size: 6, color: '2E5E8C' });
  doc.selectCell(cell(1, 0).id);
  T.setTextDirection(doc, 'btLr'); T.setCellAlignment(doc, { vertical: 'center', horizontal: 'center' }); T.setCellWrap(doc, false);
  T.setTableAltText(doc, { title: 'Totals', description: 'Totals by quarter' });
  T.setTableCellMargins(doc, { top: 40, bottom: 40 });
  T.setSelectedRowHeight(doc, 500, 'exact');
  saveTableStyle(doc, { id: 'TableFixtureStyle', name: 'Fixture Style', borders: { top: { style: 'single', size: 8, color: '000000' } }, regions: { firstRow: { fill: 'FFEEAA', bold: true, borders: { bottom: { style: 'single', size: 12, color: '000000' } } }, band1Horz: { fill: 'F0F0F0' } }, whole: { color: '333333' } });
  // A merge below the shifted row would no longer line up: the edit is refused.
  doc.selectCell(cell(0, 0).id); expect(() => T.deleteCells(doc, { shift: 'left' })).toThrow('line up');
  doc.undo();
  doc.selectCell(cell(table.rows.length - 1, 0).id); T.deleteCells(doc, { shift: 'left' });
  doc.select(doc.text.length);
  insertQuickTable(doc, 'calendar', (r, c) => doc.insertTable(r, c), { date: new Date(2024, 1, 1) });
  doc.select(doc.text.length);
  doc.insertTable(2, 2); T.setTableWrapping(doc, 'around');
  T.setTablePositioning(doc, { x: 'right', horzAnchor: 'margin', y: 360, vertAnchor: 'text', bottomFromText: 144, overlap: false });
  doc.select(doc.text.length); doc.insertTable(1, 1); T.autofitTable(doc, 'contents');
  const bytes = new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables).arrayBuffer());
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/table-features.docx', bytes);
  const reopened = await DocxPackage.open(bytes);
  expect(reopened.tables.length).toBe(doc.tables.length);
});
