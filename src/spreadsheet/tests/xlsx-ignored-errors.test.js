import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { parseRange } from '../src/core/cell.js';
import { MAX_ROW, MAX_COL } from '../src/core/refs.js';
import { IGNORED_ERROR_KEYS } from '../src/core/ignored-errors.js';
import { readXlsxIgnoredErrors, writeXlsxIgnoredErrors } from '../src/core/xlsx-ignored-errors.js';
import { clearRangeFlagsAtCells } from '../src/core/range-flags.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';

const flag = (ref, ...keys) => ({ range: parseRange(ref), keys });
const has = (wb, r, c, key = 'numberStoredAsText') => wb.activeSheet.ignoredErrors.some(x => x.keys.includes(key) && r >= x.range.r1 && r <= x.range.r2 && c >= x.range.c1 && c <= x.range.c2);
const book = () => new Workbook({ sheets: [{ name: 'Checks', cells: { '0,0': { v: '001' }, '1,0': { v: '002' }, '2,0': { v: '003' } }, ignoredErrors: [flag('A1:A3', 'numberStoredAsText')] }] });
async function saved(wb) {
  const data = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(data, { type: 'array' });
  const text = path => new TextDecoder().decode(X.CFB.find(zip, path).content);
  const xml = text('/xl/worksheets/sheet1.xml');
  X.CFB.utils.cfb_add(zip, '/xl/workbook.xml', new TextEncoder().encode(text('/xl/workbook.xml').replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
  return { own: await workbookFromFile(data, 'own.xlsx'), native: await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'native.xlsx'), xml };
}

it('reads all independent checks, disjoint references, booleans, namespaces and x14 references', () => {
  const xml = `<worksheet><ignoredErrors><ignoredError sqref="$B$2:C4 F7" ${IGNORED_ERROR_KEYS.map((k, i) => `${k}="${i % 2 ? 'true' : '1'}"`).join(' ')}/></ignoredErrors>
    <extLst><x14:ignoredErrors><x14:ignoredError formula = ' true ' evalError='false'><xm:sqref>J9 J11</xm:sqref></x14:ignoredError></x14:ignoredErrors></extLst></worksheet>`;
  const records = readXlsxIgnoredErrors(xml);
  expect(records).toHaveLength(4);
  expect(records.find(r => r.range.r1 === 1)).toEqual(flag('B2:C4', ...IGNORED_ERROR_KEYS));
  expect(records.find(r => r.range.r1 === 8)).toEqual(flag('J9', 'formula'));
  expect(readXlsxIgnoredErrors(writeXlsxIgnoredErrors('<worksheet/>'.replace('/>', '></worksheet>'), records))).toEqual(records);
});

it('rejects malformed ranges/checks and ignores comments, cell payloads and custom views', () => {
  const valid = '<ignoredErrors><ignoredError sqref="A1" evalError="1"/></ignoredErrors>';
  const bad = '<ignoredErrors><ignoredError sqref="A0 XFE1 A1048577 #REF! Sheet!B2 B2#" formula="1"/><ignoredError sqref="D3" evalError="yes" unknown="1"/></ignoredErrors>';
  expect(readXlsxIgnoredErrors(`<worksheet><!--${valid}--><sheetData>${valid}</sheetData><customSheetViews>${valid}</customSheetViews>${bad}</worksheet>`)).toEqual([]);
  const wb = new Workbook({ sheets: [{ ignoredErrors: [{ range: { r1: 0, c1: 0, r2: MAX_ROW + 1, c2: 0 }, keys: ['evalError'] }, flag('B2', 'unknown'), flag('C3', 'evalError', 'evalError')] }] });
  expect(wb.activeSheet.ignoredErrors).toEqual([flag('C3', 'evalError')]);
});

it('imports acknowledged checks and exports them natively without inventing blanket suppressions', async () => {
  const source = otherProgramsXlsx({ sheetXml: { Data: { rows: '<row r="1"><c r="A1" t="inlineStr"><is><t>001</t></is></c></row><row r="2"><c r="B2"><f>1+2</f><v>3</v></c></row>' } }, patch: {
    '/xl/worksheets/sheet1.xml': xml => xml.replace(/<ignoredErrors\b[\s\S]*?<\/ignoredErrors>/g, '').replace('</worksheet>', '<ignoredErrors><ignoredError sqref="B2 B6:B8" calculatedColumn="1" formula="1"/></ignoredErrors></worksheet>'),
  } });
  const wb = await workbookFromFile(source, 'checks.xlsx');
  const expected = [flag('B2', 'calculatedColumn', 'formula'), flag('B6:B8', 'calculatedColumn', 'formula')];
  expect(wb.activeSheet.ignoredErrors).toEqual(expected);
  const out = await saved(wb);
  for (const back of [out.own, out.native, new Workbook(wb.toJSON())]) {
    expect(back.activeSheet.ignoredErrors).toEqual(expected);
    expect(back.getValue(back.activeSheetId, 0, 0)).toBe('001');
    expect(back.getValue(back.activeSheetId, 1, 1)).toBe(3);
    expect(back.getCell(back.activeSheetId, 1, 1).f).toBe('1+2');
  }
  expect(out.xml).not.toContain('numberStoredAsText=');
  const blank = await saved(new Workbook());
  expect(blank.xml).not.toContain('ignoredError');
});

// Copying A1 does not copy its acknowledgement; replacing its
// contents clears it. Formatting leaves the reviewed content unchanged.
it('invalidates changed content without copying acknowledgements and restores it with undo', async () => {
  const wb = book(), id = wb.activeSheetId;
  wb.applyStyle(id, parseRange('A1'), { bold: true });
  expect(has(wb, 0, 0)).toBe(true);
  wb.pasteCells(id, wb.copyRange(id, parseRange('A1')), 0, 2);
  expect(has(wb, 0, 0)).toBe(true); expect(has(wb, 0, 2)).toBe(false);
  wb.setInput(id, 0, 0, "'004");
  expect(has(wb, 0, 0)).toBe(false); expect(has(wb, 1, 0)).toBe(true);
  wb.undo(); expect(has(wb, 0, 0)).toBe(true);
  wb.redo(); expect(has(wb, 0, 0)).toBe(false);
  const out = await saved(wb);
  expect(out.native.activeSheet.ignoredErrors).toEqual(wb.activeSheet.ignoredErrors);
});

it('clears both overwritten and cut content acknowledgements rather than moving them', () => {
  const wb = book(), id = wb.activeSheetId;
  wb.moveRange(id, parseRange('A1'), 1, 0);
  expect(has(wb, 0, 0)).toBe(false); expect(has(wb, 1, 0)).toBe(false); expect(has(wb, 2, 0)).toBe(true);
  wb.undo(); expect(wb.activeSheet.ignoredErrors).toEqual([flag('A1:A3', 'numberStoredAsText')]);
});

it('shifts acknowledged cells on insert/delete without marking newly inserted cells', () => {
  const wb = book(), id = wb.activeSheetId;
  wb.insertRows(id, 1, 2);
  expect([0, 1, 2, 3, 4].map(r => has(wb, r, 0))).toEqual([true, false, false, true, true]);
  wb.insertCols(id, 0, 2);
  expect(has(wb, 3, 2)).toBe(true); expect(has(wb, 3, 0)).toBe(false);
  wb.deleteRows(id, 0, 2);
  expect(has(wb, 1, 2)).toBe(true); expect(has(wb, 0, 2)).toBe(false);
  wb.undo(); wb.undo(); wb.undo();
  expect(wb.activeSheet.ignoredErrors).toEqual([flag('A1:A3', 'numberStoredAsText')]);
});

it('splits annotations when only part of their columns shifts, and retains them on sheet copies', () => {
  const wb = new Workbook({ sheets: [{ ignoredErrors: [flag('B2:D5', 'evalError', 'formula')] }] }), id = wb.activeSheetId;
  wb.insertCells(id, parseRange('C3:C4'));
  expect(has(wb, 2, 1, 'evalError')).toBe(true); expect(has(wb, 2, 2, 'evalError')).toBe(false); expect(has(wb, 5, 2, 'formula')).toBe(true);
  wb.deleteCells(id, parseRange('C3:C4'));
  expect(wb.activeSheet.ignoredErrors).toEqual([flag('B2:D5', 'evalError', 'formula')]);
  const expected = wb.activeSheet.ignoredErrors;
  wb.duplicateSheet(id);
  expect(wb.sheets[1].ignoredErrors).toEqual(expected);
  expect(wb.sheets[1].ignoredErrors).not.toBe(expected);
});

it('keeps full-sheet annotations sparse through large edits and export', async () => {
  const range = { r1: 0, c1: 0, r2: MAX_ROW, c2: MAX_COL };
  const records = [{ range, keys: ['evalError'] }];
  const cells = Array.from({ length: 20000 }, (_, r) => ({ r, c: 5 }));
  const after = clearRangeFlagsAtCells(records, cells);
  expect(after.length).toBeLessThanOrEqual(3);
  expect(records[0].range).toEqual(range);
  const wb = new Workbook({ sheets: [{ ignoredErrors: records }] });
  const out = await saved(wb);
  expect(wb.activeSheet.cells.size).toBe(0);
  expect(out.native.activeSheet.cells.size).toBe(0);
  expect(out.native.activeSheet.ignoredErrors).toEqual(records);
  expect(out.xml.length).toBeLessThan(5000);
});

it('accepts native changes and removal instead of reviving stale private settings', async () => {
  const wb = book();
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  for (const replacement of [[], [flag('E4:E5', 'formulaRange')]]) {
    const zip = X.CFB.read(bytes, { type: 'array' });
    const file = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
    X.CFB.utils.cfb_add(zip, '/xl/worksheets/sheet1.xml', new TextEncoder().encode(writeXlsxIgnoredErrors(new TextDecoder().decode(file.content), replacement)));
    const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'edited.xlsx');
    expect(back.activeSheet.ignoredErrors).toEqual(replacement);
  }
});


