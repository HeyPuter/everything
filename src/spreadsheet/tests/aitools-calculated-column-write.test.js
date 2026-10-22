import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall } from '../src/core/aitools.js';

// A new formula typed into a table's calculated column is written down the whole column, but the assistant's
// question said it replaced 1 cell and its result said 1 cell written, while every row of the column changed.
describe('the assistant writing a formula into a table\'s calculated column', () => {
  function setup() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    [['Item', 'Qty', 'Price', 'Total'], ['a', '2', '3'], ['b', '4', '5'], ['c', '6', '7'], ['d', '8', '9']]
      .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
    wb.addTable(id, { r1: 0, c1: 0, r2: 4, c2: 3 }, { name: 'Sales' });
    wb.setInput(id, 1, 3, '=B2*C2'); // fills the column
    const env = { sheetId: () => id, selection: () => null };
    return { wb, id, run: (n, a) => runTool(wb, n, a, env), desc: (n, a) => describeCall(wb, n, a, env) };
  }

  it('asks about, and reports, the column\'s other rows', () => {
    const { wb, id, run, desc } = setup();
    expect(wb.getCell(id, 4, 3).f).toBe('B5*C5');
    const asked = desc('write_cells', { start_cell: 'D3', values: [['=B3+C3']] });
    expect(asked.destructive).toBe(true);
    expect(asked.detail).toMatch(/calculated column, so it may replace the formulas in 3 other rows/);
    const out = JSON.parse(run('write_cells', { start_cell: 'D3', values: [['=B3+C3']] }).content.split('\n')[0]);
    expect(wb.getCell(id, 4, 3).f).toBe('B5+C5');
    expect(out.calculated_column).toMatch(/3 more cells \(D2, D4, D5\)/);
  });

  it('says nothing of it for a value', () => {
    const { run } = setup();
    const out = JSON.parse(run('write_cells', { start_cell: 'D3', values: [[99]] }).content.split('\n')[0]);
    expect(out.calculated_column).toBeUndefined();
  });
});
