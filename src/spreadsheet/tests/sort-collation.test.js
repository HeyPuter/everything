import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';

// Sorting compared text by lowercased code points, so every accented name landed
// after "z": Émile and Ærø followed Zoe. Text now sorts the way a dictionary
// orders it, while numbers, booleans, errors and blanks keep their places.
function book(values) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, values.map((v, r) => ({ r, c: 0, cell: v == null ? null : { v } })));
  return { wb, id };
}
const column = (wb, id, n) => Array.from({ length: n }, (_, r) => wb.getValue(id, r, 0));

describe('sorting text', () => {
  it('orders accented letters with their base letters instead of after z', () => {
    const { wb, id } = book(['Zoe', 'Émile', 'Adam', 'zed', 'Ærø', 'ñu', 'Nora']);
    wb.sortRangeBy(id, parseRange('A1:A7'), [{ col: 0, ascending: true }]);
    expect(column(wb, id, 7)).toEqual(['Adam', 'Ærø', 'Émile', 'Nora', 'ñu', 'zed', 'Zoe']);
    wb.sortRangeBy(id, parseRange('A1:A7'), [{ col: 0, ascending: false }]);
    expect(column(wb, id, 7)).toEqual(['Zoe', 'zed', 'ñu', 'Nora', 'Émile', 'Ærø', 'Adam']);
  });

  it('sorts columns left to right by the same order', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    wb.setCells(id, ['zed', 'Émile', 'Adam'].map((v, c) => ({ r: 0, c, cell: { v } })));
    wb.sortColumnsBy(id, parseRange('A1:C1'), [{ row: 0, ascending: true }]);
    expect([0, 1, 2].map((c) => wb.getValue(id, 0, c))).toEqual(['Adam', 'Émile', 'zed']);
  });

  it('keeps numbers before text, then booleans and errors, all reversed descending, with blanks last either way', () => {
    const { wb, id } = book(['b', 2, true, { error: '#N/A' }, null, 'a', 1, false, 'Ä']);
    wb.sortRangeBy(id, parseRange('A1:A9'), [{ col: 0, ascending: true }]);
    expect(column(wb, id, 9)).toEqual([1, 2, 'a', 'Ä', 'b', false, true, { error: '#N/A' }, null]);
    wb.sortRangeBy(id, parseRange('A1:A9'), [{ col: 0, ascending: false }]);
    expect(column(wb, id, 9)).toEqual([{ error: '#N/A' }, true, false, 'b', 'Ä', 'a', 2, 1, null]);
  });

  it('still treats letters differing only in case as equal unless asked, lowercase first when asked', () => {
    const { wb, id } = book(['b', 'B', 'a', 'é', 'E']);
    wb.sortRangeBy(id, parseRange('A1:A5'), [{ col: 0, ascending: true }]);
    expect(column(wb, id, 5)).toEqual(['a', 'b', 'B', 'E', 'é']);
    const { wb: w2, id: i2 } = book(['Apple', 'apple', 'Émile', 'émile']);
    w2.sortRangeBy(i2, parseRange('A1:A4'), [{ col: 0, ascending: true }], { caseSensitive: true });
    expect(column(w2, i2, 4)).toEqual(['apple', 'Apple', 'émile', 'Émile']);
  });
});
