// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Ungroup Sheets, and a click on a sheet tab that changes the group (a tab outside it, or a Shift or Ctrl/Cmd click),
// did not finish an entry first: the group changed under a value being typed, which then went in on the active sheet
// alone (or on the sheets newly added too), though it was typed for the group. The entry now goes in first, on every
// sheet of the group it was typed for, and then the group changes.
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

async function typing() {
  const doc = new Doc({ name: 'Group', path: 'Spreadsheets/Group.xlsx' });
  const wb = doc.wb;
  const [a, b, c] = [wb.activeSheetId, wb.addSheet('Feb').id, wb.addSheet('Mar').id];
  wb.setActiveSheet(a);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  wb.groupSheets([b]);
  view.goTo('Sheet1!A1');
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '7', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '7';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  return { wb, a, b, c };
}
const tab = (name) => [...view.el.querySelectorAll('[role="tab"]')].find((t) => t.querySelector('.tab-name')?.textContent === name);
const clickOn = (node, init = {}) => node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, ...init }));

it('enters the value on every grouped sheet before ungrouping them', async () => {
  const { wb, a, b } = await typing();
  await view.run('ungroupSheets');
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.sheetGroup).toBe(null);
  expect(wb.getValue(a, 0, 0)).toBe(7);
  expect(wb.getValue(b, 0, 0)).toBe(7);
});

it('enters the value on every grouped sheet before going to a sheet outside the group', async () => {
  const { wb, a, b, c } = await typing();
  clickOn(tab('Mar'));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.activeSheetId).toBe(c);
  expect(wb.getValue(a, 0, 0)).toBe(7);
  expect(wb.getValue(b, 0, 0)).toBe(7);
  expect(wb.getValue(c, 0, 0)).toBe(null);
});

it('enters the value on the group it was typed for before a Ctrl+click adds a sheet', async () => {
  const { wb, a, b, c } = await typing();
  clickOn(tab('Mar'), { ctrlKey: true });
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.sheetGroup).toEqual([a, b, c]);
  expect(wb.getValue(b, 0, 0)).toBe(7);
  expect(wb.getValue(c, 0, 0)).toBe(null);
});
