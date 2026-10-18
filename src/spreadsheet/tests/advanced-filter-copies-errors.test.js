import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { advancedFilter } from '../src/core/advanced-filter.js';

// Advanced Filter copying records elsewhere wrote an error value (#N/A typed in, or a formula's #DIV/0!)
// as the text "#N/A": the copy looked the same but ISERROR, IFERROR and lookups no longer saw an error.
describe('Advanced Filter copying errors', () => {
  it('copies an error as the error, not as its text', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    [['Name', 'Val'], ['a', '=1/0'], ['b', '#N/A'], ['c', '3']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
    expect(advancedFilter(wb, id, { list: { r1: 0, c1: 0, r2: 3, c2: 1 }, copyTo: { range: { r1: 0, c1: 4, r2: 0, c2: 4 } } })).toEqual({ copied: 3, columns: 2 });
    expect([1, 2, 3].map((r) => wb.getValue(id, r, 5))).toEqual([{ error: '#DIV/0!' }, { error: '#N/A' }, 3]);
    wb.setInput(id, 6, 0, '=ISERROR(F2)');
    expect(wb.getValue(id, 6, 0)).toBe(true);
  });
});
