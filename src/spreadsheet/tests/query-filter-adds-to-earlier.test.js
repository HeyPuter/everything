// @vitest-environment jsdom
// After values were unticked in a column's filter list, a second filter on the same column (Remove Empty, or a
// Text Filter) took the place of the first, and the unticked rows came back. A filter that is not read from the
// step before is now a step of its own on what that step left, as in Power Query; ticking the list again, or
// changing the conditions the Filter Rows dialog shows, still edits that step.
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openQueryEditor } from '../src/ui/query-editor.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';
window.matchMedia ||= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
globalThis.CSS ||= {}; CSS.escape ||= (s) => String(s).replace(/["\\]/g, '\\$&');
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
afterEach(() => { closeMenu(); closeAllModals(); document.body.replaceChildren(); });
const button = (label) => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) || null;
const bodyRows = () => [...document.querySelectorAll('.pq-live tbody tr')].map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent));
it('Remove Empty after unticking a value keeps the value filtered out', async () => {
  const wb = new Workbook(); const id = wb.activeSheetId;
  [['Region', 'Units'], ['North', 10], ['South', 4], ['', 7], ['East', 1]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.addTable(id, { r1: 0, c1: 0, r2: 4, c2: 1 }, { name: 'Sales' });
  const ctx = { wb, grid: { focus: vi.fn(), editing: false }, sheetId: () => wb.activeSheetId, active: () => ({ r: 1, c: 0 }), subscribe: () => () => {}, onQueriesChanged: vi.fn() };
  // A CSV source so the empty Region stays "" (a blank, not null).
  const draft = { id: 'q1', name: 'Q', source: { kind: 'csv', name: 'x.csv', text: 'Region,Units\nNorth,10\nSouth,4\n,7\nEast,1\n' }, steps: [{ id: 's0', type: 'promoteHeaders' }], load: { kind: 'connection' } };
  const editor = openQueryEditor(ctx, { draft }); await editor.ready; await settle();
  button('Filter Region').click();
  let popup = document.querySelector('.pq-popup');
  [...popup.querySelectorAll('label.check')].find((l) => l.textContent === 'North').querySelector('input').checked = false;
  [...popup.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
  await settle();
  button('Filter Region').click();
  popup = document.querySelector('.pq-popup');
  [...popup.querySelectorAll('button')].find((b) => b.textContent === 'Remove Empty').click();
  await settle();
  const regions = bodyRows().map((r) => r[0]);
  expect(regions).toEqual(['South', 'East']);
  // The second filter is a step of its own after the first.
  expect([...document.querySelectorAll('.pq-step-name')].map((b) => b.textContent)).toEqual(['Source', 'Promoted Headers', 'Filtered Rows', 'Filtered Rows1']);
});
