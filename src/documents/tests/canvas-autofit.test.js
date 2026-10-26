import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument, paragraph } from '../src/engine/model.js';
import { autoColumnWidths } from '../src/engine/tables.js';
import { cellIntrinsicWidths } from '../src/engine/intrinsic-widths.js';
import { layoutDocument, caretRect, hitTest, selectionRects } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const bytes = async b => new Uint8Array(await b.arrayBuffer());
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
const save = (pkg, doc) => bytes(pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables));
const source = readFileSync('public/fixtures/autofit-tables.docx');
const wordWidths = JSON.parse(readFileSync('tests/fixtures/nested-tables/legacy-autofit-native-widths.json', 'utf8'));
const legacyPageWidth = wordWidths.sumPoints * 4 / 3;
const measure = (text, style) => ({ width: [...text].length * style.fontSize * (style.bold ? .75 : 2 / 3), ascent: style.fontSize * 1.25, descent: style.fontSize * 5 / 12 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const widths = (result, table) => table.rows[0].cells.map(cell => result.cells.find(c => c.id === cell.id).width);

it('keeps measured subpixel content separate from the empty-cell writing floor', () => {
  const metrics = text => cellIntrinsicWidths({margins:{left:0,right:0},content:[{paragraph:paragraph(text),index:0}]}, t => ({width:t.length / 4,ascent:1,descent:0}), {}, undefined, []);
  expect(metrics('').contentMin).toBe(0);
  expect(metrics('i').min).toBe(.4);
  expect(metrics('i').contentMin).toBeCloseTo(4 / 15, 8);
});

it('opens default/explicit AutoFit and zero-width grids, measures cells and leaves all source parts unchanged', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), result = layout(doc);
  expect(createHash('sha256').update(source).digest('hex')).toBe(wordWidths.sourceSha256);
  expect(doc.tables.map(t => t.layout)).toEqual(['autofit', 'autofit']);
  expect(doc.tables[0].width).toEqual({ type: 'pct', value: 5000 }); expect(doc.tables[1].grid).toEqual([0, 0]);
  const wide = widths(result, doc.tables[0]); expect(wide[0]).toBeGreaterThan(72); expect(wide.reduce((a,b) => a+b, 0)).toBeCloseTo(legacyPageWidth);
  expect(widths(result, doc.tables[1]).reduce((a,b) => a+b, 0)).toBeLessThan(120);
  const out = unzipSync(await save(pkg, doc)), original = unzipSync(source);
  for (const name of Object.keys(original)) expect(Buffer.from(out[name]).equals(Buffer.from(original[name])), name).toBe(true);
});

it('redistributes before expanding, overrides preferred table width when necessary, and forces wrapping only at page capacity', () => {
  const table = { grid: [1000, 3000], width: { type: 'dxa', value: 4000 }, rows: [{ cells: [{ width: { type: 'dxa', value: 1000 } }, { width: { type: 'dxa', value: 3000 } }] }] };
  const intrinsic = [{ min: 2000, max: 4000, floor: 200 }, { min: 500, max: 3000, floor: 200 }];
  expect(autoColumnWidths(table, 6000, intrinsic)).toEqual([2000, 2000]);
  intrinsic[0].min = 4500; expect(autoColumnWidths(table, 6000, intrinsic)).toEqual([4500, 500]);
  intrinsic[0].min = 8000; const forced = autoColumnWidths(table, 6000, intrinsic);
  expect(forced.reduce((a,b) => a+b, 0)).toBe(6000); expect(forced[0]).toBeLessThan(8000); expect(forced[1]).toBeGreaterThanOrEqual(200);
  expect(() => autoColumnWidths(table, 300, intrinsic)).toThrow(/cannot fit/);
  table.width = { type: 'pct', value: 5000 }; intrinsic[0].min = 1000;
  expect(autoColumnWidths(table, 6000, intrinsic, 5000).reduce((a,b) => a+b, 0)).toBe(5000);
});

