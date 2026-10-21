import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Merge Across merged each row of the selection on its own, and every merge copied all the sheet's merges into its
// own undo record: 4,000 rows took a second and 20,000 held the page for minutes. The blocks are now merged in one
// step, with the same outcome as merging them one after another.

function book(seed) {
  let s = seed;
  const rand = (k) => { s = (s * 1103515245 + 12345) % 2147483648; return Math.floor(s / 65536) % k; };
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 30; r++) for (let c = 0; c < 6; c++) if (rand(3)) wb.setInput(id, r, c, rand(4) ? `v${r}-${c}` : `=ROW()+${c}`);
  for (let k = rand(5); k > 0; k--) { const r = rand(28), c = rand(5); wb.mergeCells(id, { r1: r, c1: c, r2: r + rand(2), c2: c + 1 }); }
  if (rand(2)) wb.addTable(id, { r1: 20, c1: 3, r2: 24, c2: 5 });
  wb.clearHistory();
  const blocks = Array.from({ length: 1 + rand(8) }, () => { const r = rand(30), c = rand(6); return { r1: r, c1: c, r2: r + rand(3), c2: c + rand(3) }; });
  return { wb, id, blocks };
}

describe('merging many blocks in one step', () => {
  it('ends as merging them one after another does, refusals included', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const one = book(seed), all = book(seed);
      const flags = one.blocks.map((b) => one.wb.mergeCells(one.id, b));
      expect(all.wb.mergeBlocks(all.id, all.blocks)).toEqual(flags);
      expect(all.wb.sheet(all.id).merges).toEqual(one.wb.sheet(one.id).merges);
      expect(Object.fromEntries(all.wb.sheet(all.id).cells)).toEqual(Object.fromEntries(one.wb.sheet(one.id).cells));
      all.wb.undo();
      const fresh = book(seed);
      expect(all.wb.sheet(all.id).merges).toEqual(fresh.wb.sheet(fresh.id).merges);
    }
  });

  it('merges across 20,000 rows in moments, as one undo step', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    const rows = 20000;
    for (let r = 0; r < rows; r++) { wb.setInput(id, r, 0, `a${r}`); wb.setInput(id, r, 1, `b${r}`); }
    for (let r = 0; r < 300; r++) wb.mergeCells(id, { r1: rows + 2 * r, c1: 0, r2: rows + 2 * r + 1, c2: 1 });
    wb.clearHistory();
    const time = (n) => {
      const start = performance.now();
      wb.mergeBlocks(id, Array.from({ length: n }, (_, r) => ({ r1: r, c1: 0, r2: r, c2: 2 })));
      const ms = performance.now() - start;
      wb.undo();
      return ms;
    };
    time(200);
    const few = time(400), many = time(rows);
    // Fifty times the rows took some 2,500 times as long one by one.
    expect(many).toBeLessThan(Math.max(150 * few, 2000));
    wb.mergeBlocks(id, Array.from({ length: rows }, (_, r) => ({ r1: r, c1: 0, r2: r, c2: 2 })));
    expect(wb.sheet(id).merges.length).toBe(rows + 300);
    expect(wb.getValue(id, 7, 1)).toBe(null);
    expect(wb.getValue(id, 7, 0)).toBe('a7');
    wb.undo();
    expect(wb.sheet(id).merges.length).toBe(300);
    expect(wb.getValue(id, 7, 1)).toBe('b7');
  });
});

describe('merging many blocks on grouped sheets', () => {
  it('merges each block on every grouped sheet where the active sheet merged it, as one step', () => {
    const wb = new Workbook({ sheets: [{ name: 'Jan' }, { name: 'Feb' }, { name: 'Mar' }] });
    const [a, b, c] = wb.sheets.map((s) => s.id);
    for (const id of [a, b, c]) for (let r = 0; r < 6; r++) wb.setInput(id, r, 1, `x${r}`);
    wb.addTable(a, { r1: 4, c1: 0, r2: 5, c2: 2 }); // the active sheet refuses rows 5 and 6
    wb.groupSheets([b]);
    wb.clearHistory();
    const blocks = Array.from({ length: 6 }, (_, r) => ({ r1: r, c1: 0, r2: r, c2: 2 }));
    expect(wb.mergeBlocks(a, blocks)).toEqual([true, true, true, true, false, false]);
    const rows = (id) => wb.sheet(id).merges.map((m) => m.r1);
    expect(rows(a)).toEqual([0, 1, 2, 3]);
    expect(rows(b)).toEqual([0, 1, 2, 3]);
    expect(rows(c)).toEqual([]);
    expect(wb.getValue(b, 2, 1)).toBe(null);
    wb.undo();
    expect(rows(a)).toEqual([]);
    expect(rows(b)).toEqual([]);
    expect(wb.getValue(b, 2, 1)).toBe('x2');
  });
});
