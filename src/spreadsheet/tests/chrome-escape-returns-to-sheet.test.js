// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Escape on the chrome around the sheet went nowhere: with the keyboard on a menu bar title, a ribbon tab, a
// sheet tab or the status bar (after F6, or after Escape closed a menu or stepped back from a ribbon
// command), it stayed there, and only F6 round the regions or a click got back to the cells. Escape now
// hands the keyboard back to the sheet from there, as it leaves the ribbon in Excel; a menu's Escape still
// goes back to its title first, and a ribbon command's to its tab.
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
  const doc = new Doc({ name: 'Keys', path: 'Spreadsheets/Keys.xlsx' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return doc.wb;
}
const press = (key, target = document.activeElement) => target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
const grid = () => view.el.querySelector('.grid-viewport');

it('takes the keyboard back to the sheet from a menu bar title, a ribbon tab, a sheet tab and the status bar', async () => {
  await mount();
  for (const selector of ['.menubar-btn', '.ribbon-tab', '.sheet-tabs [role="tab"]', '.status-bar .zoom-slider']) {
    const node = view.el.querySelector(selector);
    node.focus();
    expect(document.activeElement, selector).toBe(node);
    press('Escape');
    expect(document.activeElement, selector).toBe(grid());
  }
});

it('steps back from a ribbon command to its tab, and from there to the sheet', async () => {
  await mount();
  const bold = view.el.querySelector('button[aria-label="Bold"]');
  bold.focus();
  press('Escape');
  expect(document.activeElement.classList.contains('ribbon-tab')).toBe(true);
  press('Escape');
  expect(document.activeElement).toBe(grid());
});

it('closes an open menu bar menu onto its title before leaving for the sheet', async () => {
  await mount();
  const file = view.el.querySelector('[data-menu="file"]');
  file.focus();
  press('ArrowDown');
  expect(document.querySelector('.menu')).not.toBeNull();
  press('Escape');
  expect(document.querySelector('.menu')).toBeNull();
  expect(document.activeElement).toBe(file);
  press('Escape');
  expect(document.activeElement).toBe(grid());
});

it('still gives up an entry when Escape is pressed with a title focused mid-edit', async () => {
  const wb = await mount();
  grid().focus();
  press('x', grid());
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.formula-bar').classList.contains('editing')).toBe(true);
  view.el.querySelector('.ribbon-tab').focus();
  press('Escape');
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.formula-bar').classList.contains('editing')).toBe(false);
  expect(wb.getCell(wb.activeSheetId, 0, 0)).toBeUndefined();
});
