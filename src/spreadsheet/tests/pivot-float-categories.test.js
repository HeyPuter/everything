import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { buildPivot } from '../src/core/pivot.js';

// Row labels equal at 15 significant digits but not bit for bit (0.3 typed beside =0.1+0.2, or prices computed by
// formulas) became two categories, while each category's SUMIFS matched both values, as the IFS functions compare
// numbers at 15 digits: every such record was counted twice and the total came out doubled. They are one category.
it('takes numbers that read the same as one category and counts each record once', () => {
  const wb = new Workbook({ sheets: [{ name: 'Data' }, { name: 'Pivot' }] });
  const [data, out] = wb.sheets;
  [['Rate', 'Orders'], ['0.3', '1'], ['=0.1+0.2', '10'], ['0.1', '100'], ['=1-0.9', '1000']].forEach((row, r) => row.forEach((t, c) => wb.setInput(data.id, r, c, t)));
  for (const [agg, rows] of [['sum', [['0.1', 1100], ['0.3', 11], ['Total', 1111]]], ['count', [['0.1', 2], ['0.3', 2], ['Total', 4]]]]) {
    const built = buildPivot(wb, data.id, { range: parseRange('A1:B5'), rowField: 0, colField: null, valueField: 1, agg });
    wb.setCells(out.id, built.cells, 'Insert pivot table');
    expect(Array.from({ length: built.rows - 1 }, (_, i) => [wb.getDisplay(out.id, i + 1, 0), wb.getValue(out.id, i + 1, 1)])).toEqual(rows);
    wb.clearRange(out.id, { r1: 0, c1: 0, r2: 10, c2: 5 });
  }
});
