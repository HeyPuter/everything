// @vitest-environment jsdom
import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { cellsToHtml, parseHtmlClipboard, cellsFromHtmlRows } from '../src/core/clipboard.js';
import { Workbook, safeSheetName } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx, workbookToOds } from '../src/core/io.js';

const names = ['Data', ' Data', 'Data ', 'Data  set', 'Data set', ' 雪\u00a0 ', ' '];
const quote = name => `'${name.replace(/'/g, "''")}'`;
function source() {
  const book = X.utils.book_new();
  for (const [i, name] of names.entries()) X.utils.book_append_sheet(book, { A1: { t: 'n', v: i + 1 }, '!ref': 'A1' }, name);
  const summary = { '!ref': `A1:B${names.length}` };
  names.forEach((name, i) => {
    summary[`A${i + 1}`] = { t: 'n', v: i + 1, f: `${quote(name)}!A1` };
    summary[`B${i + 1}`] = { t: 'n', v: i + 1, f: `INDIRECT("${quote(name)}!A1")` };
  });
  X.utils.book_append_sheet(book, summary, 'Summary');
  return X.write(book, { type: 'array', bookType: 'xlsx' });
}
function verify(wb) {
  expect(wb.sheets.map(s => s.name)).toEqual([...names, 'Summary']);
  for (let i = 0; i < names.length; i++) {
    expect(wb.getValue(wb.sheets.at(-1).id, i, 0)).toBe(i + 1);
    expect(wb.getValue(wb.sheets.at(-1).id, i, 1)).toBe(i + 1);
  }
}

it('preserves distinct valid whitespace names and literal references on native import', async () => {
  verify(await workbookFromFile(source(), 'names.xlsx'));
  for (const name of names) expect(safeSheetName(name, names.filter(n => n !== name))).toBe(name);
});

it.each(['xlsx', 'ods'])('preserves exact names through edits and metadata-free %s export', async format => {
  const wb = await workbookFromFile(source(), 'names.xlsx');
  wb.setInput(wb.sheets[2].id, 0, 0, '27');
  const blob = await (format === 'xlsx' ? workbookToXlsx(wb) : workbookToOds(wb, { settings: false }));
  const bytes = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsArrayBuffer(blob); });
  const zip = X.CFB.read(new Uint8Array(bytes), { type: 'array' });
  if (format === 'xlsx') {
    const part = X.CFB.find(zip, '/xl/workbook.xml');
    part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
    part.size = part.content.length;
  }
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), `names.${format}`);
  expect(back.sheets.map(s => s.name)).toEqual([...names, 'Summary']);
  expect(back.getValue(back.sheets.at(-1).id, 2, 0)).toBe(27);
  expect(back.getValue(back.sheets.at(-1).id, 2, 1)).toBe(27);
});

it('uses the same exact names for adding, renaming, lookup, duplication and undo', () => {
  const wb = new Workbook(), summary = wb.activeSheetId;
  for (const name of names) expect(wb.addSheet(name).name).toBe(name);
  expect(wb.validateSheetName('DATA ')).toMatch(/already exists/);
  expect(wb.validateSheetName('  Data')).toBeNull();
  const target = wb.sheetByName('Data ');
  wb.setInput(target.id, 0, 0, '9');
  wb.setInput(summary, 0, 0, "='Data '!A1");
  expect(wb.renameSheet(target.id, '  New  ')).toBe(true);
  expect(wb.getCell(summary, 0, 0).f).toBe("'  New  '!A1");
  expect(wb.getValue(summary, 0, 0)).toBe(9);
  wb.undo();
  expect(wb.sheetByName('Data ').id).toBe(target.id);
  expect(wb.getValue(summary, 0, 0)).toBe(9);
  expect(wb.duplicateSheet(target.id).name).toBe('Data  (2)');
});

it('still sanitizes invalid names without making truncation produce invalid endings', () => {
  const wb = new Workbook();
  for (const name of ['x'.repeat(30) + "'tail", 'x'.repeat(30) + '😀', "''", 'Bad/Name', 'History']) {
    expect(wb.validateSheetName(safeSheetName(name), wb.activeSheetId)).toBeNull();
  }
  expect(safeSheetName(' Data ', [' data '])).toBe(' Data  2');
});


it('retains exact quoted names in rich clipboard formulas and exports typed values', async () => {
  const wb = await workbookFromFile(source(), 'names.xlsx'), id = wb.sheets.at(-1).id;
  const range = { r1: 2, c1: 0, r2: 2, c2: 1 }, values = wb.rangeValues(id, range);
  const html = cellsToHtml([values[0].map(String)], wb.copyRange(id, range), null, values);
  const rich = parseHtmlClipboard(html);
  wb.pasteCells(id, rich.cells, 2, 0, { r: 2, c: 0 });
  expect(wb.getCell(id, 2, 0).f).toBe("'Data '!A1");
  expect(wb.getCell(id, 2, 1).f).toBe(`@INDIRECT("'Data '!A1")`);
  expect(wb.getValue(id, 2, 1)).toBe(3);
  const external = cellsFromHtmlRows(parseHtmlClipboard(html.replace(/ data-spreadsheet-[\w-]+="[^"]*"/g, '')).rows);
  expect(external.map(c => c.cell.v)).toEqual([3, 3]);
});
