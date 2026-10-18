// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { applyStep, normalizeQuery, stepFormula, stepNames } from '../src/core/queries.js';
import { openQueryEditor } from '../src/ui/query-editor.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

window.matchMedia ||= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
afterEach(() => { closeMenu(); closeAllModals(); document.body.replaceChildren(); });
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

it('adds a formatted copy of a column for Add Column ▸ Format, leaving the column as it was', () => {
  const t = { columns: ['Name', 'Qty'], types: ['text', 'int'], rows: [['ann lee', 3], [' bo ', 5], [null, 1]] };
  const step = normalizeQuery({ name: 'Q', steps: [{ type: 'addTextColumn', column: 'Name', op: 'upper' }] }).steps[0];
  expect(step).toMatchObject({ type: 'addTextColumn', column: 'Name', op: 'upper', as: 'UPPERCASE' });
  const out = applyStep(t, step);
  expect(out.columns).toEqual(['Name', 'Qty', 'UPPERCASE']);
  expect(out.types).toEqual(['text', 'int', 'text']);
  expect(out.rows).toEqual([['ann lee', 3, 'ANN LEE'], [' bo ', 5, ' BO '], [null, 1, null]]);
  expect(applyStep(t, { type: 'addTextColumn', column: 'Qty', op: 'trim', as: 'Trim' }).rows.map((r) => r[2])).toEqual(['3', '5', '1']);
  const query = { source: { kind: 'blank' }, steps: [step] };
  expect(stepNames(query)).toEqual(['Source', 'Inserted Uppercased Text']);
  expect(stepFormula(query, 1)).toBe('= Table.AddColumn(Source, "UPPERCASE", each Text.Upper([Name]), type text)');
});

it('Add Column ▸ Format in the editor adds the column; Transform ▸ Format still changes it in place', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Units'], ['north', 10], ['south', 4]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.addTable(id, { r1: 0, c1: 0, r2: 2, c2: 1 }, { name: 'Sales' });
  const ctx = { wb, grid: { focus: vi.fn(), editing: false }, sheetId: () => id, active: () => ({ r: 1, c: 0 }), subscribe: () => () => {}, onQueriesChanged: vi.fn() };
  const editor = openQueryEditor(ctx, { draft: { id: 'q1', name: 'Sales', source: { kind: 'table', table: 'Sales' }, steps: [{ id: 's1', type: 'changeType', columns: { Region: 'text', Units: 'int' } }], load: { kind: 'connection' } } });
  await editor.ready;
  const headers = () => [...document.querySelectorAll('.pq-live th.pq-col .pq-colname')].map((n) => n.textContent);
  const rows = () => [...document.querySelectorAll('.pq-live tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
  const tab = (name) => [...document.querySelectorAll('.pq-tab')].find((b) => b.textContent === name).click();
  const format = (label) => {
    [...document.querySelectorAll('.pq-ribbon-panel button')].find((b) => b.getAttribute('aria-label') === 'Format').click();
    [...document.querySelectorAll('.menu [role="menuitem"]')].find((n) => n.textContent.trim() === label).click();
  };
  document.querySelector('th.pq-col[data-col="Region"]').click();
  tab('Add Column');
  format('UPPERCASE');
  await settle();
  expect(headers()).toEqual(['Region', 'Units', 'UPPERCASE']);
  expect(rows()).toEqual([['north', '10', 'NORTH'], ['south', '4', 'SOUTH']]);
  document.querySelector('th.pq-col[data-col="Region"]').click();
  tab('Transform');
  format('Capitalize Each Word');
  await settle();
  expect(rows()).toEqual([['North', '10', 'NORTH'], ['South', '4', 'SOUTH']]);
});
