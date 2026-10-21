import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { invalidCells } from '../src/core/validation-circles.js';

// Circle Invalid Data redraws its circles after every edit while they are shown, and it sorted and looked at
// every cell of the sheet each time: with 100,000 cells and one validated column, each typed entry waited a
// fifth of a second or more. Only the cells under a rule are candidates now, in the same reading order.
it('finds invalid cells in reading order looking only at the cells under a rule', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const cells = [];
  for (let r = 0; r < 2000; r++) for (let c = 0; c < 10; c++) cells.push({ r, c, cell: { v: r * 10 + c } });
  wb.setCells(id, cells);
  wb.setInput(id, 3, 12, 'text');
  wb.addValidation(id, { range: parseRange('B1:B6'), type: 'whole', min: 0, max: 30, strict: false });
  wb.addValidation(id, { range: parseRange('M1:M5'), type: 'whole', min: 0, max: 30, strict: false });
  wb.addValidation(id, { range: parseRange('A2:A3'), type: 'list', source: '10, 20', strict: false });
  const map = wb.sheet(id).cells;
  let walked = 0;
  for (const name of ['keys', 'entries', 'values', Symbol.iterator]) {
    const own = map[name].bind(map);
    map[name] = function* () { for (const item of own()) { walked++; yield item; } };
  }
  const found = invalidCells(wb, id);
  for (const name of ['keys', 'entries', 'values', Symbol.iterator]) delete map[name];
  expect(found).toEqual({ cells: [{ r: 3, c: 1 }, { r: 3, c: 12 }, { r: 4, c: 1 }, { r: 5, c: 1 }], more: false });
  expect(walked).toBeLessThan(100);
  expect(invalidCells(wb, id, 2)).toEqual({ cells: [{ r: 3, c: 1 }, { r: 3, c: 12 }], more: true });
});
