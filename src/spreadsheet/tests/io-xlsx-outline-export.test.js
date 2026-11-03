import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// Row and column groups made here travelled only in this app's settings sheet, so a grouped sheet opened in
// Excel with no outline: no levels on its rows and columns, nothing to expand a collapsed group by. They are
// now written as Excel writes them: outline levels on the lines, collapsed="1" on a collapsed group's summary
// line, and the deepest levels on sheetFormatPr.
async function saved(wb) {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const text = (path) => new TextDecoder().decode(X.CFB.find(zip, path).content);
  return { zip, sheet: text('/xl/worksheets/sheet1.xml'), workbook: text('/xl/workbook.xml') };
}

function grouped() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 12; r++) wb.setInput(id, r, 0, String(r));
  wb.groupLines(id, 'row', 1, 8);
  wb.groupLines(id, 'row', 2, 4);
  wb.toggleGroup(id, 'row', 2, 4);
  wb.groupLines(id, 'col', 2, 3);
  wb.toggleGroup(id, 'col', 2, 3);
  return wb;
}

it('writes row and column groups as Excel outline levels', async () => {
  const { sheet } = await saved(grouped());
  const level = (r) => sheet.match(new RegExp(`<row r="${r}"[^>]*>`))[0].match(/outlineLevel="(\d)"/)?.[1] ?? null;
  expect([1, 2, 3, 4, 5, 6, 9, 10].map(level)).toEqual([null, '1', '2', '2', '2', '1', '1', null]);
  expect(sheet).toMatch(/<row r="6"[^>]*collapsed="1"/);
  expect(sheet).toMatch(/<col min="3" max="4"[^>]*hidden="1"[^>]*outlineLevel="1"/);
  expect(sheet).toMatch(/<col min="5" max="5"[^>]*collapsed="1"/);
  expect(sheet).toMatch(/<sheetFormatPr\b[^>]*outlineLevelRow="2" outlineLevelCol="1"/);
});

it('gives a reader without this app\'s settings sheet the same groups', async () => {
  const wb = grouped();
  const { zip, workbook } = await saved(wb);
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(workbook.replace(/<sheet name="_puter_meta"[^>]*\/>/, ''));
  part.size = part.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'grouped.xlsx');
  expect(back.sheets[0].groups).toEqual(wb.activeSheet.groups);
  expect([...back.sheets[0].hiddenRows]).toEqual([2, 3, 4]);
});

it('puts a collapsed group\'s mark above it where summary rows sit above their detail', async () => {
  const wb = grouped();
  wb.setOutlineSettings(wb.activeSheetId, { summaryBelow: false });
  const { sheet } = await saved(wb);
  expect(sheet).toMatch(/<row r="2"[^>]*collapsed="1"/);
  expect(sheet).not.toMatch(/<row r="6"[^>]*collapsed="1"/);
});

it('stops a group of every row at the sheet\'s last row, rather than writing a million empty rows', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'title');
  wb.groupLines(id, 'row', 1, 1048575);
  const { sheet } = await saved(wb);
  const rows = sheet.match(/<row [^>]*outlineLevel="1"/g) || [];
  expect(rows.length).toBe(wb.activeSheet.rows - 1);
  const back = await workbookFromFile(await workbookToXlsx(wb), 'whole.xlsx');
  expect(back.activeSheet.groups.rows).toEqual([{ from: 1, to: 1048575, collapsed: false }]);
});
