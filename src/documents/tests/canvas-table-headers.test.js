import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { DocxPackage, createDocx, W } from '../src/engine/docx.js';
import { TextDocument, paragraph, paragraphText } from '../src/engine/model.js';
import { headerRowCount, verticalMerges, documentBlocks } from '../src/engine/tables.js';
import { layoutDocument, caretRect, hitTest, selectionRects, lineAtPosition, verticalLine } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/table-headers.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables).arrayBuffer());
const measure = (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize * 1.25, descent: style.fontSize * 5 / 12 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const changed = mutate => {
  const parts = unzipSync(source), xml = new DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml');
  mutate(xml); parts['word/document.xml'] = strToU8(new XMLSerializer().serializeToString(xml)); return zipSync(parts);
};
function geometry(result) {
  for (const line of [...result.lines, ...result.repeatedLines]) if (line.cellId) {
    const box = result.cells.find(c => c.id === line.cellId && c.page === line.page);
    expect(box).toBeDefined(); expect(line.y).toBeGreaterThanOrEqual(box.y - 1e-6); expect(line.y + line.height).toBeLessThanOrEqual(box.y + box.height + 1e-6);
    const stop = line.stops[Math.floor(line.stops.length / 2)]; expect(hitTest(result, line.page, stop.x, line.y + line.height / 2)).toBe(stop.offset);
    expect(caretRect(result, stop.offset, stop.offset === line.end ? 'backward' : 'forward', line.page).page).toBe(line.page);
  }
  for (const cell of result.cells) {
    expect(cell.y).toBeGreaterThanOrEqual(result.page.top - 1e-6); expect(cell.y + cell.height).toBeLessThanOrEqual(result.page.height - result.page.bottom + 1e-6);
    for (const other of result.cells) if (other !== cell && other.page === cell.page) expect(Math.min(other.x + other.width, cell.x + cell.width) - Math.max(other.x, cell.x) > 1e-6 && Math.min(other.y + other.height, cell.y + cell.height) - Math.max(other.y, cell.y) > 1e-6).toBe(false);
  }
}

it('opens inherited multi-row headers with direct overrides and preserves ignored flags and every package entry', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  expect(doc.tables[0].rows.map(r => r.header)).toEqual([true, true, false, false, false, false, true]);
  expect(doc.tables.map(headerRowCount)).toEqual([2, 1]); expect(doc.text.match(/Product Á😀/g)).toHaveLength(1);
  const out = unzipSync(await save(pkg, doc)); for (const [name, bytes] of Object.entries(pkg.parts)) expect(Buffer.from(out[name]).equals(Buffer.from(bytes)), name).toBe(true);
});

it('repeats fixed and AutoFit headers on every occupied table page without duplicating source lines or overlapping body text', async () => {
  const doc = model(await DocxPackage.open(source)), result = layout(doc); geometry(result, doc);
  expect(result.pageCount).toBeGreaterThan(3); expect(result.repeatedLines.length).toBeGreaterThan(0);
  for (const table of doc.tables) {
    const pages = new Set(result.cells.filter(c => c.tableId === table.id).map(c => c.page));
    const headerCell = table.rows[0].cells[0], boxes = result.cells.filter(c => c.id === headerCell.id);
    expect(boxes).toHaveLength(pages.size); expect(boxes.filter(c => !c.repeatedHeader)).toHaveLength(1);
    const count = result.lines.filter(l => l.cellId === headerCell.id).length;
    expect(result.repeatedLines.filter(l => l.cellId === headerCell.id)).toHaveLength(count * (pages.size - 1));
    for (const box of boxes.filter(c => c.repeatedHeader)) expect(box.y).toBeCloseTo(result.page.top + 1 / 3);
  }
  const later = doc.tables[0].rows.at(-1).cells[0].id;
  expect(result.repeatedLines.some(l => l.cellId === later)).toBe(false);
  expect(new Set(result.lines.map(l => `${l.paragraphId}/${l.start}/${l.end}`)).size).toBe(result.lines.length);
});

