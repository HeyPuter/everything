import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { addComment, getThread } from '../src/core/comments.js';

// Randomize range moved every row of the range, a row hidden by hand among them: its record came into view in
// another row while a shown one went under the hidden row, as a sort used to do. The shown rows now change
// places among themselves and a hidden row keeps its record, its note and its comment, as a sort leaves it.
it('leaves a hidden row where it is and shuffles the shown rows among themselves', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['a', 'b', 'kept', 'c', 'd'].forEach((v, r) => { wb.setInput(id, r, 0, v); wb.setInput(id, r, 1, `=A${r + 1}&"!"`); });
  wb.setNote(id, 2, 0, 'on kept');
  addComment(wb, id, 2, 1, 'thread on kept', 'me');
  wb.setHidden(id, 'row', [2], true);
  // Fisher–Yates with these draws reverses the four shown rows.
  const draws = [0, 0, 0];
  expect(wb.shuffleRows(id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { random: () => draws.shift() ?? 0 })).toBeGreaterThan(0);
  const col = (c) => [0, 1, 2, 3, 4].map((r) => wb.getValue(id, r, c));
  expect(col(0)[2]).toBe('kept');
  expect(col(0).filter((v, r) => r !== 2).sort()).toEqual(['a', 'b', 'c', 'd']);
  expect(col(0)).not.toEqual(['a', 'b', 'kept', 'c', 'd']);
  expect(col(1)).toEqual(col(0).map((v) => `${v}!`));
  expect(wb.getNote(id, 2, 0)).toBe('on kept');
  expect(getThread(wb, id, 2, 1)?.items[0].text).toBe('thread on kept');
  wb.undo();
  expect(col(0)).toEqual(['a', 'b', 'kept', 'c', 'd']);
});
