// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openQueryEditor } from '../src/ui/query-editor.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

// Keep Top Rows (and Keep Bottom, Remove Top and Remove Bottom Rows) took an empty box for 0, as Number('') is:
// OK with nothing typed added a step that kept no rows at all, and the query's preview went empty. The box must
// now hold a whole number, as Power Query's dialog asks for one.
window.matchMedia ||= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
afterEach(() => { closeMenu(); closeAllModals(); document.body.replaceChildren(); });

it('refuses an empty row count instead of keeping no rows', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region', 'Units'], ['North', 10], ['South', 4], ['East', 1]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 1 }, { name: 'Sales' });
  const ctx = { wb, grid: { focus: vi.fn(), editing: false }, sheetId: () => id, active: () => ({ r: 1, c: 0 }), subscribe: () => () => {}, onQueriesChanged: vi.fn() };
  const editor = openQueryEditor(ctx, { draft: { id: 'q1', name: 'Sales', source: { kind: 'table', table: 'Sales' }, steps: [], load: { kind: 'connection' } } });
  await editor.ready;
  [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Keep Rows').click();
  [...document.querySelectorAll('.menu [role="menuitem"]')].find((n) => n.textContent.trim().startsWith('Keep Top Rows')).click();
  const dialog = [...document.querySelectorAll('.modal-panel')].at(-1);
  dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  const input = dialog.querySelector('[aria-label="Number of rows"]');
  expect(input.getAttribute('aria-invalid')).toBe('true');
  expect(editor.query.steps).toEqual([]);
  input.value = '2';
  dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  expect(editor.query.steps.map((s) => [s.type, s.count])).toEqual([['keepFirst', 2]]);
  expect(editor.result.table.rows).toHaveLength(2);
});
