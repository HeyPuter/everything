// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { Workbook } from '../src/core/workbook.js';
import * as notifications from '../src/ui/toast.js';

// "Freeze rows up to the selection" with whole columns selected asked for a
// sheet's worth of rows: the workbook clamped that to 50, the toast reported
// the unclamped count, and nothing visibly froze.
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

async function mount(book = null) {
  const doc = new Doc({ wb: book, name: 'Freeze', path: 'Spreadsheets/Freeze.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, id, toast: vi.spyOn(notifications, 'toast') };
}
async function select(text) {
  const name = view.el.querySelector('[aria-label="Cell reference"]');
  name.value = text;
  name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await vi.advanceTimersByTimeAsync(1);
}
const menuItem = (label) => [...document.querySelectorAll('.menu-item')].find((n) => n.querySelector('.menu-label')?.textContent === label);
async function freeze(label) {
  view.el.querySelector('[data-menu="view"]').click();
  menuItem('Freeze').click();
  menuItem(label).click();
  await vi.advanceTimersByTimeAsync(1);
}
const key = (k, init = {}) => {
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  viewport.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
};

it('freezes rows up to the active cell when whole columns are selected', async () => {
  const { wb, id, toast } = await mount();
  await select('C3');
  key(' ', { ctrlKey: true }); // select the column, the active cell staying at C3
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.status-left .status-item').textContent).toBe('C:C'); // the whole column
  await freeze('Rows up to the selection');
  expect(wb.sheet(id).frozenRows).toBe(3);
  expect(toast).toHaveBeenCalledWith('Frozen 3 rows', expect.anything());
});

it('freezes columns up to the active cell when whole rows are selected', async () => {
  const { wb, id, toast } = await mount();
  await select('C3');
  key(' ', { shiftKey: true }); // select the row
  await vi.advanceTimersByTimeAsync(1);
  expect(view.el.querySelector('.status-left .status-item').textContent).toBe('3:3');
  await freeze('Columns up to the selection');
  expect(wb.sheet(id).frozenCols).toBe(3);
  expect(toast).toHaveBeenCalledWith('Frozen 3 columns', expect.anything());
});

it('reports the rows actually frozen when the selection runs past the limit', async () => {
  const { wb, id, toast } = await mount();
  await select('A1:A60');
  await freeze('Rows up to the selection');
  expect(wb.sheet(id).frozenRows).toBe(50); // the workbook's limit
  // Fifty rows would fill the 400px window, so the grid draws no pane, and the toast says so.
  expect(toast).toHaveBeenCalledWith('50 rows would fill most of the window, so they are not frozen', expect.anything());
});


it.each([['First row', 'F10', 1, 2], ['Rows up to the selection', 'F10', 6, 2], ['Columns up to the selection', 'H7', 3, 5]])
  ('keeps an imported frozen origin when applying %s', async (command, selection, rows, cols) => {
    const book = new Workbook({ sheets: [{ name: 'Offset', frozenRows: 3, frozenCols: 2, frozenOrigin: { r: 4, c: 3 }, viewOrigin: { r: 19, c: 7 } }] });
    const { wb, id } = await mount(book);
    await select(selection);
    await freeze(command);
    expect([wb.sheet(id).frozenRows, wb.sheet(id).frozenCols]).toEqual([rows, cols]);
    expect(wb.sheet(id).frozenOrigin).toEqual({ r: 4, c: 3 });
    wb.undo();
    expect([wb.sheet(id).frozenRows, wb.sheet(id).frozenCols]).toEqual([3, 2]);
    expect(wb.sheet(id).frozenOrigin).toEqual({ r: 4, c: 3 });
  });
