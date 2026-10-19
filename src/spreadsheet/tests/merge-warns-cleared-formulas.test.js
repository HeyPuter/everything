// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { editorView } from '../src/views/editor.js';
import { Doc } from '../src/lib/doc.js';
import { closeAllModals } from '../src/ui/modal.js';
import { closeMenu } from '../src/ui/menu.js';

const toasts = vi.hoisted(() => []);
vi.mock('../src/ui/toast.js', () => ({ toast: (message) => { toasts.push(message); } }));

// Merging keeps only the top-left cell, and the toast that says how many cells were cleared counted the cells
// holding a value: a formula, whose result is worked out rather than stored, was discarded without a word.
let view;
beforeEach(() => {
  toasts.length = 0;
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (q) => ({ matches: !/max-width|pointer/.test(q), addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Element.prototype.scrollIntoView = () => {};
  Element.prototype.scrollTo = () => {};
  Element.prototype.setPointerCapture = () => {};
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeMenu(); closeAllModals(); view?.destroy(); view = null; vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function setup() {
  const doc = new Doc({ name: 'Merge', path: 'Spreadsheets/Merge.xlsx' });
  const wb = doc.wb;
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '4');
  wb.setInput(id, 0, 1, '=A1*2');
  wb.setInput(id, 1, 0, '5');
  wb.setInput(id, 1, 1, '=A2*2');
  wb.clearHistory();
  view = editorView({ doc, goHome: vi.fn(), openPath: vi.fn(), newDoc: vi.fn(), templateDoc: vi.fn(), importFile: vi.fn() });
  document.querySelector('#app').append(view.el);
  vi.runOnlyPendingTimers();
  return { wb, id };
}

describe('merging over formulas', () => {
  it('says the formulas it cleared', () => {
    const { wb, id } = setup();
    view.goTo('Sheet1!A1:B1'); vi.runOnlyPendingTimers();
    view.run('merge');
    expect(wb.getCell(id, 0, 1)?.f ?? null).toBeNull();
    expect(toasts.at(-1)).toBe('Merged. Only the top-left value was kept (1 cleared)');
  });

  it('says so for Merge Across too', () => {
    const { wb, id } = setup();
    view.goTo('Sheet1!A1:B2'); vi.runOnlyPendingTimers();
    view.run('mergeAcross');
    expect(wb.sheet(id).merges).toHaveLength(2);
    expect(toasts.at(-1)).toBe('Merged. Only the first value of each row was kept (2 cleared)');
  });
});
