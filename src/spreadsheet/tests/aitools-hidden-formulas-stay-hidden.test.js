import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';
import { workbookSnapshot } from '../src/core/aiagent.js';

// A formula hidden by the sheet's protection (Format Cells ▸ Protection ▸ Hidden) is kept from the formula bar, Find
// and the Watch Window, but the assistant was told it: read_range listed it, find in formulas matched it, and the
// snapshot of a selected cell quoted it.
describe('formulas hidden by protection', () => {
  it('stay hidden from the assistant', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 1, '10');
    wb.setInput(id, 1, 1, '=B1*1234.5678+42');
    wb.applyStyle(id, { r1: 1, c1: 1, r2: 1, c2: 1 }, { formulaHidden: true });
    wb.setSheetProtected(id, true);
    const env = { sheetId: () => id };
    const read = runTool(wb, 'read_range', { range: 'A1:B2' }, env).content;
    expect(read).not.toContain('1234.5678');
    expect(read).toContain('12387.678'); // the value still shows
    expect(JSON.parse(runTool(wb, 'find', { query: '1234', in_formulas: true }, env).content).matches).toEqual([]);
    const snap = workbookSnapshot(wb, { sheetId: id, selection: { sheetId: id, range: { r1: 1, c1: 1, r2: 1, c2: 1 } } });
    expect(snap).not.toContain('1234.5678');
    wb.setSheetProtected(id, false);
    expect(runTool(wb, 'read_range', { range: 'A1:B2' }, env).content).toContain('=B1*1234.5678+42');
  });
});
