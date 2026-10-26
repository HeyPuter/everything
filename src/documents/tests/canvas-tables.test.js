import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage, W } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { documentBlocks, fixedColumnWidths, tableCells } from '../src/engine/tables.js';
import { layoutDocument, caretRect, hitTest, selectionRects, verticalLine, lineAtPosition } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/tables.docx');
const bytes = async blob => new Uint8Array(await blob.arrayBuffer());
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
const save = (pkg, doc) => bytes(pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables));
const measure = (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize * 1.25, descent: style.fontSize * 5 / 12 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const content = (doc, cell) => doc.paragraphs.filter(p => p.cellId === cell.id).map(paragraphText);
const changedXml = async mutate => {
  const parts = unzipSync(source), xml = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
  mutate(xml); parts['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(xml)); return zipSync(parts);
};

it('imports independent fixed tables, inherited styles and cell contents without changing package parts', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), table = doc.tables[0];
  expect(table.grid).toEqual([4320, 2880]); expect(table.rows).toHaveLength(4);
  expect(documentBlocks(doc.paragraphs, doc.tables).map(b => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
  expect(content(doc, table.rows[1].cells[0])).toEqual(['Alpha café Á😀', 'Second paragraph']);
  expect(doc.paragraphs.find(p => p.cellId).runs[0]).toMatchObject({ bold: true, italic: true, fontSize: 11 });
  expect(doc.paragraphs[0].runs[0].italic).toBe(false);
  const exported = unzipSync(await save(pkg, doc)), original = unzipSync(source);
  for (const name of Object.keys(original)) expect(Buffer.from(exported[name]).equals(Buffer.from(original[name])), name).toBe(true);
});

it('edits, splits and joins paragraphs within cells, retains formatting and restores exact input on undo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), cell = doc.tables[0].rows[1].cells[0];
  doc.selectCell(cell.id); const position = doc.selection.focus;
  doc.replace('Edited '); doc.select(position + 7); doc.insertParagraph();
  expect(content(doc, cell)).toEqual(['Edited ', 'Alpha café Á😀', 'Second paragraph']);
  doc.delete(-1); expect(content(doc, cell)).toEqual(['Edited Alpha café Á😀', 'Second paragraph']);
  doc.select(position, position + 6); doc.toggleBold();
  const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  expect(reopened.text).toBe(doc.text); expect(reopened.paragraphs.find(p => paragraphText(p).startsWith('Edited')).runs[0]).toMatchObject({ bold: true, italic: true });
  while (doc.undo()) { /* restore the source */ }
  expect(unzipSync(await save(pkg, doc))['word/document.xml']).toEqual(unzipSync(source)['word/document.xml']);
});

it('protects cell separators on deletion and preserves all cells during cross-cell replacement', async () => {
  const doc = model(await DocxPackage.open(source)), table = doc.tables[0], cell = table.rows[0].cells[1];
  doc.selectCell(cell.id); const start = doc.selection.focus, before = doc.snapshot();
  expect(doc.delete(-1)).toBe(false); expect(doc.snapshot()).toEqual(before); expect(doc.history).toHaveLength(0);
  doc.select(start - 1); expect(doc.delete(1)).toBe(false);
  doc.select(start - 1, start); expect(doc.replace('')).toBe(false); expect(doc.history).toHaveLength(0);
  const a = doc.text.indexOf('Product') + 3, b = doc.text.indexOf('Alpha') + 2;
  doc.select(b, a); doc.replace('X\nY');
  expect(content(doc, table.rows[0].cells[0])).toEqual(['ProX', 'Y']);
  expect(content(doc, table.rows[0].cells[1])).toEqual(['']);
  expect(content(doc, table.rows[1].cells[0])[0]).toBe('pha café Á😀');
  expect(tableCells(doc.tables[0])).toHaveLength(8); documentBlocks(doc.paragraphs, doc.tables);
  doc.undo(); expect(doc.text).toBe(model(await DocxPackage.open(source)).text); expect(doc.selection).toEqual({ anchor: b, focus: a });
  // Selecting everything takes the table with the text around it, as in other word processors.
  doc.select(0, doc.text.length); doc.replace('Clear');
  expect(doc.text).toBe('Clear'); expect(doc.tables).toHaveLength(0); documentBlocks(doc.paragraphs, doc.tables);
});

it('creates tables at a caret, inserts and deletes rows/columns and round-trips structure with undo', async () => {
  const pkg = createDocx([paragraph('BeforeAfter')]), doc = model(pkg); doc.select(6); doc.insertTable(2, 2);
  expect(doc.paragraphs[0].runs[0].text).toBe('Before'); expect(paragraphText(doc.paragraphs.at(-1))).toBe('After');
  doc.replace('First'); doc.moveCell(1); doc.replace('Second');
  doc.insertTableColumn(); expect(doc.tables[0].grid).toHaveLength(3); doc.replace('Third');
  doc.insertTableRow(); expect(doc.tables[0].rows).toHaveLength(3); doc.replace('Inserted');
  const exported = await save(pkg, doc), reopened = model(await DocxPackage.open(exported));
  expect(reopened.text).toBe(doc.text); expect(reopened.tables[0].rows).toHaveLength(3);
  const before = doc.snapshot(); doc.deleteTablePart('column'); expect(doc.tables[0].grid).toHaveLength(2);
  doc.undo(); expect(doc.snapshot()).toEqual(before); doc.redo(); doc.deleteTablePart('row'); expect(doc.tables[0].rows).toHaveLength(2);
  doc.deleteTablePart('table'); expect(doc.tables).toHaveLength(0); expect(doc.text).toBe('Before\nAfter');
  while (doc.undo()) { /* restore insertion caret */ }
  expect(doc.text).toBe('BeforeAfter'); expect(doc.selection.focus).toBe(6);
});

it('lays out synchronized cells, flows oversized kept rows, and maps hit/caret/selection geometry to the correct column', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc), table = doc.tables[0];
  expect(result.pageCount).toBeGreaterThan(2);
  const tall = table.rows[2], pieces = result.cells.filter(c => c.id === tall.cells[0].id);
  expect(pieces.length).toBeGreaterThan(1); expect(pieces[0].page).toBe(1);
  for (const piece of pieces) {
    const other = result.cells.find(c => c.page === piece.page && c.id === tall.cells[1].id);
    expect(other.y).toBe(piece.y); expect(other.height).toBe(piece.height);
  }
  for (const cell of result.cells) expect(cell.y + cell.height).toBeLessThanOrEqual(result.page.height - result.page.bottom + 1e-6);
  for (const row of table.rows) for (const cell of row.cells) {
    doc.selectCell(cell.id); const position = doc.selection.focus, caret = caretRect(result, position);
    expect(hitTest(result, caret.page, caret.x, caret.y + caret.height / 2)).toBe(position);
  }
  const rects = selectionRects(result, 0, doc.text.length);
  expect(rects).toHaveLength(result.lines.length);
  expect(result.lines.every(l => l.stops.every(s => Number.isFinite(s.x)))).toBe(true);
  doc.selectCell(table.rows[0].cells[1].id);
  const line = lineAtPosition(result, doc.selection.focus), next = verticalLine(result, line, 1, line.stops[0].x);
  expect(next.cellId).toBe(table.rows[1].cells[1].id);
});

