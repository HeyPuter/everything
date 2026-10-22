import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx, workbookToOds } from '../src/core/io.js';

const str = (t) => `<c t="inlineStr"><is><t>${t}</t></is></c>`;
const num = (n) => `<c><v>${n}</v></c>`;
/** A sheet part with the given rows (each a list of cell XML, `hidden` rows marked) and an autoFilter element. */
function sheetXml(rows, filterBody, ref = `A1:${X.utils.encode_col(rows[0].cells.length - 1)}${rows.length}`) {
  const data = rows.map((row, i) => `<row r="${i + 1}"${row.hidden ? ' hidden="1"' : ''}>${row.cells.map((c, j) => c.replace('<c', `<c r="${X.utils.encode_cell({ r: i, c: j })}"`)).join('')}</row>`).join('');
  return `<sheetData>${data}</sheetData><autoFilter ref="${ref}">${filterBody}</autoFilter>`;
}
async function open(xml) {
  const book = X.utils.book_new();
  X.utils.book_append_sheet(book, X.utils.aoa_to_sheet([['x']]), 'Data');
  const zip = X.CFB.read(new Uint8Array(X.write(book, { type: 'array', bookType: 'xlsx' })), { type: 'array' });
  const entry = X.CFB.find(zip, '/xl/worksheets/sheet1.xml');
  entry.content = new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${xml}</worksheet>`);
  entry.size = entry.content.length;
  return workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'filtered.xlsx');
}
const regions = [
  { cells: [str('Region'), str('Amt')] },
  { cells: [str('East'), num(1)] },
  { cells: [str('West'), num(2)], hidden: true },
  { cells: [str('East'), num(3)] },
];
const hidden = (wb) => [...wb.activeSheet.filterHidden].sort((a, b) => a - b);
const manual = (wb) => [...wb.activeSheet.hiddenRows].sort((a, b) => a - b);

it('imports a value filter and treats the rows it hid as filtered, so clearing the filter shows them again', async () => {
  const wb = await open(sheetXml(regions, '<filterColumn colId="0"><filters><filter val="East"/></filters></filterColumn>'));
  const id = wb.activeSheetId;
  expect(wb.activeSheet.filter).toEqual({ range: { r1: 0, c1: 0, r2: 3, c2: 1 }, criteria: { 0: { caseSensitive: false, values: ['East'] } } });
  expect(hidden(wb)).toEqual([2]);
  expect(manual(wb)).toEqual([]);
  wb.setFilterCriteria(id, 0, { values: ['West'] });
  expect(hidden(wb)).toEqual([1, 3]);
  wb.clearFilter(id);
  expect(hidden(wb)).toEqual([]);
  expect(wb.isRowHidden(id, 2)).toBe(false);
});

it.each([
  ['<customFilters><customFilter operator="greaterThan" val="5"/></customFilters>', { op: 'gt', value: 5 }],
  ['<customFilters><customFilter operator="lessThanOrEqual" val="-2.5"/></customFilters>', { op: 'lte', value: -2.5 }],
  ['<customFilters><customFilter operator="equal" val="7"/></customFilters>', { op: 'eq', value: 7 }],
  ['<customFilters><customFilter operator="notEqual" val="yes"/></customFilters>', { op: 'neq', value: 'yes' }],
  ['<customFilters><customFilter val="*ab*"/></customFilters>', { op: 'contains', value: 'ab' }],
  ['<customFilters><customFilter operator="notEqual" val="*ab*"/></customFilters>', { op: 'notContains', value: 'ab' }],
  ['<customFilters><customFilter val="ab*"/></customFilters>', { op: 'beginsWith', value: 'ab' }],
  ['<customFilters><customFilter val="*ab"/></customFilters>', { op: 'endsWith', value: 'ab' }],
  ['<customFilters><customFilter val="*a~*b~~*"/></customFilters>', { op: 'contains', value: 'a*b~' }],
  ['<customFilters and="1"><customFilter operator="greaterThanOrEqual" val="2"/><customFilter operator="lessThanOrEqual" val="9"/></customFilters>', { op: 'between', value: 2, value2: 9 }],
  ['<customFilters><customFilter operator="notEqual" val=" "/></customFilters>', { op: 'notEmpty' }],
  ['<filters blank="1"/>', { caseSensitive: false, values: [''] }],
  ['<filters blank="1"><filter val="a &amp; b"/><filter val="1,234.50"/></filters>', { caseSensitive: false, values: ['a & b', '1,234.50', ''] }],
])('imports the custom filter %s as %j', async (column, criterion) => {
  const wb = await open(sheetXml(regions, `<filterColumn colId="1">${column}</filterColumn>`));
  expect(wb.activeSheet.filter.criteria).toEqual({ 1: criterion });
});

it('retains the saved filtered view until its live condition is reapplied', async () => {
  const wb = await open(sheetXml(regions, '<filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="1"/></customFilters></filterColumn>'));
  expect(hidden(wb)).toEqual([2]);
  wb.reapplyFilter(wb.activeSheetId);
  expect(hidden(wb)).toEqual([1]);
  wb.setInput(wb.activeSheetId, 1, 1, '9');
  wb.reapplyFilter(wb.activeSheetId);
  expect(hidden(wb)).toEqual([]);
});

// A condition the app has no criterion for is kept as the file wrote it ({ native }, written back unchanged; see
// io-xlsx-filter-kept-conditions.test.js), and the rows the file's filter hid stay hidden as the filter's.
it.each([
  ['<filterColumn colId="0"><top10 val="1"/></filterColumn>', { 0: { native: '<top10 val="1"/>' } }],
  ['<filterColumn colId="0"><dynamicFilter type="aboveAverage"/></filterColumn>', { 0: { native: '<dynamicFilter type="aboveAverage"/>' } }],
  ['<filterColumn colId="0"><filters><dateGroupItem year="2024" dateTimeGrouping="year"/></filters></filterColumn>', { 0: { native: '<filters><dateGroupItem year="2024" dateTimeGrouping="year"/></filters>' } }],
  ['<filterColumn colId="0"><customFilters><customFilter val="a*b"/></customFilters></filterColumn>', { 0: { native: '<customFilters><customFilter val="a*b"/></customFilters>' } }],
  ['<filterColumn colId="0"><customFilters><customFilter val="a"/><customFilter val="b"/></customFilters></filterColumn>', { 0: { native: '<customFilters><customFilter val="a"/><customFilter val="b"/></customFilters>' } }],
])('keeps a condition the app has no criterion for as the file wrote it, with the rows it hid: %s', async (columns, criteria) => {
  const wb = await open(sheetXml(regions, columns));
  expect(wb.activeSheet.filter).toEqual({ range: { r1: 0, c1: 0, r2: 3, c2: 1 }, criteria });
  expect(hidden(wb)).toEqual([2]);
  expect(manual(wb)).toEqual([]);
});

// One the app cannot judge at all (a colour it has no fill for, an icon) is kept too, but the rows the file hid stay
// hidden by hand: the filter's own, they would all come back whenever the filter ran again (a row inserted anywhere).
it.each([
  ['<filterColumn colId="0"><colorFilter dxfId="1"/></filterColumn>', { 0: { native: '<colorFilter dxfId="1"/>' } }],
  ['<filterColumn colId="0"><filters><filter val="East"/></filters></filterColumn><filterColumn colId="1"><iconFilter iconSet="3Arrows"/></filterColumn>',
    { 0: { caseSensitive: false, values: ['East'] }, 1: { native: '<iconFilter iconSet="3Arrows"/>' } }],
])('keeps a condition the app cannot judge as the file wrote it, with the rows it hid as hidden by hand: %s', async (columns, criteria) => {
  const wb = await open(sheetXml(regions, columns));
  expect(wb.activeSheet.filter).toEqual({ range: { r1: 0, c1: 0, r2: 3, c2: 1 }, criteria });
  expect(hidden(wb)).toEqual([]);
  expect(manual(wb)).toEqual([2]);
});

it('keeps the filter range and the file\'s hidden rows when a condition names a column outside it', async () => {
  const wb = await open(sheetXml(regions, '<filterColumn colId="5"><filters><filter val="East"/></filters></filterColumn>'));
  expect(wb.activeSheet.filter).toEqual({ range: { r1: 0, c1: 0, r2: 3, c2: 1 }, criteria: {} });
  expect(hidden(wb)).toEqual([]);
  expect(manual(wb)).toEqual([2]);
});

it('keeps a hidden row outside the filter range, and one inside a filter without conditions, as hidden by hand', async () => {
  const rows = [...regions, { cells: [str('North'), num(4)], hidden: true }];
  const wb = await open(sheetXml(rows, '<filterColumn colId="0"><filters><filter val="East"/></filters></filterColumn>', 'A1:B4'));
  expect(hidden(wb)).toEqual([2]);
  expect(manual(wb)).toEqual([4]);
  const plain = await open(sheetXml(regions, ''));
  expect(plain.activeSheet.filter).toEqual({ range: { r1: 0, c1: 0, r2: 3, c2: 1 }, criteria: {} });
  expect(manual(plain)).toEqual([2]);
});

function filtered(criteria) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Amt'], ['East', 1], ['West', 2], ['East', 3], ['North', 4]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 4, c2: 1 });
  for (const [col, crit] of Object.entries(criteria)) wb.setFilterCriteria(id, Number(col), crit);
  wb.setHidden(id, 'row', [4], true);
  return wb;
}
async function sheetPart(wb) {
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(bytes, { type: 'array' });
  return { bytes, zip, xml: new TextDecoder().decode(X.CFB.find(zip, '/xl/worksheets/sheet1.xml').content) };
}

it.each([
  [{ 0: { values: ['East'] } }, '<filterColumn colId="0"><filters><filter val="East"/></filters></filterColumn>'],
  [{ 0: { values: ['East', ''] } }, '<filterColumn colId="0"><filters blank="1"><filter val="East"/></filters></filterColumn>'],
  [{ 1: { op: 'gt', value: 1 } }, '<filterColumn colId="1"><customFilters><customFilter operator="greaterThan" val="1"/></customFilters></filterColumn>'],
  [{ 1: { op: 'between', value: 3, value2: 1 } }, '<filterColumn colId="1"><customFilters and="1"><customFilter operator="greaterThanOrEqual" val="1"/><customFilter operator="lessThanOrEqual" val="3"/></customFilters></filterColumn>'],
  [{ 0: { op: 'contains', value: 'a*t' } }, '<filterColumn colId="0"><customFilters><customFilter operator="equal" val="*a~*t*"/></customFilters></filterColumn>'],
  [{ 0: { op: 'notContains', value: 'st' } }, '<filterColumn colId="0"><customFilters><customFilter operator="notEqual" val="*st*"/></customFilters></filterColumn>'],
  [{ 0: { op: 'beginsWith', value: 'E' } }, '<filterColumn colId="0"><customFilters><customFilter operator="equal" val="E*"/></customFilters></filterColumn>'],
  [{ 0: { op: 'eq', value: 'east' } }, '<filterColumn colId="0"><customFilters><customFilter operator="equal" val="east"/></customFilters></filterColumn>'],
  [{ 0: { op: 'notEmpty' } }, '<filterColumn colId="0"><customFilters><customFilter operator="notEqual" val=" "/></customFilters></filterColumn>'],
  [{ 0: { op: 'empty' } }, '<filterColumn colId="0"><filters blank="1"/></filterColumn>'],
  [{ 0: { text: 'es' } }, '<filterColumn colId="0"><customFilters><customFilter operator="equal" val="*es*"/></customFilters></filterColumn>'],
])('writes the criteria %j into the autoFilter element for other programs', async (criteria, expected) => {
  const wb = filtered(criteria);
  const { xml } = await sheetPart(wb);
  expect(xml).toContain(`<autoFilter ref="A1:B5">${expected}</autoFilter>`);
});

it('writes the rows the filter hides as hidden rows, and reads them back as filtered rather than hidden by hand', async () => {
  const wb = filtered({ 0: { values: ['East'] } });
  expect(hidden(wb)).toEqual([2, 4]);
  const { bytes, zip, xml } = await sheetPart(wb);
  expect(xml).toMatch(/<row r="3"[^>]*hidden="1"/);
  expect(xml).toMatch(/<row r="5"[^>]*hidden="1"/);
  expect(xml).not.toMatch(/<row r="2"[^>]*hidden="1"/);
  // Reopened here, with the sidecar: the filter and the by-hand hide are told apart as before.
  const back = await workbookFromFile(bytes, 'saved.xlsx');
  expect(back.activeSheet.filter.criteria).toEqual({ 0: { values: ['East'] } });
  expect(hidden(back)).toEqual([2, 4]);
  expect(manual(back)).toEqual([4]);
  back.clearFilter(back.activeSheetId);
  expect(back.isRowHidden(back.activeSheetId, 2)).toBe(false);
  expect(back.isRowHidden(back.activeSheetId, 4)).toBe(true);
  // Reopened from the file alone, as another program would hand it back: the conditions come from the autoFilter.
  X.CFB.utils.cfb_del(zip, '/xl/worksheets/sheet2.xml');
  const workbook = X.CFB.find(zip, '/xl/workbook.xml');
  workbook.content = new TextEncoder().encode(new TextDecoder().decode(workbook.content).replace(/<sheet name="_puter_meta"[^>]*\/>/, ''));
  workbook.size = workbook.content.length;
  const native = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'native.xlsx');
  expect(native.activeSheet.filter.criteria).toEqual({ 0: { caseSensitive: false, values: ['East'] } });
  expect(hidden(native)).toEqual([2, 4]);
  native.clearFilter(native.activeSheetId);
  expect(hidden(native)).toEqual([]);
});

it('leaves a formula criterion out of the autoFilter element, keeping it in the sidecar', async () => {
  const wb = filtered({ 1: { formula: '=B2>1' } });
  const { bytes, xml } = await sheetPart(wb);
  expect(xml).toContain('<autoFilter ref="A1:B5"/>');
  const back = await workbookFromFile(bytes, 'saved.xlsx');
  expect(back.activeSheet.filter.criteria).toEqual({ 1: { formula: '=B2>1' } });
  expect(hidden(back)).toEqual([1]);
});

it('writes the rows an .ods filter hides with the filter visibility, apart from rows hidden by hand', async () => {
  const wb = filtered({ 0: { values: ['East'] } });
  const bytes = new Uint8Array(await (await workbookToOds(wb)).arrayBuffer());
  const content = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), 'content.xml').content);
  const rows = [...content.matchAll(/<table:table-row\b[^>]*>/g)].map((m) => m[0]);
  expect(rows[2]).toContain('table:visibility="filter"');
  expect(rows[4]).toContain('table:visibility="collapse"');
  expect(rows[1]).not.toContain('table:visibility');
  const back = await workbookFromFile(bytes, 'saved.ods');
  expect(hidden(back)).toEqual([2, 4]);
  expect(manual(back)).toEqual([4]);
});

it('reapplies native value lists without case distinctions and retains literal punctuation and accents', async () => {
  const rows = ['Header', 'Alpha*?', 'ALPHA*?', 'alphaXX', 'álpha*?', 'Alpha*? '].map(t => ({ cells: [str(t)] }));
  let wb = await open(sheetXml(rows, '<filterColumn colId="0"><filters><filter val="alpha*?"/></filters></filterColumn>'));
  for (let pass = 0; pass < 2; pass++) {
    wb.reapplyFilter(wb.activeSheetId);
    expect(hidden(wb)).toEqual([3, 4, 5]);
    expect(wb.filterValues(wb.activeSheetId, 0).find(i => i.value === 'Alpha*?')).toEqual({ value: 'Alpha*?', count: 2 });
    const { zip } = await sheetPart(wb);
    const part = X.CFB.find(zip, '/xl/workbook.xml');
    part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
    part.size = part.content.length;
    wb = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'native.xlsx');
  }
  wb.setInput(wb.activeSheetId, 3, 0, 'aLpHa*?'); wb.reapplyFilter(wb.activeSheetId);
  expect(hidden(wb)).toEqual([4, 5]);
});
