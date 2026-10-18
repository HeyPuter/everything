import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { addComment } from '../src/core/comments.js';

// Excel's Save As offers "Strict Open XML Spreadsheet (*.xlsx)", whose parts use ISO 29500 Strict's
// namespaces and relationship types (http://purl.oclc.org/ooxml/...). Such a file with a table did not open
// ("Sheet ... could not be read; the file may be damaged"), and one without lost its formatting, which the
// readers find by the transitional names. It now opens as the same file saved the usual way does.

const STRICT = [
  ['http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'http://purl.oclc.org/ooxml/spreadsheetml/main'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', 'http://purl.oclc.org/ooxml/officeDocument/relationships/extendedProperties'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'http://purl.oclc.org/ooxml/officeDocument/relationships'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/extended-properties', 'http://purl.oclc.org/ooxml/officeDocument/extendedProperties'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes', 'http://purl.oclc.org/ooxml/officeDocument/docPropsVTypes'],
  ['http://schemas.openxmlformats.org/drawingml/2006/main', 'http://purl.oclc.org/ooxml/drawingml/main'],
  ['http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing', 'http://purl.oclc.org/ooxml/drawingml/spreadsheetDrawing'],
  ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'http://purl.oclc.org/ooxml/drawingml/chart'],
];
/** The package as Excel saves it in the Strict format. */
function asStrict(bytes) {
  const zip = X.CFB.read(bytes, { type: 'array' });
  for (const entry of zip.FileIndex) {
    if (!/\.(xml|rels)$/.test(entry.name) || !entry.content?.length) continue;
    let xml = new TextDecoder().decode(entry.content);
    for (const [transitional, strict] of STRICT) xml = xml.split(transitional).join(strict);
    if (entry.name === 'workbook.xml') xml = xml.replace(/<workbook\b/, '<workbook conformance="strict"');
    entry.content = new TextEncoder().encode(xml);
    entry.size = entry.content.length;
  }
  return new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
}
const snapshot = (wb) => JSON.stringify(wb.toJSON(), (key, value) => (key === 'id' || /Id$/.test(key)) && typeof value === 'string' ? '#' : value)
  .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '#');

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Item', 'Qty', 'Due'], ['Pens', '4', '2024-05-01'], ['Pads', '2', '2024-06-15']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 2 });
  wb.setInput(id, 4, 1, `=SUM(${wb.activeSheet.tables[0].name}[Qty])`);
  wb.applyStyle(id, { r1: 4, c1: 0, r2: 4, c2: 1 }, { bold: true, bg: '#ffcc00', color: '#1f4e79' });
  wb.addValidation(id, { type: 'number', range: { r1: 1, c1: 1, r2: 2, c2: 1 }, min: 0, max: 100 });
  wb.setNote(id, 0, 0, 'Stock list');
  addComment(wb, id, 1, 0, 'Reorder soon', 'Ann', new Date('2024-05-01T10:00:00Z'));
  wb.addSheet('More');
  wb.setInput(wb.sheets[1].id, 0, 0, '=Sheet1!B5*2');
  return wb;
}

it('opens a Strict Open XML workbook as the same workbook saved the usual way', async () => {
  const bytes = new Uint8Array(await (await workbookToXlsx(book())).arrayBuffer());
  const strict = asStrict(bytes);
  expect(new TextDecoder().decode(X.CFB.find(X.CFB.read(strict, { type: 'array' }), '/_rels/.rels').content)).toContain('http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument');
  const usual = await workbookFromFile(bytes, 'stock.xlsx');
  const opened = await workbookFromFile(strict, 'stock.xlsx');
  expect(snapshot(opened)).toBe(snapshot(usual));
  expect(opened.getValue(opened.sheets[1].id, 0, 0)).toBe(12);
  expect(opened.styleAt(opened.sheets[0].id, 4, 0)).toMatchObject({ bold: true, bg: '#ffcc00' });
});

it('opens Strict dates, which Excel writes as ISO dates rather than serial numbers', async () => {
  const bytes = new Uint8Array(await (await workbookToXlsx(book())).arrayBuffer());
  const zip = X.CFB.read(asStrict(bytes), { type: 'array' });
  const sheet = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  sheet.content = new TextEncoder().encode(new TextDecoder().decode(sheet.content)
    .replace(/<c r="C2"([^>]*?)>(?:(?!<\/c>)[\s\S])*<\/c>/, '<c r="C2"$1 t="d"><v>2024-05-01T00:00:00</v></c>'));
  sheet.size = sheet.content.length;
  const opened = await workbookFromFile(new Uint8Array(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), 'stock.xlsx');
  expect(opened.getValue(opened.sheets[0].id, 1, 2)).toBe(45413);
});
