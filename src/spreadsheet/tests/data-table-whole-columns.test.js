// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openDataTable } from '../src/ui/datatable.js';
import { closeAllModals } from '../src/ui/modal.js';

// What-If ▸ Data Table over whole columns (A:B selected) made a table of every row of the sheet: its formula
// ran a million times over at each recalculation, and the app froze. The table now ends where the sheet's
// data does, as the other Data commands read whole columns.
vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

it('makes the table of whole columns as tall as the data', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 5, '3');
  wb.setInput(id, 0, 1, '=F1*2');
  for (let r = 1; r <= 5; r++) wb.setInput(id, r, 0, String(r));
  const range = { r1: 0, c1: 0, r2: 1048575, c2: 1 };
  const { panel } = openDataTable({ wb, sheetId: () => id, grid: { range, focus() {} } });
  panel.querySelector('[aria-label="Column input cell"]').value = 'F1';
  panel.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  expect(wb.fixedArrayAt(id, 1, 1)).toMatchObject({ r1: 1, c1: 1, r2: 5, c2: 1 });
  expect([1, 2, 3, 4, 5].map((r) => wb.getValue(id, r, 1))).toEqual([2, 4, 6, 8, 10]);
});
