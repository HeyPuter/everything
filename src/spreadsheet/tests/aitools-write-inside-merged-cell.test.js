import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// write_cells stored values under a merged cell's hidden part, where no one sees them (read_range then listed them
// beside the merge's own text), and reported them written.
describe('the assistant writing over a merged cell', () => {
  function setup() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setInput(id, 0, 0, 'Title');
    wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 2 });
    return { wb, id, run: (n, a) => runTool(wb, n, a, { sheetId: () => id, selection: () => null }) };
  }

  it('leaves out the hidden cells and says so', () => {
    const { wb, id, run } = setup();
    const res = run('write_cells', { start_cell: 'A1', values: [['Report', 'x', 'y', 'z']] });
    expect(res.ok).toBe(true);
    const out = JSON.parse(res.content.split('\n')[0]);
    expect(out.cells).toBe(2);
    expect(out.not_written_inside_merged_cells).toHaveLength(2);
    expect(wb.getValue(id, 0, 0)).toBe('Report');
    expect(wb.getCell(id, 0, 1)?.v ?? null).toBe(null);
    expect(wb.getValue(id, 0, 3)).toBe('z');
  });

  it('refuses a write that lands only inside it', () => {
    const { wb, id, run } = setup();
    const res = run('write_cells', { start_cell: 'B1', values: [['x']] });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/merged cell A1:C1; write to A1/);
    expect(wb.getCell(id, 0, 1)?.v ?? null).toBe(null);
  });
});
