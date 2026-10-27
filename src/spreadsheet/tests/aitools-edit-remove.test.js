import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, changesWorkbook } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  const run = (name, args) => runTool(wb, name, args, env);
  const json = (name, args) => { const res = run(name, args); if (!res.ok) throw new Error(res.content); return JSON.parse(res.content); };
  run('write_cells', { start_cell: 'A1', values: [['Month', 'Sales', 'Costs'], ['Jan', 10, 4], ['Feb', 12, 5], ['Mar', 9, 6], ['Apr', 14, 7]] });
  wb.clearHistory();
  return { wb, id, env, run, json };
}

describe('AI tools: changing and deleting charts', () => {
  it('changes a chart\'s type, titles, legend and size in one undo step, keeping its data', () => {
    const { wb, id, run, json } = setup();
    const { id: chartId } = json('create_chart', { data_range: 'A1:C5', type: 'line', title: 'Sales' });
    wb.clearHistory();
    const res = json('update_chart', { chart: chartId, type: 'column', stacked: true, title: 'Sales and costs', y_title: 'USD', legend: 'none', width: 600, height: 320 });
    expect(res.changed).toEqual(['type: stacked column', 'title', 'vertical axis title', 'legend none', 'width 600px', 'height 320px']);
    const chart = wb.chartById(id, chartId);
    expect(chart).toMatchObject({ type: 'column', stacked: true, title: 'Sales and costs', yTitle: 'USD', legend: false, w: 600, h: 320, range: { r1: 0, c1: 0, r2: 4, c2: 2 } });
    expect(wb.undoLabels(5)).toEqual(['AI edit']);
    wb.undo();
    expect(wb.chartById(id, chartId)).toMatchObject({ type: 'line', title: 'Sales', legend: true });
  });

  it('finds a chart by its title, and points the model at the ids when it cannot', () => {
    const { wb, id, run, json } = setup();
    json('create_chart', { data_range: 'A1:B5', title: 'Sales' });
    json('update_chart', { chart: 'sales', data_range: 'A1:C5', anchor_cell: 'H3' });
    expect(wb.sheet(id).charts[0]).toMatchObject({ range: { r1: 0, c1: 0, r2: 4, c2: 2 }, anchor: { r: 2, c: 7 } });
    const missing = run('update_chart', { chart: 'Profit', title: 'x' });
    expect(missing.ok).toBe(false);
    expect(missing.content).toMatch(/There is no chart "Profit". The charts are: s\w+ \(column "Sales" on Sheet1\)/);
    json('create_chart', { data_range: 'A1:B5', title: 'Sales' });
    expect(run('delete_chart', { chart: 'Sales' }).content).toMatch(/2 charts are called "Sales"/);
  });

  it('says so when the chart already is what was asked, and changes nothing', () => {
    const { wb, json, run } = setup();
    const { id: chartId } = json('create_chart', { data_range: 'A1:C5', type: 'line' });
    const before = wb.version;
    const res = run('update_chart', { chart: chartId, type: 'line' });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.content.split('\n')[0]).unchanged).toBe('It is already a line chart.');
    expect(wb.version).toBe(before);
  });

  it('keeps a chart stacked, and stacked to 100%, when only its type is given', () => {
    const { wb, id, run, json } = setup();
    const { id: chartId } = json('create_chart', { data_range: 'A1:C5', type: 'column', stacked: true });
    expect(json('update_chart', { chart: chartId, type: 'bar' }).changed).toEqual(['type: stacked bar']);
    expect(wb.chartById(id, chartId)).toMatchObject({ type: 'bar', stacked: true });
    wb.updateChart(id, chartId, { type: 'column', stacked: true, stack100: true });
    expect(json('update_chart', { chart: chartId, type: 'area' }).changed).toEqual(['type: 100% stacked area']);
    expect(wb.chartById(id, chartId)).toMatchObject({ type: 'area', stacked: true, stack100: true });
    // Asked to stack a chart stacked to 100%, it already is.
    expect(run('update_chart', { chart: chartId, stacked: true }).content).toContain('It is already a 100% stacked area chart.');
    expect(wb.chartById(id, chartId).stack100).toBe(true);
    expect(json('get_sheet_details', {}).charts[0].stacked).toBe('100%');
    // Unstacking still unstacks, and a type that cannot stack does not.
    json('update_chart', { chart: chartId, stacked: false });
    expect(wb.chartById(id, chartId)).toMatchObject({ type: 'area', stacked: false, stack100: false });
    json('update_chart', { chart: chartId, stacked: true });
    expect(json('update_chart', { chart: chartId, type: 'pie' }).changed).toEqual(['type: pie']);
    expect(wb.chartById(id, chartId).stacked).toBe(false);
  });

  it('refuses stacking a pie, data on another sheet, and a protected sheet', () => {
    const { wb, id, run, json } = setup();
    const { id: chartId } = json('create_chart', { data_range: 'A1:B5', type: 'pie' });
    expect(run('update_chart', { chart: chartId, stacked: true }).content).toMatch(/A pie chart cannot be stacked/);
    wb.addSheet('Other');
    expect(run('update_chart', { chart: chartId, data_range: 'Other!A1:B3' }).content).toMatch(/its data must be on that sheet too/);
    wb.sheet(id).protected = true;
    expect(run('update_chart', { chart: chartId, title: 'x' }).content).toMatch(/Sheet1 is protected/);
    expect(run('delete_chart', { chart: chartId }).content).toMatch(/Sheet1 is protected/);
    expect(wb.sheet(id).charts).toHaveLength(1);
  });

  it('deletes a chart, asking first, and undoes it', () => {
    const { wb, id, env, json } = setup();
    const { id: chartId } = json('create_chart', { data_range: 'A1:B5', title: 'Sales' });
    expect(describeCall(wb, 'delete_chart', { chart: chartId }, env)).toEqual({ label: 'Delete the column chart “Sales” on Sheet1', destructive: true, detail: 'Removes the chart and its formatting.' });
    expect(describeCall(wb, 'update_chart', { chart: chartId, title: 'x' }, env).label).toBe('Change the column chart “Sales” on Sheet1');
    expect(json('delete_chart', { chart: chartId }).deleted).toBe('column chart "Sales" on Sheet1');
    expect(wb.sheet(id).charts).toHaveLength(0);
    wb.undo();
    expect(wb.sheet(id).charts).toHaveLength(1);
    expect(changesWorkbook('delete_chart')).toBe(true);
  });
});

