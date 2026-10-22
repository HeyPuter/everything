// @vitest-environment jsdom
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

// A column's filter list in the query editor, searched for "pen" and confirmed, kept every value: the values the
// search hid stayed ticked, so the list was whole and OK added no step. As in Power Query (and the sheet's own
// filter menu), the values a search hides are left out when the list is confirmed.
async function open() {
  const wb = new Workbook();
  const ctx = { wb, grid: { focus: vi.fn(), editing: false }, sheetId: () => wb.activeSheetId, active: () => ({ r: 1, c: 0 }), subscribe: () => () => {}, onQueriesChanged: vi.fn() };
  const draft = { id: 'q1', name: 'Q', source: { kind: 'csv', name: 'x.csv', text: 'Item,Units\nPens,10\nPencils,4\nInk,7\nClips,1\n' }, steps: [{ id: 's0', type: 'promoteHeaders' }], load: { kind: 'connection' } };
  const editor = openQueryEditor(ctx, { draft }); await editor.ready; await settle();
  button('Filter Item').click();
  const popup = document.querySelector('.pq-popup');
  const search = popup.querySelector('input[type="search"]');
  search.value = 'pen'; search.dispatchEvent(new Event('input'));
  return popup;
}

it('keeps only the values a search finds', async () => {
  const popup = await open();
  [...popup.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
  await settle();
  expect(bodyRows().map((r) => r[0])).toEqual(['Pens', 'Pencils']);
});

it('keeps only the found values left ticked', async () => {
  const popup = await open();
  [...popup.querySelectorAll('label.check')].find((l) => l.textContent === 'Pencils').querySelector('input').checked = false;
  [...popup.querySelectorAll('button')].find((b) => b.textContent === 'OK').click();
  await settle();
  expect(bodyRows().map((r) => r[0])).toEqual(['Pens']);
});

it('confirms the list with Enter in the search box', async () => {
  const popup = await open();
  popup.querySelector('input[type="search"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await settle();
  expect(document.querySelector('.pq-popup')).toBeNull();
  expect(bodyRows().map((r) => r[0])).toEqual(['Pens', 'Pencils']);
});
