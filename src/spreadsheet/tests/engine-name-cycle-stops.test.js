import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A defined name that read itself was stopped only by a limit of 64 names deep. One that reads itself
// twice, as Price = IF(ISNUMBER(Price),Price,0) does, worked itself out again twice at every level,
// 2^64 times, and the tab froze; so did a pair of names reading each other twice. Met again for the
// same cell while it is still being worked out, a name is a cycle at once.
function book() {
  const wb = new Workbook();
  return { wb, id: wb.activeSheetId };
}

it('answers a name that reads itself twice at once', () => {
  const { wb, id } = book();
  wb.defineName('Price', '=IF(ISNUMBER(Price),Price,0)');
  wb.defineName('Xa', '=Yb+Yb');
  wb.defineName('Yb', '=Xa+Xa');
  wb.defineName('Own', '=Sheet1!Own*2+Sheet1!Own', 'Sheet1');
  wb.setInput(id, 0, 0, '=Price');
  wb.setInput(id, 1, 0, '=Xa');
  wb.setInput(id, 2, 0, '=Own');
  const start = performance.now();
  expect(wb.getValue(id, 0, 0)).toBe(0); // ISNUMBER sees the cycle as an error, as it saw the depth limit's
  expect(wb.getValue(id, 1, 0)).toEqual({ error: '#CYCLE!' });
  expect(wb.getValue(id, 2, 0)).toEqual({ error: '#CYCLE!' });
  expect(performance.now() - start).toBeLessThan(1000);
});

it('still lets a name be used twice, by another cell or by the LAMBDA it answers with', () => {
  const { wb, id } = book();
  wb.setInput(id, 0, 0, '1');
  for (const r of [1, 2, 3]) wb.setInput(id, r, 0, '=Run');
  wb.defineName('Run', '=OFFSET(INDIRECT("RC",FALSE),-1,0)+1'); // reads the name again for the cell above
  wb.defineName('Base', '=Sheet1!$A$1*2');
  wb.defineName('Twice', '=Base+Base');
  wb.defineName('Fact', '=LAMBDA(n,IF(n<=1,1,n*Fact(n-1)))');
  wb.defineName('Steps', '=LET(k,1,LAMBDA(n,IF(n<=0,0,k+Steps(n-1))))');
  wb.defineName('Down', '=IF(TRUE,LAMBDA(n,IF(n=0,"done",Down(n-1))))');
  const at = (formula) => { wb.setInput(id, 0, 2, `=${formula}`); return wb.getValue(id, 0, 2); };
  expect(wb.getValue(id, 3, 0)).toBe(4);
  expect(at('Twice')).toBe(4);
  expect(at('Fact(5)')).toBe(120);
  expect(at('Steps(10)')).toBe(10);
  expect(at('Down(5)')).toBe('done');
});
