// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// The print centres TRUE, FALSE and error values and sets text written right to left at the right of its cell, as the
// grid shows them, when the cell has no alignment of its own. The preview had a rule of its own (numbers right,
// everything else left), so it drew those at the left: a column of TRUE/FALSE or #N/A, or a Hebrew or Arabic list,
// previewed otherwise than it prints. The preview now takes the print's alignment.
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
    get: (o, k) => (k in o ? o[k] : (...args) => ops.push({ op: k, args, align: state.textAlign })),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it('aligns logical values, errors and right-to-left text as the print does', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'TRUE');
  wb.setInput(id, 1, 0, '=NA()');
  wb.setInput(id, 2, 0, 'שלום עולם');
  wb.setInput(id, 3, 0, 'Plain');
  wb.setInput(id, 4, 0, '42');
  wb.setInput(id, 5, 0, 'FALSE');
  wb.applyStyle(id, { r1: 5, c1: 0, r2: 5, c2: 0 }, { align: 'left' });
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  const alignOf = (text) => ops.find((o) => o.op === 'fillText' && o.args[0] === text)?.align;
  expect(alignOf('TRUE')).toBe('center');
  expect(alignOf('#N/A')).toBe('center');
  expect(alignOf('שלום עולם')).toBe('right');
  expect(alignOf('Plain')).toBe('left');
  expect(alignOf('42')).toBe('right');
  // An alignment of the cell's own still wins.
  expect(alignOf('FALSE')).toBe('left');
});
