import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall } from '../src/core/aitools.js';

// A sheet whose name needs quotes in a reference ("Q1 Data", "2024", "It's") named without them, as a model often writes
// it: the sheet exists and the address is right, yet every tool said `"Q1 Data!B2" is not a range. Use A1 notation…`,
// which sent the model looking for what was wrong with the address.
describe('ranges on a sheet named without the quotes its name needs', () => {
  function setup() {
    const wb = new Workbook({ sheets: [{ name: 'Sheet1' }, { name: 'Q1 Data' }, { name: '2024' }, { name: "It's" }] });
    const id = wb.sheets[0].id;
    const env = { sheetId: () => id, selection: () => null, distrust: vi.fn() };
    return { wb, env, run: (name, args) => runTool(wb, name, args, env) };
  }

  it('reads and writes the sheet meant', () => {
    const { wb, env, run } = setup();
    expect(run('write_cells', { start_cell: 'Q1 Data!B2', values: [[5]] }).ok).toBe(true);
    expect(wb.getValue(wb.sheets[1].id, 1, 1)).toBe(5);
    expect(run('read_range', { range: 'Q1 Data!A1:B2' }).content).toMatch(/^'Q1 Data'!A1:B2 /);
    expect(run('write_cells', { start_cell: '2024!A1', values: [['x']] }).ok).toBe(true);
    expect(wb.getValue(wb.sheets[2].id, 0, 0)).toBe('x');
    expect(run('add_note', { cell: "It's!C3", text: 'n' }).ok).toBe(true);
    expect(wb.getNote(wb.sheets[3].id, 2, 2)).toBe('n');
    expect(describeCall(wb, 'clear_range', { range: 'Q1 Data!B2' }, env).label).toBe("Clear 'Q1 Data'!B2");
  });

  it('still names a sheet that does not exist, and an address that is not one', () => {
    const { run } = setup();
    expect(run('read_range', { range: 'Q2 Data!A1' }).content).toMatch(/There is no sheet named "Q2 Data"/);
    expect(run('read_range', { range: 'Q1 Data!A0' }).content).toMatch(/"Q1 Data!A0" is not a range/);
    expect(run('read_range', { range: "'Q1 Data!A1" }).content).toMatch(/There is no sheet named|is not a range/);
  });
});