it('repaginates mixed-height cell content and spacing, keeps borders within pages, and restores geometry with undo', async () => {
  const doc = model(await DocxPackage.open(source)), table = doc.tables[0], cell = table.rows[2].cells[0];
  const original = layout(doc); doc.selectCell(cell.id);
  doc.select(doc.selection.focus, doc.selection.focus + 100); doc.setRunFormat({ fontSize: 22 });
  const grown = layout(doc); expect(grown.pageCount).toBeGreaterThanOrEqual(original.pageCount);
  expect(selectionRects(grown, ...doc.range).length).toBeGreaterThan(1);
  doc.undo(); expect(layout(doc)).toEqual(original);
  doc.selectCell(table.rows[3].cells[1].id); doc.setRunFormat({ fontSize: 24 });
  const empty = layout(doc), p = doc.paragraphs.find(p => p.cellId === table.rows[3].cells[1].id);
  expect(empty.lines.find(l => l.paragraphId === p.id).height).toBeGreaterThan(original.lines.find(l => l.paragraphId === p.id).height);
  doc.setParagraphFormat({ spaceAfter: 600 });
  for (const box of layout(doc).cells) expect(box.y + box.height).toBeLessThanOrEqual(empty.page.height - empty.page.bottom + 1e-6);
});

it('supports row splitting without cantSplit, cell-local keeps and body paragraphs beside a table-only document', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), table = doc.tables[0];
  doc.selectCell(table.rows[2].cells[0].id); doc.setTableRowKeep(false);
  const result = layout(doc); expect(result.cells.find(c => c.id === table.rows[2].cells[0].id).page).toBe(0);
  doc.paragraphs = doc.paragraphs.filter(p => p.cellId); doc.selectCell(table.rows[0].cells[0].id);
  doc.insertTableParagraph(false); doc.replace('Before');
  doc.selectCell(table.rows.at(-1).cells.at(-1).id); doc.insertTableParagraph(); doc.replace('After');
  expect(documentBlocks(doc.paragraphs, doc.tables).map(b => b.type)).toEqual(['paragraph', 'table', 'paragraph']);
  expect((await DocxPackage.open(await save(pkg, doc))).paragraphs.at(-1).runs[0].text).toBe('After');
  doc.selectCell(table.rows[0].cells[0].id); const before = doc.snapshot();
  // Inline cell breaks are retained but ignored by native layout (the
  // independent cell-breaks controls distinguish these from pPr breaks).
  expect(() => doc.insertPageBreak()).not.toThrow();
  const cellLines = layout(doc).lines.filter(l => l.cellId === table.rows[0].cells[0].id);
  expect(cellLines.some(l => l.hardBreak === 'page')).toBe(false);
  expect(content(doc, table.rows[0].cells[0]).join('')).toContain('\f');
  doc.undo(); expect(doc.snapshot()).toEqual(before);
  expect(() => doc.setParagraphFormat({ pageBreakBefore: true })).toThrow(/inside table cells/);
  expect(doc.snapshot()).toEqual(before);
});

