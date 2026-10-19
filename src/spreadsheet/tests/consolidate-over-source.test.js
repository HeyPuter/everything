// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// Data ▸ Consolidate writes its result at the active cell. With the list selected (the dialog offers the selection
// as the reference) and OK pressed, the result went over the list itself: its header and first rows were replaced
// by the totals and the rest was left beneath them. Excel refuses a destination that overlaps a source reference;
// the dialog now says so, and so does the command, wherever the result would reach into a source.
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
afterEach(() => { closeMenu(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function open() {
  const doc = new Doc({ name: 'Cons', path: 'Spreadsheets/Cons.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  [['Region', 'Q1'], ['East', '10'], ['West', '5'], ['East', '7']].forEach((row, r) => row.forEach((t, c) => wb.setInput(id, r, c, t)));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const grid = (r2, c1, c2) => Array.from({ length: r2 + 1 }, (_, r) => Array.from({ length: c2 - c1 + 1 }, (_, j) => wb.getDisplay(id, r, c1 + j)).join('|'));
  return { wb, id, grid };
}
const LIST = ['Region|Q1', 'East|10', 'West|5', 'East|7'];

it('keeps the dialog open and the list whole when the result would land inside a reference', async () => {
  const { grid } = await open();
  view.goTo('Sheet1!A1:B4');
  await vi.advanceTimersByTimeAsync(1);
  view.run('consolidate');
  await vi.advanceTimersByTimeAsync(1);
  const dialog = document.querySelector('.modal-root:not(.closing) .consolidate-dialog');
  dialog.querySelectorAll('input[type=checkbox]').forEach((b) => { b.checked = true; });
  dialog.querySelector('button[type=submit]').click();
  await vi.advanceTimersByTimeAsync(1);
  expect(document.querySelector('.modal-root:not(.closing) .consolidate-dialog')).toBeTruthy();
  expect(dialog.textContent).toContain('inside Sheet1!A1:B4');
  expect(grid(3, 0, 1)).toEqual(LIST);
});

it('refuses a result reaching into a source, and writes one clear of them', async () => {
  const { wb, id, grid } = await open();
  [['Region', 'Q1'], ['East', '10'], ['West', '5'], ['East', '7']].forEach((row, r) => row.forEach((t, c) => wb.setInput(id, 9 + r, c, t)));
  // From A8 the three rows of totals would run into the list at A10.
  view.goTo('Sheet1!A8');
  await vi.advanceTimersByTimeAsync(1);
  await view.run('consolidate', { fn: 'sum', refs: ['Sheet1!A10:B13'], topRow: true, leftColumn: true });
  expect([9, 10, 11, 12].map((r) => `${wb.getDisplay(id, r, 0)}|${wb.getDisplay(id, r, 1)}`)).toEqual(LIST);
  expect(wb.getDisplay(id, 7, 1)).toBe('');
  view.goTo('Sheet1!D1');
  await vi.advanceTimersByTimeAsync(1);
  await view.run('consolidate', { fn: 'sum', refs: ['Sheet1!A1:B4'], topRow: true, leftColumn: true });
  expect(grid(2, 3, 4)).toEqual(['|Q1', 'East|17', 'West|5']);
  expect(grid(3, 0, 1)).toEqual(LIST);
});