describe('AI tools: removing conditional formatting', () => {
  it('removes one rule by its id', () => {
    const { wb, id, json } = setup();
    const { id: ruleId } = json('add_conditional_format', { range: 'B2:B5', rule: 'gt', value: 10 });
    json('add_conditional_format', { range: 'C2:C5', rule: 'lt', value: 5 });
    wb.clearHistory();
    const res = json('remove_conditional_format', { rule_id: ruleId });
    expect(res.removed).toMatch(/B2:B5/);
    expect(res.rules_left_on_sheet).toBe(1);
    expect(wb.sheet(id).rules.map((r) => r.type)).toEqual(['lt']);
    expect(wb.undoLabels(5)).toHaveLength(1);
  });

  it('takes rules off some cells, leaving the rest of their range, and asks first', () => {
    const { wb, id, env, json } = setup();
    json('add_conditional_format', { range: 'B2:B5', rule: 'gt', value: 10 });
    expect(describeCall(wb, 'remove_conditional_format', { range: 'B2:B3' }, env)).toEqual({ label: 'Remove the rules on Sheet1!B2:B3', destructive: true, detail: 'Takes a conditional formatting rule off these cells.' });
    json('remove_conditional_format', { range: 'B2:B3' });
    expect(wb.sheet(id).rules.map((r) => r.range)).toEqual([{ r1: 3, c1: 1, r2: 4, c2: 1 }]);
  });

  it('takes a rule of thousands of areas off a few cells without freezing', () => {
    const { wb, id, json } = setup();
    // A rule from a file on every other row: 20,000 areas, one rule.
    wb.sheet(id).rules = Array.from({ length: 20000 }, (_, i) => ({ id: `r${i}`, type: 'gt', value: 5, range: { r1: i * 2, c1: 3, r2: i * 2, c2: 3 }, style: { bg: '#ff0000' } }));
    const started = Date.now();
    expect(json('remove_conditional_format', { range: 'D1:D100' }).removed).toBe('1 rule from Sheet1!D1:D100');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(wb.sheet(id).rules).toHaveLength(19950);
    expect(wb.sheet(id).rules[0].range).toEqual({ r1: 100, c1: 3, r2: 100, c2: 3 });
  });

  it('clears a whole sheet, and says when there was nothing to clear', () => {
    const { wb, id, run, json } = setup();
    json('add_conditional_format', { range: 'B2:B5', rule: 'gt', value: 10 });
    json('add_conditional_format', { range: 'C2:C5', rule: 'scale' });
    expect(json('remove_conditional_format', { whole_sheet: true }).removed).toBe('2 rules from Sheet1');
    expect(wb.sheet(id).rules).toEqual([]);
    expect(run('remove_conditional_format', { range: 'A1:C5' }).content).toMatch(/has no conditional formatting/);
    expect(run('remove_conditional_format', {}).content).toMatch(/Give rule_id, a range, or whole_sheet/);
    expect(run('remove_conditional_format', { rule_id: 'nope' }).content).toMatch(/no conditional formatting rule with the id "nope"/);
  });
});

