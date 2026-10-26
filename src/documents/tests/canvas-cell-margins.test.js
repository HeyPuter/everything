import { beforeAll, afterAll, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';
import { createDocx, DocxPackage } from '../src/engine/docx.js';
import { TextDocument, paragraphText } from '../src/engine/model.js';
import { layoutDocument, caretRect, hitTest, selectionRects, imageAtPoint } from '../src/engine/layout.js';
import { pageGeometry } from '../src/engine/page-settings.js';
import { cellContext, tableCells, verticalMerges } from '../src/engine/tables.js';

let dom;
beforeAll(() => { dom = new JSDOM(''); globalThis.DOMParser = dom.window.DOMParser; globalThis.XMLSerializer = dom.window.XMLSerializer; });
afterAll(() => { dom.window.close(); delete globalThis.DOMParser; delete globalThis.XMLSerializer; });
const source = readFileSync('public/fixtures/cell-margins.docx');
const model = pkg => new TextDocument(pkg.paragraphs, pkg.pageSettings, pkg.numbering, pkg.styles, pkg.tables, pkg.assets);
const save = async (pkg, doc) => new Uint8Array(await pkg.export(doc.paragraphs, doc.pageSettings, doc.numbering, doc.styles, doc.tables, doc.assets).arrayBuffer());
const measure = (text, style) => ({ width: [...text].length * style.fontSize * 2 / 3, ascent: style.fontSize, descent: style.fontSize / 3 });
const layout = doc => layoutDocument(doc.paragraphs, measure, pageGeometry(doc.pageSettings), doc.numbering, doc.tables);
const paragraph = (doc, text) => doc.paragraphs.find(p => paragraphText(p).startsWith(text));
const cell = (doc, text) => cellContext(doc.tables, paragraph(doc, text).cellId).cell;
const select = (doc, text) => { const at = doc.text.indexOf(text); expect(at).toBeGreaterThanOrEqual(0); doc.select(at, at + text.length); };
function sameParts(actual, expected, except = []) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const [name, bytes] of Object.entries(expected)) if (!except.includes(name)) expect(Buffer.from(actual[name]).equals(Buffer.from(bytes)), name).toBe(true);
}
const rewrite = (from, to, path = 'word/document.xml') => {
  const parts = unzipSync(source); expect(strFromU8(parts[path])).toContain(from);
  parts[path] = strToU8(strFromU8(parts[path]).replace(from, to)); return zipSync(parts);
};
const logical = '<w:start w:w="540" w:type="dxa"/>';

it('resolves style, table and direct margins, logical aliases, nil inheritance, unit overrides and the default margins', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg);
  const inherited = { top: 60, left: 360, bottom: 120, right: 180 };
  expect(cell(doc, 'Inherited padding').margins).toEqual(inherited);
  expect(cell(doc, 'Logical padding')).toMatchObject({ inheritedMargins: inherited, margins: { top: 240, left: 540, bottom: 0, right: 200 }, directMargins: { top: 240, left: 540, bottom: 0, right: null } });
  expect(cell(doc, 'Ignored padding')).toMatchObject({ margins: { top: 100, left: 360, bottom: 120, right: 200 }, directMargins: { top: null, left: null, bottom: null, right: null } });
  expect(cell(doc, 'No padding').margins).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
  expect(cell(doc, 'Default padding').margins).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
  sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
});

it('edits sides, removes both aliases for inheritance, preserves untouched declarations and restores exact source with undo', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Inherited padding'); const before = doc.snapshot();
  doc.setCellMargins({ top: 180, left: 300 }); select(doc, 'Logical padding'); doc.setCellMargins(null);
  let bytes = await save(pkg, doc), reopened = model(await DocxPackage.open(bytes));
  expect(cell(reopened, 'Inherited padding').margins).toEqual({ top: 180, left: 300, bottom: 120, right: 180 });
  expect(cell(reopened, 'Logical padding').directMargins).toEqual({}); expect(cell(reopened, 'Logical padding').margins.left).toBe(360);
  expect(cell(reopened, 'Ignored padding').directMargins).toEqual({ top: null, left: null, bottom: null, right: null });
  sameParts(unzipSync(bytes), pkg.parts, ['word/document.xml']);
  doc.undo(); doc.undo(); expect(doc.snapshot()).toEqual(before); sameParts(unzipSync(await save(pkg, doc)), pkg.parts);
  doc.redo(); doc.redo(); select(doc, 'Logical padding'); doc.setCellMargins({ left: 0 });
  reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(cell(reopened, 'Logical padding').margins.left).toBe(0);
});

