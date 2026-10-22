import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx, workbookToOds } from '../src/core/io.js';

async function roundTrip(wb) {
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const native = X.read(bytes, { type: 'array', cellNF: true });
  const zip = X.CFB.read(bytes, { type: 'array' });
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  const xml = new TextDecoder().decode(part.content);
  part.content = new TextEncoder().encode(xml.replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  part.size = part.content.length;
  const external = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'external.xlsx');
  return { native, owned: await workbookFromFile(bytes, 'own.xlsx'), external };
}

it('imports native CSE extents and recalculates scalar, matrix, and error results', async () => {
  const file = X.utils.book_new();
  X.utils.book_append_sheet(file, { '!ref': 'B3:J7',
    B3: { t: 'n', v: 21, f: 'SUM(ROW())', F: 'B3:D5' },
    F3: { t: 'n', v: 2, f: '{2,4;6,8}', F: 'F3:H5' },
    J3: { t: 'e', v: 7, f: '1/0', F: 'J3:J7' },
  }, 'Arrays');
  const wb = await workbookFromFile(X.write(file, { type: 'array', bookType: 'xlsx' }), 'native.xlsx');
  const id = wb.activeSheetId;
  expect(wb.getCell(id, 2, 1).array).toEqual({ rows: 3, cols: 3 });
  expect(wb.rangeValues(id, { r1: 2, c1: 1, r2: 4, c2: 3 })).toEqual([[12, 12, 12], [12, 12, 12], [12, 12, 12]]);
  expect(wb.getValue(id, 4, 7)).toEqual({ error: '#N/A' });
  expect(wb.getValue(id, 6, 9)).toEqual({ error: '#DIV/0!' });
});

it('exports fixed geometry, formulas, cached errors, and independent formats without dynamic metadata', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const range = { r1: 2, c1: 1, r2: 4, c2: 3 };
  wb.setArrayFormula(id, range, '={2,4;6,8}');
  wb.applyStyle(id, { r1: 2, c1: 1, r2: 2, c2: 1 }, { fmt: 'percent' });
  wb.applyStyle(id, { r1: 3, c1: 2, r2: 3, c2: 2 }, { fmt: 'number', dec: 2, bold: true });
  wb.setArrayFormula(id, { r1: 7, c1: 5, r2: 8, c2: 6 }, '=1/0');
  wb.setArrayFormula(id, { r1: 10, c1: 2, r2: 10, c2: 2 }, '=SUM({1,2})');
  const file = await roundTrip(wb), ws = file.native.Sheets[wb.activeSheet.name];
  expect(ws.B3).toMatchObject({ f: '{2,4;6,8}', F: 'B3:D5', v: 2 });
  expect(ws.B3.D).not.toBe(true);
  expect(ws.C4.z).toBe('#,##0.00');
  expect(ws.C3.z).toBe('General');
  expect(ws.D5).toMatchObject({ t: 'e', v: 42, F: 'B3:D5' });
  expect(ws.F8).toMatchObject({ t: 'e', v: 7, f: '1/0', F: 'F8:G9' });
  expect(ws.C11.F).toBe('C11');
  expect(ws.C11.D).not.toBe(true);
  for (const back of [file.owned, file.external]) {
    const bid = back.activeSheetId;
    expect(back.getCell(bid, 2, 1).array).toEqual({ rows: 3, cols: 3 });
    expect(back.getDisplay(bid, 2, 2)).toBe('4');
    expect(back.getDisplay(bid, 3, 2)).toBe('8.00');
    expect(back.getValue(bid, 8, 6)).toEqual({ error: '#DIV/0!' });
    expect(back.getCell(bid, 10, 2).array).toEqual({ rows: 1, cols: 1 });
    expect(back.setArrayFormula(bid, range, '=ROW()+COLUMN()')).toBe(true);
    expect(back.getValue(bid, 4, 3)).toBe(9);
  }
});