it('includes shaping, tabs, indents and nonbreaking spaces in intrinsic measurements without measuring every prefix', () => {
  const metrics = text => {
    let calls = 0;
    const p = paragraph(text), cell = { margins: { left: 0, right: 0 }, content: [{ paragraph: p, index: 0 }] };
    const result = cellIntrinsicWidths(cell, (text, style) => { calls++; return measure(text, style); }, { defaultTabStop: 720 }, undefined, []);
    return { ...result, calls };
  };
  expect(metrics('aa bb').min).toBe(16); expect(metrics('aa\u00a0bb').min).toBe(40);
  expect(metrics('A\tB').max).toBe(56);
  const long = metrics('A'.repeat(10000)); expect(long.max).toBe(80000); expect(long.calls).toBeLessThan(10020);
  const p = paragraph('One', { format: { indentLeft: 720, firstLine: 360, indentRight: 360 } });
  const result = cellIntrinsicWidths({ margins: { left: 108, right: 108 }, content: [{ paragraph: p, index: 0 }] }, measure, {}, undefined, []);
  expect(result.max).toBeCloseTo(134.4);
});

it('reflows text edits and shared font changes without changing grid preferences, and restores widths/carets with undo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), table = doc.tables[0], original = layout(doc);
  doc.selectCell(table.rows[0].cells[0].id); const at = doc.selection.focus;
  doc.select(at, at + 'Extraordinary'.length); doc.replace('W'.repeat(60));
  const changed = layout(doc); expect(widths(changed, table)[0]).toBeGreaterThan(widths(original, table)[0]);
  expect(table.grid).toEqual([1080, 3240, 2880]); expect(changed.lines.filter(l => l.cellId === table.rows[0].cells[0].id).length).toBeGreaterThan(1);
  const caret = caretRect(changed, at + 10); expect(hitTest(changed, caret.page, caret.x, caret.y + caret.height / 2)).toBe(at + 10);
  expect(selectionRects(changed, at, at + 60).length).toBeGreaterThan(1);
  doc.undo(); expect(layout(doc)).toEqual(original);
  doc.editParagraphStyle('Normal', { run: { fontSize: 16 } }); expect(widths(layout(doc), table)[0]).toBeGreaterThan(widths(original, table)[0]);
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(reopened.tables[0].grid).toEqual([1080, 3240, 2880]); expect(widths(layout(reopened), reopened.tables[0])).toEqual(widths(layout(doc), doc.tables[0]));
});

it('edits sizing, fits contents/page, preserves no-op history and saves only requested properties', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), table = doc.tables[0]; doc.selectCell(table.rows[0].cells[0].id);
  const selection = { ...doc.selection }; expect(doc.setTableProperties({ layout: 'autofit', width: table.width })).toBe(false); expect(doc.history).toHaveLength(0);
  doc.fitTable('contents'); expect(table.width.type).toBe('auto'); expect(table.rows.every(row => row.cells.every(c => c.width.type === 'auto'))).toBe(true);
  const compact = layout(doc); doc.fitTable('page'); expect(widths(layout(doc), table).reduce((a,b) => a+b, 0)).toBeCloseTo(legacyPageWidth);
  doc.undo(); expect(layout(doc)).toEqual(compact); doc.redo();
  doc.setTableProperties({ layout: 'fixed', columns: [1800, 3600, 1800], alignment: 'center', indent: 720 });
  expect(doc.selection).toEqual(selection); const before = doc.snapshot();
  expect(() => doc.setTableProperties({ width: { type: 'dxa', value: -1 } })).toThrow(); expect(doc.snapshot()).toEqual(before);
  const exported = await DocxPackage.open(await save(pkg, doc)), out = model(exported);
  expect(out.tables[0]).toMatchObject({ layout: 'fixed', grid: [1800, 3600, 1800], alignment: 'center', indent: 720, width: { type: 'dxa', value: 7200 } });
  for (const name of Object.keys(pkg.parts)) if (name !== 'word/document.xml') expect(Buffer.from(exported.parts[name]).equals(Buffer.from(pkg.parts[name])), name).toBe(true);
});