describe('AI tools: data validation', () => {
  it('limits cells to whole numbers in bounds, which write_cells then keeps to', () => {
    const { wb, id, run, json } = setup();
    const res = json('add_validation', { range: 'B2:B5', type: 'whole', min: 0, max: 20 });
    expect(res.allows).toBe('Whole number: between 0 and 20');
    expect(wb.undoLabels(5)).toEqual(['Add validation']);
    const write = JSON.parse(run('write_cells', { start_cell: 'B6', values: [[25]] }).content);
    expect(write.cells).toBe(1); // B6 is outside the rule
    const refused = run('write_cells', { start_cell: 'B2', values: [[25]] });
    expect(refused.content).toMatch(/B2/);
    expect(wb.getValue(id, 1, 1)).toBe(10);
  });

  it('reads dates, times and text lengths as the dialog does', () => {
    const { wb, id, json } = setup();
    expect(json('add_validation', { range: 'D2:D5', type: 'date', operator: 'greaterThanOrEqual', min: '2024-01-01' }).allows).toMatch(/2024-01-01/);
    const date = wb.sheet(id).validations.at(-1);
    expect(date).toMatchObject({ type: 'date', operator: 'greaterThanOrEqual', min: 45292 });
    json('add_validation', { range: 'E2:E5', type: 'time', min: '09:00', max: '17:30' });
    expect(wb.sheet(id).validations.at(-1)).toMatchObject({ type: 'time', min: 0.375 });
    expect(wb.sheet(id).validations.at(-1).max).toBeCloseTo(17.5 / 24);
    json('add_validation', { range: 'F2:F5', type: 'text_length', operator: 'lessThanOrEqual', min: 10 });
    expect(wb.sheet(id).validations.at(-1)).toMatchObject({ type: 'text', operator: 'lessThanOrEqual', min: 10 });
  });

  it('refuses bounds that cannot work', () => {
    const { run } = setup();
    expect(run('add_validation', { range: 'B2:B5', type: 'decimal', min: 5, max: 1 }).content).toMatch(/min must not be more than max/);
    expect(run('add_validation', { range: 'B2:B5', type: 'whole', operator: 'greaterThan' }).content).toMatch(/needs min/);
    expect(run('add_validation', { range: 'B2:B5', type: 'date', min: '1/2/2024' }).content).toMatch(/YYYY-MM-DD/);
    expect(run('add_validation', { range: 'B2:B5', type: 'text_length', min: 1.5, max: 3 }).content).toMatch(/whole numbers/);
    expect(run('add_validation', { range: 'B2:B5', type: 'colour' }).content).toMatch(/type must be one of/);
  });

  it('checks a custom formula as the dialog does, and keeps it from reaching out', () => {
    const { wb, id, run, json } = setup();
    json('add_validation', { range: 'A2:A5', type: 'custom', formula: '=COUNTIF($A$2:$A$5,A2)=1' });
    expect(wb.sheet(id).validations[0]).toMatchObject({ type: 'formula', source: '=COUNTIF($A$2:$A$5,A2)=1' });
    expect(run('add_validation', { range: 'A2:A5', type: 'custom', formula: '=NOSUCH(A2)' }).content).toMatch(/gives #NAME\?/);
    expect(run('add_validation', { range: 'A2:A5', type: 'custom', formula: '=IMPORTDATA("https://x.test")<>""' }).content).toMatch(/cannot reach outside/);
  });

  it('says which cells already break the new rule, and keeps them', () => {
    const { wb, id, json } = setup();
    const res = json('add_validation', { range: 'B2:B5', type: 'whole', operator: 'lessThan', min: 11 });
    expect(res.note).toMatch(/^2 cells already hold values the rule does not allow \(B3, B5\)/);
    expect(wb.getValue(id, 2, 1)).toBe(12);
  });

  it('asks before replacing a dropdown on the same cells', () => {
    const { wb, env, json } = setup();
    json('add_dropdown', { range: 'A2:A5', options: ['Jan', 'Feb'] });
    expect(describeCall(wb, 'add_validation', { range: 'A2:A5', type: 'custom', formula: '=LEN(A2)=3' }, env)).toMatchObject({ destructive: true, label: 'Replace the dropdown on Sheet1!A2:A5' });
    expect(describeCall(wb, 'add_validation', { range: 'B2:B5', type: 'whole', min: 1, max: 2 }, env)).toEqual({ label: 'Limit what Sheet1!B2:B5 may hold' });
    expect(json('add_validation', { range: 'A2:A5', type: 'custom', formula: '=LEN(A2)=3' }).replaced).toBe('the dropdown these cells had before');
  });

  it('removes a rule by id, or takes validation off some cells and keeps the rest reading from its own corner', () => {
    const { wb, id, env, json } = setup();
    const { id: ruleId } = json('add_validation', { range: 'B2:B5', type: 'whole', min: 0, max: 99 });
    json('add_validation', { range: 'C2:C5', type: 'custom', formula: '=C2<B2' });
    expect(describeCall(wb, 'remove_validation', { rule_id: ruleId }, env)).toEqual({ label: 'Remove the validation rule on Sheet1!B2:B5', destructive: true, detail: 'Removes a validation rule.' });
    json('remove_validation', { rule_id: ruleId });
    expect(wb.sheet(id).validations).toHaveLength(1);
    wb.clearHistory();
    json('remove_validation', { range: 'C2:C3' });
    expect(wb.sheet(id).validations).toEqual([expect.objectContaining({ range: { r1: 3, c1: 2, r2: 4, c2: 2 }, source: '=C4<B4' })]);
    expect(wb.undoLabels(5)).toHaveLength(1);
    wb.undo();
    expect(wb.sheet(id).validations[0]).toMatchObject({ range: { r1: 1, c1: 2, r2: 4, c2: 2 }, source: '=C2<B2' });
  });

  it('removes dropdowns too, and says when there is no validation', () => {
    const { wb, id, env, run, json } = setup();
    json('add_dropdown', { range: 'A2:A5', options: ['Jan', 'Feb'] });
    expect(describeCall(wb, 'remove_validation', { range: 'A:A' }, env).detail).toBe('Takes a dropdown off these cells.');
    json('remove_validation', { range: 'A:A' });
    expect(wb.sheet(id).validations).toEqual([]);
    expect(run('remove_validation', { range: 'A1:C5' }).content).toMatch(/has no data validation/);
  });

  it('refuses on a protected sheet', () => {
    const { wb, id, run } = setup();
    wb.sheet(id).protected = true;
    expect(run('add_validation', { range: 'B2:B5', type: 'whole', min: 0, max: 9 }).content).toMatch(/Sheet1 is protected/);
    expect(run('remove_validation', { range: 'B2:B5' }).content).toMatch(/Sheet1 is protected/);
  });
});

describe('AI tools: clearing formats', () => {
  it('takes conditional formatting and merges off the cells, as Clear Formats does, in one step', () => {
    const { wb, id, json } = setup();
    json('add_conditional_format', { range: 'B2:B5', rule: 'gt', value: 10 });
    wb.mergeCells(id, { r1: 5, c1: 0, r2: 5, c2: 2 });
    wb.clearHistory();
    json('clear_range', { range: 'A3:C6', what: 'formats' });
    expect(wb.sheet(id).rules.map((r) => r.range)).toEqual([{ r1: 1, c1: 1, r2: 1, c2: 1 }]);
    expect(wb.sheet(id).merges).toEqual([]);
    expect(wb.getValue(id, 2, 1)).toBe(12);
    expect(wb.undoLabels(5)).toHaveLength(1);
    wb.undo();
    expect(wb.sheet(id).rules[0].range).toEqual({ r1: 1, c1: 1, r2: 4, c2: 1 });
    expect(wb.sheet(id).merges).toHaveLength(1);
  });

  it('asks first when the formats it clears include conditional formatting', () => {
    const { wb, env, json } = setup();
    json('add_conditional_format', { range: 'B2:B5', rule: 'gt', value: 10 });
    json('add_conditional_format', { range: 'C2:C5', rule: 'scale' });
    expect(describeCall(wb, 'clear_range', { range: 'B4:C9', what: 'formats' }, env)).toEqual({ label: 'Clear the formatting of Sheet1!B4:C9', destructive: true, detail: 'Takes 2 conditional formatting rules off these cells.' });
    expect(describeCall(wb, 'clear_range', { range: 'B2:B3', what: 'all' }, env)).toEqual({ label: 'Clear everything in Sheet1!B2:B3', destructive: true, detail: 'Removes 2 cells of data. Takes a conditional formatting rule off these cells.' });
    // Contents alone leave the rules, and formats away from them ask nothing.
    expect(describeCall(wb, 'clear_range', { range: 'B2:B3' }, env).detail).toBe('Removes 2 cells of data.');
    expect(describeCall(wb, 'clear_range', { range: 'E1:F9', what: 'formats' }, env)).toMatchObject({ destructive: false, detail: null });
  });

  it('leaves them when only contents are cleared', () => {
    const { wb, id, json } = setup();
    json('add_conditional_format', { range: 'B2:B5', rule: 'gt', value: 10 });
    json('clear_range', { range: 'B2:B5' });
    expect(wb.sheet(id).rules).toHaveLength(1);
  });
});