it('updates every vertical-merge member and preserves edits across splitting, owner deletion and row insertion', async () => {
  const pkg = await DocxPackage.open(source), doc = model(pkg); select(doc, 'Vertical margin'); doc.setCellMargins({ left: 360 });
  const { table, cell: owner } = doc.tableContext, group = verticalMerges(table).get(owner.id).cells;
  expect(group).toHaveLength(3); expect(group.every(c => c.margins.left === 360)).toBe(true);
  const before = doc.snapshot(); doc.splitCell(); expect(doc.tables[1].rows.every(row => row.cells[0].margins.left === 360)).toBe(true);
  doc.undo(); expect(doc.snapshot()).toEqual(before); doc.deleteTablePart('row'); expect(cell(doc, 'Vertical margin').margins.left).toBe(360);
  doc.undo(); doc.insertTableRow();
  const reopened = model(await DocxPackage.open(await save(pkg, doc)));
  expect(reopened.tables[1].rows.every(row => row.cells[0].margins.left === 360)).toBe(true); expect(() => layout(reopened)).not.toThrow();
});

it('reflows fixed cells without moving their edges, keeps Unicode hit testing aligned and restores pagination on undo', async () => {
  const doc = model(await DocxPackage.open(source)), before = layout(doc), text = doc.text;
  select(doc, 'Text wraps'); const id = doc.tableContext.cell.id; doc.setCellMargins({ left: 800, right: 800 });
  const after = layout(doc);
  expect(after.tableWidths).toEqual(before.tableWidths); expect(after.lines.filter(l => l.cellId === id).length).toBeGreaterThan(before.lines.filter(l => l.cellId === id).length);
  expect(after.pageCount).toBeGreaterThanOrEqual(before.pageCount); expect(doc.text).toBe(text);
  select(doc, 'Unicode Á😀'); const old = caretRect(after, doc.range[0]); doc.setCellMargins({ left: 420 });
  const moved = layout(doc), rect = caretRect(moved, doc.range[0]); expect(rect.x - old.x).toBeCloseTo(4);
  expect(hitTest(moved, rect.page, rect.x, rect.y + rect.height / 2)).toBe(doc.range[0]); expect(selectionRects(moved, doc.range[0], doc.range[0] + 7)[0].x).toBe(rect.x);
  doc.undo(); doc.undo(); expect(layout(doc)).toEqual(before);
});

it('uses edited padding in repeated headers and contains every page-fragment line inside its owning margins', async () => {
  const doc = model(await DocxPackage.open(source)); select(doc, 'Header padding'); const id = doc.tableContext.cell.id;
  doc.setCellMargins({ top: 240, bottom: 180 }); const result = layout(doc); expect(result.pageCount).toBeGreaterThan(3);
  expect(result.repeatedLines.filter(l => l.cellId === id).length).toBeGreaterThan(1);
  for (const line of [...result.lines, ...result.repeatedLines].filter(l => l.cellId)) {
    const box = result.cells.find(c => c.id === line.cellId && c.page === line.page), c = cellContext(doc.tables, line.cellId).cell;
    expect(line.y).toBeGreaterThanOrEqual(box.y + c.margins.top / 15 - 1e-6);
    expect(line.y + line.height).toBeLessThanOrEqual(box.y + box.height - c.margins.bottom / 15 + 1e-6);
  }
});

it('feeds new margins into AutoFit demand and moves inline pictures with their hit targets', async () => {
  const doc = model(await DocxPackage.open(source)); select(doc, 'AutoFit first'); const before = layout(doc), id = doc.tableContext.cell.id;
  doc.setCellMargins({ left: 600, right: 600 }); const after = layout(doc), line = after.lines.find(l => l.cellId === id), box = after.cells.find(c => c.id === id);
  expect(line.fragments[0].x - box.x).toBeCloseTo(40); expect(line.fragments.at(-1).x + line.fragments.at(-1).width).toBeLessThanOrEqual(box.x + box.width - 40 + 1e-6);
  doc.undo(); expect(layout(doc)).toEqual(before);
  const imageDoc = model(await DocxPackage.open(readFileSync('public/fixtures/inline-images.docx'))), index = imageDoc.paragraphs.findIndex(p => p.cellId && p.runs.some(r => r.image));
  imageDoc.select(imageDoc.paragraphOffset(index)); imageDoc.setCellMargins({ top: 180, left: 240 }); const imageLayout = layout(imageDoc);
  const imageLine = imageLayout.lines.find(l => l.paragraphId === imageDoc.paragraphs[index].id && l.fragments.some(f => f.image)), image = imageLine.fragments.find(f => f.image);
  expect(imageAtPoint(imageLayout, imageLine.page, image.x + image.width / 2, imageLine.baseline - image.ascent / 2)).toBe(image);
});

