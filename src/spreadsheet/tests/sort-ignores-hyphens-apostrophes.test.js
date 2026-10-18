import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Excel's default sort order ignores apostrophes and hyphens in text, except that of two texts the same but
// for a hyphen, the one with the hyphen comes last. The sort compared them as characters of their own, so
// "-x" and "e-mail" landed before every letter and "co-op" before "coop".
function sorted(values, ascending = true) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, values.map((v, r) => ({ r, c: 0, cell: { v } })));
  wb.sortRangeBy(id, parseRange(`A1:A${values.length}`), [{ col: 0, ascending }]);
  return values.map((_, r) => wb.getValue(id, r, 0));
}

describe('sorting text with hyphens and apostrophes', () => {
  it('sorts as if they were not there', () => {
    expect(sorted(['email', 'zone', 'e-mail', "o'neil", 'apple', 'ollie', 'onion', '-x'])).toEqual(['apple', 'email', 'e-mail', 'ollie', "o'neil", 'onion', '-x', 'zone']);
  });

  it('puts the hyphenated one last of two otherwise the same, either way round', () => {
    expect(sorted(['co-op', 'coop', 'cook'])).toEqual(['cook', 'coop', 'co-op']);
    expect(sorted(['coop', 'co-op', 'cook'])).toEqual(['cook', 'coop', 'co-op']);
    expect(sorted(['coop', 'co-op', 'cook'], false)).toEqual(['co-op', 'coop', 'cook']);
  });
});