it('resolves conflicting preferred widths proportionally without sizing to content', () => {
  const cell = value => ({ width: { type: 'dxa', value } });
  const table = { grid: [2000, 2000], width: { type: 'dxa', value: 4000 }, rows: [{ cells: [cell(3000), cell(3000)] }, { cells: [cell(4000), cell(2000)] }] };
  fixedColumnWidths(table, 9000).forEach((w,i)=>expect(Math.abs(w/20-[114.2,85.8][i])).toBeLessThan(.1));
  table.width = { type: 'pct', value: 2500 };
  fixedColumnWidths(table, 8000).forEach((w,i)=>expect(Math.abs(w/20-[114.2,85.8][i])).toBeLessThan(.1));
  expect(fixedColumnWidths({ grid: [3000, 1000], rows: [{ cells: [{ width: { type: 'pct', value: 2500 } }, { width: { type: 'pct', value: 2500 } }] }] }, 9000)).toEqual([2000, 2000]);
});

it('retains table/paragraph/character style layers during shared edits and empty-cell typing', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), cell = doc.tables[0].rows[3].cells[1];
  doc.selectCell(cell.id); expect(doc.runFormatting.italic).toBe(true);
  doc.setCharacterStyle('Emphasis'); expect(doc.runFormatting.italic).toBe(false);
  doc.replace('Styled cell'); const at = doc.text.indexOf('Styled cell');
  doc.select(at, at + 11); doc.setRunFormat({ bold: true });
  doc.editParagraphStyle('Normal', { run: { fontSize: 16 } });
  const result = doc.paragraphs.find(p => p.cellId === cell.id).runs[0];
  expect(result).toMatchObject({ styleId: 'Emphasis', italic: false, bold: true, fontSize: 16 });
  const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  const run = reopened.paragraphs.find(p => paragraphText(p) === 'Styled cell').runs[0];
  expect(run).toMatchObject({ styleId: 'Emphasis', italic: false, bold: true, fontSize: 16 });
  expect(run.properties).not.toMatch(/<w:(sz|i)[\s/>]/);
  doc.undo(); expect(doc.runFormatting.fontSize).toBe(11);
});

it.each([
    ['invalid layout', xml => xml.getElementsByTagNameNS(W, 'tblLayout')[0].setAttributeNS(W, 'w:type', 'unknown')],
    ['invalid merge', xml => { const n = xml.createElementNS(W, 'w:vMerge'); n.setAttributeNS(W, 'w:val', 'unknown'); xml.getElementsByTagNameNS(W, 'tcPr')[0].append(n); }],
    ['missing paragraph', xml => { const cell = xml.getElementsByTagNameNS(W, 'tc')[0]; [...cell.children].filter(n => n.localName === 'p').forEach(n => n.remove()); }],
    ['incomplete row', xml => xml.getElementsByTagNameNS(W, 'tc')[0].remove()],
    ['nested', xml => { const n = xml.createElementNS(W, 'w:tbl'); xml.getElementsByTagNameNS(W, 'tc')[0].append(n); }],
    ['invalid header', xml => { const node = xml.createElementNS(W, 'w:tblHeader'); node.setAttributeNS(W, 'w:val', 'unknown'); xml.getElementsByTagNameNS(W, 'trPr')[0].append(node); }],
  ])('rejects unsupported structures and malformed cells before editable open: %s', async (tag, mutate) => {
  await expect(DocxPackage.open(await changedXml(mutate)), tag).rejects.toThrow(/tables/);
});
