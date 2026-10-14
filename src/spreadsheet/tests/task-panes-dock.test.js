// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as P from '../src/lib/puter.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  // A desktop window: the phone query does not match.
  vi.stubGlobal('matchMedia', (q) => ({ matches: !/max-width/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (s) => String(s).replace(/["\\]/g, '\\$&') });
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (t) => ({ width: t.length * 7 }) });
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  view?.destroy();
  view = null;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

async function mount() {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb: doc.wb, id: doc.wb.activeSheetId };
}

const button = (label) => [...document.querySelectorAll('.ribbon button')].find((b) => b.getAttribute('aria-label') === label || b.textContent.trim() === label);
const tab = (name) => [...document.querySelectorAll('.ribbon [role="tab"]')].find((t) => t.textContent.trim() === name);

it('docks the task panes in the grid area, one at a time', async () => {
  await mount();
  const grid = document.querySelector('.editor-grid');
  const accessibility = grid.querySelector(':scope > .a11y-pane:not(.qc-pane):not(.chg-pane)');
  const selection = grid.querySelector(':scope > .selpane');
  expect(accessibility && selection).toBeTruthy();
  tab('Review').click();
  button('Check Accessibility').click();
  await vi.advanceTimersByTimeAsync(50);
  expect(accessibility.hidden).toBe(false);
  tab('Page Layout').click();
  button('Selection Pane').click();
  await vi.advanceTimersByTimeAsync(50);
  expect(selection.hidden).toBe(false);
  expect(accessibility.hidden).toBe(true);
});
