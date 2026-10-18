// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { applyStep, stepFormula } from '../src/core/queries.js';
import { openQueryEditor } from '../src/ui/query-editor.js';
import { closeAllModals } from '../src/ui/modal.js';

window.matchMedia ||= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); });
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const table = { columns: ['Region', 'Product', 'Units'], types: ['text', 'text', 'int'],
  rows: [['North', 'Pens', 3], ['North', 'Pens', 3], ['North', 'Pens', 5], ['North', 'Ink', 5], ['South', 'Ink', 1]] };

it('counts each group\'s distinct rows for Count Distinct Rows, every column compared, as its formula says', () => {
  const step = { type: 'groupBy', keys: ['Region'], aggregations: [{ name: 'Distinct', op: 'countDistinct', column: '' }, { name: 'Rows', op: 'count', column: '' }] };
  const out = applyStep(table, step);
  // North has four rows, two of them the same: three distinct rows (not the two distinct products or units).
  expect(out.rows).toEqual([['North', 3, 4], ['South', 1, 1]]);
  expect(stepFormula({ source: { kind: 'blank' }, steps: [step] }, 1)).toContain('Table.RowCount(Table.Distinct(_))');
  // A step saved with a column still counts rows, so the result and the formula agree.
  expect(applyStep(table, { ...step, aggregations: [{ name: 'Distinct', op: 'countDistinct', column: 'Product' }] }).rows).toEqual([['North', 3], ['South', 1]]);
});

it('takes no column for Count Distinct Rows in the Group By dialog, as for Count Rows', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Units'], ['North', 10], ['South', 4], ['North', 10], ['North', 7]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.addTable(id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { name: 'Sales' });
  const ctx = { wb, grid: { focus: vi.fn(), editing: false }, sheetId: () => wb.activeSheetId, active: () => ({ r: 1, c: 0 }), subscribe: () => () => {}, onQueriesChanged: vi.fn() };
  const editor = openQueryEditor(ctx, { draft: { id: 'q1', name: 'Sales', source: { kind: 'table', table: 'Sales' }, steps: [{ id: 's1', type: 'changeType', columns: { Region: 'text', Units: 'int' } }], load: { kind: 'connection' } } });
  await editor.ready;
  document.querySelector('th.pq-col[data-col="Region"]').click();
  [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Group By').click();
  const dialog = [...document.querySelectorAll('.modal-panel')].at(-1);
  const [, op, column] = dialog.querySelectorAll('.pq-group-rows')[1].querySelectorAll('input, select');
  op.value = 'countDistinct'; op.dispatchEvent(new Event('change'));
  expect(column.disabled).toBe(true);
  dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const rows = [...document.querySelectorAll('.pq-live tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
  expect(rows).toEqual([['North', '2'], ['South', '1']]);
});
