// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as notifications from '../src/ui/toast.js';

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

const toastSpy = () => vi.spyOn(notifications, 'toast');

async function mount({ links = true, startup = 'ask' } = {}) {
  const doc = new Doc({ name: 'Budget', path: 'Spreadsheets/Budget.xlsx' });
  const wb = doc.wb;
  if (links) {
    wb.replaceWith({ ...wb.toJSON(), linkStartup: startup, externalWorkbooks: { version: 1, books: [{ target: 'Prices.xlsx', sheets: [{ name: 'Rates', cells: { '0,0': 5 } }], names: [] }] } });
    wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { f: '[1]Rates!A1*2' } }]);
  }
  wb.clearHistory();
  const spy = toastSpy();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  return { wb, spy };
}

it('opens Edit Links from the Data menu command', async () => {
  await mount();
  await view.run('editLinks');
  const panel = document.querySelector('.modal-panel[aria-label="Edit Links"]');
  expect(panel.querySelector('[role="option"]').textContent).toContain('Prices.xlsx');
});

it('offers to update the links of a saved book that asks on opening', async () => {
  const { spy } = await mount();
  expect(spy).toHaveBeenCalledWith('This workbook reads values from other workbooks', expect.objectContaining({ action: expect.objectContaining({ label: 'Update links' }) }));
});

it('says nothing on opening when the book is set to leave its links', async () => {
  const { spy } = await mount({ startup: 'none' });
  expect(spy).not.toHaveBeenCalledWith('This workbook reads values from other workbooks', expect.anything());
});

it('shows an empty list in a book without links', async () => {
  await mount({ links: false });
  await view.run('editLinks');
  expect(document.querySelector('.el-empty').hidden).toBe(false);
});
