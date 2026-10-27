import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, changesWorkbook } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn() };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: [['Report', null, null], ['Item', 'Qty', 'Price'], ['Apples', 3, 1.2], ['Pears', 5, 0.8]] });
  wb.clearHistory();
  return { wb, id, env, run };
}

const parsed = (res) => JSON.parse(res.content);

describe('AI tool merge_cells', () => {
  it('merges a range and centres it as Merge & Center does, in one undo step', () => {
    const { wb, id, run } = setup();
    expect(changesWorkbook('merge_cells')).toBe(true);
    const res = run('merge_cells', { range: 'A1:C1' });
    expect(res.ok).toBe(true);
    expect(parsed(res).merged).toBe('Sheet1!A1:C1');
    expect(wb.mergeAt(id, 0, 2)).toMatchObject({ r1: 0, c1: 0, r2: 0, c2: 2 });
    expect(wb.styleAt(id, 0, 0)?.align).toBe('center');
    expect(wb.undoLabels(5)).toHaveLength(1);
    wb.undo();
    expect(wb.mergeAt(id, 0, 2)).toBeNull();
    expect(wb.styleAt(id, 0, 0)?.align).toBeFalsy();
  });

  it('merges without centring when asked, and keeps an alignment the cell had', () => {
    const { wb, id, run } = setup();
    run('merge_cells', { range: 'A1:C1', center: false });
    expect(wb.styleAt(id, 0, 0)?.align).toBeFalsy();
    run('merge_cells', { range: 'A1:C1', action: 'unmerge' });
    run('format_cells', { range: 'A1', align: 'right' });
    run('merge_cells', { range: 'A1:C1' });
    expect(wb.styleAt(id, 0, 0)?.align).toBe('right');
  });

  it('asks before deleting the other values, and says how many went', () => {
    const { wb, id, env, run } = setup();
    const d = describeCall(wb, 'merge_cells', { range: 'A2:C2' }, env);
    expect(d).toMatchObject({ label: 'Merge Sheet1!A2:C2', destructive: true });
    expect(d.detail).toMatch(/deletes 2 other cells of data/);
    expect(describeCall(wb, 'merge_cells', { range: 'A1:C1' }, env)).toMatchObject({ destructive: false });
    const res = parsed(run('merge_cells', { range: 'A2:C2' }));
    expect(res.values_deleted).toMatch(/2 other cells/);
    expect(wb.getValue(id, 1, 0)).toBe('Item');
    expect(wb.getCell(id, 1, 1)?.v ?? null).toBeNull();
    wb.undo();
    expect(wb.getValue(id, 1, 1)).toBe('Qty');
  });

  it('merges each row on its own with merge_across', () => {
    const { wb, id, env, run } = setup();
    run('write_cells', { start_cell: 'E1', values: [['a', null], ['b', 'x'], ['c', null]] });
    const d = describeCall(wb, 'merge_cells', { range: 'E1:F3', action: 'merge_across' }, env);
    expect(d.label).toBe('Merge each row of Sheet1!E1:F3');
    expect(d.detail).toMatch(/of each row: deletes 1 other cell of data/);
    const res = parsed(run('merge_cells', { range: 'E1:F3', action: 'merge_across' }));
    expect(res.merged).toBe('each row of Sheet1!E1:F3');
    for (let r = 0; r < 3; r++) expect(wb.mergeAt(id, r, 5)).toMatchObject({ r1: r, r2: r, c1: 4, c2: 5 });
    expect(wb.getValue(id, 1, 4)).toBe('b');
    expect(wb.styleAt(id, 0, 4)?.align).toBeFalsy();
    expect(run('merge_cells', { range: 'G1:G3', action: 'merge_across' }).content).toMatch(/at least two columns/);
  });

  it('grows a merge to take in a merged cell it overlaps', () => {
    const { wb, id, run } = setup();
    run('merge_cells', { range: 'E1:F1' });
    const res = parsed(run('merge_cells', { range: 'D1:E2' }));
    expect(res.merged).toBe('Sheet1!D1:F2');
    expect(res.note).toMatch(/Grown to D1:F2/);
    expect(wb.sheet(id).merges).toEqual([{ r1: 0, c1: 3, r2: 1, c2: 5 }]);
  });

  it('unmerges every merged cell the range touches, and says when there are none', () => {
    const { wb, id, run } = setup();
    run('merge_cells', { range: 'A1:C1' });
    run('merge_cells', { range: 'E5:F6' });
    wb.clearHistory();
    const res = parsed(run('merge_cells', { range: 'A1:F6', action: 'unmerge' }));
    expect(res.unmerged).toEqual(['Sheet1!A1:C1', 'Sheet1!E5:F6']);
    expect(wb.sheet(id).merges).toEqual([]);
    expect(wb.undoLabels(5)).toHaveLength(1);
    const none = run('merge_cells', { range: 'A1:C1', action: 'unmerge' });
    expect(none.ok).toBe(false);
    expect(none.content).toMatch(/holds no merged cells/);
  });

  it('refuses a single cell, a table, a protected sheet and a protected range, changing nothing', () => {
    const { wb, id, run } = setup();
    expect(run('merge_cells', { range: 'A1' }).content).toMatch(/single cell/);
    wb.addTable(id, { r1: 1, c1: 0, r2: 3, c2: 2 }, { name: 'Fruit' });
    expect(run('merge_cells', { range: 'A2:B2' }).content).toMatch(/table Fruit/);
    wb.setSheetProtected(id, true);
    expect(run('merge_cells', { range: 'E1:F1' }).content).toMatch(/protected/);
    wb.setSheetProtected(id, false);
    wb.protectRange(id, { r1: 9, c1: 0, r2: 9, c2: 1 });
    expect(wb.sheet(id).protectedRanges).toHaveLength(1);
    expect(run('merge_cells', { range: 'A10:C10' }).content).toMatch(/protected range/);
    expect(wb.sheet(id).merges).toEqual([]);
  });

  it('merges whole columns only as far as the data goes', () => {
    const { wb, id, run } = setup();
    const res = parsed(run('merge_cells', { range: 'E:F', action: 'merge_across' }));
    expect(res.merged).toBe('each row of Sheet1!E1:F4');
    expect(wb.sheet(id).merges).toHaveLength(4);
  });

  it('says when a merge blocks the results a formula spills', () => {
    const { wb, id, env, run } = setup();
    run('write_cells', { start_cell: 'H1', values: [['=SEQUENCE(1,3)']] });
    expect(wb.getValue(id, 0, 9)).toBe(3);
    const d = describeCall(wb, 'merge_cells', { range: 'I1:J1' }, env);
    expect(d.destructive).toBe(true);
    expect(d.detail).toMatch(/#SPILL!/);
    const res = parsed(run('merge_cells', { range: 'I1:J1' }));
    expect(wb.getValue(id, 0, 7)?.error).toBe('#SPILL!');
    expect(res.spills_blocked[0]).toMatch(/H1 now shows #SPILL!/);
  });
});
