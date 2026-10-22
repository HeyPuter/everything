import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// On a protected sheet the user can type into the cells formatted as unlocked (a form's input fields), but the
// assistant refused any write there with "Sheet1 is protected. The user can unprotect it…".
describe('the assistant on a protected sheet', () => {
  function form() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Rate'); wb.setInput(id, 0, 1, '0.07'); wb.setInput(id, 1, 0, 'Total'); wb.setInput(id, 1, 1, '=B1*100');
    wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 2 }, { locked: false });
    wb.setSheetProtected(id, true);
    return { wb, id, run: (n, a) => runTool(wb, n, a, { sheetId: () => id, selection: () => null }) };
  }

  it('writes into cells formatted as unlocked', () => {
    const { wb, id, run } = form();
    expect(run('write_cells', { start_cell: 'B1', values: [[0.09]] }).ok).toBe(true);
    expect(wb.getValue(id, 1, 1)).toBeCloseTo(9);
    expect(run('fill_formula', { range: 'C1', formula: '=B1*2' }).ok).toBe(true);
    expect(wb.getValue(id, 0, 2)).toBeCloseTo(0.18);
  });

  it('still refuses the locked cells', () => {
    const { wb, id, run } = form();
    const res = run('write_cells', { start_cell: 'A1', values: [['Changed', 0.5]] });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/protected/);
    expect(wb.getValue(id, 0, 0)).toBe('Rate');
    expect(wb.getValue(id, 0, 1)).toBe(0.07);
  });
});
