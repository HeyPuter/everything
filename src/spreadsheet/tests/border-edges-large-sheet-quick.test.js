import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { borderSnapshot } from '../src/core/border-regions.js';

// Each edge drawn in Format Cells ▸ Border walked every cell the sheet held to find the few in the selection:
// on a sheet of 200,000 filled cells, framing three cells took about 50 ms an edge. It now visits the
// selection's own cells when there are fewer of them, as clearing a range does.
it('draws an edge around a few cells without walking every cell of a large sheet', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const cells = [];
  for (let r = 0; r < 500; r++) for (let c = 0; c < 40; c++) cells.push({ r, c, cell: { v: r * c } });
  wb.setCells(id, cells);
  const map = wb.sheet(id).cells;
  let walked = 0;
  const entries = map.entries.bind(map);
  map[Symbol.iterator] = function* () { for (const entry of entries()) { walked++; yield entry; } };
  wb.applyBorders(id, { r1: 10, c1: 2, r2: 12, c2: 4 }, 'outer', { perSide: true, style: 'thick', color: null });
  expect(walked).toBeLessThan(1000);
  delete map[Symbol.iterator];
  expect(borderSnapshot(wb.styleAt(id, 10, 2))).toMatchObject({ bt: true, bl: true, br: false, btBorder: { bs: 'thick' } });
  expect(borderSnapshot(wb.styleAt(id, 12, 4))).toMatchObject({ bb: true, br: true, bt: false, bbBorder: { bs: 'thick' } });
  expect(borderSnapshot(wb.styleAt(id, 11, 3))).toMatchObject({ bt: false, bb: false, bl: false, br: false });
  expect(wb.getValue(id, 11, 3)).toBe(33);
});
