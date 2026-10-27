import { describe, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { runTool, describeCall, filterSummaries } from '../src/core/aitools.js';
import { tableFilterButtonOn } from '../src/core/table-header-row.js';

const DATA = [
  ['Region', 'Rep', 'Amount', 'Date'],
  ['West', 'Ana', 120, '2024-01-05'],
  ['East', 'Bo', 80, '2024-02-10'],
  ['West', 'Cy', 300, '2024-03-15'],
  ['North', 'Di', 45, '2024-04-20'],
  ['east', 'Ed', 210, '2024-05-25'],
  ['', 'Flo', 99, '2024-06-30'],
];

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: DATA });
  wb.clearHistory();
  return { wb, id, env, run };
}
const hidden = (wb, id) => [...wb.sheet(id).filterHidden].sort((a, b) => a - b);
const parsed = (res) => JSON.parse(res.content);

describe('filter_range', () => {
  it('turns a filter on over a list and keeps the rows showing the values asked for, as one undo step', () => {
    const { wb, id, run } = setup();
    const res = run('filter_range', { range: 'A1:D7', columns: [{ column: 'A', values: ['West'] }] });
    expect(res.ok).toBe(true);
    const out = parsed(res);
    expect(out).toMatchObject({ filtered: 'Sheet1!A1:D7', rows_shown: 2, data_rows: 6 });
    expect(out.criteria).toEqual(['A ("Region"): one of "West"']);
    expect(hidden(wb, id)).toEqual([2, 4, 5, 6]);
    expect(wb.undoLabels(5)).toEqual(['AI edit']);
    wb.undo();
    expect(wb.sheet(id).filter).toBeNull();
    expect(hidden(wb, id)).toEqual([]);
  });

  it('finds the list around a single cell, takes a column by its header, and matches values in any case', () => {
    const { wb, id, run } = setup();
    const out = parsed(run('filter_range', { range: 'B3', columns: [{ column: 'region', values: ['EAST', ''] }] }));
    expect(out.filtered).toBe('Sheet1!A1:D7');
    // "East" and "east" both show, and the blank region (row 7) is kept by "".
    expect(hidden(wb, id)).toEqual([1, 3, 4]);
  });

  it('keeps rows meeting a number or date condition, a between, and text conditions', () => {
    const { wb, id, run } = setup();
    run('filter_range', { range: 'A1:D7', columns: [{ column: 'C', condition: 'gt', value: 100 }] });
    expect(hidden(wb, id)).toEqual([2, 4, 6]);
    run('filter_range', { range: 'A1', columns: [{ column: 'C', condition: 'between', value: 50, value2: 150 }] });
    expect(hidden(wb, id)).toEqual([3, 4, 5]);
    run('filter_range', { range: 'A1', columns: [{ column: 'C' }, { column: 'D', condition: 'gte', value: '2024-03-01' }] });
    expect(hidden(wb, id)).toEqual([1, 2]);
    run('filter_range', { range: 'A1', clear_others: true, columns: [{ column: 'B', condition: 'beginsWith', value: 'd' }] });
    expect(hidden(wb, id)).toEqual([1, 2, 3, 5, 6]);
  });

  it('keeps the top or bottom N, and rows above the average', () => {
    const { wb, id, run } = setup();
    const out = parsed(run('filter_range', { range: 'A1:D7', columns: [{ column: 'Amount', condition: 'top', value: 2 }] }));
    expect(out.criteria).toEqual(['C ("Amount"): top 2']);
    expect(hidden(wb, id)).toEqual([1, 2, 4, 6]);
    run('filter_range', { range: 'A1', columns: [{ column: 'C', condition: 'bottom', value: 1 }] });
    expect(hidden(wb, id)).toEqual([1, 2, 3, 5, 6]);
    run('filter_range', { range: 'A1', columns: [{ column: 'C', condition: 'above_average' }] });
    // The average is 142.33: 300 and 210.
    expect(hidden(wb, id)).toEqual([1, 2, 4, 6]);
  });

  it('keeps rows by a custom formula written for the first data row', () => {
    const { wb, id, run } = setup();
    run('filter_range', { range: 'A1:D7', columns: [{ column: 'C', condition: 'formula', value: '=AND(A2="West",C2>200)' }] });
    expect(hidden(wb, id)).toEqual([1, 2, 4, 5, 6]);
  });

  it('matches values given as numbers to the numbers behind formatted cells', () => {
    const { wb, id, run } = setup();
    run('format_cells', { range: 'C2:C7', number_format: 'currency', currency: 'USD' });
    run('filter_range', { range: 'A1:D7', columns: [{ column: 'C', values: [80, '$300.00'] }] });
    expect(hidden(wb, id)).toEqual([1, 4, 5, 6]);
  });

  it('adds to an existing filter, keeping the other columns, and says which values no row shows', () => {
    const { wb, id, run } = setup();
    run('filter_range', { range: 'A1:D7', columns: [{ column: 'A', values: ['West', 'East'] }] });
    const out = parsed(run('filter_range', { range: 'C4', columns: [{ column: 'C', condition: 'lt', value: 200 }, { column: 'B', values: ['Ana', 'Zed'] }] }));
    expect(out.criteria).toHaveLength(3);
    expect(out.values_not_found).toEqual(['Rep: "Zed"']);
    expect(hidden(wb, id)).toEqual([2, 3, 4, 5, 6]);
  });

  it('refuses values no row shows, listing some it holds, and changes nothing', () => {
    const { wb, id, run } = setup();
    const res = run('filter_range', { range: 'A1:D7', columns: [{ column: 'A', values: ['South'] }] });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/No row of column A \("Region"\) shows that value.*"West"/);
    expect(wb.sheet(id).filter).toBeNull();
    expect(wb.undoLabels(5)).toEqual([]);
  });

  it('refuses unknown columns, conditions without a value, and a numeric condition on text', () => {
    const { run } = setup();
    expect(run('filter_range', { range: 'A1:D7', columns: [{ column: 'Price', values: [1] }] }).content).toMatch(/not a column of the filter.*A "Region"/);
    expect(run('filter_range', { range: 'A1:D7', columns: [{ column: 'C', condition: 'gt' }] }).content).toMatch(/needs a value/);
    expect(run('filter_range', { range: 'A1:D7', columns: [{ column: 'C', condition: 'gt', value: 'lots' }] }).content).toMatch(/needs a number/);
    expect(run('filter_range', { range: 'A1:D7', columns: [{ column: 'C', values: [1], condition: 'gt', value: 1 }] }).content).toMatch(/not both/);
  });

  it('clears every criterion, then removes the filter', () => {
    const { wb, id, run } = setup();
    run('filter_range', { range: 'A1:D7', columns: [{ column: 'A', values: ['West'] }] });
    expect(parsed(run('filter_range', { range: 'A1', action: 'clear' }))).toMatchObject({ rows_shown: 6, data_rows: 6 });
    expect(wb.sheet(id).filter.criteria).toEqual({});
    expect(hidden(wb, id)).toEqual([]);
    run('filter_range', { range: 'A1', action: 'remove' });
    expect(wb.sheet(id).filter).toBeNull();
    expect(run('filter_range', { range: 'A1', action: 'remove' }).content).toMatch(/There is no filter on Sheet1!A1:D7 to remove/);
  });

  it('filters a table by its name in its own filter, and hides its buttons rather than dropping it on remove', () => {
    const { wb, id, run } = setup();
    run('create_table', { range: 'A1:D7', name: 'Sales' });
    const out = parsed(run('filter_range', { range: 'Sales', columns: [{ column: 'Rep', values: ['Bo', 'Di'] }] }));
    expect(out).toMatchObject({ filtered: 'Sheet1!A1:D7', table: 'Sales', rows_shown: 2 });
    expect(hidden(wb, id)).toEqual([1, 3, 5, 6]);
    run('filter_range', { range: 'Sales', action: 'remove' });
    const table = wb.sheet(id).tables[0];
    expect(tableFilterButtonOn(wb, id, table)).toBe(false);
    expect(hidden(wb, id)).toEqual([]);
    expect(wb.undoLabels(1)).toEqual(['AI edit']);
  });

  it('refuses a range that crosses a table, and a protected sheet', () => {
    const { wb, id, run } = setup();
    run('create_table', { range: 'B1:C7', name: 'Reps' });
    expect(run('filter_range', { range: 'A1:D7', columns: [{ column: 'C', condition: 'gt', value: 1 }] }).content).toMatch(/crosses the table Reps/);
    wb.setSheetProtected(id, true);
    const res = run('filter_range', { range: 'Reps', columns: [{ column: 'C', condition: 'gt', value: 1 }] });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/protected/);
  });

  it('says so when a new filter takes the place of the sheet\'s other one', () => {
    const { wb, id, run } = setup();
    run('write_cells', { start_cell: 'F1', values: [['Kind'], ['a'], ['b']] });
    run('filter_range', { range: 'A1:D7', columns: [{ column: 'A', values: ['West'] }] });
    const out = parsed(run('filter_range', { range: 'F1:F3', columns: [{ column: 'F', values: ['a'] }] }));
    expect(out.note).toMatch(/The filter that was on Sheet1!A1:D7 was removed/);
    expect(hidden(wb, id)).toEqual([2]);
  });

  it('lists the filters on a sheet for the model', () => {
    const { wb, id, run } = setup();
    run('filter_range', { range: 'A1:D7', columns: [{ column: 'C', condition: 'gte', value: 100 }] });
    expect(filterSummaries(wb, id)).toEqual([{ range: 'A1:D7', criteria: ['C ("Amount"): >= 100'], rows_shown: '3 of 6' }]);
  });

  it('names the list it filters in the chat', () => {
    const { wb, id, env, run } = setup();
    expect(describeCall(wb, 'filter_range', { range: 'B2', columns: [{ column: 'A', values: ['West'] }] }, env).label).toBe('Filter Sheet1!A1:D7 by A');
    run('create_table', { range: 'A1:D7', name: 'Sales' });
    expect(describeCall(wb, 'filter_range', { range: 'C3', action: 'remove' }, env).label).toBe('Remove the filter from Sales');
    expect(describeCall(wb, 'filter_range', { range: 'Sales', action: 'clear' }, env).label).toBe('Show every row of the filter on Sales');
    void id;
  });

  it('saves its criteria to .xlsx and reads them back with the same rows hidden', async () => {
    const { wb, id, run } = setup();
    // "east" is kept with "East", as Excel's value lists ignore case; the top 3 amounts are rows 2, 4 and 6.
    run('filter_range', { range: 'A1:D7', columns: [{ column: 'A', values: ['West', 'East'] }, { column: 'C', condition: 'top', value: 3 }] });
    expect(hidden(wb, id)).toEqual([2, 4, 6]);
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    const zip = X.CFB.read(bytes, { type: 'array' });
    const xml = new TextDecoder().decode(X.CFB.find(zip, '/xl/worksheets/sheet1.xml').content);
    expect(xml).toContain('<top10 val="3"/>');
    const back = await workbookFromFile(bytes, 'filtered.xlsx');
    expect(Object.keys(back.activeSheet.filter.criteria)).toEqual(['0', '2']);
    expect(hidden(back, back.activeSheetId)).toEqual([2, 4, 6]);
  });
});
