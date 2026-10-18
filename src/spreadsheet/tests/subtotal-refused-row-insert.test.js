import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addSubtotals } from '../src/core/subtotal.js';

// Each total row goes into a row inserted for it. When the insertion was refused (a protected range or an
// array formula reaching across the rows), the total was written anyway, over the next group's first row.
function book(prepare) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Sales'], ['East', '1'], ['East', '2'], ['West', '3'], ['West', '4']]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  prepare(wb, id);
  return { wb, id };
}
const rows = (wb, id) => [0, 1, 2, 3, 4].map((r) => `${wb.getDisplay(id, r, 0)}|${wb.getDisplay(id, r, 1)}`);
const DATA = ['Region|Sales', 'East|1', 'East|2', 'West|3', 'West|4'];

describe('subtotals where a total row cannot be inserted', () => {
  it('adds nothing, and overwrites nothing, beside a protected range', () => {
    const { wb, id } = book((wb, id) => wb.protectRange(id, { r1: 1, c1: 6, r2: 4, c2: 6 }, 'notes'));
    const steps = wb.undoLabels(50).length;
    expect(addSubtotals(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { groupCol: 0, totalCols: [1], sort: false })).toBeNull();
    expect(rows(wb, id)).toEqual(DATA);
    expect(wb.getDisplay(id, 5, 0)).toBe('');
    expect(wb.sheet(id).groups.rows).toEqual([]);
    expect(wb.undoLabels(50).length).toBe(steps);
  });

  it('adds nothing beside an array formula across the rows', () => {
    const { wb, id } = book((wb, id) => wb.setArrayFormula(id, { r1: 1, c1: 6, r2: 4, c2: 6 }, '=B2:B5*2'));
    expect(addSubtotals(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { groupCol: 0, totalCols: [1], sort: false })).toBeNull();
    expect(rows(wb, id)).toEqual(DATA);
    expect(wb.getValue(id, 4, 6)).toBe(8);
  });

  it('takes back the sort it made first, leaving nothing to redo', () => {
    const { wb, id } = book((wb, id) => {
      wb.setInput(id, 2, 0, 'West');
      wb.setInput(id, 3, 0, 'East');
      wb.protectRange(id, { r1: 1, c1: 6, r2: 4, c2: 6 }, 'notes');
    });
    expect(addSubtotals(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { groupCol: 0, totalCols: [1] })).toBeNull();
    expect(rows(wb, id)).toEqual(['Region|Sales', 'East|1', 'West|2', 'East|3', 'West|4']);
    expect(wb.redoLabels()).toEqual([]);
  });
});
