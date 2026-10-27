import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall, TOOLS, changesWorkbook } from '../src/core/aitools.js';

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn() };
  const run = (name, args) => runTool(wb, name, args, env);
  run('write_cells', { start_cell: 'A1', values: [['Item', 'Price'], ['Apples', 2], ['Pears', 3], ['Plums', 5]] });
  wb.clearHistory();
  return { wb, id, env, run };
}

const parsed = (res) => JSON.parse(res.content);

describe('AI tool manage_name', () => {
  it('is described and changes the workbook', () => {
    expect(TOOLS.some((t) => t.function.name === 'manage_name')).toBe(true);
    expect(changesWorkbook('manage_name')).toBe(true);
  });

  it('defines a range name anchored on the active sheet, as one undo step, and formulas use it', () => {
    const { wb, id, run } = setup();
    const res = run('manage_name', { action: 'define', name: 'Prices', refers_to: 'B2:B4' });
    expect(res.ok).toBe(true);
    expect(parsed(res).refers_to).toBe('Sheet1!$B$2:$B$4');
    expect(wb.namedEntry('Prices').ref).toBe('Sheet1!$B$2:$B$4');
    expect(wb.undoLabels(5)).toEqual(['Define name']); // one step
    run('write_cells', { start_cell: 'D1', values: [['=SUM(Prices)']] });
    expect(wb.getValue(id, 0, 3)).toBe(10);
    wb.undo(); wb.undo();
    expect(wb.namedEntry('Prices')).toBeUndefined();
  });

  it('keeps whole columns as columns, and a sheet-qualified range anchored', () => {
    const { wb, run } = setup();
    wb.addSheet('Q1 Data');
    expect(parsed(run('manage_name', { action: 'define', name: 'Col', refers_to: 'B:B' })).refers_to).toBe('Sheet1!$B:$B');
    expect(parsed(run('manage_name', { action: 'define', name: 'Other', refers_to: "'Q1 Data'!a1:c3" })).refers_to).toBe("'Q1 Data'!$A$1:$C$3");
    expect(wb.namedRef('Col').kind).toBeTruthy();
  });

  it('defines a named formula as given', () => {
    const { wb, id, run } = setup();
    expect(parsed(run('manage_name', { action: 'define', name: 'TaxRate', refers_to: '=0.2' })).refers_to).toBe('0.2');
    run('manage_name', { action: 'define', name: 'Double', refers_to: '=LAMBDA(x, x*2)' });
    run('write_cells', { start_cell: 'D1', values: [['=B2*TaxRate', '=Double(4)']] });
    expect(wb.getValue(id, 0, 3)).toBeCloseTo(0.4);
    expect(wb.getValue(id, 0, 4)).toBe(8);
  });

  it('refuses a bad name or reference with the reason, changing nothing', () => {
    const { wb, run } = setup();
    for (const [args, why] of [
      [{ action: 'define', name: 'A1', refers_to: 'B2' }, /cell reference/],
      [{ action: 'define', name: '1abc', refers_to: 'B2' }, /Names start with a letter/],
      [{ action: 'define', name: 'Lost', refers_to: 'Nowhere!A1' }, /no sheet/i],
      [{ action: 'define', name: 'Typo', refers_to: 'Sumtotal' }, /Enter a reference/],
      [{ action: 'define', name: 'Empty' }, /refers_to/],
      [{ action: 'define', name: 'X', refers_to: 'B2', scope: 'Nope' }, /no sheet named "Nope"/],
    ]) {
      const res = run('manage_name', args);
      expect(res.ok).toBe(false);
      expect(res.content).toMatch(why);
    }
    expect(wb.names.length).toBe(0);
    expect(wb.undoLabels(5)).toEqual([]);
  });

  it('redefines an existing name, says what it replaced, and asks first', () => {
    const { wb, env, run } = setup();
    run('manage_name', { action: 'define', name: 'Prices', refers_to: 'B2:B4' });
    run('write_cells', { start_cell: 'D1', values: [['=SUM(Prices)']] });
    const d = describeCall(wb, 'manage_name', { action: 'define', name: 'prices', refers_to: 'B2:B3' }, env);
    expect(d.destructive).toBe(true);
    expect(d.label).toBe('Change Prices to refer to Sheet1!$B$2:$B$3');
    expect(d.detail).toMatch(/Sheet1!\$B\$2:\$B\$4 now, and 1 formula that uses it/);
    const res = parsed(run('manage_name', { action: 'define', name: 'Prices', refers_to: 'B2:B3' }));
    expect(res.replaced).toMatch(/\$B\$4/);
    expect(wb.getValue(wb.activeSheetId, 0, 3)).toBe(5);
    expect(wb.names.length).toBe(1);
    // A new name asks nothing.
    expect(describeCall(wb, 'manage_name', { action: 'define', name: 'Fresh', refers_to: 'A1' }, env)).toEqual({ label: 'Define the name Fresh as Sheet1!$A$1' });
  });

  it('keeps sheet-scoped names apart from workbook ones', () => {
    const { wb, run } = setup();
    run('manage_name', { action: 'define', name: 'Rate', refers_to: '=0.1' });
    const res = parsed(run('manage_name', { action: 'define', name: 'Rate', refers_to: '=0.3', scope: 'Sheet1' }));
    expect(res.scope).toBe('Sheet1');
    expect(res.defined).toBe('Sheet1!Rate');
    expect(wb.names.length).toBe(2);
    const del = run('manage_name', { action: 'delete', name: 'Rate', scope: 'Sheet1' });
    expect(del.ok).toBe(true);
    expect(wb.names.map((n) => n.sheet || null)).toEqual([null]);
  });

  it('renames a name and the formulas that use it follow', () => {
    const { wb, id, run } = setup();
    run('manage_name', { action: 'define', name: 'Prices', refers_to: 'B2:B4' });
    run('write_cells', { start_cell: 'D1', values: [['=SUM(Prices)']] });
    wb.clearHistory();
    const res = run('manage_name', { action: 'rename', name: 'Prices', new_name: 'UnitPrices' });
    expect(res.ok).toBe(true);
    expect(wb.getCell(id, 0, 3).f).toBe('SUM(UnitPrices)');
    expect(wb.getValue(id, 0, 3)).toBe(10);
    expect(wb.undoLabels(5)).toHaveLength(1);
    wb.undo();
    expect(wb.getCell(id, 0, 3).f).toBe('SUM(Prices)');
    expect(wb.namedEntry('Prices')).toBeTruthy();
  });

  it('refuses to rename or delete a name that is not there, naming the one in another scope', () => {
    const { run } = setup();
    run('manage_name', { action: 'define', name: 'Rate', refers_to: '=0.3', scope: 'Sheet1' });
    const res = run('manage_name', { action: 'delete', name: 'Rate' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/no name Rate in the workbook scope.*Sheet1!Rate \(scope Sheet1\)/);
    expect(run('manage_name', { action: 'rename', name: 'Rate', scope: 'Sheet1' }).content).toMatch(/new_name/);
  });

  it('deletes a name, asks first, and says which formulas lost it', () => {
    const { wb, id, env, run } = setup();
    run('manage_name', { action: 'define', name: 'Prices', refers_to: 'B2:B4' });
    run('write_cells', { start_cell: 'D1', values: [['=SUM(Prices)'], ['=MAX(Prices)']] });
    const d = describeCall(wb, 'manage_name', { action: 'delete', name: 'Prices' }, env);
    expect(d).toMatchObject({ label: 'Delete the name Prices', destructive: true });
    expect(d.detail).toMatch(/\(2\) will show #NAME\?/);
    const res = parsed(run('manage_name', { action: 'delete', name: 'prices' }));
    expect(res.note).toMatch(/2 formulas use it/);
    expect(wb.getValue(id, 0, 3)?.error).toBe('#NAME?');
  });

  it('leaves the workbook\'s own hidden names alone', () => {
    const { wb, run } = setup();
    wb.names = [{ name: '_PuterPivot_Source', ref: 'Sheet1!$A$1:$B$4', hidden: true, sheet: 'Sheet1' }];
    const res = run('manage_name', { action: 'delete', name: '_PuterPivot_Source', scope: 'Sheet1' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/hidden name/);
    expect(wb.names.length).toBe(1);
  });

  it('distrusts a name that reaches outside the workbook, as a formula that does', () => {
    const { env, run } = setup();
    const res = parsed(run('manage_name', { action: 'define', name: 'Grab', refers_to: '=LAMBDA(u, IMPORTDATA(u))' }));
    expect(env.distrust).toHaveBeenCalled();
    expect(res.note).toMatch(/#BLOCKED!/);
  });

  it('a name the same as a table is refused', () => {
    const { wb, id, run } = setup();
    wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 1 }, { name: 'Fruit' });
    const res = run('manage_name', { action: 'define', name: 'fruit', refers_to: 'B2' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/already used/);
  });
});
