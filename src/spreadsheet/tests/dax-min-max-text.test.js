import { expect, it } from 'vitest';
import { evaluateDax } from '../src/core/dax.js';

// DAX MIN and MAX take a text column too and give its alphabetically first or last value; a measure such as
// MIN(Orders[Group]) failed instead with "DAX expression requires a finite number".
const over = (expression, values) => evaluateDax(expression, { table: 'Orders', column: () => values, rowCount: () => values.length });

it('takes the first and last text of a column, without regard to case, skipping blanks', () => {
  expect(over('MIN(Orders[Group])', ['pear', 'apple', null, 'fig'])).toBe('apple');
  expect(over('MAX(Orders[Group])', ['pear', 'apple', null, 'fig'])).toBe('pear');
  expect(over('MIN(Orders[Group])', ['banana', 'Apple', 'cherry'])).toBe('Apple');
  expect(over('MAX(Orders[Group])', [null])).toBeNull();
  // Numbers are compared as they were.
  expect(over('MAX(Orders[Group])', [3, 9, null])).toBe(9);
});
