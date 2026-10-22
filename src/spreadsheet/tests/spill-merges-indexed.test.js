import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Every spill of a sheet checked every merged block of the sheet for one in its way, and a sheet's spills are worked
// out again after every edit: a formatted report with 3,000 merged rows beside a column of 5,000 TEXTSPLITs took
// 400 ms per keystroke anywhere, where without the merges it took 50 ms. The merges near the spill's rows are found
// through the bands of rows the grid already files them by.
function book(merges) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.mergeBlocks(id, merges);
  return { wb, id };
}

it('still blocks a spill with a merged block in its way, wherever the block lies', () => {
  // Enough merges for them to be filed by bands of rows, some short and one over many bands.
  const merges = Array.from({ length: 40 }, (_, i) => ({ r1: i * 10, c1: 20, r2: i * 10, c2: 21 }));
  merges.push({ r1: 1000, c1: 5, r2: 1001, c2: 5 }, { r1: 2000, c1: 30, r2: 9000, c2: 30 }, { r1: 130, c1: 8, r2: 200, c2: 9 });
  const { wb, id } = book(merges);
  const spill = (r, c, formula) => {
    wb.setInput(id, r, c, formula);
    const v = wb.getValue(id, r, c);
    wb.setInput(id, r, c, '');
    return v;
  };
  expect(spill(995, 5, '=SEQUENCE(10)')).toEqual({ error: '#SPILL!' }); // runs into F1001:F1002
  expect(spill(990, 5, '=SEQUENCE(10)')).toBe(1); // stops at F1000
  expect(spill(5000, 29, '=SEQUENCE(1,3)')).toEqual({ error: '#SPILL!' }); // AE2001:AE9001 is in the way
  expect(spill(127, 8, '=SEQUENCE(5)')).toEqual({ error: '#SPILL!' }); // into I131:J201, three bands down
  expect(spill(100, 8, '=SEQUENCE(30)')).toBe(1); // ends at row 130
  expect(spill(300, 19, '=SEQUENCE(1,2)')).toEqual({ error: '#SPILL!' }); // into U301:V301
  expect(spill(0, 40, '=SEQUENCE(3000)')).toBe(1); // over many bands, clear of every merge
  expect(spill(0, 21, '=SEQUENCE(400)')).toEqual({ error: '#SPILL!' }); // down column V, through every short merge
});

it('looks only at the merges near each spill when the spills are worked out', () => {
  const n = 300;
  const { wb, id } = book(Array.from({ length: 2000 }, (_, i) => ({ r1: i, c1: 10, r2: i, c2: 11 })));
  wb.setCells(id, Array.from({ length: n }, (_, r) => ({ r, c: 0, cell: { v: `a${r},b,c` } })));
  wb.setCells(id, Array.from({ length: n }, (_, r) => ({ r, c: 3, cell: { f: `TEXTSPLIT(A${r + 1},",")` } })));
  expect(wb.getValue(id, n - 1, 5)).toBe('c');
  // Count the merges looked at while an unrelated edit has the spills worked out again.
  const sheet = wb.sheet(id);
  let looked = 0;
  sheet.merges = new Proxy(sheet.merges, { get: (t, k) => { if (typeof k === 'string' && /^\d+$/.test(k)) looked++; return t[k]; } });
  wb.setInput(id, n + 5, 20, 'x');
  expect(wb.getValue(id, 0, 4)).toBe('b');
  expect(wb.getValue(id, n - 1, 5)).toBe('c');
  // Every merge for every spill was 600,000; the merges in the band of rows of each spill, and the filing of
  // them once, are about 21,000.
  expect(looked).toBeLessThan(40000);
});
