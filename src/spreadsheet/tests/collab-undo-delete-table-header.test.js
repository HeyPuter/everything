import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { Replica } from '../src/collab/replica.js';

// Deleting the row of a table's header makes its first data row the header, which holds no formulas: the calculated
// column's formula in that row goes. In a shared workbook Undo writes back only the formulas a deletion turned to
// #REF!, so this one stayed gone after Undo; Undo on a workbook of one's own put it back.
it('puts back the formula a table lost from the row that became its header', () => {
  const wb = new Workbook({ sheets: [{ name: 'Sheet1' }] });
  new Replica(wb);
  const s = wb.activeSheetId;
  wb.addTable(s, { r1: 2, c1: 1, r2: 4, c2: 2 });
  wb.setInput(s, 4, 1, '=C5*2');
  const formulas = () => [...wb.sheet(s).cells].filter(([, c]) => c.f).map(([k, c]) => `${k}=${c.f}`).sort();
  const before = formulas();
  expect(before).toEqual(['3,1=C4*2', '4,1=C5*2']);
  wb.deleteRows(s, 2, 1);
  wb.undo();
  expect(formulas()).toEqual(before);
});
