import { expect, it } from 'vitest';
import { flashFill } from '../src/core/flashfill.js';

// Flash Fill split cells only at spaces and some punctuation, and copied what it could not find as fixed
// text, so it filled confidently wrong values: ABC123 → ABC taught "X" + "BC" (XBC for XYZ9), $1,234.56 →
// 1234 taught "1" + 234 (1678 for $5,678.90), Size 10cm → 10 taught 20 for Size 25cm, and Order #123 → 123
// learned nothing. Runs of letters and of digits are now pieces too, and of the patterns that fit the
// examples the one copying the fewest letters and digits as fixed text is taken.
it.each([
  [['ABC123', 'XYZ9'], 'ABC', 'XYZ'],
  [['ABC123', 'XYZ9'], '123', '9'],
  [['$1,234.56', '$5,678.90'], '1234', '5678'],
  [['Size 10cm', 'Size 25cm'], '10', '25'],
  [['Order #123', 'Order #4567'], '123', '4567'],
  [['user+tag@x.com', 'bob+news@y.org'], 'user', 'bob'],
  [['"Hello" world', '"Bye" moon'], 'Hello', 'Bye'],
  [['3rd place', '1st place'], '3rd', '1st'],
  [["O'Brien, Pat", "D'Arcy, Kim"], "Pat O'Brien", "Kim D'Arcy"],
  [['john smith', 'mary jane watson'], 'J. Smith', 'M. Watson'],
  [['Ann', 'Bo'], 'Ms. Ann', 'Ms. Bo'],
])('learns %j → %s and fills %s', ([first, second], example, expected) => {
  expect(flashFill([{ sources: [first], target: example }, { sources: [second], target: null }])).toEqual([undefined, expected]);
});
