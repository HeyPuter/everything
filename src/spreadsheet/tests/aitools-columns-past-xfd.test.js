import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool, describeCall } from '../src/core/aitools.js';

// A column letter past XFD names no column, yet the tools took it: set_column_width "XFE" stored a width for a 16,385th
// column (reported as resized), set_hidden "XFE" said a sheet keeps one column showing, and insert_columns given a long
// run of letters named a column so far out that spelling it for the result never ended, and the tab ran out of memory.
describe('column letters past XFD', () => {
  function setup() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const env = { sheetId: () => id, selection: () => null, distrust: vi.fn(), autofit: vi.fn() };
    const run = (name, args) => runTool(wb, name, args, env);
    run('write_cells', { start_cell: 'A1', values: [['a', 1], ['b', 2]] });
    wb.clearHistory();
    return { wb, id, env, run };
  }

  it('are refused as columns, and nothing is sized or hidden', () => {
    const { wb, id, run } = setup();
    for (const [name, args] of [['set_column_width', { columns: 'XFE', width: '50' }], ['set_column_width', { columns: 'XFC:XFE', width: '50' }],
      ['set_hidden', { columns: 'XFE', hidden: true }], ['insert_columns', { before_column: 'XFE' }], ['delete_columns', { start_column: 'ZZZZ' }]]) {
      const res = run(name, args);
      expect(res.ok, name).toBe(false);
      expect(res.content).toMatch(/is not a column letter such as "C" \(columns run from A to XFD\)/);
    }
    expect([...wb.sheet(id).colWidths.keys()]).toEqual([]);
    expect(wb.canUndo()).toBe(false);
  });

  it('answers at once for a long run of letters', () => {
    const { wb, env, run } = setup();
    const letters = 'X'.repeat(300);
    expect(describeCall(wb, 'delete_columns', { start_column: letters }, env).destructive).toBe(false);
    const res = run('insert_columns', { before_column: letters });
    expect(res.ok).toBe(false);
    expect(res.content.length).toBeLessThan(200);
  });

  it('still takes XFD, the last column', () => {
    const { wb, id, run } = setup();
    expect(run('set_column_width', { columns: 'XFD', width: '50' }).ok).toBe(true);
    expect(wb.sheet(id).colWidths.get(16383)).toBe(50);
  });
});
