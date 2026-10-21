import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseCellRef } from '../src/core/cell.js';
import { calc } from './helpers/calc.js';

function arr(formula, cells = {}) {
  const wb = new Workbook();
  const id = wb.sheets[0].id;
  for (const [a1, text] of Object.entries(cells)) { const { r, c } = parseCellRef(a1); wb.setInput(id, r, c, String(text)); }
  wb.setInput(id, 0, 9, `=${formula}`);
  const range = wb.spillRangeAt(id, 0, 9) || { r1: 0, c1: 9, r2: 0, c2: 9 };
  return wb.rangeValues(id, range);
}
const E = (code) => ({ error: code });
const close = (got, want, digits = 6) => {
  expect(got.length).toBe(want.length);
  got.forEach((line, r) => {
    expect(line.length).toBe(want[r].length);
    line.forEach((v, c) => (typeof want[r][c] === 'number' ? expect(v).toBeCloseTo(want[r][c], digits) : expect(v).toEqual(want[r][c])));
  });
};

// LINEST(known_y, [known_x], [const], [stats]) and LOGEST read const and stats; TREND and GROWTH
// read const; and a known_x of several columns (or rows) fits one coefficient per variable,
// instead of the slope and intercept alone, or #REF! for more than one variable.
describe('LINEST with const and stats', () => {
  it('forces the intercept to 0 when const is FALSE', () => {
    // Through the origin the slope is Σxy/Σx² = 34/14.
    close(arr('LINEST({3,5,7},{1,2,3},FALSE)'), [[34 / 14, 0]], 12);
    close(arr('LINEST({3,5,7},{1,2,3},TRUE)'), [[2, 1]], 12);
    expect(arr('LINEST({3,5,7},{1,2,3})')).toEqual([[2, 1]]);
    close(arr('LINEST({3,5,7},{1,2,3},,TRUE)'), [[34 / 14, 0], [Math.sqrt(3 / 14) / Math.sqrt(14), E('#N/A')], [578 / 581, Math.sqrt(3 / 14)], [(578 / 7) / (3 / 14), 2], [578 / 7, 3 / 7]], 9); // an empty const is FALSE
  });

  it('returns the five statistics rows when stats is TRUE', () => {
    // y = 1/3 + 2.5x fitted to (1,3), (2,5), (3,8): residuals 1/6, -1/3, 1/6.
    close(arr('LINEST({3,5,8},{1,2,3},TRUE,TRUE)'), [
      [2.5, 1 / 3],
      [0.288675, 0.623610], // se_y/√sxx and se_y·√(1/n + x̄²/sxx)
      [0.986842, 0.408248], // r² = 12.5/12.6667 and se_y = √(1/6)
      [75, 1], // F = (12.5/1)/((1/6)/1) on 1 and 1 degrees of freedom
      [12.5, 1 / 6],
    ]);
    expect(calc('STEYX({3,5,8},{1,2,3})')).toBeCloseTo(0.408248, 6);
    expect(calc('RSQ({3,5,8},{1,2,3})')).toBeCloseTo(0.986842, 6);
    expect(calc('INDEX(LINEST({3,5,8},{1,2,3},TRUE,TRUE),3,1)')).toBeCloseTo(0.986842, 6);
  });

  it('marks a statistic the fit leaves undefined #NUM!', () => {
    // y = 2x exactly: no residual, so the standard error of y is 0 and F divides by it.
    expect(arr('LINEST({2,4,6},{1,2,3},TRUE,TRUE)')).toEqual([[2, 0], [0, 0], [1, 0], [E('#NUM!'), 1], [8, 0]]);
    // Two points and two coefficients: no residual degrees of freedom.
    expect(arr('LINEST({1,2},{1,2},TRUE,TRUE)')).toEqual([[1, 0], [E('#NUM!'), E('#NUM!')], [1, E('#NUM!')], [E('#NUM!'), 0], [0.5, 0]]);
  });

  it('fits one coefficient per column of known_x for a column of y, last variable first', () => {
    // y = 2 + 3x₁ + 5x₂ exactly on four points.
    close(arr('LINEST({10;8;16;14},{1,1;2,0;3,1;4,0})'), [[5, 3, 2]], 12);
    const stats = arr('LINEST({10;8;16;14},{1,1;2,0;3,1;4,0},TRUE,TRUE)');
    close(stats.slice(0, 1), [[5, 3, 2]], 12);
    close(stats.slice(1, 3), [[0, 0, 0], [1, 0, E('#N/A')]], 6);
    expect(stats[3][1]).toBe(1); // 4 points less 3 coefficients
    expect(stats[3][2]).toEqual(E('#N/A'));
    expect(stats[4][0]).toBeCloseTo(40, 9); // Σ(y - ȳ)², all of it explained
    expect(stats[4][1]).toBeCloseTo(0, 9);
    expect(stats[4][2]).toEqual(E('#N/A'));
    close(arr('LINEST({3;5;8},{1,2;2,3;3,5})'), [[1, 1, 0]], 9); // an exact fit of three points, no degrees of freedom left
  });

  it('fits one coefficient per row of known_x for a row of y', () => {
    close(arr('LINEST({10,8,16,14},{1,2,3,4;1,0,1,0})'), [[5, 3, 2]], 12);
  });

  it('answers #REF! for counts that do not pair and #DIV/0! for more coefficients than points', () => {
    expect(calc('LINEST({1,2,3},{1,2})')).toEqual(E('#REF!'));
    expect(calc('LINEST({1;2;3},{1,2;3,4})')).toEqual(E('#REF!'));
    expect(arr('LINEST({1,2},{1,1})')).toEqual([[0, 1.5]]); // a constant variable is left out, as Excel does
    close(arr('LINEST({1;2;3},{1,2;2,4;3,6})'), [[0, 1, 0]], 12); // and so is a collinear one
    expect(calc('LINEST({1;2},{1,2;3,4})')).toEqual(E('#DIV/0!')); // more coefficients than points
    expect(calc('LINEST({1,"x",3},{1,2,3})')).toBe(1); // a non-numeric pair is left out, as before
  });
});

