// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import * as notifications from '../src/ui/toast.js';

// Delete cells answered every refusal with "That shift would split a table or remove its header", whatever
// stood in the way: a merged block or a protected range only half inside the band being shifted, a protected
// cell among those deleted (which had its own notice already, and got this one as well), or a table indeed.
// The notice now names the cause, as Insert cells' does, and a refusal that announced itself says nothing more.
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

const item = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);

async function mount(prep) {
  const doc = new Doc({ name: 'Shift', path: 'Spreadsheets/Shift.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) wb.setInput(id, r, c, `r${r}c${c}`);
  prep(wb, id);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const toast = vi.spyOn(notifications, 'toast');
  const shift = async (where, label) => {
    view.goTo(`Sheet1!${where}`);
    await vi.advanceTimersByTimeAsync(1);
    view.el.querySelector('[data-menu="edit"]').click();
    item('Delete').click();
    await vi.advanceTimersByTimeAsync(1);
    item(label).click();
    await vi.advanceTimersByTimeAsync(1);
  };
  return { wb, id, toast, shift };
}

const messages = (toast) => toast.mock.calls.map(([msg]) => msg);

it('names the merged block a shift up would cut through, not a table', { timeout: 20000 }, async () => {
  const { wb, id, toast, shift } = await mount((wb, id) => {
    wb.mergeCells(id, { r1: 2, c1: 0, r2: 2, c2: 1 });
  });
  await shift('A1', 'Cells, shifting up');
  expect(messages(toast)).toContain('The cells cannot be shifted: only part of the merged cell A3:B3 would move. Unmerge it first, or take it all in');
  expect(messages(toast).some((m) => /table/.test(m))).toBe(false);
  expect(wb.getValue(id, 0, 0)).toBe('r0c0');
});

it('names the table a shift left would leave ragged', { timeout: 20000 }, async () => {
  const { wb, id, toast, shift } = await mount((wb, id) => {
    wb.addTable(id, { r1: 0, c1: 0, r2: 3, c2: 1 }, { name: 'Sales' });
  });
  await shift('A1', 'Cells, shifting left');
  expect(messages(toast)).toContain('The cells cannot be shifted: table Sales would be left ragged. Select whole rows of it, or move the table first');
});

it('gives a protected cell among those deleted its own notice alone', { timeout: 20000 }, async () => {
  const { wb, id, toast, shift } = await mount((wb, id) => {
    wb.protectRange(id, { r1: 0, c1: 0, r2: 0, c2: 0 });
  });
  await shift('A1', 'Cells, shifting up');
  expect(messages(toast)).toEqual(['A1 is protected. Unprotect it under Protected ranges in the cell menu']);
  expect(wb.getValue(id, 0, 0)).toBe('r0c0');
});
