// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openQueryEditor } from '../src/ui/query-editor.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

// Add Column ▸ Index Column ▸ Custom read an emptied Increment box as 0 (Number('') is 0), and added an index
// column whose every row held the same number. An empty box is now refused, as one that holds no number is.
window.matchMedia ||= () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
afterEach(() => { closeMenu(); closeAllModals(); document.body.replaceChildren(); });

it('refuses an empty increment instead of numbering every row the same', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Region'], ['North'], ['South'], ['East']].forEach((row, r) => wb.setInput(id, r, 0, row[0]));
  wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 0 }, { name: 'Sales' });
  const ctx = { wb, grid: { focus: vi.fn(), editing: false }, sheetId: () => id, active: () => ({ r: 1, c: 0 }), subscribe: () => () => {}, onQueriesChanged: vi.fn() };
  const editor = openQueryEditor(ctx, { draft: { id: 'q1', name: 'Sales', source: { kind: 'table', table: 'Sales' }, steps: [], load: { kind: 'connection' } } });
  await editor.ready;
  [...document.querySelectorAll('.pq-tab')].find((t) => t.textContent === 'Add Column').click();
  [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === 'Index Column').click();
  [...document.querySelectorAll('.menu [role="menuitem"]')].find((n) => n.textContent.trim().startsWith('Custom')).click();
  const dialog = [...document.querySelectorAll('.modal-panel')].at(-1);
  const inc = dialog.querySelector('[aria-label="Increment"]');
  inc.value = '';
  dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  expect(inc.getAttribute('aria-invalid')).toBe('true');
  expect(editor.query.steps).toEqual([]);
  inc.value = '10';
  dialog.querySelector('form').dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
  expect(editor.result.table.rows.map((r) => r[1])).toEqual([0, 10, 20]);
});
