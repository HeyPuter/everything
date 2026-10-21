import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Expanding a group (or ungrouping a collapsed one) asked, line by line, whether some other collapsed group still held
// the line, comparing it with every group: the outer group of a Subtotal outline of 20,000 groups took a second and a
// half to open. The lines still held are now found in one pass over the groups.
it('expands the outer group of an outline of 20,000 groups at once, its collapsed groups staying shut', () => {
  const n = 20000;
  const rows = [{ from: 0, to: n * 3, collapsed: false }];
  for (let i = 0; i < n; i++) rows.push({ from: i * 3 + 1, to: i * 3 + 2, collapsed: false });
  const wb = new Workbook({ sheets: [{ name: 'S', rows: n * 3 + 10, groups: { rows, cols: [] } }] });
  const id = wb.activeSheetId;
  wb.setAllGroups(id, 'row', true);
  wb.toggleGroup(id, 'row', 4, 5); // one inner group open again, under the closed outer one
  const start = performance.now();
  wb.toggleGroup(id, 'row', 0, n * 3);
  expect(performance.now() - start).toBeLessThan(400);
  const hidden = wb.sheet(id).hiddenRows;
  expect([0, 3, 4, 5, 6].map((r) => hidden.has(r))).toEqual([false, false, false, false, false]);
  expect([1, 2, 7, 8].map((r) => hidden.has(r))).toEqual([true, true, true, true]);
  expect(hidden.size).toBe((n - 1) * 2);
  // Ungrouping a collapsed group shows only the lines no other collapsed group holds.
  wb.toggleGroup(id, 'row', 0, n * 3);
  wb.ungroupLines(id, 'row', 0, n * 3);
  expect(wb.sheet(id).hiddenRows.size).toBe((n - 1) * 2);
  expect(wb.sheet(id).hiddenRows.has(4)).toBe(false);
});
