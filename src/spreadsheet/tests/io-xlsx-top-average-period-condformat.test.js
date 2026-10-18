import { afterEach, expect, it, vi } from 'vitest';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { todaySerialUTC } from '../src/core/condformat.js';
import { otherProgramsXlsx } from './helpers/xlsx-fixture.js';
import * as X from '../src/vendor/xlsx.mjs';

// Excel's Top 10, Above Average and A Date Occurring rules, as Excel saves them.
afterEach(() => vi.useRealTimers());
const values = [4, 9, 1, 7, 'x', 3, 10, null, 6, 2, 8, 5];
const rows = values.map((v, i) => `<row r="${i + 2}">${v == null ? '' : typeof v === 'number'
  ? `<c r="A${i + 2}"><v>${v}</v></c>` : `<c r="A${i + 2}" t="inlineStr"><is><t>${v}</t></is></c>`}</row>`).join('');
const fill = { '/xl/styles.xml': xml => xml.replace(/<dxfs[^>]*(?:\/>|>[\s\S]*?<\/dxfs>)/,
  '<dxfs count="1"><dxf><fill><patternFill><bgColor rgb="FFB6E6AD"/></patternFill></fill></dxf></dxfs>') };
async function imported(rule, sheetRows = rows, sqref = 'A2:A13') {
  return workbookFromFile(otherProgramsXlsx({
    sheetXml: { Data: { rows: sheetRows, tail: `<conditionalFormatting sqref="${sqref}">${rule}</conditionalFormatting>` } },
    patch: fill,
  }), 'excel.xlsx');
}
const painted = (wb, count = values.length) => {
  const id = wb.activeSheetId, out = [];
  for (let r = 1; r <= count; r++) if (wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0))?.bg) out.push(wb.getValue(id, r, 0));
  return out.sort((a, b) => a - b);
};
async function reopened(wb) {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  part.content = new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
  part.size = part.content.length;
  return workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }), 'again.xlsx');
}

it.each([
  ['expression', '<cfRule type="expression" dxfId="0" priority="1"><formula>AND(ISNUMBER(A2),A2&gt;8)</formula></cfRule>', [9, 10]],
  ['top 3', '<cfRule type="top10" dxfId="0" priority="1" rank="3"/>', [8, 9, 10]],
  ['bottom 2', '<cfRule type="top10" dxfId="0" priority="1" bottom="1" rank="2"/>', [1, 2]],
  ['above average', '<cfRule type="aboveAverage" dxfId="0" priority="1"/>', [6, 7, 8, 9, 10]],
  ['below average', '<cfRule type="aboveAverage" dxfId="0" priority="1" aboveAverage="0"/>', [1, 2, 3, 4, 5]],
])('reads the %s rule of an Excel file and paints the same cells after saving', async (_label, rule, expected) => {
  const wb = await imported(rule);
  expect(wb.activeSheet.rules).toHaveLength(1);
  expect(painted(wb)).toEqual(expected);
  expect(painted(await reopened(wb))).toEqual(expected);
});

it('ranks and averages over every area of a split range', async () => {
  expect(painted(await imported('<cfRule type="top10" dxfId="0" priority="1" rank="3"/>', rows, 'A2:A7 A8:A13'))).toEqual([8, 9, 10]);
  expect(painted(await imported('<cfRule type="aboveAverage" dxfId="0" priority="1"/>', rows, 'A2:A7 A8:A13'))).toEqual([6, 7, 8, 9, 10]);
});

it('reads equal-or-above and equal-or-below average rules', async () => {
  const flat = [1, 2, 3].map((v, i) => `<row r="${i + 2}"><c r="A${i + 2}"><v>${v}</v></c></row>`).join('');
  expect(painted(await imported('<cfRule type="aboveAverage" dxfId="0" priority="1" equalAverage="1"/>', flat, 'A2:A4'), 3)).toEqual([2, 3]);
  expect(painted(await imported('<cfRule type="aboveAverage" dxfId="0" priority="1" aboveAverage="0" equalAverage="1"/>', flat, 'A2:A4'), 3)).toEqual([1, 2]);
});

it('reads a date-occurring rule through the formula Excel saves with it', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 0, 5, 12));
  const today = todaySerialUTC();
  const dates = [today - 2, today - 1, today - 1 + 0.75, today, today + 1];
  const dateRows = dates.map((v, i) => `<row r="${i + 2}"><c r="A${i + 2}"><v>${v}</v></c></row>`).join('');
  const wb = await imported('<cfRule type="timePeriod" dxfId="0" priority="1" timePeriod="yesterday"><formula>FLOOR(A2,1)=TODAY()-1</formula></cfRule>', dateRows, 'A2:A6');
  expect(painted(wb, dates.length)).toEqual([today - 1, today - 1 + 0.75]);
});
