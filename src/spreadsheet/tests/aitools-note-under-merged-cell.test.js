import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// A cell covered by a merged cell (B1 under A1:C1) is never drawn, nor the mark that says it has a note: add_note put a
// note there and reported it added, and the user could neither see nor open it. write_cells and set_link already
// refuse such a cell and name its top-left one.
describe('add_note on a cell inside a merged cell', () => {
  function setup() {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const run = (name, args) => runTool(wb, name, args, { sheetId: () => id, selection: () => null, distrust: vi.fn() });
    run('write_cells', { start_cell: 'A1', values: [['Report', null, null]] });
    run('merge_cells', { range: 'A1:C1' });
    wb.clearHistory();
    return { wb, id, run };
  }

  it('is refused, naming the cell the note can go on', () => {
    const { wb, id, run } = setup();
    const res = run('add_note', { cell: 'B1', text: 'Check the title' });
    expect(res.ok).toBe(false);
    expect(res.content).toMatch(/B1 is inside the merged cell A1:C1, where a note does not show; put it on A1/);
    expect(wb.getNote(id, 0, 1)).toBeFalsy();
    expect(wb.canUndo()).toBe(false);
  });

  it('goes on the merged cell itself, and one already under it can still be removed', () => {
    const { wb, id, run } = setup();
    expect(run('add_note', { cell: 'A1', text: 'Check the title' }).ok).toBe(true);
    expect(wb.getNote(id, 0, 0)).toBe('Check the title');
    wb.setNote(id, 0, 2, 'left from before the merge');
    const res = run('add_note', { cell: 'C1', text: '' });
    expect(res.ok).toBe(true);
    expect(wb.getNote(id, 0, 2)).toBeFalsy();
  });
});
