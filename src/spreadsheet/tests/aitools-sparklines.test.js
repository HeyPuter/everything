import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { runTool, describeCall, callTarget } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: [['Region', 'Jan', 'Feb', 'Mar', 'Apr'], ['North', 5, 7, -2, 9], ['South', 3, 4, 6, 8]] });
  wb.clearHistory();
  return { wb, id, env, run, describe: (name, args) => describeCall(wb, name, args, env) };
}
const groups = (wb, id) => wb.sheet(id).sparklineGroups;

describe('add_sparklines', () => {
  it('adds one sparkline per data row, keeps the cells, and undoes in one step', () => {
    const { wb, id, run } = setup();
    wb.setInput(id, 1, 5, 'note');
    wb.clearHistory();
    const res = run('add_sparklines', { data_range: 'B2:E3', location: 'F2:F3' });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content)).toMatchObject({ sparklines: 2, type: 'line', in: 'Sheet1!F2:F3', data: 'Sheet1!B2:E3' });
    expect(groups(wb, id)[0]).toMatchObject({ type: 'line', sparklines: [{ ref: 'F2', formula: 'Sheet1!B2:E2' }, { ref: 'F3', formula: 'Sheet1!B3:E3' }] });
    expect(wb.getValue(id, 1, 5)).toBe('note');
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect(groups(wb, id)).toEqual([]);
  });

  it('draws win/loss and column types, by columns when asked, with markers and highlighted points', () => {
    const { wb, id, run } = setup();
    run('add_sparklines', { data_range: 'B2:E3', location: 'B5:E5', type: 'win_loss' });
    expect(groups(wb, id)[0]).toMatchObject({ type: 'stacked', sparklines: [{ ref: 'B5', formula: 'Sheet1!B2:B3' }, { ref: 'C5' }, { ref: 'D5' }, { ref: 'E5' }] });
    run('add_sparklines', { data_range: 'B2:E3', location: 'G2:G3', markers: true, highlight: ['high', 'negative'] });
    expect(groups(wb, id)[1]).toMatchObject({ type: 'line', markers: true, high: true, negative: true });
    expect(run('add_sparklines', { data_range: 'B2:E3', location: 'H2:H3', type: 'column', markers: true }).content).toMatch(/Markers are for line sparklines only/);
  });

  it('draws from another sheet and from a named range', () => {
    const { wb, id, run } = setup();
    wb.addSheet('Summary');
    run('add_sparklines', { data_range: 'Sheet1!B2:E2', location: 'Summary!B2' });
    const summary = wb.sheetByName('Summary');
    expect(summary.sparklineGroups[0].sparklines).toEqual([{ ref: 'B2', formula: 'Sheet1!B2:E2' }]);
    wb.defineName('North', 'Sheet1!$B$2:$E$2');
    run('add_sparklines', { data_range: 'north', location: 'F2' });
    expect(groups(wb, id)[0].sparklines[0].formula).toBe('North');
  });

  it('passes on the workbook\'s refusals, changing nothing', () => {
    const { wb, id, run } = setup();
    expect(run('add_sparklines', { data_range: 'B2:E3', location: 'F2:F4' }).content).toMatch(/number of data rows or columns must match/);
    expect(run('add_sparklines', { data_range: 'B2:E3', location: 'F2:G3' }).content).toMatch(/single row or column/);
    expect(run('add_sparklines', { location: 'F2' }).content).toMatch(/Give the data_range/);
    run('add_sparklines', { data_range: 'B2:E2', location: 'F2' });
    expect(run('add_sparklines', { data_range: 'B3:E3', location: 'F2' }).content).toMatch(/already contains a sparkline/);
    wb.setSheetProtected(id, true);
    expect(run('add_sparklines', { data_range: 'B3:E3', location: 'F3' }).content).toMatch(/protected/);
    expect(groups(wb, id)).toHaveLength(1);
  });

  it('removes the sparklines in a range, asking first', () => {
    const { wb, id, run, describe } = setup();
    run('add_sparklines', { data_range: 'B2:E3', location: 'F2:F3' });
    expect(describe('add_sparklines', { location: 'F2:F3', remove: true })).toMatchObject({ label: 'Remove the sparklines in Sheet1!F2:F3', destructive: true, detail: 'Removes 2 sparklines.' });
    expect(describe('add_sparklines', { data_range: 'B2:E3', location: 'G2:G3', type: 'column' })).toEqual({ label: 'Add column sparklines to Sheet1!G2:G3' });
    const res = run('add_sparklines', { location: 'F3', remove: true });
    expect(JSON.parse(res.content)).toEqual({ removed_sparklines: 1, from: 'Sheet1!F3' });
    expect(groups(wb, id)[0].sparklines.map((s) => s.ref)).toEqual(['F2']);
    expect(run('add_sparklines', { location: 'A1:A9', remove: true }).content).toMatch(/no sparklines in Sheet1!A1:A9/);
  });

  it('points the chat at the cells they go in', () => {
    const { wb, env } = setup();
    expect(callTarget(wb, 'add_sparklines', { data_range: 'B2:E3', location: 'F2:F3' }, env).range).toEqual({ r1: 1, c1: 5, r2: 2, c2: 5 });
  });

  it('keeps the sparklines through a save as .xlsx', async () => {
    const { wb, run } = setup();
    run('add_sparklines', { data_range: 'B2:E3', location: 'F2:F3', type: 'column', highlight: ['high'] });
    const back = await workbookFromFile(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), 'saved.xlsx');
    expect(back.sheets[0].sparklineGroups[0]).toMatchObject({ type: 'column', high: true, sparklines: [{ ref: 'F2', formula: 'Sheet1!B2:E2' }, { ref: 'F3', formula: 'Sheet1!B3:E3' }] });
  });
});
