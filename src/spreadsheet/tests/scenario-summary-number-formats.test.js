import { expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { saveScenario, createScenarioSummary, parseChangingCells } from '../src/core/scenarios.js';

it('shows the changing and result cells in the summary in their own number formats', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 1, '$1,200.00'); // B1: a price, typed as currency
  wb.setInput(id, 1, 1, '5%'); // B2: a rate
  wb.setInput(id, 2, 1, '=B1*(1+B2)'); // B3: carries B1's currency
  expect(wb.getDisplay(id, 2, 1)).toBe('$1,260.00');
  saveScenario(wb, id, { name: 'High', cells: parseChangingCells('B1:B2'), values: [1500, 0.1] });
  const s = createScenarioSummary(wb, id, parseChangingCells('B3')).sheetId;
  const shown = (r, c) => wb.getDisplay(s, r, c);
  expect([shown(5, 3), shown(5, 4)]).toEqual(['$1,200.00', '$1,500.00']);
  expect([shown(6, 3), shown(6, 4)]).toEqual(['5%', '10%']);
  expect([shown(8, 3), shown(8, 4)]).toEqual(['$1,260.00', '$1,650.00']);
  // Labels keep their own look.
  expect(wb.getCell(s, 5, 2)?.s?.fmt).toBeUndefined();
});
