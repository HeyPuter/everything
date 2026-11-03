import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// The app has a few functions Excel has not got, taken from Sheets (SPLIT, FLATTEN, JOIN, ADD and the like).
// Their names are free in Excel, so a workbook from Excel may define a LAMBDA by one of them, and its formulas
// call that LAMBDA. Here they called the built-in instead: with Flatten defined as LAMBDA(x,x*2), =Flatten(3)
// answered 3 rather than 6, =Split(A1) the text itself rather than its length, and =Add(1,2) 3 rather than 103.
// A LAMBDA the workbook names so now answers for such a call; Excel's own functions, and a name that holds no
// LAMBDA, leave the built-in as it was.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'a,b');
  wb.defineName('Flatten', '=LAMBDA(x,x*2)');
  wb.defineName('Split', '=LAMBDA(t,LEN(t))');
  wb.defineName('Add', '=LAMBDA(a,b,a+b+100)');
  wb.defineName('Join', '=Sheet1!$A$1');
  wb.defineName('ABS', '=LAMBDA(x,x+10)');
  return { wb, id, calc: (f, r = 2) => { wb.setInput(id, r, 1, f); return wb.getValue(id, r, 1); } };
}

it.each([
  ['=Flatten(3)', 6],
  ['=Split(A1)', 3],
  ['=Add(1,2)', 103],
  ['=SPLIT(A1,",")', { error: '#VALUE!' }],
  ['=JOIN("-",{1,2})', '1-2'],
  ['=ABS(-2)', 2],
])('%s answers %j', (formula, value) => {
  expect(book().calc(formula)).toEqual(value);
});

it('spills an array such a LAMBDA hands back', () => {
  const { wb, id } = book();
  wb.defineName('Minus', '=LAMBDA(n,SEQUENCE(n))');
  wb.setInput(id, 4, 3, '=Minus(3)');
  expect([4, 5, 6].map((r) => wb.getValue(id, r, 3))).toEqual([1, 2, 3]);
});
