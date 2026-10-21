import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

const sheetXml = async (wb) => {
  vi.stubGlobal('Blob', NodeBlob);
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(bytes, { type: 'array' });
  return { bytes, xml: new TextDecoder().decode(X.CFB.find(zip, '/xl/worksheets/sheet1.xml').content) };
};

// Saving listed every result of an array formula one by one, so a CSE array or a What-If data table declared
// over the whole sheet (seventeen billion cells) never finished saving. Past the cells any array may hold, the
// file keeps the anchor and its declared extent, and readers work the results out again.
it('saves an array formula entered over the whole sheet, and opens it again', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  expect(wb.setArrayFormula(id, { r1: 0, c1: 1, r2: 1048575, c2: 16383 }, '=A1*2')).toBe(true);
  expect(wb.getValue(id, 7, 9)).toBe(10);
  const started = performance.now();
  const { bytes, xml } = await sheetXml(wb);
  expect(performance.now() - started).toBeLessThan(20000);
  expect(xml).toMatch(/<c r="B1"[^>]*><f t="array" ref="B1:XFD1048576">A1\*2<\/f><v>10<\/v><\/c>/);
  expect(xml).not.toMatch(/<c r="C1"/);
  const back = await workbookFromFile(bytes, 'array.xlsx'), sheet = back.activeSheetId;
  expect(back.getCell(sheet, 0, 1)).toMatchObject({ f: 'A1*2', array: { rows: 1048576, cols: 16383 } });
  expect(back.getValue(sheet, 7, 9)).toBe(10);
}, 60000);

it('saves a What-If data table a file stretches over the whole sheet', async () => {
  const zip = X.CFB.read(new Uint8Array(X.write({ SheetNames: ['Data'], Sheets: { Data: { '!ref': 'A1' } } }, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const part = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  part.content = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
    + '<row r="1"><c r="A1"><v>2</v></c><c r="B1"><f>A1*10</f><v>20</v></c></row>'
    + '<row r="2"><c r="A2"><v>3</v></c><c r="B2"><f t="dataTable" ref="B2:XFD1048576" dt2D="0" dtr="0" r1="A1"/><v>30</v></c></row></sheetData></worksheet>');
  part.size = part.content.length;
  const wb = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'table.xlsx');
  const { xml } = await sheetXml(wb);
  expect(xml).toMatch(/<c r="B2"[^>]*><f t="dataTable" ref="B2:XFD1048576" dt2D="0" dtr="0" r1="A1"\/>/);
  expect(xml).not.toMatch(/<c r="C2"/);
}, 60000);

it('still lists every result of an ordinary array formula', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '5');
  wb.setArrayFormula(id, { r1: 0, c1: 1, r2: 2, c2: 2 }, '=A1*2');
  const { xml } = await sheetXml(wb);
  for (const ref of ['B1', 'C1', 'B2', 'C2', 'B3', 'C3']) expect(xml).toMatch(new RegExp(`<c r="${ref}"[^>]*>(?:<f[^>]*>[^<]*</f>)?<v>10</v></c>`));
});
