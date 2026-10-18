import { afterEach, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { setLocale } from '../src/core/format.js';
import * as X from '../src/vendor/xlsx.mjs';

afterEach(() => setLocale('en-US'));

// Equal to keeps an entry that reads as a date or a time as typed, so the same text in a cell matches, but no
// date cell ever did: Equal to 3/15/2024 painted nothing in a column of dates, while Greater than 3/15/2024
// read the date. Such an entry now also matches the cell holding that moment, in the app and in Excel.
const range = { r1: 0, c1: 0, r2: 6, c2: 0 };
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['3/14/2024', '3/15/2024', "'3/15/2024", '3/15/2024 12:00', '25:30', 'Jan 2024'].forEach((t, r) => wb.setInput(id, r, 0, t));
  wb.setCells(id, [{ r: 6, c: 0, cell: { v: 45366, f: null } }]);
  return { wb, id };
}
const painted = (wb, id) => [0, 1, 2, 3, 4, 5, 6].filter(r => wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0))?.bg);

it.each([
  ['eq', '3/15/2024', [1, 2, 6]], ['neq', '3/15/2024', [0, 3, 4, 5]], ['eq', '25:30', [4]], ['eq', 'Jan 2024', [5]], ['eq', 'abc', []],
])('%s %s matches the dates and times it names, and the same text', async (type, value, rows) => {
  const { wb, id } = book();
  wb.addRule(id, { type, value, range, style: { bg: '#ffcc00' } });
  expect(painted(wb, id)).toEqual(rows);
  // The rule as Excel reads it from the file (the app's own copy of its rules left out) paints the same cells.
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  part.size = part.content.length;
  const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'dates.xlsx');
  expect(back.activeSheet.rules[0].type).toBe('formula');
  expect(painted(back, back.activeSheetId)).toEqual(rows);
});

it('reads the date in the regional format it was typed in', () => {
  setLocale('de-DE');
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '15.03.2024');
  wb.addRule(id, { type: 'eq', value: '15.03.2024', range: { r1: 0, c1: 0, r2: 0, c2: 0 }, style: { bg: '#ffcc00' } });
  expect(wb.conditionalStyle(id, 0, 0, wb.getValue(id, 0, 0))?.bg).toBe('#ffcc00');
});