it('resolves explicit percentage/measurement units over a contradictory type, retaining lexical forms until edited', async () => {
  const parts = unzipSync(source), xml = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
  const tblW = xml.getElementsByTagNameNS(W, 'tblW')[0]; tblW.setAttributeNS(W, 'w:type', 'dxa'); tblW.setAttributeNS(W, 'w:w', '33.33%');
  const tcW = xml.getElementsByTagNameNS(W, 'tcW')[0]; tcW.setAttributeNS(W, 'w:type', 'pct'); tcW.setAttributeNS(W, 'w:w', '1in');
  parts['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(xml));
  const pkg = await DocxPackage.open(zipSync(parts)), doc = model(pkg);
  expect(doc.tables[0].width).toEqual({ type: 'pct', value: 1666.5 }); expect(doc.tables[0].rows[0].cells[0].width).toEqual({ type: 'dxa', value: 1440 });
  doc.selectCell(doc.tables[0].rows[0].cells[0].id); doc.replace('Changed ');
  expect(strFromU8(unzipSync(await save(pkg, doc))['word/document.xml'])).toContain('33.33%');
  doc.setTableProperties({ width: { type: 'pct', value: 1666.75 } });
  expect((await DocxPackage.open(await save(pkg, doc))).tables[0].width.value).toBe(1666.75);
});

it('inherits the table layout algorithm and saves direct overrides without changing shared styles', async () => {
  const parts = unzipSync(source), xml = new DOMParser().parseFromString(strFromU8(parts['word/styles.xml']), 'application/xml');
  const style = [...xml.getElementsByTagNameNS(W, 'style')].find(n => n.getAttributeNS(W, 'styleId') === 'TableGrid');
  const layoutNode = xml.createElementNS(W, 'w:tblLayout'); layoutNode.setAttributeNS(W, 'w:type', 'fixed');
  style.getElementsByTagNameNS(W, 'tblPr')[0].append(layoutNode);
  parts['word/styles.xml'] = strToU8(new XMLSerializer().serializeToString(xml));
  const pkg = await DocxPackage.open(zipSync(parts)), doc = model(pkg);
  expect(doc.tables.map(t => t.layout)).toEqual(['fixed', 'autofit']);
  doc.selectCell(doc.tables[0].rows[0].cells[0].id); doc.setTableProperties({ layout: 'autofit' });
  const exported = await DocxPackage.open(await save(pkg, doc));
  expect(exported.tables.map(t => t.layout)).toEqual(['autofit', 'autofit']);
  expect(Buffer.from(exported.parts['word/styles.xml']).equals(Buffer.from(parts['word/styles.xml']))).toBe(true);
  doc.undo(); const undone = unzipSync(await save(pkg, doc));
  for (const name of Object.keys(parts)) expect(Buffer.from(undone[name]).equals(Buffer.from(parts[name])), name).toBe(true);
});

it('inserts and deletes AutoFit columns without requiring or flattening width preferences', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  for (const tableIndex of [0, 1]) {
    let table = doc.tables[tableIndex]; const before = doc.snapshot(), original = layout(doc), grid = [...table.grid], preferred = structuredClone(table.width);
    doc.selectCell(table.rows[0].cells[0].id); doc.insertTableColumn();
    // The new column starts as wide as the one it follows, never zero-width.
    expect(table.grid).toEqual([grid[0], grid[0], ...grid.slice(1)]); expect(table.width).toEqual(preferred);
    expect(table.rows.every(row => row.cells[1].width.type === 'auto')).toBe(true);
    doc.replace('Inserted'); const changed = layout(doc);
    expect(changed.cells.length).toBeGreaterThan(original.cells.length);
    const reopened = model(await DocxPackage.open(await save(pkg, doc)));
    expect(reopened.tables[tableIndex].grid).toEqual(table.grid); expect(reopened.text).toContain('Inserted');
    doc.deleteTablePart('column'); expect(table.grid).toEqual(grid); expect(table.width).toEqual(preferred); expect(doc.text).not.toContain('Inserted');
    doc.undo(); expect(layout(doc)).toEqual(changed); doc.redo(); expect(layout(doc)).toEqual(original);
    doc.restore(before);
  }
});
