// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// The name box (and Go To) took whole columns and rows typed alone, B:C and 3:5, but not written with dollar signs
// ($3:$5, as a formula writes them) nor on another sheet (Sheet2!B:C, Sheet2!$3:$5): those were not found, and
// the text stayed in the box. They now select those lines, on their sheet.
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
  const doc = new Doc({ name: 'Lines', path: 'Spreadsheets/Lines.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const other = wb.addSheet('Sheet2').id;
  wb.setActiveSheet(home);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, home, other, box: view.el.querySelector('.name-box') };
}
async function go(box, text) {
  box.focus();
  box.value = text;
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
}

it.each([
  ['$3:$5', 'A3:XFD5'],
  ['Sheet2!B:C', 'B1:C1048576'],
  ['Sheet2!$3:$5', 'A3:XFD5'],
  ["'Sheet2'!$B:$C", 'B1:C1048576'],
])('selects %s', async (text, shown) => {
  const { wb, home, other, box } = await mount();
  await go(box, text);
  expect(wb.activeSheetId).toBe(text.includes('Sheet2') ? other : home);
  expect(document.activeElement).toBe(view.el.querySelector('.grid-viewport'));
  expect(box.value).toBe(shown);
});