it('retains intentional calculated-column exceptions without altering templates or error values', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Input', 'Result'], [2, null], [3, null]].forEach((row, r) => row.forEach((v, c) => {
    if (v != null) wb.setInput(id, r, c, String(v));
  }));
  wb.addTable(id, parseRange('A1:B3'), { name: 'Samples' });
  wb.setInput(id, 1, 1, '=Samples[@Input]*2');
  // An exception in the calculated column, as a paste makes one (a formula typed there would rewrite the column).
  wb.setCells(id, [{ r: 2, c: 1, cell: { v: null, f: '1/0' } }]);
  wb.activeSheet.ignoredErrors = [flag('B3', 'calculatedColumn', 'evalError')];
  const out = await saved(wb);
  expect(out.native.activeSheet.tables[0].calc['1']).toBe('Samples[@Input]*2');
  expect(out.native.getCell(out.native.activeSheetId, 2, 1).f).toBe('1/0');
  expect(out.native.getValue(out.native.activeSheetId, 2, 1)).toEqual({ error: '#DIV/0!' });
  expect(out.native.activeSheet.ignoredErrors).toEqual(wb.activeSheet.ignoredErrors);
});

it('leaves acknowledgements intact when a protected edit is refused', () => {
  const wb = book(), id = wb.activeSheetId;
  wb.protectRange(id, parseRange('A1:A3'), 'Reviewed');
  wb.clearHistory();
  wb.setInput(id, 0, 0, '42');
  expect(wb.getValue(id, 0, 0)).toBe('001');
  expect(wb.activeSheet.ignoredErrors).toEqual([flag('A1:A3', 'numberStoredAsText')]);
  expect(wb.canUndo()).toBe(false);
});

it('clears cut whole-line acknowledgements while shifting untouched lines and restoring undo', () => {
  const wb = book(), id = wb.activeSheetId;
  wb.moveRows(id, 0, 1, 3);
  expect([0, 1, 2].map(r => has(wb, r, 0))).toEqual([true, true, false]);
  wb.undo();
  wb.moveCols(id, 0, 1, 3);
  expect(wb.activeSheet.ignoredErrors).toEqual([]);
  wb.undo();
  expect(wb.activeSheet.ignoredErrors).toEqual([flag('A1:A3', 'numberStoredAsText')]);
});
