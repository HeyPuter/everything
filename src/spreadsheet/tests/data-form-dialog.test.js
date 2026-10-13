// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const doc = new Doc({ name: 'Stock', path: 'Spreadsheets/Stock.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  const rows = [['Name', 'Qty', 'Price', 'Total'], ['Apple', '3', '2', '=B2*C2'], ['Banana', '10', '1', '=B3*C3'], ['Cherry', '150', '0.5', '=B4*C4']];
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!A2');
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id };
}

const panel = () => document.querySelector('.modal-panel');
const button = (label) => [...panel().querySelectorAll('button')].find((b) => b.textContent === label);
const status = () => panel().querySelector('.df-status').textContent;
const field = (name) => panel().querySelector(`input[aria-label="${name}"]`);
const key = (target, k, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));
const type = (input, text) => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };

it('opens on the record at the selection, with the formula field read-only', async () => {
  await mount();
  await view.run('dataForm');
  expect(panel().getAttribute('aria-label')).toBe('Form: Sheet1');
  expect(status()).toBe('1 of 3');
  expect(field('Name').value).toBe('Apple');
  expect(field('Total').hidden).toBe(true);
  const total = panel().querySelector('output[aria-label="Total (calculated)"]');
  expect(total.textContent).toBe('6');
  expect(total.hidden).toBe(false);
});

it('writes an edited record when moving on, as one undo step, and Restore puts back what was typed over', async () => {
  const { wb, id } = await mount();
  await view.run('dataForm');
  type(field('Qty'), '5');
  expect(button('Restore').disabled).toBe(false);
  button('Restore').click();
  expect(field('Qty').value).toBe('3');
  type(field('Qty'), '7');
  key(field('Qty'), 'ArrowDown');
  expect(status()).toBe('2 of 3');
  expect(wb.getValue(id, 1, 1)).toBe(7);
  expect(wb.getValue(id, 1, 3)).toBe(14);
  expect(wb.undoLabels()).toEqual(['Edit record']);
  key(field('Name'), 'PageDown');
  expect(status()).toBe('New Record');
  key(field('Name'), 'PageUp');
  expect(status()).toBe('1 of 3');
});

it('adds a new record under the list and closes onto it', async () => {
  const { wb, id } = await mount();
  await view.run('dataForm');
  button('New').click();
  expect(status()).toBe('New Record');
  type(field('Name'), 'Date');
  type(field('Qty'), '4');
  type(field('Price'), '3');
  button('Close').click();
  await vi.advanceTimersByTimeAsync(5);
  expect(wb.getValue(id, 4, 0)).toBe('Date');
  expect(wb.getCell(id, 4, 3).f).toBe('B5*C5');
  expect(wb.getValue(id, 4, 3)).toBe(12);
  expect(view.el.querySelector('.grid-viewport').getAttribute('aria-activedescendant')).toBe('gc-4-0');
});

it('finds records by criteria and deletes the one shown after asking', async () => {
  const { wb, id } = await mount();
  await view.run('dataForm');
  button('Criteria').click();
  expect(status()).toBe('Criteria');
  type(field('Qty criteria'), '>=10');
  button('Find Next').click();
  expect(status()).toBe('2 of 3');
  button('Find Next').click();
  expect(status()).toBe('3 of 3');
  button('Find Next').click();
  expect(status()).toBe('3 of 3');
  expect(panel().querySelector('.df-message').textContent).toMatch(/No more records/);
  button('Find Prev').click();
  expect(status()).toBe('2 of 3');
  button('Delete').click();
  await vi.advanceTimersByTimeAsync(1);
  const confirm = [...document.querySelectorAll('.modal-panel')].at(-1);
  [...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Delete').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(status()).toBe('2 of 2');
  expect(field('Name').value).toBe('Cherry');
  expect(wb.getValue(id, 2, 0)).toBe('Cherry');
  wb.undo();
  expect(wb.getValue(id, 2, 0)).toBe('Banana');
});

it('says so when there is no list at the selection', async () => {
  await mount();
  view.goTo('Sheet1!H20');
  await vi.advanceTimersByTimeAsync(1);
  await view.run('dataForm');
  expect(document.querySelector('.modal-panel')).toBeNull();
});
