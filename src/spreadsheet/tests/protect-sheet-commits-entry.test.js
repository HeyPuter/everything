// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';

// Protect Sheet did not finish an entry first. Pressed while typing into a cell, it protected the sheet under the
// entry, which then could not go in: Enter was refused, the cell stayed in edit, and the typing could only be given
// up. With a formula showing another sheet to pick references on, it protected that sheet instead. The entry now
// goes in first, and its own sheet is protected.
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

async function pointingAway() {
  const doc = new Doc({ name: 'Sheets', path: 'Spreadsheets/Sheets.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const other = wb.addSheet('Sheet2').id;
  wb.setActiveSheet(home);
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  view.goTo('Sheet1!B3');
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '=', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '=1+';
  editor.setSelectionRange(3, 3);
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', ctrlKey: true, bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.activeSheetId).toBe(other);
  return { wb, home, other };
}

it('enters a value typed into the cell before protecting its sheet', async () => {
  const doc = new Doc({ name: 'Protect' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '5';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  view.run('protectSheet');
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.getValue(home, 0, 0)).toBe(5);
  expect(wb.sheet(home).protected).toBeTruthy();
});

it('enters a formula picking references on another sheet, and protects its own sheet', async () => {
  const { wb, home, other } = await pointingAway();
  view.run('protectSheet');
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.getCell(home, 2, 1)?.f).toBe('1+');
  expect(wb.sheet(other).protected).toBeFalsy();
  expect(wb.sheet(home).protected).toBeTruthy();
});

it('enters the value first from the tab menu too', async () => {
  const doc = new Doc({ name: 'Protect' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = '5';
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  view.el.querySelector('.tab-menu-btn').click();
  await vi.advanceTimersByTimeAsync(1);
  [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent.includes('Protect Sheet')).click();
  await vi.advanceTimersByTimeAsync(1);
  expect(wb.getValue(home, 0, 0)).toBe(5);
  expect(wb.sheet(home).protected).toBeTruthy();
});
