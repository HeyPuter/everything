import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, changesWorkbook } from '../src/core/aitools.js';

function setup(extra = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), ...extra };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: [['Item', 'Qty'], ['Apples', 3], ['Pears', 5], ['Plums', 2], ['Figs', 7]] });
  wb.clearHistory();
  return { wb, id, env, run };
}

const parsed = (res) => JSON.parse(res.content);

describe('AI tool set_row_height', () => {
  it('sets rows to a height in pixels as one undo step', () => {
    const { wb, id, env, run } = setup();
    expect(describeCall(wb, 'set_row_height', { rows: '2:3', height: 40 }, env).label).toBe('Set rows 2–3 on Sheet1 to 40px');
    const res = parsed(run('set_row_height', { rows: '2:3', height: 40 }));
    expect(res).toEqual({ resized: 'rows 2–3 on Sheet1', height: 40 });
    expect(wb.rowHeight(id, 1)).toBe(40);
    expect(wb.rowHeight(id, 2)).toBe(40);
    expect(wb.undoLabels(5)).toHaveLength(1);
    wb.undo();
    expect(wb.rowHeight(id, 1)).not.toBe(40);
  });

  it('sizes every row through the sheet\'s default height', () => {
    const { wb, id, run } = setup();
    expect(parsed(run('set_row_height', { rows: '1:1048576', height: 30 })).resized).toBe('every row on Sheet1');
    expect(wb.sheet(id).defaultRowHeight).toBe(30);
    expect(wb.sheet(id).rowHeights.size).toBe(0);
  });

  it('refuses a height out of range, too many rows and a protected sheet', () => {
    const { wb, id, run } = setup();
    expect(run('set_row_height', { rows: '2', height: 5 }).content).toMatch(/18 to 400/);
    expect(run('set_row_height', { rows: '2', height: 'tall' }).content).toMatch(/18 to 400/);
    expect(run('set_row_height', { rows: '1:30000', height: 30 }).content).toMatch(/20,000/);
    wb.setSheetProtected(id, true);
    expect(run('set_row_height', { rows: '2', height: 30 }).content).toMatch(/protected/);
  });

  it('fits rows through the editor, stopping at the data', () => {
    const autofitRows = vi.fn(() => true);
    const { wb, env, run } = setup({ autofitRows });
    expect(describeCall(wb, 'set_row_height', { rows: '1:1048576', height: 'fit' }, env).label).toBe('Fit rows 1–1048576 on Sheet1 to their contents');
    const res = run('set_row_height', { rows: '1:1048576', height: 'fit' });
    expect(res.ok).toBe(true);
    expect(autofitRows).toHaveBeenCalledWith(wb.activeSheetId, 0, 4);
  });

  it('says why rows on a sheet not in view cannot be fitted, and when fitting is not offered', () => {
    const { run } = setup({ autofitRows: () => false });
    const res = run('set_row_height', { rows: '2', height: 'fit' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/sheet the user is looking at.*activate/);
    expect(setup().run('set_row_height', { rows: '2', height: 'fit' }).content).toMatch(/give a height in pixels/);
  });
});
