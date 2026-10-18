// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// F6 moves round the areas of the window (menus, ribbon, formula bar, grid, sheet tabs, status bar, assistant),
// but not the find bar, the task panes that open at the grid's edge (Show Changes, Thesaurus, Accessibility…),
// the Watch Window or the Comments pane: once a click on the sheet took the keyboard out of one, no key brought
// it back. They are areas of the cycle now, entered at their first control (the find bar at its search field).
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
  const doc = new Doc({ name: 'Areas', path: 'Spreadsheets/Areas.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
}
const press = (key, shiftKey = false) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
const grid = () => view.el.querySelector('.grid-viewport');

it('reaches the find bar from the grid with F6, at its search field', async () => {
  await mount();
  await view.run('find');
  grid().focus();
  press('F6');
  expect(document.activeElement).toBe(view.el.querySelector('.find-panel .find-input'));
  press('F6', true);
  expect(document.activeElement).toBe(grid());
});

it('reaches the Show Changes pane and the Watch Window, and goes on past them to the sheet tabs', async () => {
  await mount();
  await view.run('showChanges');
  await view.run('watchWindow');
  const changes = view.el.querySelector('.chg-pane');
  expect(changes.hidden).toBe(false);
  grid().focus();
  press('F6');
  expect(changes.contains(document.activeElement)).toBe(true);
  press('F6');
  expect(document.activeElement.closest('.sheet-tabs')).not.toBeNull();
  press('F6');
  expect(document.activeElement.closest('.status-bar')).not.toBeNull();
  press('F6');
  expect(view.el.querySelector('.watch-window').contains(document.activeElement)).toBe(true);
});
