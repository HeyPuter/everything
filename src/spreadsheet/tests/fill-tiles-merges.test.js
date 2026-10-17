import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// Dragging the fill handle (or Ctrl+D) from merged cells copied the values but not the merges, as a paste
// of the same block would have: the filled rows came out unmerged.
function book(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => { if (v != null) wb.setInput(id, r, c, v); }));
  return { wb, id };
}
const merges = (wb, id) => wb.sheet(id).merges.map(m => [m.r1, m.c1, m.r2, m.c2]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);

describe('fill repeats the source merges', () => {
  it('lays a merge down in each filled copy, and undo takes them away again', () => {
    const { wb, id } = book([['Q1', null]]);
    wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 1 });
    const before = wb.toJSON();
    wb.fill(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { r1: 0, c1: 0, r2: 3, c2: 1 });
    expect(merges(wb, id)).toEqual([[0, 0, 0, 1], [1, 0, 1, 1], [2, 0, 2, 1], [3, 0, 3, 1]]);
    expect([0, 1, 2, 3].map(r => wb.getValue(id, r, 0))).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    const after = wb.toJSON();
    wb.undo();
    expect(wb.toJSON()).toEqual(before);
    wb.redo();
    expect(wb.toJSON()).toEqual(after);
  });

  it('repeats along Ctrl+D, a fill right, and a fill up on the source grid', () => {
    const down = book([['Title']]);
    down.wb.mergeCells(down.id, { r1: 0, c1: 0, r2: 0, c2: 2 });
    down.wb.fillDirection(down.id, { r1: 0, c1: 0, r2: 2, c2: 2 }, 'down');
    expect(merges(down.wb, down.id)).toEqual([[0, 0, 0, 2], [1, 0, 1, 2], [2, 0, 2, 2]]);

    const right = book([['a'], [null]]);
    right.wb.mergeCells(right.id, { r1: 0, c1: 0, r2: 1, c2: 0 });
    right.wb.fill(right.id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 1, c2: 2 });
    expect(merges(right.wb, right.id)).toEqual([[0, 0, 1, 0], [0, 1, 1, 1], [0, 2, 1, 2]]);

    // A two-row block holding a two-row merge, filled up over five rows: only whole copies get the merge.
    const up = book([[], [], [], [], [], ['x'], [null]]);
    up.wb.mergeCells(up.id, { r1: 5, c1: 0, r2: 6, c2: 0 });
    up.wb.fill(up.id, { r1: 5, c1: 0, r2: 6, c2: 0 }, { r1: 0, c1: 0, r2: 6, c2: 0 });
    expect(merges(up.wb, up.id)).toEqual([[1, 0, 2, 0], [3, 0, 4, 0], [5, 0, 6, 0]]);
  });

  it('replaces a destination merge it covers whole, clearing what was hidden under it', () => {
    const { wb, id } = book([['a', null, null], [null, 'old', 'hidden']]);
    wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 2 });
    wb.mergeCells(id, { r1: 1, c1: 1, r2: 1, c2: 2 });
    wb.fill(id, { r1: 0, c1: 0, r2: 0, c2: 2 }, { r1: 0, c1: 0, r2: 1, c2: 2 });
    expect(merges(wb, id)).toEqual([[0, 0, 0, 2], [1, 0, 1, 2]]);
    expect([0, 1, 2].map(c => wb.getValue(id, 1, c))).toEqual(['a', null, null]);
  });

  it('refuses a fill whose merges would cut through a destination merge', () => {
    const { wb, id } = book([['a', null], [null, null]]);
    wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 1 });
    wb.mergeCells(id, { r1: 1, c1: 1, r2: 1, c2: 2 });
    const events = [];
    wb.addEventListener('change', e => { if (e.detail.type === 'merge-paste') events.push(e.detail.reason); });
    const before = wb.toJSON();
    wb.fill(id, { r1: 0, c1: 0, r2: 0, c2: 1 }, { r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(events).toEqual(['overlap']);
    expect(wb.toJSON()).toEqual(before);
  });
});
