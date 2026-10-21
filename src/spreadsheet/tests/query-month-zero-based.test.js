import { expect, it } from 'vitest';
import { runQuery } from '../src/core/formula/query.js';
import { ymdToSerial } from '../src/core/format.js';

// In the query language QUERY comes from, month() counts from 0: month(date '2009-02-05') is 1,
// and a sheet labels its months with month(C)+1 or a lookup on 0-11. QUERY answered 1-based
// months, so every such summary from Google Sheets came out a month late.
const rows = [['When'], [ymdToSerial(2009, 2, 5)], [ymdToSerial(2020, 1, 31)], [ymdToSerial(2020, 12, 1)]];

it('answers months from 0 for January, as the query language does', () => {
  expect(runQuery(rows, 'select month(A)', { headers: 1 }).values).toEqual([['month(When)'], [1], [0], [11]]);
  expect(runQuery(rows, "select A where month(A) = 0", { headers: 1 }).values).toEqual([['When'], [ymdToSerial(2020, 1, 31)]]);
});

it('keeps days of the month and of the week as they were', () => {
  // 26 February 2009 was a Thursday: day of the week 5, counting Sunday as 1.
  expect(runQuery([['d'], [ymdToSerial(2009, 2, 26)]], 'select day(A), dayofweek(A), year(A)', { headers: 1 }).values)
    .toEqual([['day(d)', 'dayofweek(d)', 'year(d)'], [26, 5, 2009]]);
});