it('round trips fresh margins, inherits through repeated edits and clears a mixed selection atomically', async () => {
  const pkg = createDocx(), doc = model(pkg); doc.insertTable(1, 2); doc.replace('First'); const first = doc.tableContext.cell;
  doc.setCellMargins({ left: 240, top: 120 }); doc.setCellMargins({ left: null }); expect(first.margins.left).toBe(108);
  const other = tableCells(doc.tables[0])[1]; doc.selectCell(other.id); doc.replace('Second'); doc.setCellMargins({ right: 0 });
  doc.selectCell(first.id); const start = doc.range[0]; doc.selectCell(other.id); doc.select(start, doc.range[0] + 6);
  doc.setCellMargins({ top: 0, left: 0, bottom: 0, right: 0 }); expect(doc.selectedTableCells).toHaveLength(2);
  const reopened = model(await DocxPackage.open(await save(pkg, doc))); expect(tableCells(reopened.tables[0]).every(c => Object.values(c.margins).every(v => v === 0))).toBe(true);
});

it.each([['', 0], ['w:w="12"', 12], ['w:w="0.25in" w:type="pct"', 360], ['w:w="6pt"', 120], ['w:w="2.54cm"', 1440], ['w:w="25.4mm"', 1440], ['w:w="1pc"', 240], ['w:w="1pi"', 240], ['w:w=" +40 "', 40], ['w:w="12%" w:type="dxa"', 360], ['w:w="99" w:type="nil"', 360], ['w:w="99" w:type="auto"', 360]])('reads missing and explicit margin units: %s', async (attrs, expected) => {
  const doc = model(await DocxPackage.open(rewrite(logical, `<w:start ${attrs}/>`))); expect(cell(doc, 'Logical padding').margins.left).toBe(expected);
});

it('uses zero for table-level auto/percentage side margins while top/bottom and nil inherit', async () => {
  const parts = unzipSync(source), xml = new dom.window.DOMParser().parseFromString(strFromU8(parts['word/document.xml']), 'application/xml'), W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const table = xml.getElementsByTagNameNS(W, 'tbl')[0], pr = table.getElementsByTagNameNS(W, 'tblPr')[0], mar = xml.createElementNS(W, 'w:tblCellMar');
  for (const [side, type] of [['top','nil'], ['left','auto'], ['bottom','pct'], ['right','pct']]) { const n = xml.createElementNS(W, 'w:' + side); n.setAttributeNS(W, 'w:type', type); n.setAttributeNS(W, 'w:w', '100'); mar.append(n); }
  pr.getElementsByTagNameNS(W, 'tblCellMar')[0].replaceWith(mar); parts['word/document.xml'] = strToU8(new dom.window.XMLSerializer().serializeToString(xml));
  const doc = model(await DocxPackage.open(zipSync(parts))); expect(doc.tables[0].margins).toEqual({ top: 80, left: 0, bottom: 120, right: 0 });
  expect(cell(doc, 'Inherited padding').margins).toEqual({ top: 60, left: 0, bottom: 120, right: 180 });
});

it.each(['<w:start w:w="-1"/>', '<w:start w:w="1.5.0"/>', '<w:start w:w="999999"/>', '<w:start w:w="bad"/>', '<w:start w:w="1em"/>', '<w:start w:type="bad"/>', '<w:start w:unknown="1"/>', '<w:start>text</w:start>', '<w:start><w:left/></w:start>', '<w:start/><w:start/>', '<w:insideH/>'])('rejects malformed margins before editable import: %s', async markup => {
  await expect(DocxPackage.open(rewrite(logical, markup))).rejects.toThrow(/cell margins/);
});

it('rejects invalid edits before history changes and ignores selections outside tables', async () => {
  const doc = model(await DocxPackage.open(source)); expect(doc.setCellMargins(null)).toBe(false); select(doc, 'Inherited padding'); const before = doc.snapshot();
  for (const patch of [undefined, [], { start: 120 }, { top: -1 }, { left: 1.5 }, { right: 31681 }, { bottom: NaN }, { top: '20' }]) expect(() => doc.setCellMargins(patch)).toThrow();
  expect(doc.snapshot()).toEqual(before); expect(doc.undo()).toBe(false);
});
