import { expect, it } from 'vitest';
import { calc } from './helpers/calc.js';

// FORECAST.ETS lays its values out on an even timeline, and refuses one more than 30% gaps. It built the
// whole timeline before counting the gaps, so one far-off date (a year typed as 20230) cost an array of
// millions of steps, two seconds of calculation, and a date of 1E10 failed to build it at all (#VALUE!).
it('refuses a timeline that is mostly gaps at once, with #NUM!', () => {
  const start = performance.now();
  expect(calc('FORECAST.ETS(5,{1,2,3,4},{1,2,3,1E7})')).toEqual({ error: '#NUM!' });
  expect(calc('FORECAST.ETS.SEASONALITY({1,2,3,4},{1,2,4,1E10})')).toEqual({ error: '#NUM!' });
  expect(calc('FORECAST.ETS({5},{1,2,3,4},{1,2,4,1E10})')).toEqual({ error: '#NUM!' });
  expect(calc('FORECAST.ETS.CONFINT(5,{1,2,3,4},{1,2,3,DATE(20230,1,1)})')).toEqual({ error: '#NUM!' });
  expect(performance.now() - start).toBeLessThan(1000);
});

it('still forecasts over a timeline with a few gaps', () => {
  expect(calc('FORECAST.ETS(5,{1,2,3,4},{0,1,2,3})')).toBe(6);
  expect(calc('FORECAST.ETS(5,{1,2,3,4,5,6,7},{1,2,3,4,5,6,10})')).toBeCloseTo(5.521634095033771, 12);
});
