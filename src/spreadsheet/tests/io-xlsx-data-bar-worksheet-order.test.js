import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

// A data bar is written with an extension list of its own inside its rule (the id of its Excel 2010
// settings). Page setup, ignored errors and sparklines were placed before the first extension list in
// the sheet, which was that rule's: inside the conditional format, where Excel repairs the file and
// drops them, and where this app's own reader did not find the sparklines either.
it('writes page setup, ignored errors and sparklines after the rules of a sheet with a data bar', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const cells = [];
  for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) cells.push({ r, c, cell: { v: r * 10 + c } });
  cells.push({ r: 0, c: 6, cell: { v: '001' } });
  wb.setCells(id, cells);
  wb.addRule(id, { range: parseRange('B1:B6'), type: 'databar', style: {}, barColor: '#a7d9b5' });
  expect(wb.createNativeSparklines(id, { source: 'A1:D1', location: 'E1' })).toBeNull();
  wb.ignoreErrors(id, [parseRange('G1')], 'numberStoredAsText');
  wb.setPageBreaks(id, { rows: [3], cols: [] });

  const data = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const zip = X.CFB.read(data, { type: 'array' });
  const xml = new TextDecoder().decode(X.CFB.find(zip, '/xl/worksheets/sheet1.xml').content);
  // Every rule closes before the worksheet's next children begin.
  const lastRule = xml.lastIndexOf('</conditionalFormatting>');
  for (const tag of ['<pageMargins', '<pageSetup', '<rowBreaks', '<ignoredErrors', '<x14:sparklineGroups']) {
    expect(xml.indexOf(tag), tag).toBeGreaterThan(lastRule);
  }
  for (const rule of xml.match(/<cfRule\b[\s\S]*?<\/cfRule>/g)) expect(rule).not.toMatch(/sparkline|pageSetup|ignoredError/);

  const back = (await workbookFromFile(data, 'bars.xlsx')).activeSheet;
  expect(back.sparklineGroups).toHaveLength(1);
  expect(back.rules).toHaveLength(1);
  expect(back.ignoredErrors).toHaveLength(1);
  expect(back.printSettings.rowBreaks).toEqual([3]);
});
