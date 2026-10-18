import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// A cell holding an error is not blank: COUNTBLANK of it alone is 0, as it is of a range that holds it,
// rather than that error (COUNT and COUNTA already read such a cell this way).
it('counts a single error cell as not blank', () => {
  const cells = { A1: '=1/0', A2: '', B1: '=NA()' };
  expect(calc('COUNTBLANK(A1)', cells)).toBe(0);
  expect(calc('COUNTBLANK(B1)', cells)).toBe(0);
  expect(calc('COUNTBLANK(A1:A2)', cells)).toBe(1);
  expect(calc('COUNTBLANK(A2)', cells)).toBe(1);
  expect(calc('COUNTBLANK(C5)', cells)).toBe(1);
});
