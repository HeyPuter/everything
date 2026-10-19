// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openImportData } from '../src/ui/get-data.js';
import { closeAllModals } from '../src/ui/modal.js';
import { saveQuery, queryByName, loadResult, evaluateQuery, loadedTable } from '../src/core/queries.js';

// Load To… ▸ Existing worksheet for a query already loaded took its table away first and only then tried the new
// place: when that place held data (or the source could not be read), the move failed and the table was gone,
// the query left as a connection only. A failed move now leaves the table where it was, still the query's.
window.matchMedia ||= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });

async function loaded() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 5, 'keep me');
  const ctx = { wb, grid: { focus: vi.fn(), editing: false }, sheetId: () => id, active: () => ({ r: 0, c: 5 }), subscribe: () => () => {}, onQueriesChanged: vi.fn(), autofitColumns: () => {} };
  saveQuery(wb, { id: 'q', name: 'Sales', source: { kind: 'csv', name: 's.csv', text: 'a,b\n1,2\n3,4\n' }, steps: [{ type: 'promoteHeaders' }] });
  const q = queryByName(wb, 'Sales');
  loadResult(wb, q, (await evaluateQuery(wb, q, {})).table, { at: { sheetId: id, r: 0, c: 0 } });
  return { wb, id, ctx };
}

async function loadTo(ctx, wb, where) {
  openImportData(ctx, { query: queryByName(wb, 'Sales') });
  const form = document.querySelector('.pq-import');
  form.querySelector('input[value="existing"]').click();
  form.querySelector('input[aria-label="Existing worksheet location"]').value = where;
  form.dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
}

it('keeps the loaded table when the new place is taken', async () => {
  const { wb, id, ctx } = await loaded();
  const steps = wb.historySince(null).length;
  await loadTo(ctx, wb, '=$F$1');
  const hit = loadedTable(wb, queryByName(wb, 'Sales'));
  expect(hit?.table.range).toMatchObject({ r1: 0, c1: 0, r2: 2, c2: 1 });
  expect([wb.getValue(id, 0, 0), wb.getValue(id, 1, 0), wb.getValue(id, 2, 1)]).toEqual(['a', '1', '4']);
  expect(wb.getValue(id, 0, 5)).toBe('keep me');
  // Nothing happened, so nothing is left to undo.
  expect(wb.historySince(null).length).toBe(steps);
});

it('still moves the table to a free place', async () => {
  const { wb, id, ctx } = await loaded();
  await loadTo(ctx, wb, '=$H$3');
  const hit = loadedTable(wb, queryByName(wb, 'Sales'));
  expect(hit.table.range).toMatchObject({ r1: 2, c1: 7 });
  expect(wb.getValue(id, 3, 7)).toBe('1');
  expect(wb.getValue(id, 1, 0)).toBe(null);
});
