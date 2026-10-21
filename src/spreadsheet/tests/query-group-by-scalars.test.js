import { describe, expect, it } from 'vitest';
import { runQuery } from '../src/core/formula/query.js';
import { ymdToSerial } from '../src/core/format.js';
import { calc } from './helpers/calc.js';

// group by parsed a bare column name alone, while select, order by and label all parsed a whole
// term, so the month-by-month summary everyone writes — select year(C), sum(B) group by year(C) —
// was refused with Unexpected "(" although select year(C) and order by year(C) both worked.

const rows = [
  ['Name', 'Amount', 'When'],
  ['a', 1, ymdToSerial(2023, 1, 5)],
  ['b', 2, ymdToSerial(2024, 3, 9)],
  ['c', 4, ymdToSerial(2025, 7, 1)],
  ['d', 8, ymdToSerial(2023, 11, 2)],
];
const q = (text) => runQuery(rows, text, { headers: 1 });

describe('QUERY group by a scalar of a column', () => {
  it('groups by year, month and upper as select and order by already do', () => {
    expect(q('select year(C), sum(B) group by year(C)').values)
      .toEqual([['year(When)', 'sum Amount'], [2023, 9], [2024, 2], [2025, 4]]);
    expect(q('select month(C), sum(B) group by month(C) order by month(C)').values)
      .toEqual([['month(When)', 'sum Amount'], [0, 1], [2, 2], [6, 4], [10, 8]]);
    expect(q('select upper(A), count(B) group by upper(A)').values)
      .toEqual([['upper(Name)', 'count Amount'], ['A', 1], ['B', 1], ['C', 1], ['D', 1]]);
  });

  it('takes several grouping keys, an order by over an aggregate and a label', () => {
    expect(q('select year(C), upper(A), sum(B) group by year(C), upper(A)').values)
      .toEqual([['year(When)', 'upper(Name)', 'sum Amount'], [2023, 'A', 1], [2023, 'D', 8], [2024, 'B', 2], [2025, 'C', 4]]);
    expect(q('select year(C), sum(B) group by year(C) order by sum(B) desc').values)
      .toEqual([['year(When)', 'sum Amount'], [2023, 9], [2025, 4], [2024, 2]]);
    expect(q("select year(C), sum(B) group by year(C) label year(C) 'Year'").values)
      .toEqual([['Year', 'sum Amount'], [2023, 9], [2024, 2], [2025, 4]]);
  });

  it('still refuses an aggregate as a grouping key, and says why', () => {
    const out = q('select A, sum(B) group by sum(B)');
    expect(out.error).toBe('#VALUE!');
    expect(out.message).toBe('Aggregates cannot be grouped by');
  });

  it('still requires every plain column of the select to be grouped', () => {
    expect(q('select A, sum(B) group by year(C)').message).toBe('Columns in select must be grouped or aggregated');
    expect(q('select A, sum(B) group by A').values).toEqual([['Name', 'sum Amount'], ['a', 1], ['b', 2], ['c', 4], ['d', 8]]);
  });

  it('works through the QUERY function on a sheet', () => {
    expect(calc('QUERY(A1:B4,"select upper(A), sum(B) group by upper(A)",1)', {
      A1: 'Name', B1: 'Amount', A2: 'a', B2: '1', A3: 'A', B3: '2', A4: 'b', B4: '4',
    })).toBe('upper(Name)');
  });
});
