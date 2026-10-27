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

describe('AI tool set_hidden', () => {
  it('hides rows and shows them again, each one undo step', () => {
    const { wb, id, env, run } = setup();
    expect(changesWorkbook('set_hidden')).toBe(true);
    expect(describeCall(wb, 'set_hidden', { rows: '3:4', hidden: true }, env).label).toBe('Hide rows 3–4 on Sheet1');
    const res = parsed(run('set_hidden', { rows: '3:4', hidden: true }));
    expect(res).toMatchObject({ hidden: 'rows 3–4 on Sheet1', changed: 2 });
    expect(wb.isRowHidden(id, 2) && wb.isRowHidden(id, 3)).toBe(true);
    expect(wb.isRowHidden(id, 1)).toBe(false);
    expect(wb.undoLabels(5)).toHaveLength(1);
    expect(describeCall(wb, 'set_hidden', { rows: '1:10', hidden: false }, env).label).toBe('Show rows 1–10 on Sheet1');
    expect(parsed(run('set_hidden', { rows: '1:10', hidden: false }))).toMatchObject({ shown: 'rows 1–10 on Sheet1', changed: 2 });
    expect(wb.isRowHidden(id, 2)).toBe(false);
    wb.undo();
    expect(wb.isRowHidden(id, 2)).toBe(true);
  });

  it('hides columns, and lists of rows or columns', () => {
    const { wb, id, run } = setup();
    expect(parsed(run('set_hidden', { columns: 'B, D:E', hidden: true })).hidden).toBe('columns B, D–E on Sheet1');
    expect([1, 3, 4].every((c) => wb.isHidden(id, 'col', c))).toBe(true);
    expect(wb.isHidden(id, 'col', 2)).toBe(false);
    expect(parsed(run('set_hidden', { rows: '2,4:5,5', hidden: true })).changed).toBe(3);
  });

  it('says nothing changed when they were already that way', () => {
    const { run } = setup();
    run('set_hidden', { rows: '2', hidden: true });
    const again = run('set_hidden', { rows: '2', hidden: true });
    expect(again.ok).toBe(true);
    expect(again.changed).toBe(false);
    expect(again.content).toMatch(/hidden already/);
    expect(run('set_hidden', { rows: '9', hidden: false }).content).toMatch(/None of them was hidden/);
  });

  it('says rows a filter hides stay hidden', () => {
    const { wb, id, run } = setup();
    wb.sheet(id).filterHidden.add(2);
    run('set_hidden', { rows: '4', hidden: true });
    const res = parsed(run('set_hidden', { rows: '1:5', hidden: false }));
    expect(res.changed).toBe(1);
    expect(res.note).toMatch(/1 row is hidden by a filter/);
    expect(run('set_hidden', { rows: '3', hidden: false }).content).toMatch(/hidden by a filter[\s\S]*nothing in the workbook changed/);
    expect(wb.isRowHidden(id, 2)).toBe(true);
  });

  it('refuses bad lines, both or neither axis, a protected sheet and hiding every row', () => {
    const { wb, id, run } = setup();
    expect(run('set_hidden', { rows: 'B', hidden: true }).content).toMatch(/not a row number/);
    expect(run('set_hidden', { columns: '3', hidden: true }).content).toMatch(/column letter/);
    expect(run('set_hidden', { rows: '2', columns: 'B', hidden: true }).content).toMatch(/not both/);
    expect(run('set_hidden', { hidden: true }).content).toMatch(/Give rows or columns/);
    expect(run('set_hidden', { rows: '2:3:4', hidden: true }).content).toMatch(/run of them/);
    expect(run('set_hidden', { columns: 'A:XFD', hidden: true }).content).toMatch(/at least one column showing/);
    wb.setSheetProtected(id, true);
    expect(run('set_hidden', { rows: '2', hidden: true }).content).toMatch(/protected/);
    expect(wb.isRowHidden(id, 1)).toBe(false);
  });
});

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
