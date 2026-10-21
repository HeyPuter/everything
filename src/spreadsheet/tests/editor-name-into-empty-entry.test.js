// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';

// With the formula bar clicked on an empty cell (or F2 on one), a name picked from Paste Name (F3) or Use in Formula
// went into the entry without its "=", so Enter stored the text "Price" rather than a formula reading the name. An
// entry with nothing typed yet now starts with "=Price", as a function picked there starts "=SUM(".
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

async function mount() {
  const doc = new Doc({ name: 'Names', path: 'Spreadsheets/Names.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 1, '5');
  wb.defineName('Price', 'Sheet1!$B$1');
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, viewport: view.el.querySelector('.grid-viewport'), editor: view.el.querySelector('.grid-editor') };
}
const press = (target, key, extra = {}) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const pick = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label).click();

it('starts a formula with a name pasted into an empty entry', async () => {
  const { wb, id, viewport, editor } = await mount();
  viewport.focus();
  press(viewport, 'F2');
  expect(editor.value).toBe('');
  press(editor, 'F3');
  pick('Price');
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe('=Price');
  press(editor, 'Enter');
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getCell(id, 0, 0)?.f).toBe('Price');
  expect(wb.getValue(id, 0, 0)).toBe(5);
});

it('puts the name in at the caret of an entry under way', async () => {
  const { viewport, editor } = await mount();
  viewport.focus();
  press(viewport, '=');
  editor.value = '=2*';
  editor.setSelectionRange(3, 3);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  press(editor, 'F3');
  pick('Price');
  await vi.advanceTimersByTimeAsync(1);
  expect(editor.value).toBe('=2*Price');
});
