import { expect, it } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { toFileFormula } from '../src/core/xlfn.js';

// A sheet named like a cell (FY2024, Q1), an R1C1 reference (R1C1) or a boolean must be quoted where a
// formula names it: Excel writes 'FY2024'!B2, and cannot read FY2024!B2, which it takes for a cell and
// a stray "!". This app reads the unquoted spelling, so a formula typed that way (=FY2024!B2) worked here
// and was saved as typed. It is now written quoted, as renaming a sheet already writes it.

it('quotes a sheet prefix that would read as something else, and only that', () => {
  expect(toFileFormula('FY2024!B2*2')).toBe("'FY2024'!B2*2");
  expect(toFileFormula('SUM(Q1!A1:A3,Data!B2)')).toBe("SUM('Q1'!A1:A3,Data!B2)");
  expect(toFileFormula('R1C1!A1+TRUE!A1+RC!A1')).toBe("'R1C1'!A1+'TRUE'!A1+'RC'!A1");
  expect(toFileFormula('SUM(Q1:Q4!A1)')).toBe("SUM('Q1:Q4'!A1)");
  expect(toFileFormula('A1!Rate*2')).toBe("'A1'!Rate*2");
  expect(toFileFormula('XLOOKUP(1,Q1!A:A,Q1!B:B)')).toBe("_xlfn.XLOOKUP(1,'Q1'!A:A,'Q1'!B:B)");
  // Names that read as names stay as they are, quoted or not.
  for (const f of ["'FY2024'!B2", 'Data!A:A', 'Übersicht!A1', 'Sheet1!1:2', 'SUM(Jan:Dec!A1)', "'My Sheet'!A1", '#REF!A1']) expect(toFileFormula(f)).toBe(f);
});

it('saves formulas typed with such names so that they open with the same values', async () => {
  const wb = new Workbook({ sheets: [{ name: 'Summary' }, { name: 'FY2024' }, { name: 'Q1' }] });
  const [summary, fy, q1] = wb.sheets;
  wb.setInput(fy.id, 1, 1, '120');
  wb.setInput(q1.id, 0, 0, '7');
  wb.setInput(summary.id, 0, 0, '=FY2024!B2*2');
  wb.setInput(summary.id, 1, 0, '=SUM(Q1!A1,FY2024!B2)');
  expect([wb.getValue(summary.id, 0, 0), wb.getValue(summary.id, 1, 0)]).toEqual([240, 127]);
  const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
  const sheetXml = new TextDecoder().decode(X.CFB.find(X.CFB.read(bytes, { type: 'array' }), '/xl/worksheets/sheet1.xml').content);
  expect(sheetXml).toContain('<f>&apos;FY2024&apos;!B2*2</f>');
  expect(sheetXml).toContain('<f>SUM(&apos;Q1&apos;!A1,&apos;FY2024&apos;!B2)</f>');
  const back = await workbookFromFile(bytes, 'summary.xlsx');
  const id = back.sheets[0].id;
  expect([back.getValue(id, 0, 0), back.getValue(id, 1, 0)]).toEqual([240, 127]);
});
