// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';

let view;
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0)); vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {}; Element.prototype.scrollTo = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: text => ({ width: text.length * 7 }), font: '' });
  localStorage.clear(); document.body.replaceChildren();
});
afterEach(() => { closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });
const flush = () => vi.advanceTimersByTimeAsync(1);
async function mount() {
  const doc = new Doc({ name: 'Menus' }); const wb = doc.wb; const id = wb.activeSheetId;
  wb.addValidation(id, { range: { r1: 0, c1: 0, r2: 3, c2: 0 }, type: 'list', source: 'apple, banana' });
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.body.append(view.el); await flush(); return { wb, id };
}
const viewport = () => view.el.querySelector('.grid-viewport');
const press = (target, key, extra = {}) => { const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }); target.dispatchEvent(e); return e; };

it('hands the keyboard back to the sheet when Tab leaves the cell menu or a drop-down list', async () => {
  await mount();
  viewport().focus();
  press(viewport(), 'F10', { shiftKey: true }); await flush();
  expect(document.activeElement.closest('.menu')).toBeTruthy();
  const tab = press(document.activeElement, 'Tab'); await flush();
  expect(document.querySelector('.menu')).toBeNull();
  // The browser would carry the focus on past the sheet (to the sheet tabs): it stays on the cells.
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(viewport());
  press(viewport(), 'ArrowDown', { altKey: true }); await flush();
  expect(document.activeElement.closest('.menu')).toBeTruthy();
  const again = press(document.activeElement, 'Tab'); await flush();
  expect(again.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(viewport());
});

it('lets Tab carry on from a menu opened from a button, as before', async () => {
  await mount();
  const button = view.el.querySelector('.menubar-btn');
  button.focus(); button.click(); await flush();
  expect(document.activeElement.closest('.menu')).toBeTruthy();
  const tab = press(document.activeElement, 'Tab'); await flush();
  expect(tab.defaultPrevented).toBe(false);
});
