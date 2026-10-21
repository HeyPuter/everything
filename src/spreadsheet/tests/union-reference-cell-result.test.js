import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';

// A union of references, (A1,A2), feeds SUM, AREAS and INDEX as several areas, but it is no value a cell can show:
// Excel gives #VALUE!. Entered on its own it spilled its cells out as one column instead, or showed #SPILL! where
// something stood in the way.
it('shows #VALUE! for a union of references as a cell result, and still reads it in functions', () => {
  const wb = new Workbook({ sheets: [{ name: 'Sheet1' }, { name: 'Data' }] });
  const [id, data] = wb.sheets.map((s) => s.id);
  wb.setInput(data, 0, 0, '1');
  wb.setInput(data, 1, 0, '2');
  wb.setInput(id, 0, 0, '=(Data!A1,Data!A2)');
  wb.setInput(id, 0, 1, '=(Data!A1:A2,Data!B1)');
  wb.setInput(id, 1, 1, 'in the way');
  wb.setInput(id, 0, 2, '=SUM((Data!A1,Data!A2))');
  wb.setInput(id, 0, 3, '=AREAS((Data!A1,Data!A2))');
  wb.setInput(id, 0, 4, '=INDEX((Data!A1,Data!A2),1,1,2)');
  expect(wb.getValue(id, 0, 0)).toEqual({ error: '#VALUE!' });
  expect(wb.spillRangeAt(id, 0, 0)).toBe(null);
  expect(wb.getValue(id, 1, 0)).toBe(null);
  expect(wb.getValue(id, 0, 1)).toEqual({ error: '#VALUE!' });
  expect([wb.getValue(id, 0, 2), wb.getValue(id, 0, 3), wb.getValue(id, 0, 4)]).toEqual([3, 2, 2]);
});
