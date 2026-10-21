import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// For many degrees of freedom the t tail is integrated from the density, up to 45 deviations, past which
// it is below the doubles. A t further out than that was integrated all the same, in steps that only
// narrow with the distance, so =T.DIST(2958465,1E15,TRUE) never finished and froze the tab.
it('answers at once for a t far out with many degrees of freedom', () => {
  const start = performance.now();
  expect(calc('T.DIST(2958465,1E15,TRUE)')).toBe(1);
  expect(calc('T.DIST(-1E6,1E15,TRUE)')).toBe(0);
  expect(calc('T.DIST.RT(1E6,1E15)')).toBe(0);
  expect(calc('T.DIST.2T(1E5,1E14)')).toBe(0);
  expect(performance.now() - start).toBeLessThan(5000);
});

it('keeps the tails nearer in', () => {
  expect(calc('T.DIST.RT(46,1E6)')).toBe(0);
  expect(Math.abs(calc('T.DIST.RT(30,1E6)') / 6.010047116831668e-198 - 1)).toBeLessThan(1e-12);
  expect(Math.abs(calc('T.DIST.RT(5,1E6)') / 2.8669989354453713e-7 - 1)).toBeLessThan(1e-12);
  expect(calc('T.DIST(44,1E6,TRUE)')).toBe(1);
});