describe('LOGEST with const and stats', () => {
  it('fits through b = 1 when const is FALSE and reports the statistics of the fit on ln(y)', () => {
    close(arr('LOGEST({2,4,8},{1,2,3},FALSE)'), [[2, 1]], 9);
    close(arr('LOGEST({2,4,8},{1,2,3})'), [[2, 1]], 9);
    const stats = arr('LOGEST({2,4,8},{1,2,3},TRUE,TRUE)');
    expect(stats.length).toBe(5);
    expect(stats[0][0]).toBeCloseTo(2, 9);
    expect(stats[0][1]).toBeCloseTo(1, 9);
    expect(stats[2][0]).toBeCloseTo(1, 9); // r² of an exact fit
    expect(stats[3][1]).toBe(1);
    expect(stats[2][2]).toBeUndefined();
    expect(arr('LOGEST({2,4,8},{1,2,3},FALSE,TRUE)')[1][1]).toEqual(E('#N/A'));
    expect(calc('LOGEST({2,-4,8},{1,2,3})')).toEqual(E('#NUM!'));
  });
});

describe('TREND and GROWTH with const and several variables', () => {
  it('predict through the origin when const is FALSE', () => {
    expect(calc('TREND({3,5,7},{1,2,3},{4},FALSE)')).toBeCloseTo(68 / 7, 12);
    expect(calc('TREND({3,5,7},{1,2,3},{4})')).toBe(9);
    expect(calc('TREND({3,5,7},{1,2,3},{4},TRUE)')).toBe(9);
    expect(calc('GROWTH({2,4,8},{1,2,3},{4},FALSE)')).toBeCloseTo(16, 9);
    expect(calc('GROWTH({2,4,8},{1,2,3},{4})')).toBeCloseTo(16, 9);
  });

  it('take a row of new_x per observation for several variables', () => {
    close(arr('TREND({10;8;16;14},{1,1;2,0;3,1;4,0},{5,1;6,0})'), [[22], [20]], 10);
    close(arr('TREND({10;8;16;14},{1,1;2,0;3,1;4,0})'), [[10], [8], [16], [14]], 10);
    close(arr('TREND({10,8,16,14},{1,2,3,4;1,0,1,0},{5;1})'), [[22]], 10);
    expect(calc('TREND({10;8;16;14},{1,1;2,0;3,1;4,0},{5})')).toEqual(E('#REF!'));
  });

  it('answer as before with one variable', () => {
    expect(arr('TREND({3,5,7},{1,2,3},{4;5})')).toEqual([[9], [11]]);
    expect(arr('TREND({3,5,7})')).toEqual([[3, 5, 7]]);
    expect(arr('TREND({3;5;7})')).toEqual([[3], [5], [7]]);
  });
});
