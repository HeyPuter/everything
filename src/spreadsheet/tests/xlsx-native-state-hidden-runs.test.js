import { expect, it } from 'vitest';
import { nativeSheetState } from '../src/core/xlsx-native-state.js';

// Every opening of a file saved here, and every save, notes the part's hidden rows as runs. A sheet with every
// row below its data hidden has a million of them, which were put through a Set and sorted although a part
// lists its rows in order: about 0.4 s of the 1 s the note took each way. Rows in order are now taken as they come.
const part = (rows) => `<worksheet><sheetData>${rows.map((r) => `<row r="${r + 1}" hidden="1"/>`).join('')}</sheetData></worksheet>`;

it('notes rows hidden in order without sorting them', () => {
  const xml = part(Array.from({ length: 100000 }, (_, i) => i + 3));
  const sorted = [], sort = Array.prototype.sort;
  Array.prototype.sort = function (...args) { sorted.push(this.length); return sort.apply(this, args); };
  let state;
  try { state = nativeSheetState(xml); } finally { Array.prototype.sort = sort; }
  expect(state.hiddenRows).toEqual([[3, 100002]]);
  expect(sorted.filter((length) => length > 1000)).toEqual([]);
});

it('still notes rows listed out of order, or twice, as their runs', () => {
  expect(nativeSheetState(part([7, 3, 4, 9, 8, 4])).hiddenRows).toEqual([[3, 4], [7, 9]]);
  expect(nativeSheetState(part([3, 3, 4, 6, 6])).hiddenRows).toEqual([[3, 4], [6, 6]]);
});
