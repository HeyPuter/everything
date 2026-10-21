import { describe, expect, it } from 'vitest';
import { Workbook, remapLines } from '../src/core/workbook.js';
import { insertMap, deleteMap } from '../src/core/refs.js';

// Rows hidden from under a list to the sheet's end are a million hidden lines, and inserting or deleting a row built a
// new set of all of them, renumbered one by one (150 ms of processor time a row). They are renumbered in place now:
// only the lines at the ends of each run of hidden lines change.

describe('renumbering hidden lines in place', () => {
  it('ends with the lines a renumbering one by one gives, for insertions and deletions anywhere', () => {
    let seed = 5;
    const rand = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % k; };
    for (let t = 0; t < 2000; t++) {
      const limit = 40 + rand(40);
      const lines = [];
      for (let k = rand(30); k > 0; k--) { const a = rand(limit + 1); for (let j = a; j <= Math.min(limit, a + rand(8)); j++) lines.push(j); }
      if (rand(2)) lines.reverse();
      const map = rand(2)
        ? insertMap(Array.from({ length: 1 + rand(3) }, () => ({ at: rand(limit + 1), n: 1 + rand(6) })))
        : deleteMap(Array.from({ length: 1 + rand(3) }, () => { const from = rand(limit + 1); return { from, to: from + rand(6) }; }));
      const want = [...new Set(lines.map(map.move).filter((i) => i != null && i <= limit))].sort((a, b) => a - b);
      const set = new Set(lines);
      expect(remapLines(set, map.move, limit)).toBe(set);
      expect([...set].sort((a, b) => a - b)).toEqual(want);
    }
  });

  it('keeps rows hidden to the sheet end hidden through inserted and deleted rows and their undo', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 20; r++) wb.setInput(id, r, 0, String(r + 1));
    wb.setHidden(id, 'row', [3], true);
    wb.setHidden(id, 'row', Array.from({ length: 1048576 - 30 }, (_, i) => i + 30), true);
    const hidden = () => wb.sheet(id).hiddenRows;
    wb.insertRows(id, 2, 2);
    expect(hidden().has(5) && !hidden().has(3) && !hidden().has(31) && hidden().has(32) && hidden().has(1048575)).toBe(true);
    expect(hidden().size).toBe(1 + 1048576 - 32);
    wb.deleteRows(id, 0, 3);
    // The rows that come in at the sheet's end are new ones, shown.
    expect(hidden().has(2) && !hidden().has(28) && hidden().has(29) && hidden().has(1048572) && !hidden().has(1048573)).toBe(true);
    expect(hidden().size).toBe(1 + 1048573 - 29);
    expect(wb.getValue(id, 1, 0)).toBe(3);
    wb.undo();
    wb.undo();
    expect(hidden().has(3) && !hidden().has(29) && hidden().has(30) && hidden().size === 1 + 1048576 - 30).toBe(true);
    wb.redo();
    expect(hidden().has(5) && hidden().has(32) && !hidden().has(31) && hidden().size === 1 + 1048576 - 32).toBe(true);
  });
});
