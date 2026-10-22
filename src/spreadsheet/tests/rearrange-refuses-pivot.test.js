import { expect, it } from 'vitest';
import { pivotBook } from './helpers/native-pivot-report-fixture.js';
import { rearrangeProblem } from '../src/ui/sortdialog.js';
import { addSubtotals } from '../src/core/subtotal.js';

// Sort, Remove Duplicates and Randomize moved the cells of a PivotTable report like any others: a sort of its rows
// put West above East while the report still named East first, and a sort of its columns swapped its labels with its
// values. A report is laid out from its definition, so these tools now refuse a range over one, as Excel does, with
// the reason said. (The assistant's and scripts' sorts already named a pivot table as a reason; none was ever given.)
const values = (wb, report) => [2, 3, 4, 5].map((r) => [0, 1].map((c) => wb.getValue(report.id, r, c)).join('/'));

it('refuses to rearrange the rows or columns of a PivotTable report', () => {
  const { wb, report } = pivotBook();
  wb.clearHistory();
  const before = values(wb, report);
  expect(wb.rearrangeBlocker(report.id, { r1: 3, c1: 0, r2: 4, c2: 1 })).toBe('pivot');
  expect(rearrangeProblem(wb, report.id, { r1: 3, c1: 0, r2: 4, c2: 1 })).toBe("Can't sort: the range overlaps a PivotTable");
  expect(wb.sortRangeBy(report.id, { r1: 3, c1: 0, r2: 4, c2: 1 }, [{ col: 1, ascending: false }])).toBe(false);
  expect(wb.sortColumnsBy(report.id, { r1: 2, c1: 0, r2: 5, c2: 1 }, [{ row: 2, ascending: false }])).toBe(false);
  expect(wb.shuffleRows(report.id, { r1: 3, c1: 0, r2: 5, c2: 1 }, { random: () => 0 })).toBe(0);
  expect(wb.removeDuplicates(report.id, { r1: 2, c1: 0, r2: 5, c2: 1 }, {})).toBe(false);
  expect(addSubtotals(wb, report.id, { r1: 2, c1: 0, r2: 5, c2: 1 }, { groupCol: 0, totalCols: [1] })).toBeNull();
  expect(values(wb, report)).toEqual(before);
  expect(wb.undoLabels()).toEqual([]);
});

it('still sorts the cells beside a report', () => {
  const { wb, report } = pivotBook();
  ['c', 'a', 'b'].forEach((v, i) => wb.setInput(report.id, 10 + i, 0, v));
  expect(wb.sortRangeBy(report.id, { r1: 10, c1: 0, r2: 12, c2: 0 }, [{ col: 0, ascending: true }])).toBe(true);
  expect([10, 11, 12].map((r) => wb.getValue(report.id, r, 0))).toEqual(['a', 'b', 'c']);
});
