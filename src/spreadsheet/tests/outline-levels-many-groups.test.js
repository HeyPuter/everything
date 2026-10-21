import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Each group's level was found by comparing it with every other group, on every redraw (the outline gutter asks for
// the levels and the depth of both axes): a Subtotal outline of 20,000 groups took over a second and a half a frame,
// and a click on one group's button as long. The levels now come from one walk down the sorted outline.
const pairwise = (list) => list.map((g, i) => list.filter((o, j) => o.from <= g.from && o.to >= g.to && (j <= i || o.from !== g.from || o.to !== g.to)).length);

it('works out the levels of an outline of 20,000 groups at once', () => {
  const n = 20000;
  const rows = [{ from: 0, to: n * 3, collapsed: false }];
  for (let i = 0; i < n; i++) rows.push({ from: i * 3 + 1, to: i * 3 + 2, collapsed: false });
  const wb = new Workbook({ sheets: [{ name: 'S', rows: n * 3 + 10, groups: { rows, cols: [] } }] });
  const id = wb.activeSheetId;
  const start = performance.now();
  const groups = wb.outlineGroups(id, 'row');
  expect(wb.outlineDepth(id, 'row')).toBe(2);
  wb.toggleGroup(id, 'row', 4, 5);
  expect(performance.now() - start).toBeLessThan(400);
  expect(groups[0].level).toBe(1);
  expect(groups.slice(1).every((g) => g.level === 2)).toBe(true);
});

it('gives every group the level counting the groups around it would, twins and all', () => {
  let seed = 7;
  const rnd = (k) => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor((seed / 2147483648) * k); };
  for (let run = 0; run < 40; run++) {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let k = 0; k < 25; k++) { const from = rnd(30); wb.groupLines(id, 'row', from, from + rnd(12)); }
    const list = wb.sheet(id).groups.rows;
    expect(wb.outlineGroups(id, 'row').map((g) => g.level)).toEqual(pairwise(list));
  }
});

it('counts the crossing groups of a damaged file as before', () => {
  const rows = [{ from: 1, to: 5 }, { from: 3, to: 8 }, { from: 4, to: 4 }];
  const wb = new Workbook({ sheets: [{ name: 'S', groups: { rows, cols: [] } }] });
  expect(wb.outlineGroups(wb.activeSheetId, 'row').map((g) => g.level)).toEqual([1, 1, 3]);
});
