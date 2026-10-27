import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { runTool, describeCall, callTarget } from '../src/core/aitools.js';
import { refreshPivot, pivotDefinitionState } from '../src/core/pivot.js';

const DATA = [
  ['Region', 'Rep', 'Amount', 'Quarter'],
  ['West', 'Ana', 120, 'Q1'],
  ['East', 'Bo', 80, 'Q1'],
  ['West', 'Cy', 300, 'Q2'],
  ['North', 'Di', 45, 'Q2'],
  ['East', 'Ed', 210, 'Q2'],
];

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  let active = id;
  const env = { sheetId: () => (wb.sheet(active) ? active : id), selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: DATA });
  wb.clearHistory();
  return { wb, id, env, run, show: (sheetId) => { active = sheetId; } };
}
const parsed = (res) => JSON.parse(res.content);
/** A block of a sheet's values, row by row. */
const block = (wb, sheetId, r1, c1, r2, c2) => Array.from({ length: r2 - r1 + 1 }, (_, i) => Array.from({ length: c2 - c1 + 1 }, (_, j) => wb.getValue(sheetId, r1 + i, c1 + j)));

describe('create_pivot_table', () => {
  it('summarizes a field by another on a new sheet, as Insert ▸ PivotTable does, in one undo step', () => {
    const { wb, run } = setup();
    const res = run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount' });
    expect(res.ok).toBe(true);
    const out = parsed(res);
    expect(out).toMatchObject({ pivot_table: "'Pivot of Sheet1'!A1:B5", new_sheet: 'Pivot of Sheet1', summarizes: 'Sum of Amount by Region', row_labels: 3 });
    const pivot = wb.sheetByName('Pivot of Sheet1');
    expect(block(wb, pivot.id, 0, 0, 4, 1)).toEqual([['Region', 'Sum of Amount'], ['East', 290], ['North', 45], ['West', 420], ['Total', 755]]);
    expect(pivot.frozenRows).toBe(1);
    expect(pivotDefinitionState(wb, pivot.id)).toBe('intact');
    expect(wb.undoLabels(5)).toEqual(['AI edit']);
    wb.undo();
    expect(wb.sheetByName('Pivot of Sheet1')).toBeFalsy();
  });

  it('spreads a second field across the columns, with row and column totals', () => {
    const { wb, run } = setup();
    run('create_pivot_table', { data_range: 'B2', rows: 'region', columns: 'Quarter', values: 'C', summarize: 'sum', new_sheet_name: 'By quarter' });
    const pivot = wb.sheetByName('By quarter');
    expect(block(wb, pivot.id, 0, 0, 4, 3)).toEqual([
      ['Region', 'Q1', 'Q2', 'Total'],
      ['East', 80, 210, 290],
      ['North', '', 45, 45],
      ['West', 120, 300, 420],
      ['Total', 200, 555, 755],
    ]);
  });

  it('counts a text field, and refuses to add up one that holds no numbers', () => {
    const { wb, run } = setup();
    run('create_pivot_table', { data_range: 'A1:D6', rows: 'Quarter', values: 'Rep', summarize: 'count' });
    const pivot = wb.sheetByName('Pivot of Sheet1');
    expect(block(wb, pivot.id, 0, 0, 3, 1)).toEqual([['Quarter', 'Count of Rep'], ['Q1', 2], ['Q2', 3], ['Total', 5]]);
    const res = run('create_pivot_table', { data_range: 'A1:D6', rows: 'Quarter', values: 'Rep' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/"Rep" holds no numbers to add up\. Use summarize "count"/);
  });

  it('puts a filter cell above the table that starts on the value asked for and re-filters it when changed', () => {
    const { wb, run } = setup();
    const out = parsed(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', summarize: 'average', filter: 'Quarter', filter_value: 'q2' }));
    const pivot = wb.sheetByName('Pivot of Sheet1');
    expect(out.filter).toBe(`Quarter: the cell 'Pivot of Sheet1'!B1 picks the value (now "Q2").`);
    expect(wb.validationAt(pivot.id, 0, 1)?.type).toBe('list');
    expect(block(wb, pivot.id, 2, 0, 5, 1)).toEqual([['Region', 'Average of Amount'], ['East', 210], ['North', 45], ['West', 300]]);
    wb.setInput(pivot.id, 0, 1, 'Q1');
    expect(block(wb, pivot.id, 3, 1, 5, 1)).toEqual([[80], [''], [120]]);
    expect(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', filter: 'Quarter', filter_value: 'Q9' }).content).toMatch(/"Quarter" has no value "Q9"\. Some it has: "Q1", "Q2"/);
  });

  it('puts it at a cell on an existing sheet, with its formulas there, and Refresh rebuilds it in place', () => {
    const { wb, id, run } = setup();
    const out = parsed(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', filter: 'Rep', destination: 'F3' }));
    expect(out.pivot_table).toBe('Sheet1!F3:G9');
    expect(out.new_sheet).toBeUndefined();
    expect(wb.undoLabels(5)).toEqual(['AI edit']);
    expect(block(wb, id, 2, 5, 7, 6)).toEqual([['Rep', '(All)'], [null, null], ['Region', 'Sum of Amount'], ['East', 290], ['North', 45], ['West', 420]]);
    expect(wb.getValue(id, 8, 6)).toBe(755);
    wb.setInput(id, 2, 6, 'Cy');
    expect(wb.getValue(id, 7, 6)).toBe(300);
    wb.setInput(id, 2, 6, '(All)');
    // A new category in the source gets its row on Refresh, built again where the table stands.
    wb.setInput(id, 5, 0, 'South');
    expect(refreshPivot(wb, id)).toEqual({ rows: 4 });
    expect(block(wb, id, 5, 5, 9, 6)).toEqual([['East', 80], ['North', 45], ['South', 210], ['West', 420], ['Total', 755]]);
  });

  it('asks before putting it over cells that hold data, and clears the block it takes', () => {
    const { wb, id, env, run } = setup();
    run('write_cells', { start_cell: 'G2', values: [['old'], ['old'], [null], [null], ['keep me out']] });
    const d = describeCall(wb, 'create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', destination: 'F1' }, env);
    expect(d).toMatchObject({ label: 'Add a pivot table of Sheet1!A1:D6 (sum of Amount by Region) at Sheet1!F1:G5', destructive: true, detail: 'Replaces 2 cells that already hold data.' });
    expect(callTarget(wb, 'create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', destination: 'F1' }, env).range).toEqual({ r1: 0, c1: 5, r2: 0, c2: 5 });
    run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', destination: 'F1' });
    expect(block(wb, id, 0, 5, 1, 6)).toEqual([['Region', 'Sum of Amount'], ['East', 290]]);
    expect(wb.getValue(id, 5, 6)).toBe('keep me out');
    expect(describeCall(wb, 'create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount' }, env)).toEqual({ label: 'Add a pivot table of Sheet1!A1:D6 (sum of Amount by Region) on a new sheet "Pivot of Sheet1"' });
  });

  it('refuses a destination over its own data, a sheet already holding one, a protected sheet, and a locked structure', () => {
    const { wb, id, run } = setup();
    expect(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', destination: 'C3' }).content).toMatch(/over its own data/);
    run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', destination: 'F1' });
    expect(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Quarter', values: 'Amount', destination: 'J1' }).content).toMatch(/already holds a pivot table built here/);
    const other = wb.addSheet('Other');
    wb.setSheetProtected(other.id, true);
    expect(run('create_pivot_table', { data_range: 'Sheet1!A1:D6', rows: 'Region', values: 'Amount', destination: 'Other!A1' }).content).toMatch(/Other is protected/);
    wb.structureProtected = true;
    expect(run('create_pivot_table', { data_range: 'Sheet1!A1:D6', rows: 'Region', values: 'Amount' }).content).toMatch(/structure is protected/);
    void id;
  });

  it('takes fields by column letter, names the fields when one is unknown, and checks the choices', () => {
    const { run } = setup();
    expect(parsed(run('create_pivot_table', { data_range: 'A1:D6', rows: 'D', values: 'C', summarize: 'max' })).summarizes).toBe('Max of Amount by Quarter');
    expect(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Country', values: 'Amount' }).content).toMatch(/"Country" \(rows\) is not a field of A1:D6\. Its fields are "Region", "Rep", "Amount", "Quarter"/);
    expect(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', columns: 'Region', values: 'Amount' }).content).toMatch(/different fields/);
    expect(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', filter: 'Region' }).content).toMatch(/filter must be a field other/);
    expect(run('create_pivot_table', { data_range: 'A1:A6', rows: 'Region', values: 'Region' }).content).toMatch(/needs at least two columns/);
    expect(run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', values: 'Amount', filter_value: 'Q1' }).content).toMatch(/filter_value needs a filter field/);
  });

  it('summarizes a table by its name, naming its columns so it keeps up as the table grows', () => {
    const { wb, run } = setup();
    run('create_table', { range: 'A1:D6', name: 'Sales' });
    run('create_pivot_table', { data_range: 'Sales', rows: 'Rep', values: 'Amount' });
    const pivot = wb.sheetByName('Pivot of Sheet1');
    expect(wb.getCell(pivot.id, 1, 1).f).toMatch(/Sales\[Amount\]/);
    expect(wb.getValue(pivot.id, 6, 1)).toBe(755);
  });

  it('saves to .xlsx and reads back with its values and its definition for Refresh', async () => {
    const { wb, run } = setup();
    run('create_pivot_table', { data_range: 'A1:D6', rows: 'Region', columns: 'Quarter', values: 'Amount' });
    const bytes = new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer());
    const back = await workbookFromFile(bytes, 'pivot.xlsx');
    const pivot = back.sheetByName('Pivot of Sheet1');
    expect(block(back, pivot.id, 1, 0, 4, 3)).toEqual([['East', 80, 210, 290], ['North', '', 45, 45], ['West', 120, 300, 420], ['Total', 200, 555, 755]]);
    expect(pivotDefinitionState(back, pivot.id)).toBe('intact');
  });
});