it('keeps caret page affinity for header copies, highlights their shared selection and updates every copy after editing', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), result = layout(doc), copy = result.repeatedLines.find(l => l.fragments.some(f => f.text.includes('Description')));
  const stop = copy.stops[1], at = hitTest(result, copy.page, stop.x, copy.y + copy.height / 2);
  expect(lineAtPosition(result, at, 'forward', copy.page)).toBe(copy); expect(caretRect(result, at).page).toBeLessThan(copy.page);
  expect(selectionRects(result, copy.start, copy.end).filter(r => r.page === copy.page).length).toBeGreaterThan(0);
  const next = verticalLine(result, copy, 1, stop.x); expect(next.header).not.toBe(true); expect(next.page).toBe(copy.page);
  doc.select(at); const before = doc.snapshot(); doc.replace('X'); const edited = layout(doc); geometry(edited, doc);
  expect(doc.text.match(/DXescription/g)).toHaveLength(1);
  for (const line of [lineAtPosition(edited, at), ...edited.repeatedLines.filter(l => l.cellId === copy.cellId)]) expect(line.fragments.map(f => f.text).join('')).toContain('DXescription');
  const out = model(await DocxPackage.open(await save(pkg, doc))); expect(out.text).toBe(doc.text); expect(out.tables.map(headerRowCount)).toEqual([2, 1]);
  doc.undo(); expect(doc.snapshot()).toEqual(before); expect(layout(doc)).toEqual(result);
});

it('defines a contiguous header including whole vertical merges, clears orphan flags, and preserves selection through undo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), table = doc.tables[0]; doc.selectCell(table.rows[0].cells[1].id);
  const before = doc.snapshot(); expect(doc.headerRowsThroughSelection).toBe(1); doc.setTableHeaderRows(1);
  expect(headerRowCount(table)).toBe(2); expect(table.rows.at(-1).header).toBe(false); const defined = doc.snapshot();
  expect(doc.setTableHeaderRows(1)).toBe(false); expect(doc.snapshot()).toEqual(defined);
  doc.setTableHeaderRows(0); expect(table.rows.every(r => r.header === false)).toBe(true); expect(layout(doc).repeatedLines.every(l => l.cellId !== table.rows[0].cells[0].id)).toBe(true);
  const out = model(await DocxPackage.open(await save(pkg, doc))); expect(headerRowCount(out.tables[0])).toBe(0); expect(out.tables[0].rows.every(r => !r.header)).toBe(true);
  doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(before);
  doc.redo(); expect(doc.snapshot()).toEqual(defined); doc.redo(); expect(doc.tables[0].rows.every(r => !r.header)).toBe(true);
  doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(before);
  const exported = unzipSync(await save(pkg, doc)); for (const [name, bytes] of Object.entries(pkg.parts)) expect(Buffer.from(exported[name]).equals(Buffer.from(bytes)), name).toBe(true);
});

it('extends headers for inserted interior rows, stops at the boundary, and retains them through column and row deletion', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); doc.selectCell(doc.tables[0].rows[0].cells[1].id); const before = doc.snapshot();
  doc.insertTableRow(); let table = doc.tables[0]; expect(headerRowCount(table)).toBe(3);
  expect(verticalMerges(table).get(table.rows[0].cells[0].id).endRow).toBe(2); doc.replace('New header'); geometry(layout(doc), doc);
  doc.selectCell(table.rows[2].cells[1].id); doc.insertTableRow(); expect(headerRowCount(table)).toBe(3); expect(table.rows[3].header).toBe(false);
  doc.insertTableColumn(); doc.replace('Column'); doc.deleteTablePart('column'); expect(doc.text).not.toContain('Column'); geometry(layout(doc), doc);
  doc.selectCell(table.rows[0].cells[0].id); doc.deleteTablePart('row'); expect(headerRowCount(table)).toBe(2); expect(doc.text).toContain('Product Á😀');
  documentBlocks(doc.paragraphs, doc.tables); const out = model(await DocxPackage.open(await save(pkg, doc))); expect(out.text).toBe(doc.text); geometry(layout(out), out);
  while (doc.history.length) doc.undo(); expect(doc.snapshot()).toEqual(before);
});

