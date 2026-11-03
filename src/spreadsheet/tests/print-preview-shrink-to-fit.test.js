// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// A cell set to Shrink to fit prints its text smaller, so all of it fits the cell. The print preview drew it at its
// own size, cut off at the cell's edge. It now sets it smaller until it fits, and leaves text that fits as it is.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let ops;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  ops = [];
  const state = {};
  const g = new Proxy(state, {
    // A character is as wide as half the font's size.
    get: (o, k) => (k in o ? o[k] : k === 'measureText' ? (t) => ({ width: String(t).length * Number(/([\d.]+)px/.exec(state.font)?.[1] || 10) / 2 })
      : (...args) => ops.push({ op: k, args, font: state.font })),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it('sets text that is too wide for its cell smaller when the cell shrinks to fit', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const long = 'A rather long label that will not fit';
  wb.setInput(id, 0, 0, long);
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { shrink: true });
  wb.setInput(id, 1, 0, 'Short');
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { shrink: true });
  wb.setInput(id, 2, 0, long);
  wb.setColWidth(id, 0, 60);
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  const sizeOf = (text, nth = 0) => Number(/([\d.]+)px/.exec(ops.filter((o) => o.op === 'fillText' && o.args[0] === text)[nth].font)[1]);
  const plain = sizeOf(long, 1);
  expect(sizeOf(long, 0)).toBeLessThan(plain * 0.8);
  expect(sizeOf('Short')).toBeCloseTo(plain, 6);
});
