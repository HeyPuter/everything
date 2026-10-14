import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'fflate';
import { DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphText, runFormat } from '../src/engine/model.js';
import { rowGrid } from '../src/engine/tables.js';
import { bodyFieldRanges } from '../src/engine/body-fields.js';
import { updateSequenceFields } from '../src/engine/field-update.js';
import { tableLook, setTableLook, applyTableStyle, specFromTable, saveTableStyle } from '../src/engine/table-styles.js';
import * as T from '../src/engine/table-editing.js';

// Handwritten by tools/table_tools_fixture.py (no application serializer).
const source = readFileSync('tests/fixtures/table-tools/table-tools.docx');
let dom;
beforeAll(() => { dom = new JSDOM(); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => dom.window.close());
const open = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const cellAt = (table, r, c) => rowGrid(table.rows[r]).find(x => x.column <= c && x.end > c).cell;
const text = (doc, cell) => doc.paragraphs.filter(p => p.cellId === cell.id).map(paragraphText).join('/');
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables).arrayBuffer());

it('reads the look, alt text, formulas, ragged rows, rotation, no-wrap and floating placement', async () => {
  const pkg = await DocxPackage.open(source), doc = open(pkg);
  expect(pkg.readOnly).toBeFalsy();
  const [ledger, shapes, floating] = doc.tables;
  expect(tableLook(ledger)).toMatchObject({ firstRow: true, lastRow: true, firstColumn: false, noVBand: true });
  expect([ledger.caption, ledger.description]).toEqual(['Supplies', 'Units and prices of art supplies']);
  expect(cellAt(ledger, 0, 0).shading).toBe('1F4E79');
  expect(cellAt(ledger, 1, 0).shading).toBe('DDEBF7');
  expect(runFormat(doc.paragraphs.find(p => p.cellId === cellAt(ledger, 3, 0).id).runs[0]).italic).toBe(true);
  expect(bodyFieldRanges(doc.paragraphs).map(r => [r.field.type, doc.text.slice(r.start, r.end)])).toEqual([['=', '6'], ['=', '42.50']]);
  expect(shapes.rows[1].gridAfter).toBe(1);
  expect([cellAt(shapes, 0, 0).textDirection, cellAt(shapes, 0, 1).noWrap]).toEqual(['btLr', true]);
  expect(floating.floating).toMatchObject({ tblpXSpec: 'right', horzAnchor: 'margin' });
  // Untouched, the package saves byte for byte.
  const exported = unzipSync(await save(pkg, doc)), original = unzipSync(source);
  for (const name of Object.keys(original)) expect(Buffer.from(exported[name]).equals(Buffer.from(original[name])), name).toBe(true);
});

it('recomputes formulas, edits the look and structure, and keeps the rest of the source', async () => {
  const pkg = await DocxPackage.open(source), doc = open(pkg), ledger = doc.tables[0];
  // A changed price: Update Fields recomputes both totals with their number formats.
  const price = doc.paragraphs.find(p => p.cellId === cellAt(ledger, 2, 2).id), at = doc.paragraphOffset(doc.paragraphs.indexOf(price));
  doc.select(at, at + 2); doc.replace('47.5');
  expect(updateSequenceFields(doc)).toBe(1);
  expect(text(doc, cellAt(ledger, 3, 2))).toBe('60.00');
  setTableLook(doc, { noHBand: true });
  doc.selectCell(cellAt(ledger, 1, 0).id);
  T.insertRows(doc, {});
  doc.selectCell(cellAt(doc.tables[1], 0, 0).id);
  T.setTextDirection(doc, 'tbRl');
  const bytes = await save(pkg, doc), parts = unzipSync(bytes), xml = strFromU8(parts['word/document.xml']);
  expect(xml).toContain('w:noHBand="1"');
  expect(xml).toContain('<w:textDirection w:val="tbRl"/>');
  expect(xml).toContain('<w:tblCaption w:val="Supplies"/>');
  expect(xml).toContain('w:tblpXSpec="right"');
  expect(strFromU8(parts['word/styles.xml'])).toBe(strFromU8(unzipSync(source)['word/styles.xml']));
  const reopened = open(await DocxPackage.open(bytes));
  expect(reopened.tables[0].rows).toHaveLength(5);
  expect(cellAt(reopened.tables[0], 1, 0).shading).not.toBe('DDEBF7');
  expect(text(reopened, cellAt(reopened.tables[0], 4, 2))).toBe('60.00');
  // Applying a library style replaces the document's style reference but keeps its definition.
  reopened.selectCell(cellAt(reopened.tables[0], 0, 0).id); applyTableStyle(reopened, 'DocsTablePlainGrid');
  expect(reopened.styles.definitions.Ledger).toBeTruthy();
});

it('derives an editable copy of a style that came with the document', async () => {
  const pkg = await DocxPackage.open(source), doc = open(pkg), ledger = doc.tables[0];
  const spec = specFromTable(doc.styles, ledger);
  expect(spec.name).toBe('Ledger');
  expect(spec.regions.firstRow).toMatchObject({ fill: '1F4E79', bold: true, color: 'FFFFFF' });
  expect(spec.regions.band1Horz).toMatchObject({ fill: 'DDEBF7' });
  expect(spec.borders.top).toMatchObject({ style: 'single', size: 8, color: '1F4E79' });
  doc.selectCell(cellAt(ledger, 0, 0).id);
  saveTableStyle(doc, { ...spec, id: 'LedgerCopy', name: 'Ledger Copy' });
  expect(ledger.styleId).toBe('LedgerCopy');
  expect(cellAt(ledger, 0, 0).shading).toBe('1F4E79');
  expect(cellAt(ledger, 1, 0).shading).toBe('DDEBF7');
});
