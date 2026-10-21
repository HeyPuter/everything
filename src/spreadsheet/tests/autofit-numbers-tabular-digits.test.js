// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Numbers are drawn with tabular figures, every digit as wide as a 0, and the grid decides whether a
// number fits its cell by that measure. Fitting a column measured the digits as the font draws them on
// their own: in a font whose 1 is narrower than its 0 (Helvetica, Segoe UI, Times New Roman, Georgia,
// the system font), a column of such numbers fitted to its content still showed ###, and so did a
// column widened for a number just typed into it.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });

let view;
const canvas = {
  font: '',
  // A proportional font: a 1 is narrower than the other digits.
  measureText(text) {
    const size = Number(/([\d.]+)px/.exec(this.font)?.[1] || 13);
    let width = 0;
    for (const ch of text) width += size * (ch === '1' ? 0.3 : 0.6);
    return { width };
  },
};
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(canvas);
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

async function open() {
  const doc = new Doc({ name: 'Ones', path: 'Spreadsheets/Ones.xlsx' });
  const wb = doc.wb, id = wb.activeSheetId;
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id };
}
const shown = async (r, c) => { await vi.advanceTimersByTimeAsync(20); return view.el.querySelector(`#gc-${r}-${c}`)?.textContent; };

it.each(['menu', 'header'])('a column of numbers fitted to its content (%s) shows them whole', async (path) => {
  const { wb, id } = await open();
  wb.setInput(id, 0, 1, '111111111111111');
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { fmt: 'number' });
  view.goTo('B1');
  await vi.advanceTimersByTimeAsync(1);
  if (path === 'menu') {
    view.el.querySelector('[data-menu="format"]').click();
    const item = (label) => [...document.querySelectorAll('.menu-item')].find((node) => node.querySelector('.menu-label')?.textContent === label);
    item('Rows and columns').click();
    item('Fit columns to content').click();
  } else view.el.querySelector('.col-resizer[data-c="1"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  expect(await shown(0, 1)).toBe('111,111,111,111,111.00');
});

it('a column widened for a number typed into it shows the number whole', async () => {
  const { wb, id } = await open();
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { fmt: 'number' });
  view.goTo('B1');
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '111111111111111';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  expect(wb.getValue(id, 0, 1)).toBe(111111111111111);
  expect(wb.colWidth(id, 1)).toBeGreaterThan(100);
  expect(await shown(0, 1)).toBe('111,111,111,111,111.00');
});