it('moves the first header with a kept first body row and resolves shared font changes before reserving header space', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), table = doc.tables[0];
  table.rows[2].cantSplit = true; table.rows[2].minHeight = 2400;
  const before = layout(doc), header = before.cells.find(c => c.id === table.rows[0].cells[0].id), body = before.cells.find(c => c.id === table.rows[2].cells[0].id);
  expect(header.page).toBe(body.page); expect(header.y).toBeCloseTo(before.page.top + 1 / 3); expect(header.page).toBeGreaterThan(0);
  doc.editParagraphStyle('Normal', { run: { fontSize: 12 } }); const result = layout(doc); geometry(result, doc);
  expect(result.cells.find(c => c.id === table.rows[0].cells[0].id).height).toBeGreaterThan(header.height);
  doc.undo(); expect(layout(doc)).toEqual(before);
});

it('places a header-only table once with its preceding kept heading and retains all header flags on reopen', async () => {
  const pkg = createDocx([paragraph('Lead A'), paragraph('Lead B'), paragraph('Heading'), paragraph()]), doc = model(pkg);
  doc.select(doc.text.length); doc.insertTable(2, 1); doc.replace('First'); doc.selectCell(doc.tables[0].rows[1].cells[0].id); doc.replace('Second'); doc.setTableHeaderRows(2);
  doc.paragraphs = doc.paragraphs.filter(p => p.cellId || paragraphText(p));
  for (const p of doc.paragraphs) p.format = { ...p.format, lineSpacing: 1, spaceAfter: 0, spaceBefore: 0, keepNext: paragraphText(p) === 'Heading' };
  const page = { width: 816, height: 130, top: 20, bottom: 20, left: 96, right: 96, gap: 24 };
  const result = layoutDocument(doc.paragraphs, text => ({ width: text.length * 8, ascent: 10, descent: 10 }), page, doc.numbering, doc.tables);
  geometry(result); expect(result.pageCount).toBe(2); expect(result.repeatedLines).toEqual([]);
  const heading = result.lines.find(l => l.paragraphId === doc.paragraphs[2].id);
  expect(heading.page).toBe(1); expect(result.cells).toHaveLength(2); expect(result.cells.every(c => c.page === heading.page)).toBe(true);
  expect(result.lines.filter(l => l.header)).toHaveLength(2);
  // The saved body ends with the table; reopening gives it a final paragraph to type in.
  const out = model(await DocxPackage.open(await save(pkg, doc))); expect(out.text).toBe(doc.text + '\n'); expect(headerRowCount(out.tables[0])).toBe(2);
});

it('ignores noncontiguous header flags, rejects crossing merges and lays out headers that cannot repeat once', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg), table = doc.tables[0];
  table.rows[0].header = false; const plain = layout(doc); expect(headerRowCount(table)).toBe(0); expect(plain.repeatedLines.some(l => l.cellId === table.rows[1].cells[1].id)).toBe(false);
  table.rows[0].header = true; table.rows[1].header = false; expect(() => layout(doc)).toThrow(/cross.*header boundary/);
  // A header too tall to leave its page room for the body is not repeated, as in Word: the rows are
  // laid out once, as ordinary rows, instead of refusing the table (and the typing that grew it).
  table.rows[1].header = true; doc.selectCell(table.rows[0].cells[0].id); doc.replace('Tall header '.repeat(100));
  const tall = layout(doc), headerCell = doc.tables[0].rows[0].cells[0].id, first = new Set(doc.tables[0].rows.flatMap(r => r.cells.map(c => c.id)));
  expect(tall.repeatedLines.filter(l => first.has(l.cellId))).toEqual([]);
  expect(new Set(tall.lines.filter(l => l.cellId === headerCell).map(l => l.page)).size).toBeGreaterThan(1);
  expect(tall.lines.some(l => l.cellId === doc.tables[0].rows.at(-1).cells[0].id)).toBe(true);
  doc.undo();
  doc.selectCell(doc.tables[0].rows[2].cells[0].id); doc.setRunFormat({ fontSize: 160 }); doc.replace('W'); expect(() => layout(doc)).not.toThrow(/too little space/);
  await expect(DocxPackage.open(changed(xml => xml.getElementsByTagNameNS(W, 'tblHeader')[0].setAttributeNS(W, 'w:val', 'unknown')))).rejects.toMatchObject({ name: 'UnsupportedDocumentError' });
});
