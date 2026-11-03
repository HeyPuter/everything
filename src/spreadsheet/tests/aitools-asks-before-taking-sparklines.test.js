import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall } from '../src/core/aitools.js';

// Removing sparklines with add_sparklines asks first, as removing a note does; but a copy or a move landing on cells
// that held sparklines (and no values), or deleting a column of nothing but sparklines, took them away unasked: the
// sparkline cells hold no data, so nothing was counted.
describe('the assistant asks before a step takes sparklines away', () => {
  function setup() {
    const wb = new Workbook({ sheets: [{ name: 'Sales' }, { name: 'Other' }] });
    const id = wb.activeSheetId;
    const env = { sheetId: () => id, selection: () => null, distrust: vi.fn() };
    const run = (name, args) => runTool(wb, name, args, env);
    run('write_cells', { start_cell: 'A1', values: [['Region', 'Q1', 'Q2'], ['West', 3, 4], ['East', 5, 2], ['North', 1, 6]] });
    run('add_sparklines', { data_range: 'B2:C4', location: 'E2:E4' });
    wb.clearHistory();
    const sparklines = () => wb.sheet(id).sparklineGroups.flatMap((g) => g.sparklines).map((s) => s.ref);
    return { wb, id, env, run, sparklines };
  }

  it('asks before a copy lands on them, and says how many', () => {
    const { wb, env, run, sparklines } = setup();
    const d = describeCall(wb, 'copy_range', { source: 'A1:A2', destination: 'E2' }, env);
    expect(d).toMatchObject({ destructive: true, detail: 'Replaces 2 sparklines there.' });
    run('copy_range', { source: 'A1:A2', destination: 'E2' });
    expect(sparklines()).toEqual(['E4']);
    // Values alone, and a transposed copy, leave them.
    expect(describeCall(wb, 'copy_range', { source: 'A1:A2', destination: 'E4', what: 'values' }, env).destructive).toBe(false);
  });

  it('asks before a move lands on them, but not when they move with the cells', () => {
    const { wb, env, sparklines } = setup();
    expect(describeCall(wb, 'move_range', { source: 'A1:A3', destination: 'E2' }, env)).toMatchObject({ destructive: true, detail: 'Replaces 3 sparklines there.' });
    expect(describeCall(wb, 'move_range', { source: 'E2:E4', destination: 'E3' }, env)).toMatchObject({ destructive: false });
    expect(describeCall(wb, 'move_range', { source: 'E2:E4', destination: 'G2' }, env)).toMatchObject({ destructive: false });
    expect(sparklines()).toEqual(['E2', 'E3', 'E4']);
  });

  it('asks before deleting a column or row that holds them', () => {
    const { wb, env, run, sparklines } = setup();
    expect(describeCall(wb, 'delete_columns', { start_column: 'E' }, env)).toMatchObject({ destructive: true, detail: 'Removes 3 sparklines.' });
    expect(describeCall(wb, 'delete_rows', { start_row: 2 }, env).detail).toBe('Removes 3 cells of data and 1 sparkline.');
    expect(describeCall(wb, 'delete_columns', { start_column: 'F' }, env).destructive).toBe(false);
    run('delete_columns', { start_column: 'E' });
    expect(sparklines()).toEqual([]);
  });
});