it('keeps native dynamic formulas resizable, including one-cell and blocked results', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 2, 2, '=SEQUENCE(A1)');
  wb.setInput(id, 2, 5, '=SEQUENCE(3)');
  wb.setInput(id, 3, 5, 'occupied');
  const file = await roundTrip(wb), ws = file.native.Sheets[wb.activeSheet.name];
  expect(ws.C3.D).toBe(true);
  expect(ws.F3.D).toBe(true);
  for (const back of [file.owned, file.external]) {
    const bid = back.activeSheetId;
    expect(back.getCell(bid, 2, 2).array).toBeUndefined();
    back.setInput(bid, 0, 0, '4');
    expect(back.getValue(bid, 5, 2)).toBe(4);
    expect(back.getValue(bid, 2, 5)).toEqual({ error: '#SPILL!' });
    back.clearRange(bid, { r1: 3, c1: 5, r2: 3, c2: 5 });
    expect(back.getValue(bid, 4, 5)).toBe(3);
  }
});

it('round-trips fixed and resizable ODS matrices with independent and inherited formats', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '2');
  wb.setInput(id, 2, 2, '=SEQUENCE(A1)');
  wb.setArrayFormula(id, { r1: 2, c1: 5, r2: 3, c2: 5 }, '=SEQUENCE(A1)');
  wb.setArrayFormula(id, { r1: 8, c1: 3, r2: 8, c2: 3 }, '=SUM({1,2})');
  for (const c of [2, 5]) wb.applyStyle(id, { r1: 2, c1: c, r2: 2, c2: c }, { fmt: 'percent', dec: 1 });
  const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
  const native = X.read(bytes, { type: 'array', cellNF: true });
  // The file names SEQUENCE as LibreOffice does (COM.MICROSOFT.SEQUENCE), which the reader gives back plain.
  expect(native.Sheets.Sheet1.F3).toMatchObject({ F: 'F3:F4', f: 'SEQUENCE(A1)' });
  expect(native.Sheets.Sheet1.D9).toMatchObject({ F: 'D9', f: 'SUM({1,2})' });
  const back = await workbookFromFile(bytes, 'matrices.ods'), bid = back.activeSheetId;
  expect(back.getCell(bid, 2, 2).array).toBeUndefined();
  expect(back.getCell(bid, 2, 5).array).toEqual({ rows: 2, cols: 1 });
  expect(back.getCell(bid, 8, 3).array).toEqual({ rows: 1, cols: 1 });
  expect(back.getValue(bid, 8, 3)).toBe(3);
  expect(back.getDisplay(bid, 3, 2)).toBe('200.0%');
  expect(back.getDisplay(bid, 3, 5)).toBe('2');
  back.setInput(bid, 0, 0, '4');
  expect(back.getValue(bid, 5, 2)).toBe(4);
  expect(back.getValue(bid, 5, 5)).toBeNull();

  // A reader without the private settings sees the native ODF fixed matrix.
  const zip = X.CFB.read(bytes, { type: 'array' });
  X.CFB.utils.cfb_del(zip, 'settings.xml');
  const foreign = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'foreign.ods');
  expect(foreign.getCell(foreign.activeSheetId, 2, 2).array).toEqual({ rows: 2, cols: 1 });
  expect(foreign.getDisplay(foreign.activeSheetId, 3, 2)).toBe('200.0%');
});

it.each(['formula', 'extent'])('ignores stale ODS dynamic-array settings after a native %s edit', async (change) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 2, 2, '=SEQUENCE(2)');
  wb.applyStyle(id, { r1: 2, c1: 2, r2: 2, c2: 2 }, { fmt: 'percent', dec: 1 });
  const zip = X.CFB.read(new Uint8Array(await (await workbookToOds(wb)).arrayBuffer()), { type: 'array' });
  const part = X.CFB.find(zip, 'content.xml');
  const xml = new TextDecoder().decode(part.content);
  const changed = change === 'formula' ? xml.replace('SEQUENCE(2)', 'SEQUENCE(3)')
    : xml.replace('table:number-matrix-rows-spanned="2"', 'table:number-matrix-rows-spanned="3"');
  expect(changed).not.toBe(xml);
  X.CFB.utils.cfb_add(zip, 'content.xml', new TextEncoder().encode(changed));
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'edited.ods');
  expect(back.getCell(back.activeSheetId, 2, 2).array).toEqual({ rows: change === 'formula' ? 2 : 3, cols: 1 });
  expect(back.getDisplay(back.activeSheetId, 3, 2)).toBe('200.0%');
});
