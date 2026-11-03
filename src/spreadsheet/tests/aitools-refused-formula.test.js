import { describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { runTool } from '../src/core/aitools.js';

// A formula Excel refuses as typed (=ROUND(A1), =ABS(1,2), functions nested past 64 levels) is kept as the
// text of the formula when written. The assistant's write_cells and fill_formula wrote it so all the same and
// answered that the cells were written or filled: the model went on as though the formulas calculated, while
// the user found "=ROUND(A1)" as text in each cell. Such a formula is now refused, with the reason, for the
// model to write it again as Excel takes it.
function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const env = { sheetId: () => id, selection: () => ({ sheetId: id, range: { r1: 0, c1: 0, r2: 0, c2: 0 } }), distrust: vi.fn(), select: vi.fn(() => true) };
  return { wb, id, run: (name, args) => runTool(wb, name, args, env) };
}

describe('a formula Excel refuses, written by the assistant', () => {
  it('is left out of write_cells, the rest written, and said why', () => {
    const { wb, id, run } = setup();
    const out = run('write_cells', { start_cell: 'A1', values: [[1.5, '=ROUND(A1)', '=ROUND(A1,0)']] });
    expect(wb.getCell(id, 0, 1)).toBeFalsy();
    expect(wb.getValue(id, 0, 2)).toBe(2);
    expect(out.ok).not.toBe(false);
    expect(JSON.parse(out.content.split('\n')[0])).toMatchObject({ cells: 2, refused_formulas: ['B1 (ROUND needs 2 arguments)'] });
  });

  it('writes nothing when every cell is refused', () => {
    const { wb, id, run } = setup();
    expect(run('write_cells', { start_cell: 'A1', values: [['=ABS(1,2)']] })).toMatchObject({ ok: false, content: 'Error: Nothing was written: A1 (ABS takes only 1 argument).' });
    expect(wb.getCell(id, 0, 0)).toBeFalsy();
  });

  it('is refused by fill_formula before any cell is filled', () => {
    const { wb, id, run } = setup();
    expect(run('fill_formula', { range: 'B1:B3', formula: '=ROUND(A1)' })).toMatchObject({ ok: false, content: 'Error: Excel refuses this formula: ROUND needs 2 arguments.' });
    for (let r = 0; r < 3; r++) expect(wb.getCell(id, r, 1)).toBeFalsy();
    run('fill_formula', { range: 'B1:B3', formula: '=ROUND(A1,0)' });
    expect(wb.getCell(id, 2, 1).f).toBe('ROUND(A3,0)');
  });

  it('still writes text that only looks like a formula', () => {
    const { wb, id, run } = setup();
    run('write_cells', { start_cell: 'A1', values: [["'=ABS(1,2)"]] });
    expect(wb.getValue(id, 0, 0)).toBe('=ABS(1,2)');
  });
});
