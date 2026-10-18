import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

const cells = { A1: '3', A2: '=1/0', A3: 'x', B1: '10', B2: '20', B3: '30' };

// A lookup value that arrives as a reference to an error cell (INDEX, a LET name, a MAP cell) is that
// error, as the same cell named directly is; it is not a value the table lacks (#N/A).
it.each([
  'MATCH(INDEX(A1:A3,2),A1:A3,0)',
  'MATCH(A2:A2,A1:A3,0)',
  'LET(x,A2,MATCH(x,A1:A3,0))',
  'VLOOKUP(INDEX(A1:A3,2),A1:B3,2,FALSE)',
  'LET(x,A2,VLOOKUP(x,A1:B3,2,FALSE))',
  'HLOOKUP(INDEX(A1:A3,2),A1:B3,2,FALSE)',
  'MAP(A2:A2,LAMBDA(x,MATCH(x,A1:A3,0)))',
])('%s is #DIV/0!', (formula) => {
  expect(calc(formula, cells)).toEqual({ error: '#DIV/0!' });
});

it('still finds values given as references', () => {
  expect(calc('MATCH(INDEX(A1:A3,3),A1:A3,0)', cells)).toBe(3);
  expect(calc('LET(x,A1,VLOOKUP(x,A1:B3,2,FALSE))', cells)).toBe(10);
  expect(calc('MATCH(Z9,A1:A3,0)', cells)).toEqual({ error: '#N/A' });
});
