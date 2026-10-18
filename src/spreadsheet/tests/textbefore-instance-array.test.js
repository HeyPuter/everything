import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

/** The block a formula in A1 spills, `rows` by `cols`. */
function spill(formula, rows, cols) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, `=${formula}`);
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => wb.getValue(id, r, c)));
}

// An array of instance numbers (or match modes) answers one result for each, as an array of texts
// does; the delimiter stays whole, since an array there lists several delimiters.
it('answers one result for each instance number of an array', () => {
  expect(spill('TEXTBEFORE("a-b-c","-",{1,2})', 1, 2)).toEqual([['a', 'a-b']]);
  expect(spill('TEXTAFTER("a-b-c","-",SEQUENCE(2))', 2, 1)).toEqual([['b-c'], ['c']]);
  expect(spill('TEXTBEFORE("a-b-c","-",{1,-1,3})', 1, 3)).toEqual([['a', 'a-b', { error: '#N/A' }]]);
  expect(spill('TEXTAFTER("aXbxc","x",1,{0,1})', 1, 2)).toEqual([['c', 'bxc']]);
  expect(spill('TEXTBEFORE({"a-b";"c-d-e"},"-",{1,2})', 2, 2)).toEqual([['a', { error: '#N/A' }], ['c', 'c-d']]);
});

it('keeps an array of delimiters as alternatives', () => {
  expect(spill('TEXTBEFORE("a_b-c",{"-","_"})', 1, 1)).toEqual([['a']]);
  expect(spill('TEXTAFTER("a_b-c",{"-","_"},2)', 1, 1)).toEqual([['c']]);
});
