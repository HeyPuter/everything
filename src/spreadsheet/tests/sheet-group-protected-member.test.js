import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// With a protected sheet in a group, Insert rows (or Delete rows, a column width, a merge, a format) went ahead on the
// unprotected sheets and was refused on the protected one alone, with its "is protected" notice: the sheets were no
// longer in line, so every later edit to the group landed on different data on each. The protected sheet now
// refuses the edit for the whole group, as it refuses it alone.
function book() {
  const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }] });
  const [a, b] = wb.sheets.map((s) => s.id);
  for (const id of [a, b]) for (let r = 0; r < 5; r++) wb.setInput(id, r, 0, String(r + 1));
  wb.setSheetProtected(b, true);
  wb.clearHistory();
  wb.groupSheets([b]);
  const notices = [];
  wb.addEventListener('change', (e) => { if (e.detail.type === 'protected') notices.push(e.detail.sheetId); });
  return { wb, a, b, notices, column: (id) => [0, 1, 2, 3, 4, 5].map((r) => wb.getValue(id, r, 0)) };
}

describe('a grouped edit with a protected sheet in the group', () => {
  it('changes none of the sheets, says which one is protected, and leaves nothing to undo', () => {
    const { wb, a, b, notices, column } = book();
    expect(wb.insertRows(a, 1, 1)).toBe(false);
    expect(wb.deleteRows(a, 2, 1)).toBe(false);
    expect(wb.insertCells(a, { r1: 0, c1: 0, r2: 0, c2: 0 }, 'down')).toBe(false);
    expect(wb.mergeCells(a, { r1: 0, c1: 1, r2: 0, c2: 2 })).toBe(false);
    wb.setColWidth(a, 0, 200);
    wb.applyStyle(a, { r1: 0, c1: 0, r2: 0, c2: 0 }, { bold: true });
    expect(column(a)).toEqual([1, 2, 3, 4, 5, null]);
    expect(column(b)).toEqual([1, 2, 3, 4, 5, null]);
    expect(wb.sheet(a).merges).toEqual([]);
    expect(wb.colWidth(a, 0)).toBe(wb.colWidth(b, 0));
    expect(wb.styleAt(a, 0, 0)?.bold).toBeFalsy();
    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((id) => id === b)).toBe(true);
    expect(wb.canUndo()).toBe(false);
  });

  it('goes ahead on every sheet once the protection is off', () => {
    const { wb, a, b, column } = book();
    wb.setSheetProtected(b, false);
    expect(wb.insertRows(a, 1, 1)).toBe(true);
    expect(column(a)).toEqual([1, null, 2, 3, 4, 5]);
    expect(column(b)).toEqual([1, null, 2, 3, 4, 5]);
  });
});
