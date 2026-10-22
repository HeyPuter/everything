// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as notifications from '../src/ui/toast.js';

// A chart inserted from a range is selected over it, the range staying selected behind it out of sight. A paste
// then went into that range: Ctrl+V with a chart just made from A1:C3 wrote the clipboard over its own headers,
// with nothing on screen saying where it went. Cells are not pasted behind a selected object now; a picture on the
// clipboard still lands as a picture.
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
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function mount() {
  const doc = new Doc({ name: 'Chart', path: 'Spreadsheets/Chart.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setCells(id, [['Region', 'Q1'], ['North', 10], ['South', 20]].flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  const paste = (data) => {
    const e = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t) => data[t] ?? '', setData() {}, files: [] } });
    viewport.dispatchEvent(e);
  };
  view.goTo('Sheet1!A1:B3');
  const chartId = await view.run('chart', { action: 'insert', subtype: 'columnClustered' });
  await vi.advanceTimersByTimeAsync(5);
  return { wb, id, paste, chartId };
}

it('pastes no cells behind a chart selected over them, from the shortcut or the Edit menu', async () => {
  vi.stubGlobal('navigator', { onLine: true, clipboard: { readText: async () => 'Y\tZ' } });
  const { wb, id, paste, chartId } = await mount();
  expect(wb.sheet(id).charts.map((ch) => ch.id)).toEqual([chartId]);
  const notify = vi.spyOn(notifications, 'toast');
  paste({ 'text/plain': 'X\tW' });
  await vi.advanceTimersByTimeAsync(5);
  expect(wb.rangeValues(id, { r1: 0, c1: 0, r2: 0, c2: 1 })).toEqual([['Region', 'Q1']]);
  expect(notify.mock.calls.some(([message]) => message === 'Select the cells to paste into')).toBe(true);
  await view.run('paste');
  await vi.advanceTimersByTimeAsync(5);
  expect(wb.rangeValues(id, { r1: 0, c1: 0, r2: 0, c2: 1 })).toEqual([['Region', 'Q1']]);
  // Cells selected again take the paste.
  view.goTo('Sheet1!D5');
  paste({ 'text/plain': 'X\tW' });
  await vi.advanceTimersByTimeAsync(5);
  expect(wb.rangeValues(id, { r1: 4, c1: 3, r2: 4, c2: 4 })).toEqual([['X', 'W']]);
});
