// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeMenu } from '../src/ui/menu.js';
import { closeAllModals } from '../src/ui/modal.js';
import { Workbook } from '../src/core/workbook.js';

// Copy a number in another app, select a block, Paste Special ▸ Multiply: Excel multiplies every selected
// cell by it. The arithmetic for another app's numbers wrote only the block's own size from the top-left,
// so one copied number changed the first selected cell and left the rest as they were.
function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage(), configurable: true });
const mod = navigator.platform.includes('Mac') ? { metaKey: true } : { ctrlKey: true };

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

async function mount(prep) {
  const doc = new Doc({ name: 'Special', path: 'Spreadsheets/Special.xlsx' });
  const { wb } = doc;
  const id = wb.activeSheetId;
  prep?.(wb, id);
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  await vi.advanceTimersByTimeAsync(1);
  const viewport = view.el.querySelector('.grid-viewport');
  viewport.focus();
  let copied = {};
  const ev = (type, data = {}) => {
    const e = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'clipboardData', { value: { getData: (t) => data[t] ?? '', setData: (t, v) => { copied[t] = v; }, files: [] } });
    return e;
  };
  const at = async (a) => { view.goTo(`Sheet1!${a}`); await vi.advanceTimersByTimeAsync(1); };
  const copy = async (a) => { copied = {}; await at(a); viewport.dispatchEvent(ev('copy')); await vi.advanceTimersByTimeAsync(1); return copied; };
  const clipboardOf = (data) => vi.stubGlobal('navigator', { onLine: true, clipboard: { read: async () => [{ types: Object.keys(data), getType: async (t) => ({ text: async () => data[t] }) }] } });
  /** Ctrl+Alt+V at `a`: the Paste Special dialog over the clipboard (what was copied, unless `data` says otherwise). */
  const openDialog = async (a, data = copied) => {
    clipboardOf(data);
    await at(a);
    viewport.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', altKey: true, bubbles: true, cancelable: true, ...mod }));
    await vi.advanceTimersByTimeAsync(5);
    return [...document.querySelectorAll('.modal-root:not(.closing) form.paste-special')].at(-1);
  };
  const choose = async (form, { what = 'all', operation = 'none', skipBlanks = false, transpose = false } = {}) => {
    form.querySelector(`input[type="radio"][value="${what}"]`).click();
    form.querySelector(`input[type="radio"][value="${operation}"]`).click();
    const [skip, flip] = form.querySelectorAll('.paste-special-checks input');
    if (skip.checked !== skipBlanks) skip.click();
    if (flip.checked !== transpose) flip.click();
    form.requestSubmit();
    await vi.advanceTimersByTimeAsync(5);
  };
  const special = async (from, to, options) => { await copy(from); await choose(await openDialog(to), options); };
  return { wb, id, viewport, at, copy, openDialog, choose, special, clipboardOf, copied: () => copied };
}


describe('Paste Special arithmetic with another app\'s numbers over a larger selection', () => {
  it('repeats the copied number over every selected cell', async () => {
    const { wb, id, openDialog, choose } = await mount((wb, id) => {
      ['10', '20', '30'].forEach((v, r) => wb.setInput(id, r, 2, v));
      wb.setInput(id, 3, 2, 'text');
    });
    await choose(await openDialog('C1:C4', { 'text/plain': '2' }), { what: 'values', operation: 'mul' });
    expect([0, 1, 2, 3].map((r) => wb.getValue(id, r, 2))).toEqual([20, 40, 60, 'text']);
    expect(wb.undoLabels(50).length).toBe(1);
  });

  it('tiles in the workbook as the other pastes do, and only over a multiple of the block', () => {
    const wb = new Workbook();
    const id = wb.activeSheetId;
    for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) wb.setInput(id, r, c, '1');
    expect(wb.pasteOperation(id, [[1, 2]], 0, 0, 'add', { r1: 0, c1: 0, r2: 3, c2: 1 })).toBe(8);
    expect([0, 1, 2, 3].map((r) => [wb.getValue(id, r, 0), wb.getValue(id, r, 1)])).toEqual([[2, 3], [2, 3], [2, 3], [2, 3]]);
    expect(wb.pasteOperation(id, [[1, 2]], 0, 0, 'add', { r1: 0, c1: 0, r2: 2, c2: 2 })).toBe(2);
    expect([wb.getValue(id, 0, 0), wb.getValue(id, 0, 1), wb.getValue(id, 1, 0)]).toEqual([3, 5, 2]);
  });
});
