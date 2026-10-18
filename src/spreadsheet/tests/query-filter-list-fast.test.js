import { expect, it } from 'vitest';
import { applyStep } from '../src/core/queries.js';

const ids = (rows, distinct) => ({ columns: ['Id', 'N'], types: ['text', 'int'], rows: Array.from({ length: rows }, (_, i) => [`id${i % distinct}`, i]) });

it('filters on a long list of values without testing every value against every row', () => {
  const t = ids(40000, 2000);
  const time = (count) => {
    const values = Array.from({ length: count }, (_, i) => `id${i}`);
    const start = performance.now();
    const out = applyStep(t, { type: 'filterRows', column: 'Id', join: 'and', conditions: [{ op: 'in', values }] });
    return { ms: performance.now() - start, rows: out.rows.length };
  };
  time(10);
  const few = time(20), many = time(2000);
  expect(few.rows).toBe(400);
  expect(many.rows).toBe(40000);
  // A hundred times the values once took a hundred times as long (5 s for 1,000 values over 100,000 rows).
  expect(many.ms).toBeLessThan(Math.max(5 * few.ms, 150));
});
