import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, WRITING_STYLES } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText, runFormat } from '../src/engine/model.js';
import { tableCells, rowGrid } from '../src/engine/tables.js';
import { TABLE_STYLE_LIBRARY, applyTableStyle, setTableLook, clearTableStyle, saveTableStyle, tableLook, availableTableStyles, newTableStyleId, checkedTableStyleSpec } from '../src/engine/table-styles.js';
import { lookAttributes } from '../src/engine/docx-table-styles.js';

let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());

const open = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
function tableDocument(rows = 4, columns = 3) {
  const pkg = createDocx([paragraph()], undefined, undefined, undefined, [], {}, WRITING_STYLES);
  const doc = open(pkg);
  doc.insertTable(rows, columns, 9000);
  tableCells(doc.tables[0]).forEach((cell, i) => { doc.selectCell(cell.id); doc.replace(`t${i}`); });
  doc.selectCell(tableCells(doc.tables[0])[4].id);
  return { pkg, doc };
}
const cellAt = (doc, r, c) => rowGrid(doc.tables[0].rows[r]).find(x => x.column <= c && x.end > c).cell;
const runOf = (doc, r, c) => { const p = doc.paragraphs.find(x => x.cellId === cellAt(doc, r, c).id); return runFormat(p.runs[0]); };
const look = (doc, r, c) => ({ fill: cellAt(doc, r, c).shading, bold: runOf(doc, r, c).bold, color: runOf(doc, r, c).color, borders: Object.fromEntries(Object.entries(cellAt(doc, r, c).borders).map(([k, v]) => [k, v.style + v.size + v.color])) });
async function reopen(pkg, doc) {
  const bytes = new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables).arrayBuffer());
  const parts = unzipSync(bytes);
  return { doc: open(await DocxPackage.open(bytes)), document: strFromU8(parts['word/document.xml']), styles: strFromU8(parts['word/styles.xml']) };
}

it('offers a library of plain, grid and list styles with distinct ids and names', () => {
  expect(TABLE_STYLE_LIBRARY.length).toBeGreaterThan(40);
  expect(new Set(TABLE_STYLE_LIBRARY.map(s => s.id)).size).toBe(TABLE_STYLE_LIBRARY.length);
  expect(new Set(TABLE_STYLE_LIBRARY.map(s => s.name)).size).toBe(TABLE_STYLE_LIBRARY.length);
  expect([...new Set(TABLE_STYLE_LIBRARY.map(s => s.family))]).toEqual(['plain', 'grid', 'list']);
  for (const spec of TABLE_STYLE_LIBRARY) expect(checkedTableStyleSpec(spec).regions).toEqual(spec.regions);
});

it('applies a style with header, bands and first column in one step, and the look survives saving', async () => {
  const { pkg, doc } = tableDocument();
  expect(applyTableStyle(doc, 'DocsTableGridBandedBlue')).toBe(true);
  expect(look(doc, 0, 1)).toMatchObject({ fill: '2E5E8C', bold: true, color: 'FFFFFF' });
  expect(look(doc, 1, 1).fill).toBe('DCE6F2');
  expect(look(doc, 2, 1).fill).toBe('auto');
  expect(look(doc, 1, 0).bold).toBe(true);
  expect(look(doc, 1, 1).bold).toBe(false);
  const saved = await reopen(pkg, doc);
  expect(saved.document).toContain('<w:tblStyle w:val="DocsTableGridBandedBlue"/>');
  expect(saved.document).toMatch(/<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"\/>/);
  expect(saved.document).not.toMatch(/<w:tblBorders>/);
  expect(saved.styles).toContain('w:styleId="DocsTableGridBandedBlue"');
  expect(saved.styles).toContain('<w:tblStylePr w:type="firstRow">');
  for (const [r, c] of [[0, 0], [0, 1], [1, 0], [1, 1], [2, 1], [3, 2]]) expect(look(saved.doc, r, c), `${r},${c}`).toEqual(look(doc, r, c));
  expect(tableLook(saved.doc.tables[0])).toEqual(tableLook(doc.tables[0]));
});

it('Table Style Options switch regions through the look', async () => {
  const { pkg, doc } = tableDocument();
  applyTableStyle(doc, 'DocsTableGridBandedGreen');
  expect(setTableLook(doc, { firstRow: false, noHBand: true, lastRow: true })).toBe(true);
  expect(look(doc, 0, 1)).toMatchObject({ fill: 'auto', bold: false });
  expect(look(doc, 1, 1).fill).toBe('auto');
  expect(look(doc, 3, 1).bold).toBe(true);
  expect(lookAttributes(tableLook(doc.tables[0]))).toMatchObject({ firstRow: '0', lastRow: '1', noHBand: '1' });
  const saved = await reopen(pkg, doc);
  expect(look(saved.doc, 3, 1)).toEqual(look(doc, 3, 1));
  expect(look(saved.doc, 0, 1)).toEqual(look(doc, 0, 1));
  doc.undo();
  expect(look(doc, 0, 1).fill).toBe('4A7A35');
});

it('clears direct cell formatting unless asked to keep it, and Clear removes the style', async () => {
  const { pkg, doc } = tableDocument();
  doc.selectCell(cellAt(doc, 2, 2).id); doc.setCellShading('FF0000');
  applyTableStyle(doc, 'DocsTableListLightTeal', { keepFormatting: true });
  expect(cellAt(doc, 2, 2).shading).toBe('FF0000');
  applyTableStyle(doc, 'DocsTableListLightTeal');
  expect(cellAt(doc, 2, 2).shading).not.toBe('FF0000');
  clearTableStyle(doc);
  expect(Object.keys(cellAt(doc, 0, 0).borders)).toEqual([]);
  expect(look(doc, 0, 0).bold).toBe(false);
  const saved = await reopen(pkg, doc);
  expect(saved.document).not.toContain('<w:tblStyle ');
  expect(look(saved.doc, 0, 0).bold).toBe(false);
});

it('creates and modifies the document’s own styles; every table using one follows', async () => {
  const { pkg, doc } = tableDocument();
  const id = newTableStyleId(doc.styles, 'Quarterly Figures');
  expect(id).toBe('TableQuarterlyFigures');
  saveTableStyle(doc, { id, name: 'Quarterly Figures', borders: { top: { style: 'single', size: 8, color: '000000' }, bottom: { style: 'single', size: 8, color: '000000' } }, regions: { firstRow: { fill: 'FFEEAA', bold: true } } });
  expect(doc.tables[0].styleId).toBe(id);
  expect(look(doc, 0, 0)).toMatchObject({ fill: 'FFEEAA', bold: true });
  expect(availableTableStyles(doc.styles).at(-1).id).toBe(id);
  saveTableStyle(doc, { id, name: 'Quarterly Figures', borders: {}, regions: { firstRow: { fill: '112233', color: 'FFFFFF' } } });
  expect(look(doc, 0, 0)).toMatchObject({ fill: '112233', color: 'FFFFFF', bold: false });
  expect(() => saveTableStyle(doc, { id: 'Other', name: 'quarterly figures', regions: {} })).toThrow('already has that name');
  const saved = await reopen(pkg, doc);
  expect(saved.styles).toContain('<w:name w:val="Quarterly Figures"/>');
  expect(look(saved.doc, 0, 0)).toEqual(look(doc, 0, 0));
});
