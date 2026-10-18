import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// LOG(x,1) divides by the logarithm of 1, which is zero: Excel answers #DIV/0!, where this said #NUM!,
// so IFERROR chains and ERROR.TYPE that tell the two apart went the wrong way.
it('is #DIV/0! for a base of 1 and #NUM! for a number or base that has no logarithm', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const calc = (f) => { wb.setInput(id, 0, 0, `=${f}`); return wb.getValue(id, 0, 0); };
  expect(calc('LOG(10,1)')).toEqual({ error: '#DIV/0!' });
  expect(calc('LOG(1,1)')).toEqual({ error: '#DIV/0!' });
  expect(calc('ERROR.TYPE(LOG(5,1))')).toBe(2);
  expect(calc('LOG(0,1)')).toEqual({ error: '#NUM!' });
  expect(calc('LOG(-2,1)')).toEqual({ error: '#NUM!' });
  expect(calc('LOG(10,0)')).toEqual({ error: '#NUM!' });
  expect(calc('LOG(8,2)')).toBe(3);
  expect(calc('LOG(100)')).toBe(2);
});
