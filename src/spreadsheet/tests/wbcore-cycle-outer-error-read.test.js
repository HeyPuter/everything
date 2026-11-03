import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';

// D2 = IF(E3>2,"a","b") over E3 = COUNTIF(D2:D2,"<>1") was "b" and 1 when D2 was read first and
// #CYCLE! in both when E3 was read first. Read from D2, E3's count was the same with D2 blank or
// in error, and D2 was the same with E3 blank or 1, so the circle was accepted; read from E3, D2
// passed E3's provisional #CYCLE! on and the pair was a cycle at once. Which cell the sheet
// happened to calculate first (an unrelated edit or undo changes it) flipped both cells. The outer
// cell of a circle is now also calculated with the circle's other cells in error, as it would have
// read them had it been reached second, and a different answer makes the circle a cycle.

function book(cells = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  const api = {
    wb, id,
    set: (a1, text) => { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, text); },
    val: (a1) => { const { r, c } = parseCellRef(a1); return wb.getValue(id, r, c); },
  };
  for (const [a1, text] of Object.entries(cells)) api.set(a1, text);
  return api;
}

const CYCLE = { error: '#CYCLE!' };

describe('a circle whose reader counts the outer cell whatever it holds', () => {
  it.each([
    ['COUNTIF', '=COUNTIF(D2:D2,"<>1")'],
    ['COUNTIFS', '=COUNTIFS(D2:D2,"<>1")'],
    ['COUNTIF of a longer range', '=COUNTIF(D1:D3,"<>1")'],
  ])('is a cycle whichever cell is read first (%s)', (_, reader) => {
    for (const first of ['D2', 'E3']) {
      const b = book({ D2: '=IF(E3>2,"a","b")', E3: reader });
      expect(b.val(first), `${first} read first`).toEqual(CYCLE);
      expect(b.val('D2'), `D2 after ${first}`).toEqual(CYCLE);
      expect(b.val('E3'), `E3 after ${first}`).toEqual(CYCLE);
    }
  });

  it('keeps the verdict across an unrelated edit', () => {
    const b = book({ D2: '=IF(E3>2,"a","b")', E3: '=COUNTIF(D2:D2,"<>1")' });
    expect(b.wb.rangeValues(b.id, { r1: 1, c1: 3, r2: 2, c2: 4 })).toEqual([[CYCLE, null], [null, CYCLE]]);
    b.set('A1', 'x');
    expect(b.val('E3')).toEqual(CYCLE);
    expect(b.val('D2')).toEqual(CYCLE);
  });

  it('still accepts an outer cell that answers the same whatever the circle holds', () => {
    for (const first of ['A1', 'B1']) {
      const b = book({ A1: '=IF(ISNUMBER(B1),5,5)', B1: '=COUNTIF(A1,"<>1")' });
      b.val(first);
      expect(b.val('A1'), `${first} read first`).toBe(5);
      expect(b.val('B1'), `${first} read first`).toBe(1);
    }
  });
});
