// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';

const toastRoot = document.querySelector('.toast-root');
let view, writeText;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  writeText = vi.fn(async () => {});
  vi.stubGlobal('navigator', { onLine: true, clipboard: { write: vi.fn(async () => {}), writeText } });
  vi.stubGlobal('ClipboardItem', class { constructor(data) { this.data = data; } });
  document.body.innerHTML = '<div id="app"></div>';
  toastRoot?.replaceChildren(); if (toastRoot) document.body.append(toastRoot);
});
afterEach(() => { view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// A text box linked to a cell (a dashboard's KPI tile, from an Excel file) shows that cell's text.
it('copies the text a linked text box shows, not the text it was opened with', async () => {
  const doc = new Doc({ name: 'Tiles' }), wb = doc.wb, id = wb.activeSheetId;
  wb.setInput(id, 0, 1, '1250');
  wb.addChart(id, { type: 'text', text: 'Revenue: 900 k', textRef: 'B1', textPrefix: 'Revenue: ', textSuffix: ' k', anchor: { r: 3, c: 0 }, w: 200, h: 60 });
  wb.clearHistory();
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} }); document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport'); viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', code: 'KeyO', ctrlKey: true, metaKey: true, altKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.chart-box.selected .text-body')?.textContent).toContain('Revenue: 1250 k');
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { setData: vi.fn(), getData: () => '', files: [] } });
  viewport.dispatchEvent(event);
  await vi.advanceTimersByTimeAsync(5);
  expect(writeText).toHaveBeenCalledWith('Revenue: 1250 k');
});
