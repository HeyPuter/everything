import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, getThread } from '../src/core/comments.js';

// Excel does not move hidden rows when it sorts rows, nor hidden columns when it sorts columns: the shown
// lines are sorted among themselves. The sort moved every line, so a hidden row's contents came into view
// and a shown row's disappeared under the row that stayed hidden.
const rows = (wb, id) => [0, 1, 2, 3, 4].map((r) => `${wb.getValue(id, r, 0)}${wb.sheet(id).hiddenRows.has(r) ? '*' : ''}`);

describe('sorting around hidden lines', () => {
  it('leaves a hidden row where it is and sorts the shown rows', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    ['d', 'b', 'kept', 'a', 'c'].forEach((v, r) => { wb.setInput(id, r, 0, v); wb.setInput(id, r, 1, `=A${r + 1}&"!"`); });
    wb.setNote(id, 4, 0, 'on c');
    addComment(wb, id, 2, 0, 'on kept', 'me');
    wb.setHidden(id, 'row', [2], true);
    expect(wb.sortRangeBy(id, { r1: 0, c1: 0, r2: 4, c2: 1 }, [{ col: 0 }])).toBe(true);
    expect(rows(wb, id)).toEqual(['a', 'b', 'kept*', 'c', 'd']);
    expect([0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, 1))).toEqual(['a!', 'b!', 'kept!', 'c!', 'd!']);
    expect(wb.getNote(id, 3, 0)).toBe('on c');
    expect(getThread(wb, id, 2, 0)?.items[0].text).toBe('on kept');
    wb.undo();
    expect([0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, 0))).toEqual(['d', 'b', 'kept', 'a', 'c']);
  });

  it('still sorts the rows a filter hides, which the filter then hides again', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    [['Name', 'Keep'], ['d', 'y'], ['b', 'n'], ['a', 'y'], ['c', 'n']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
    wb.setFilterRange(id, { r1: 0, c1: 0, r2: 4, c2: 1 });
    wb.setFilterCriteria(id, 1, { values: ['y'] });
    expect([...wb.sheet(id).filterHidden].sort()).toEqual([2, 4]);
    wb.sortRangeBy(id, { r1: 1, c1: 0, r2: 4, c2: 1 }, [{ col: 0 }]);
    expect([1, 2, 3, 4].map((r) => wb.getValue(id, r, 0))).toEqual(['a', 'b', 'c', 'd']);
    expect([...wb.sheet(id).filterHidden].sort()).toEqual([2, 3]);
  });

  it('leaves a hidden column where it is when sorting columns', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    ['3', '1', '0', '2'].forEach((v, c) => wb.setInput(id, 0, c, v));
    wb.setHidden(id, 'col', [2], true);
    expect(wb.sortColumnsBy(id, { r1: 0, c1: 0, r2: 0, c2: 3 }, [{ row: 0 }])).toBe(true);
    expect([0, 1, 2, 3].map((c) => wb.getValue(id, 0, c))).toEqual([1, 2, 0, 3]);
  });
});
