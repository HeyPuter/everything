import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// BESSELI summed its power series term by term until the terms stopped counting, about x/2 of
// them however far past the largest number the sum had already gone, so =BESSELI(1E10,0)
// froze the tab for half a minute before answering #NUM!. A sum past the doubles now stops there.
it('answers #NUM! at once for an argument whose BESSELI overflows', () => {
  const start = performance.now();
  expect(calc('BESSELI(1E10,0)')).toEqual({ error: '#NUM!' });
  expect(calc('BESSELI(-1E10,1)')).toEqual({ error: '#NUM!' });
  expect(calc('BESSELI(1E9,5)')).toEqual({ error: '#NUM!' });
  expect(performance.now() - start).toBeLessThan(2000);
});

it('still gives the values just inside the doubles', () => {
  // I_0(x) ≈ e^x / √(2πx) far out; I_0(700) is about 1.53E+302 and I_0(714) overflows.
  expect(Math.abs(calc('BESSELI(700,0)') / 1.529593347671801e302 - 1)).toBeLessThan(1e-12);
  expect(calc('BESSELI(714,0)')).toEqual({ error: '#NUM!' });
});
