import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, replyToThread, setThreadResolved } from '../src/core/comments.js';
import { runTool, describeCall, changesWorkbook, TOOLS } from '../src/core/aitools.js';
import { workbookFromFile } from '../src/core/io.js';
import { chartXlsx } from './helpers/xlsx-chart-fixture.js';

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
    expect(d.data_validation).toEqual([{ id: sheet.validations[0].id, range: 'A2:A4', allows: 'List: West, East, North' }]);
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

  it('names the cells a chart from a file draws, not the placeholder range it keeps', async () => {
    const wb = await workbookFromFile(new Uint8Array(chartXlsx({ embedded: true })), 'run.xlsx');
    const sheet = wb.sheets[0];
    const env = { sheetId: () => sheet.id, selection: () => null, distrust: vi.fn(), select: vi.fn(() => true) };
    const chart = sheet.charts[0];
    expect(chart.sourceRefs.length).toBe(2);
    const details = JSON.parse(runTool(wb, 'get_sheet_details', {}, env).content);
    expect(details.charts[0].data).toBe('series from Data!$A$1:$A$80, Data!$B$1:$B$80, Data!$C$1:$C$22');
    const info = JSON.parse(runTool(wb, 'get_workbook_info', {}, env).content);
    expect(info.sheets[0].charts[0].data).toBe(details.charts[0].data);
    const changed = JSON.parse(runTool(wb, 'update_chart', { chart: chart.id, type: 'column' }, env).content);
    expect(changed.data).toBe(details.charts[0].data);
  });

  it('holds a rule of thousands of areas, a long formula and many charts to a length', () => {
    const { wb, id, run } = setup();
    const sheet = wb.sheet(id);
    // A rule from a file, on every other row: one rule of 5,000 areas.
    sheet.rules = Array.from({ length: 5000 }, (_, i) => ({ id: `r${i}`, type: 'gt', value: 5, range: { r1: i * 2, c1: 3, r2: i * 2, c2: 3 }, style: { bg: '#ff0000' } }));
    sheet.rules.push({ id: 'long', type: 'formula', value: `=${Array.from({ length: 2000 }, (_, i) => `A${i + 1}`).join('+')}>0`, range: { r1: 0, c1: 6, r2: 9, c2: 6 }, style: { bold: true } });
    const text = run('get_sheet_details', {}).content;
    const [first, second] = JSON.parse(text).conditional_formats;
    expect(first.applies_to).toMatch(/^D1, D3, D5, .* and 4960 more$/);
    expect(second.rule.length).toBeLessThan(500);
    expect(text.length).toBeLessThan(4000);
    for (let i = 0; i < 100; i++) run('create_chart', { data_range: 'A1:C4', title: `Chart ${i} ${'x'.repeat(400)}` });
    const charts = JSON.parse(run('get_workbook_info', {}).content).sheets[0].charts;
    expect(charts).toHaveLength(81);
    expect(charts[0].title.length).toBeLessThan(210);
    expect(charts[80]).toBe('(20 more; get_sheet_details lists them)');
  });
});
