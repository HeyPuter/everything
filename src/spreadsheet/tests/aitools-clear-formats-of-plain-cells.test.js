import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// Clearing the formats of cells that hold values but no formatting changed nothing, and the tool took that for a clear
// the workbook had refused: it told the model "could not be cleared (it may cross part of an array formula or a pivot
// table)", so the model reported a failure, or went looking for an array formula that was not there.
describe('clear_range with what "formats" over unformatted cells', () => {
  function setup() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const env = { sheetId: () => id, selection: () => null, distrust: vi.fn() };
    const run = (name, args) => runTool(wb, name, args, env);
    run('write_cells', { start_cell: 'A1', values: [['Month', 'Sales'], ['Jan', 10], ['Feb', 12]] });
    wb.clearHistory();
    return { wb, id, run };
  }

  it('says there was nothing to clear, not that the clear was refused', () => {
    const { wb, id, run } = setup();
    const res = run('clear_range', { range: 'A1:B3', what: 'formats' });
    expect(res.ok).toBe(true);
    expect(res.content).not.toMatch(/could not be cleared/);
    expect(res.content).toMatch(/nothing in the workbook changed/);
    expect(wb.getValue(id, 1, 1)).toBe(10);
  });

  it('still clears formatting where there is some, values staying', () => {
    const { wb, id, run } = setup();
    run('format_cells', { range: 'A1:B1', bold: true });
    wb.clearHistory();
    const res = run('clear_range', { range: 'A1:B3', what: 'formats' });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(wb.styleAt(id, 0, 0)?.bold).toBeFalsy();
    expect(wb.getValue(id, 0, 0)).toBe('Month');
  });

  it('still says why a clear across part of an array formula was refused', () => {
    const { wb, id, run } = setup();
    wb.setArrayFormula(id, { r1: 0, c1: 3, r2: 2, c2: 3 }, '=B1:B3*2');
    const res = run('clear_range', { range: 'D1:D2' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/could not be cleared \(it may cross part of an array formula/);
    expect(wb.getValue(id, 1, 3)).toBe(20);
  });
});
