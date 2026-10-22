import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// IFS over a whole column answered an array of the rows read, without saying it stood for the whole column
// as IF's and SWITCH's answers do. Paired with a whole column of another sheet holding more rows,
// SUMPRODUCT(IFS(A:A>1,1,TRUE,0),Data!B:B) was #VALUE! for unequal shapes and SUM(IFS(...)*Data!B:B) #N/A,
// where the IF spelling gave 50, as Excel does for both.
function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  for (const r of [0, 1, 2]) wb.setInput(id, r, 0, String(r + 1));
  const data = wb.addSheet('Data').id;
  for (let r = 0; r < 6; r++) wb.setInput(data, r, 1, String(10 * (r + 1)));
  return { wb, id };
}

it('pairs IFS over a whole column with a whole column of another sheet', () => {
  const { wb, id } = book();
  const at = (formula) => { wb.setInput(id, 0, 4, `=${formula}`); return wb.getValue(id, 0, 4); };
  expect(at('SUMPRODUCT(IF(A:A>1,1,0),Data!B:B)')).toBe(50);
  expect(at('SUMPRODUCT(IFS(A:A>1,1,TRUE,0),Data!B:B)')).toBe(50);
  expect(at('SUM(IFS(A:A>1,1,TRUE,0)*Data!B:B)')).toBe(50);
  expect(at('SUMPRODUCT(IFS(A:A>2,1,A:A>1,2,TRUE,0),Data!B:B)')).toBe(70);
  expect(at('SUM(IFS(A1:A3>1,1))')).toEqual({ error: '#N/A' }); // a row no condition takes is #N/A
});
