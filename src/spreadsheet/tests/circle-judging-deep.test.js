import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Judging whether a circle of references is a cycle calculates its outer cell again with the circle's
// other cells read as blank (or in error); what that reads for the first time may judge circles of its
// own, one inside the other. A chain of 400 such circles — A1 = IF(ISERROR(B1),A2*0+5,5) beside
// B1 = COUNTIF(A1,"<>1"), filled down — ran the stack out among those judgings, outside any calculation
// that could catch it, and reading A1 threw "Maximum call stack size exceeded" out of getValue. The
// judging that the stack ran out under is now caught by a shallow one, which takes its circle for a
// cycle, as a chain too deep to follow ends in an error.

function chain(n, test) {
  const cells = {};
  for (let i = 1; i <= n; i++) {
    cells[`${i - 1},0`] = { f: `IF(${test}(B${i}),A${i + 1}*0+5,5)` };
    cells[`${i - 1},1`] = { f: `COUNTIF(A${i},"<>1")` };
  }
  const wb = new Workbook({ sheets: [{ name: 'Sheet1', rows: n + 5, cols: 4, cells }] });
  return { wb, id: wb.activeSheetId };
}

const answer = (v) => v === 5 || v === 1 || v?.error === '#CYCLE!';

describe('a chain of circles each judged inside the one before it', () => {
  it.each(['ISERROR', 'ISBLANK'])('answers rather than throwing, read from either end (%s)', (test) => {
    for (const first of [0, 399]) {
      const { wb, id } = chain(400, test);
      expect(answer(wb.getValue(id, first, 0))).toBe(true);
      for (let r = 0; r < 400; r++) {
        expect(answer(wb.getValue(id, r, 0)), `A${r + 1}`).toBe(true);
        expect(answer(wb.getValue(id, r, 1)), `B${r + 1}`).toBe(true);
      }
    }
  }, 120000);

  it('judges a short chain as before', () => {
    const { wb, id } = chain(50, 'ISERROR');
    for (let r = 0; r < 50; r++) expect(wb.getValue(id, r, 0)).toBe(5);
  });
});
