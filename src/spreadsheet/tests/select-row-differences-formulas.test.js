import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Go To Special ▸ Row differences compared formulas by their text, so a formula filled along a row (=A2*2, =B2*2,
// =C2*2) counted as different in every cell, and the classic audit — select a row of copied formulas and find the
// one typed over — selected the whole row. Formulas are now compared by what they do from where they sit (their
// R1C1 form), as Excel compares them; values still compare as they show.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (let r = 0; r < 3; r++) wb.setInput(id, r, 0, String(r + 1));
  for (let c = 1; c <= 4; c++) for (let r = 0; r < 3; r++) wb.setInput(id, r, c, `=${String.fromCharCode(64 + c)}${r + 1}*2`);
  wb.setInput(id, 1, 3, '=C2*3'); // D2 breaks its row's pattern
  wb.setInput(id, 2, 4, '=$A$3*2'); // E3 breaks its column's and its row's
  return { wb, id };
}

describe('Go To Special: row and column differences', () => {
  it('finds the formula that breaks a row of filled formulas', () => {
    const { wb, id } = book();
    expect(wb.specialCells(id, { r1: 0, c1: 1, r2: 2, c2: 4 }, 'rowDiff', 500, { r: 0, c: 1 }))
      .toEqual([{ r1: 1, c1: 3, r2: 1, c2: 3 }, { r1: 2, c1: 4, r2: 2, c2: 4 }]);
  });

  it('finds the formula that breaks a column of filled formulas', () => {
    const { wb, id } = book();
    expect(wb.specialCells(id, { r1: 0, c1: 1, r2: 2, c2: 4 }, 'colDiff', 500, { r: 0, c: 1 }))
      .toEqual([{ r1: 1, c1: 3, r2: 1, c2: 3 }, { r1: 2, c1: 4, r2: 2, c2: 4 }]);
  });

  it('still tells values apart as they show, and a value from a formula giving it', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    ['5', '5', '6', '=2+3'].forEach((t, c) => wb.setInput(id, 0, c, t));
    expect(wb.specialCells(id, { r1: 0, c1: 0, r2: 0, c2: 3 }, 'rowDiff', 500, { r: 0, c: 0 }))
      .toEqual([{ r1: 0, c1: 2, r2: 0, c2: 2 }, { r1: 0, c1: 3, r2: 0, c2: 3 }]);
  });
});
