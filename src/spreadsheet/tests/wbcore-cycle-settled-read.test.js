import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';

// A cell reading one already settled as #CYCLE! was not seen to be on that cell's circle. With
// A1 = B1+C1, B1 = A1+1 and C1 = IF(ISNUMBER(B1),B1*2,0), read from A1 the circle A1 → B1 → A1
// settled first, and C1 then read B1's #CYCLE! as a finished answer and showed 0; read from B1 or
// C1, C1 met B1 still being calculated and was #CYCLE! with the rest. C1 is on the circle A1 → C1
// → B1 → A1 either way, so it is #CYCLE! whichever cell is read first.
const CYCLE = { error: '#CYCLE!' };

function read(cells, first) {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); }
  const val = (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(id, r, c); };
  val(first);
  return Object.fromEntries(Object.keys(cells).map((a1) => [a1, val(a1)]));
}

describe('a cell reading a cell already settled on a cycle', () => {
  const circle = { A1: '=B1+C1', B1: '=A1+1', C1: '=IF(ISNUMBER(B1),B1*2,0)' };

  it.each(['A1', 'B1', 'C1'])('is on its circle when %s is read first', (first) => {
    expect(read(circle, first)).toEqual({ A1: CYCLE, B1: CYCLE, C1: CYCLE });
  });

  it('is on it through a longer circle too', () => {
    const cells = { A1: '=B1+C1', B1: '=D1+1', D1: '=A1*2', C1: '=IF(ISNUMBER(D1),D1,0)' };
    for (const first of Object.keys(cells)) expect(Object.values(read(cells, first))).toEqual([CYCLE, CYCLE, CYCLE, CYCLE]);
  });

  it('is not when the settled cell only feeds it from outside every circle it lies on', () => {
    const cells = { A1: '=B1+1', B1: '=A1+1', C1: '=IF(ISNUMBER(B1),B1*2,0)' };
    for (const first of Object.keys(cells)) expect(read(cells, first)).toEqual({ A1: CYCLE, B1: CYCLE, C1: 0 });
  });
});
