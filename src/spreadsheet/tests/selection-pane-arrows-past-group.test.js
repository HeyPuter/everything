// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { memoryStorage } from './helpers/memory-storage.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

let view;
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
  vi.stubGlobal('matchMedia', (q) => ({ matches: !/max-width/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  if (!globalThis.CSS?.escape) vi.stubGlobal('CSS', { escape: (s) => String(s).replace(/["\\]/g, '\\$&') });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ font: '', measureText: (t) => ({ width: t.length * 7 }) });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  view?.destroy(); view = null;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// The Selection Pane's Down arrow stopped at a group: it moved onto the group's first member, which picks
// the whole group, so the next press started from the group's row again and the objects behind the group
// could not be reached from the keyboard. Shift+Down took a group already selected out of the selection.
// The arrows now step from one group or object to the next, and Shift adds the next one.
it('steps over a group’s members with the arrow keys, and Shift adds the next object', async () => {
  const doc = new Doc({ name: 'Objects', path: 'Spreadsheets/Objects.xlsx' }), wb = doc.wb, id = wb.activeSheetId;
  const mk = (r, text) => wb.addChart(id, { type: 'text', text, anchor: { r, c: 1 }, w: 120, h: 50 });
  const back = mk(1, 'Back'); const b = mk(5, 'B'); const c = mk(9, 'C'); const front = mk(13, 'Front');
  wb.groupObjects(id, [b, c]);
  view = editorView({ doc, goHome() {}, openPath() {}, newDoc() {}, importFile() {} });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.run('selectionPane');
  await vi.advanceTimersByTimeAsync(1);
  const list = document.querySelector('.selpane-list');
  const press = async (key, shiftKey = false) => { list.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })); await vi.advanceTimersByTimeAsync(1); };
  const picked = () => [...document.querySelectorAll('.selpane-row:not(.member)')].filter((r) => r.getAttribute('aria-selected') === 'true').map((r) => r.textContent);
  expect([...document.querySelectorAll('.selpane-row')].map((r) => r.textContent)).toEqual(['Text Box 4', 'Group 1', 'Text Box 3', 'Text Box 2', 'Text Box 1']);
  await press('ArrowDown');
  expect(picked()).toEqual(['Text Box 4']);
  await press('ArrowDown');
  expect(picked()).toEqual(['Group 1']);
  await press('ArrowDown');
  expect(picked()).toEqual(['Text Box 1']);
  await press('ArrowUp');
  expect(picked()).toEqual(['Group 1']);
  await press('ArrowUp');
  expect(picked()).toEqual(['Text Box 4']);
  await press('ArrowDown', true);
  await press('ArrowDown', true);
  expect(picked()).toEqual(['Text Box 4', 'Group 1', 'Text Box 1']);
  expect(back && front).toBeTruthy();
});
