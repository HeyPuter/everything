import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, replyToThread, setThreadResolved } from '../src/core/comments.js';
import { runTool, describeCall, changesWorkbook, TOOLS } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: [['Region', 'Q1', 'Q2'], ['West', 10, 12], ['East', 7, 9], ['North', 4, 15]] });
  wb.clearHistory();
  return { wb, id, env, run };
}

describe('AI tools: what the model sees besides values', () => {
  it('reads the notes and comment threads on the cells, with who wrote what', () => {
    const { wb, id, run } = setup();
    wb.setNote(id, 1, 1, 'Includes a one-off refund');
    addComment(wb, id, 2, 2, 'Is this right?', 'Ana');
    replyToThread(wb, id, 2, 2, 'Yes, checked with finance', 'Ben');
    setThreadResolved(wb, id, 2, 2, true);
    const text = run('read_range', { range: 'A1:C4' }).content;
    expect(text).toContain('Notes:\nB2: Includes a one-off refund');
    expect(text).toContain('Comments:\nC3 (resolved): Ana: Is this right? / Ben: Yes, checked with finance');
  });

  it('finds a note on cells with no values, inside or beside the data', () => {
    const { wb, id, run } = setup();
    wb.setNote(id, 9, 5, 'Fill in by Friday');
    expect(run('read_range', { range: 'F10' }).content).toBe('Sheet1!F10 holds no values.\nNotes:\nF10: Fill in by Friday');
    // A read past the values takes in the notes the range holds there too.
    expect(run('read_range', { range: 'A1:H20' }).content).toContain('F10: Fill in by Friday');
    expect(run('read_range', { range: 'G1:G5' }).content).toBe('Sheet1!G1:G5 is empty.');
  });

  it('names merged blocks, links, hidden columns and the rules that cover the cells', () => {
    const { wb, id, run } = setup();
    run('write_cells', { start_cell: 'A6', values: [['Totals']] });
    wb.mergeCells(id, { r1: 5, c1: 0, r2: 5, c2: 2 });
    wb.setLink(id, 1, 0, 'https://example.com/west');
    wb.setHidden(id, 'col', [1], true);
    run('add_conditional_format', { range: 'B2:C4', rule: 'gt', value: 10 });
    const text = run('read_range', { range: 'A1:C6' }).content;
    expect(text).toContain('Merged cells (each shows its top-left cell\'s value): A6:C6');
    expect(text).toContain('Links:\nA2 → https://example.com/west');
    expect(text).toContain('Hidden columns: B');
    expect(text).toContain('(Part of this range has conditional formatting; get_sheet_details lists the rules.)');
    // A plain read says nothing of the kind.
    expect(run('read_range', { range: 'A2:A4' }).content).not.toMatch(/Notes|Merged|Hidden|get_sheet_details/);
  });

  it('lists a sheet\'s rules, charts, merges, hidden lines and filters with ids', () => {
    const { wb, id, run } = setup();
    run('add_conditional_format', { range: 'B2:C4', rule: 'gt', value: 10, fill_color: '#ffcccc', bold: true });
    run('add_dropdown', { range: 'A2:A4', options: ['West', 'East', 'North'] });
    run('create_chart', { data_range: 'A1:C4', type: 'line', title: 'Sales' });
    wb.mergeCells(id, { r1: 8, c1: 0, r2: 8, c2: 1 });
    wb.setHidden(id, 'row', [5, 6, 7], true);
    wb.setHidden(id, 'col', [4], true);
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 2 });
    wb.setNote(id, 1, 1, 'note');
    const res = run('get_sheet_details', {});
    expect(res.ok).toBe(true);
    expect(res.changed).toBe(false);
    const d = JSON.parse(res.content);
    const sheet = wb.sheet(id);
    expect(d.conditional_formats).toEqual([{ id: sheet.rules[0].id, applies_to: 'B2:C4', rule: expect.stringMatching(/10/), format: 'fill #ffcccc, bold' }]);
    expect(d.data_validation).toEqual([{ id: sheet.validations[0].id, range: 'A2:A4', allows: 'Dropdown list: West, East, North' }]);
    expect(d.charts).toEqual([expect.objectContaining({ id: sheet.charts[0].id, type: 'line', title: 'Sales', data: 'A1:C4', placed_at: 'E1' })]);
    expect(d.merged_cells).toBe('A9:B9');
    expect(d.hidden_rows).toBe('6:8');
    expect(d.hidden_columns).toBe('E');
    expect(d.filters).toEqual([{ range: 'A1:C4', rows_hidden: 0 }]);
    expect(d.notes).toBe('B2');
  });

  it('shows a rule split over several areas as the one rule Manage Rules lists', () => {
    const { wb, id, run } = setup();
    run('add_conditional_format', { range: 'B2:C4', rule: 'gt', value: 10 });
    // Inserting a column through the rule's range splits it into pieces.
    wb.insertCols(id, 2, 1);
    const d = JSON.parse(run('get_sheet_details', {}).content);
    expect(d.conditional_formats).toHaveLength(1);
  });

  it('counts each sheet\'s rules, notes, filters and charts in the workbook overview, and leaves out hidden names', () => {
    const { wb, id, run } = setup();
    run('add_conditional_format', { range: 'B2:C4', rule: 'gt', value: 10 });
    run('create_chart', { data_range: 'A1:C4' });
    wb.setNote(id, 1, 1, 'note');
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 3, c2: 2 });
    wb.defineName('Totals', 'Sheet1!$B$2:$B$4');
    wb.names = [...wb.names, { name: '_PuterPivot_Area', ref: 'Sheet1!$A$1', hidden: true, sheet: 'Sheet1' }];
    const info = JSON.parse(run('get_workbook_info', {}).content);
    const s = info.sheets[0];
    expect(s.charts[0].id).toBe(wb.sheet(id).charts[0].id);
    expect(s.conditional_formats).toBe(1);
    expect(s.filtered).toBe('A1:C4');
    expect(s.notes).toBe(1);
    expect(info.named_ranges.map((n) => n.name)).toEqual(['Totals']);
  });

  it('is a read: described as one, and not asked about', () => {
    const { wb, id, env } = setup();
    expect(changesWorkbook('get_sheet_details')).toBe(false);
    expect(describeCall(wb, 'get_sheet_details', {}, env).label).toBe('Look over the sheet Sheet1');
    expect(TOOLS.some((t) => t.function.name === 'get_sheet_details')).toBe(true);
    expect(wb.sheet(id)).toBeTruthy();
  });

  it('names the sheets there are when asked about one that is not there', () => {
    const { run } = setup();
    const res = run('get_sheet_details', { sheet: 'Nope' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no sheet named "Nope". The sheets are: "Sheet1"/);
  });
});
