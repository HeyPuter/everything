import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, callTarget, TOOLS, changesWorkbook } from '../src/core/aitools.js';

function setup(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  if (rows) run('write_cells', { start_cell: 'A1', values: rows });
  wb.clearHistory();
  return { wb, id, env, run, describe: (name, args) => describeCall(wb, name, args, env) };
}

const column = (wb, id, c, n) => Array.from({ length: n }, (_, r) => wb.getValue(id, r, c) ?? null);

describe('remove_duplicates', () => {
  const people = [['Name', 'City', 'Amount'], ['Ann', 'Oslo', 10], ['Bob', 'Rome', 20], ['ann', 'oslo', 10], ['Cy', 'Oslo', 30], ['Bob', 'Rome', 25]];

  it('is described as a tool that changes the workbook', () => {
    const tool = TOOLS.find((t) => t.function.name === 'remove_duplicates');
    expect(tool.function.parameters.required).toEqual(['range']);
    expect(changesWorkbook('remove_duplicates')).toBe(true);
  });

  it('removes rows that repeat an earlier one, keeps the header, and says how many go and stay', () => {
    const { wb, id, run } = setup(people);
    const res = run('remove_duplicates', { range: 'A1:C6' });
    expect(res.ok).toBe(true);
    const out = JSON.parse(res.content);
    expect(out).toMatchObject({ removed_rows: 1, remaining_rows: 4, header_kept: true, compared_columns: ['A', 'B', 'C'] });
    expect(column(wb, id, 0, 6)).toEqual(['Name', 'Ann', 'Bob', 'Cy', 'Bob', null]);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect(column(wb, id, 0, 6)).toEqual(['Name', 'Ann', 'Bob', 'ann', 'Cy', 'Bob']);
  });

  it('compares only the columns asked for', () => {
    const { wb, id, run } = setup(people);
    const out = JSON.parse(run('remove_duplicates', { range: 'A1:C6', columns: ['a', 'B'] }).content);
    expect(out.removed_rows).toBe(2);
    expect(column(wb, id, 0, 6)).toEqual(['Name', 'Ann', 'Bob', 'Cy', null, null]);
    expect(column(wb, id, 2, 4)).toEqual(['Amount', 10, 20, 30]);
  });

  it('reads whole columns as their data, and the header from it', () => {
    const { wb, id, run } = setup([[null], [null], ...people]);
    const out = JSON.parse(run('remove_duplicates', { range: 'A:C' }).content);
    expect(out.range).toBe('Sheet1!A3:C8');
    expect(out.removed_rows).toBe(1);
    expect(wb.getValue(id, 2, 0)).toBe('Name');
  });

  it('asks before taking rows away, with the count the runner then removes', () => {
    const { run, describe } = setup(people);
    const d = describe('remove_duplicates', { range: 'A1:C6', columns: ['A', 'B'] });
    expect(d).toMatchObject({ label: 'Remove duplicate rows from Sheet1!A1:C6', destructive: true });
    expect(d.detail).toBe('Deletes 2 rows that repeat an earlier row; 3 rows stay.');
    expect(JSON.parse(run('remove_duplicates', { range: 'A1:C6', columns: ['A', 'B'] }).content).removed_rows).toBe(2);
  });

  it('says when there are no duplicates, and does not ask', () => {
    const { run, describe } = setup([['x', 1], ['y', 2]]);
    expect(describe('remove_duplicates', { range: 'A1:B2', has_header: false }).destructive).toBe(false);
    const res = run('remove_duplicates', { range: 'A1:B2', has_header: false });
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    expect(res.content).toContain('No duplicate rows were found.');
  });

  it('takes a table\'s rows out of the table', () => {
    const { wb, id, run } = setup(people);
    wb.addTable(id, { r1: 0, c1: 0, r2: 5, c2: 2 }, { name: 'People' });
    const out = JSON.parse(run('remove_duplicates', { range: 'People' }).content);
    expect(out.removed_rows).toBe(1);
    expect(wb.tableByName('People').table.range).toMatchObject({ r1: 0, r2: 4 });
  });

  it('refuses columns outside the range and a protected sheet', () => {
    const { wb, id, run } = setup(people);
    expect(run('remove_duplicates', { range: 'A1:B6', columns: ['C'] }).content).toMatch(/Column C is outside A1:B6/);
    wb.setSheetProtected(id, true);
    const res = run('remove_duplicates', { range: 'A1:C6' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/protected/);
    expect(column(wb, id, 0, 6)).toEqual(['Name', 'Ann', 'Bob', 'ann', 'Cy', 'Bob']);
  });

  it('refuses rows that cannot move, and changes nothing', () => {
    const { wb, id, run } = setup(people);
    wb.mergeCells(id, { r1: 2, c1: 0, r2: 2, c2: 1 });
    const res = run('remove_duplicates', { range: 'A1:C6' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/merged cells/);
    expect(wb.getValue(id, 3, 0)).toBe('ann');
  });
});
