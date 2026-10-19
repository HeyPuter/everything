// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { rowsFromDelimited, rowsFromHtml } from '../src/core/importrange.js';
import { parseInput } from '../src/core/format.js';
import { parseDelimited } from '../src/core/tsv.js';

// IMPORTDATA and IMPORTHTML keep a date or a time as its text, since a bare serial would mean nothing in a
// formula's result. A month and year ("Feb 2024", "3/2024") or an elapsed time ("25:30") reads with a custom
// format of its own and was missed, so it came back as 45323 or 1.0625. It now stays text like other dates.
describe('imported month-year and duration text', () => {
  it('stays text in IMPORTDATA', () => {
    const rows = rowsFromDelimited('Month,Hours,Qty\nFeb 2024,25:30,5\n3/2024,1 1/2,6\n', ',', { detectDelimiter: () => ',', parseDelimited, parseInput });
    expect(rows.slice(1)).toEqual([['Feb 2024', '25:30', 5], ['3/2024', 1.5, 6]]);
  });

  it('stays text in IMPORTHTML', () => {
    expect(rowsFromHtml('<table><tr><td>Feb 2024</td><td>7</td></tr></table>', 'table', 1, parseInput)).toEqual([['Feb 2024', 7]]);
  });
});
