import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// HYPERLINK("#Sheet!A1", …) names its sheet inside a string, where a double quote is written twice. Renaming
// the linked sheet to a name holding a double quote (Excel allows one, as in 12" pipes) wrote it once, ending
// the string early: the formula broke into #ERROR! and the link was gone. A link already written correctly to
// such a sheet was not recognised either, so renaming that sheet left the link pointing at a missing sheet.
describe('renaming a sheet linked by HYPERLINK to a name with a double quote', () => {
  it('keeps the formula and its link working, both ways', () => {
    const wb = new Workbook();
    const main = wb.activeSheetId;
    const pipes = wb.addSheet('Pipes').id;
    wb.setInput(main, 0, 0, '=HYPERLINK("#Pipes!B2","Go")');
    wb.renameSheet(pipes, '12" pipes');
    expect(wb.getCell(main, 0, 0).f).toBe('HYPERLINK("#\'12"" pipes\'!B2","Go")');
    expect(wb.getValue(main, 0, 0)).toBe('Go');
    expect(wb.linkAt(main, 0, 0)?.url).toBe('#\'12" pipes\'!B2');
    expect(wb.resolveLink(wb.linkAt(main, 0, 0).url, main)).toMatchObject({ sheetId: pipes });
    wb.renameSheet(pipes, 'Tubes');
    expect(wb.getCell(main, 0, 0).f).toBe('HYPERLINK("#Tubes!B2","Go")');
  });
});
