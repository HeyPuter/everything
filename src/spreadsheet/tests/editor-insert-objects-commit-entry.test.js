// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as notifications from '../src/ui/toast.js';

// Insert ▸ Text Box and an Insert ▸ Equation from the gallery read the sheet in view before finishing the entry: with a
// formula showing another sheet to pick references on, the entry went in on its own sheet but the text box or
// equation landed on the other one. Note, Link, Shapes, Icons, WordArt, Equation and Symbol asked whether the sheet in
// view was protected before finishing the entry, so a protected sheet shown to pick a reference refused them, with
// the formula left open. The entry now goes in first (Symbol, which goes into the entry, keeps it open), and the
// formula's own sheet is the one asked about and given the object.
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
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

async function pointingAway(setup) {
  const doc = new Doc({ name: 'Sheets', path: 'Spreadsheets/Sheets.xlsx' });
  const wb = doc.wb;
  const home = wb.activeSheetId;
  const other = wb.addSheet('Sheet2').id;
  setup?.(wb, home, other);
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

const entered = (wb, home) => {
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(false);
  expect(wb.getCell(home, 2, 1)?.f).toBe('1+');
  expect(wb.activeSheetId).toBe(home);
};
const protectOther = (wb, home, other) => wb.setSheetProtected(other, true);

it.each([['insertTextBox', undefined], ['insertEquation', 'circle']])('%s puts its object on the formula\'s sheet', async (cmd, arg) => {
  const { wb, home, other } = await pointingAway();
  await view.run(cmd, arg);
  await vi.advanceTimersByTimeAsync(1);
  entered(wb, home);
  if (cmd === 'insertTextBox') {
    document.querySelector('textarea.textbox-text').value = 'Note';
    document.querySelector('textarea.textbox-text').closest('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await vi.advanceTimersByTimeAsync(1);
  }
  expect(wb.sheet(other).charts).toHaveLength(0);
  expect(wb.sheet(home).charts).toHaveLength(1);
});

it.each(['note', 'link', 'shapesMenu', 'iconsDialog', 'wordArtMenu', 'insertEquation'])('%s is not refused for the protected sheet shown to pick a reference', async (cmd) => {
  const { wb, home } = await pointingAway(protectOther);
  const toast = vi.spyOn(notifications, 'toast');
  await view.run(cmd);
  await vi.advanceTimersByTimeAsync(1);
  expect(toast.mock.calls.map(([text]) => text).filter((t) => /protected/.test(t))).toEqual([]);
  entered(wb, home);
});

it('Symbol keeps the entry open and is not refused for the protected sheet shown', async () => {
  await pointingAway(protectOther);
  const toast = vi.spyOn(notifications, 'toast');
  await view.run('symbolDialog');
  await vi.advanceTimersByTimeAsync(1);
  expect(toast.mock.calls.map(([text]) => text).filter((t) => /protected/.test(t))).toEqual([]);
  expect(view.el.querySelector('.grid').classList.contains('editing')).toBe(true);
});
