import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A filter's text conditions compared the value literally: "equals a?c" kept only a cell reading "a?c", and
// "contains a~*c" kept nothing. Excel's custom AutoFilter reads ? as any one character, * as any run of them, and
// ~ before either as that character itself.
function list() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['Name', 'abc', 'a*c', 'axc', 'a?c', 'ab', 'ABC', 'xabcx', ''].forEach((v, r) => v && wb.setInput(id, r, 0, v));
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 8, c2: 0 });
  const shown = () => [1, 2, 3, 4, 5, 6, 7, 8].filter((r) => !wb.sheet(id).filterHidden.has(r)).map((r) => wb.getDisplay(id, r, 0));
  return { wb, id, shown };
}

it('reads ? and * as wildcards in each text condition', () => {
  const { wb, id, shown } = list();
  const by = (op, value) => { wb.setFilterCriteria(id, 0, { op, value }); return shown(); };
  expect(by('eq', 'a?c')).toEqual(['abc', 'a*c', 'axc', 'a?c', 'ABC']);
  expect(by('neq', 'a?c')).toEqual(['ab', 'xabcx', '']);
  expect(by('contains', 'b*x')).toEqual(['xabcx']);
  expect(by('notContains', 'a*c')).toEqual(['ab', '']);
  expect(by('beginsWith', 'a?')).toEqual(['abc', 'a*c', 'axc', 'a?c', 'ab', 'ABC']);
  expect(by('endsWith', '?C')).toEqual(['abc', 'a*c', 'axc', 'a?c', 'ABC']);
});

it('takes ~ before a wildcard as the character itself, and plain text as it is', () => {
  const { wb, id, shown } = list();
  const by = (op, value) => { wb.setFilterCriteria(id, 0, { op, value }); return shown(); };
  expect(by('contains', 'a~*c')).toEqual(['a*c']);
  expect(by('eq', 'a~?c')).toEqual(['a?c']);
  expect(by('contains', 'bc')).toEqual(['abc', 'ABC', 'xabcx']);
});
