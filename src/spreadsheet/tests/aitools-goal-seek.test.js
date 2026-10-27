import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, callTarget, changesWorkbook } from '../src/core/aitools.js';

// A loan: rate in B1, years in B2, amount in B3, monthly payment in B4.
function loan() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn() };
  wb.setInput(id, 0, 0, 'Rate'); wb.setInput(id, 0, 1, '0.05');
  wb.setInput(id, 1, 0, 'Years'); wb.setInput(id, 1, 1, '30');
  wb.setInput(id, 2, 0, 'Amount'); wb.setInput(id, 2, 1, '200000');
  wb.setInput(id, 3, 0, 'Payment'); wb.setInput(id, 3, 1, '=-PMT(B1/12,B2*12,B3)');
  wb.clearHistory();
  return { wb, id, env, run: (name, args) => runTool(wb, name, args, env) };
}

describe('goal_seek', () => {
  it('finds the input that reaches the value, writes it as one undo step and reports it', () => {
    const { wb, id, env, run } = loan();
    expect(changesWorkbook('goal_seek')).toBe(true);
    const res = run('goal_seek', { set_cell: 'B4', to_value: 1500, by_changing: 'B3' });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(true);
    expect(wb.getValue(id, 3, 1)).toBeCloseTo(1500, 6);
    const out = JSON.parse(res.content);
    expect(out.changed).toBe('Sheet1!B3');
    expect(out.from).toBe('200000');
    expect(out.value).toBeCloseTo(279422.43, 1);
    expect(out.set_cell).toBe('Sheet1!B4');
    expect(res.target).toEqual({ sheetId: id, range: { r1: 2, c1: 1, r2: 2, c2: 1 } });
    expect(callTarget(wb, 'goal_seek', { set_cell: 'B4', to_value: 1, by_changing: 'B3' }, env).range).toEqual({ r1: 2, c1: 1, r2: 2, c2: 1 });
    expect(wb.undoLabels(5)).toEqual(['AI edit']);
    wb.undo();
    expect(wb.getValue(id, 2, 1)).toBe(200000);
  });

  it('reads by_changing on the sheet of set_cell, and refuses one on another sheet', () => {
    const { wb, id, run } = loan();
    const other = wb.addSheet('Other').id;
    wb.setActiveSheet(other);
    const env = { sheetId: () => other, selection: () => null };
    const res = runTool(wb, 'goal_seek', { set_cell: 'Sheet1!B4', to_value: 1000, by_changing: 'B3' }, env);
    expect(res.ok).toBe(true);
    expect(wb.getValue(id, 3, 1)).toBeCloseTo(1000, 6);
    const across = runTool(wb, 'goal_seek', { set_cell: 'Sheet1!B4', to_value: 900, by_changing: 'Other!A1' }, env);
    expect(across.ok).toBe(false);
    expect(across.content).toMatch(/same sheet/);
  });

  it('says when no value reaches the goal, changing nothing', () => {
    const { wb, id, run } = loan();
    wb.setInput(id, 5, 0, '5'); wb.setInput(id, 5, 1, '=A6^2');
    wb.clearHistory();
    const res = run('goal_seek', { set_cell: 'B6', to_value: -4, by_changing: 'A6' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/No value of Sheet1!A6 makes Sheet1!B6 reach -4/);
    expect(res.changed).toBe(false);
    expect(wb.getValue(id, 5, 0)).toBe(5);
    expect(wb.undoLabels(5)).toEqual([]);
  });

  it('refuses a set_cell without a formula, a changing cell with one, and the same cell twice', () => {
    const { run } = loan();
    expect(run('goal_seek', { set_cell: 'B3', to_value: 1, by_changing: 'B1' }).content).toMatch(/holds no formula/);
    expect(run('goal_seek', { set_cell: 'B4', to_value: 1, by_changing: 'B4' }).content).toMatch(/holds a formula|same cell/);
    expect(run('goal_seek', { set_cell: 'B4', to_value: 'lots', by_changing: 'B3' }).content).toMatch(/to_value must be a number/);
    expect(run('goal_seek', { set_cell: 'B4:B5', to_value: 1, by_changing: 'B3' }).content).toMatch(/set_cell must be one cell/);
  });

  it('leaves the input alone when the formula already shows the value', () => {
    const { wb, id, run } = loan();
    const now = wb.getValue(id, 3, 1);
    const res = run('goal_seek', { set_cell: 'B4', to_value: now, by_changing: 'B3' });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(JSON.parse(res.content.split('\n')[0]).already).toMatch(/already shows/);
    expect(wb.getValue(id, 2, 1)).toBe(200000);
  });

  it('refuses on a protected sheet and in a protected range', () => {
    const { wb, id, run } = loan();
    wb.protectRange(id, { r1: 2, c1: 1, r2: 2, c2: 1 });
    expect(run('goal_seek', { set_cell: 'B4', to_value: 1500, by_changing: 'B3' }).content).toMatch(/protected range/);
    const sheet2 = loan();
    sheet2.wb.setSheetProtected(sheet2.id, true);
    const res = sheet2.run('goal_seek', { set_cell: 'B4', to_value: 1500, by_changing: 'B3' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/protected/);
    expect(sheet2.wb.getValue(sheet2.id, 2, 1)).toBe(200000);
  });

  it('asks before replacing the input cell\'s value, and not before filling a blank one', () => {
    const { wb, id, env } = loan();
    const d = describeCall(wb, 'goal_seek', { set_cell: 'B4', to_value: 1500, by_changing: 'B3' }, env);
    expect(d.label).toBe('Goal seek: set Sheet1!B4 to 1500 by changing Sheet1!B3');
    expect(d.destructive).toBe(true);
    expect(d.detail).toBe('Replaces the value in Sheet1!B3 (now 200000).');
    wb.setInput(id, 6, 1, '=C7*2');
    const blank = describeCall(wb, 'goal_seek', { set_cell: 'B7', to_value: 10, by_changing: 'C7' }, env);
    expect(blank.destructive).toBe(false);
    const res = runTool(wb, 'goal_seek', { set_cell: 'B7', to_value: 10, by_changing: 'C7' }, env);
    expect(res.ok).toBe(true);
    expect(wb.getValue(id, 6, 2)).toBe(5);
  });
});
