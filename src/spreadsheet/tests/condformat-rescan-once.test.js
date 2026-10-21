import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

const bg = (wb, id, r, c) => wb.conditionalStyle(id, r, c, wb.getValue(id, r, c))?.bg ?? null;

// After an edit inside a colour scale's, data bar's, icon set's, top/bottom or duplicate rule's range, the rule
// read the whole range again — and then walked it a second time only to learn whether it held a formula, which
// decides whether the next scan can be kept. On a 100,000-row column that second walk was a quarter of every
// keystroke's work. The scan now notes the formulas it reads on its one walk.
it('reads a rule range once when it is scanned again after an edit', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const cells = [];
  for (let r = 0; r < 2000; r++) for (let c = 0; c < 3; c++) cells.push({ r, c, cell: { v: (r * 7 + c) % 101 } });
  wb.setCells(id, cells);
  wb.addRule(id, { type: 'scale', range: { r1: 0, c1: 0, r2: 1999, c2: 0 }, from: '#ffffff', to: '#ff0000' });
  bg(wb, id, 5, 0);
  wb.setInput(id, 10, 0, '50');
  const map = wb.sheet(id).cells, get = map.get.bind(map);
  let reads = 0;
  map.get = (key) => { reads++; return get(key); };
  bg(wb, id, 5, 0);
  delete map.get;
  expect(reads).toBeLessThan(2000 * 2.5); // the walk and each value it computes: no second walk
});

it('still scans a range holding a formula afresh when the formula\'s inputs change', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [1, 2, 3, 4].forEach((v, r) => wb.setInput(id, r, 0, String(v)));
  wb.setInput(id, 4, 0, '=C1');
  wb.setInput(id, 0, 2, '5');
  wb.addRule(id, { type: 'scale', range: { r1: 0, c1: 0, r2: 4, c2: 0 }, from: '#ffffff', to: '#ff0000' });
  const before = bg(wb, id, 3, 0);
  wb.setInput(id, 0, 2, '400'); // outside the range, but the formula inside it reads it
  expect(bg(wb, id, 3, 0)).not.toBe(before);
  const fresh = new Workbook(), fid = fresh.activeSheetId;
  [1, 2, 3, 4, 400].forEach((v, r) => fresh.setInput(fid, r, 0, String(v)));
  fresh.addRule(fid, { type: 'scale', range: { r1: 0, c1: 0, r2: 4, c2: 0 }, from: '#ffffff', to: '#ff0000' });
  expect(bg(wb, id, 3, 0)).toBe(bg(fresh, fid, 3, 0));
});
