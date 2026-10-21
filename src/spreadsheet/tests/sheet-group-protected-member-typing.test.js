// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import * as notifications from '../src/ui/toast.js';

// A protected sheet in a group refuses the group's Insert rows or formats for every sheet (see
// sheet-group-protected-member.test.js), but typing into a cell went ahead on the sheets where the cell was open and
// was refused on the protected one alone: Jan held the 7 and Feb did not, so the sheets were no longer in line. A cell
// locked on any grouped sheet now refuses the entry on all of them, with the protected sheet's notice; a cell left
// unlocked on every protected sheet still takes it on each.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
let view;
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
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

async function grouped() {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  const wb = doc.wb;
  const [a, b] = [wb.activeSheetId, wb.addSheet('Feb').id];
  wb.setActiveSheet(a);
  wb.applyStyle(b, { r1: 1, c1: 0, r2: 1, c2: 0 }, { locked: false }); // A2 is left open for input on Feb
  wb.setSheetProtected(b, true);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  wb.groupSheets([b]);
  return { wb, a, b };
}

async function type(ref, text) {
  view.goTo(ref);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: text[0], bubbles: true, cancelable: true }));
  const editor = view.el.querySelector('.grid-editor');
  editor.value = text;
  editor.dispatchEvent(new Event('input', { bubbles: true }));
  editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
}

it('refuses an entry in a cell locked on another grouped sheet, on every sheet', async () => {
  const { wb, a, b } = await grouped();
  const toast = vi.spyOn(notifications, 'toast');
  await type('Sheet1!A1', '7');
  expect(wb.getValue(a, 0, 0)).toBe(null);
  expect(wb.getValue(b, 0, 0)).toBe(null);
  expect(toast.mock.calls.map(([text]) => text)).toContain('Feb is protected. Unprotect it from the sheet tab menu to make changes');
  expect(wb.canUndo()).toBe(false);
});

it('takes an entry in a cell left unlocked on the protected sheet, on every sheet', async () => {
  const { wb, a, b } = await grouped();
  await type('Sheet1!A2', '7');
  expect(wb.getValue(a, 1, 0)).toBe(7);
  expect(wb.getValue(b, 1, 0)).toBe(7);
});

it('counts a range as locked when it is locked on any grouped sheet', async () => {
  const { wb, a, b } = await grouped();
  expect(wb.lockedIn(a, { r1: 0, c1: 0, r2: 1, c2: 1 })).toBe(true);
  expect(wb.lockedAt(a, 1, 0)).toBe(false);
  wb.ungroupSheets();
  expect(wb.lockedIn(a, { r1: 0, c1: 0, r2: 1, c2: 1 })).toBe(false);
  expect(wb.lockedIn(b, { r1: 0, c1: 0, r2: 1, c2: 1 })).toBe(true);
});
