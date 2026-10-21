// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { fontColorCss } from '../src/core/font-color.js';
import * as S from '../src/core/selection.js';

// A number format can colour what it shows ("#,##0;[Red]-#,##0" prints its negatives red), and the print and the grid
// ink the number so. The print preview took a cell's colour from its font alone, so those negatives previewed black.
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
    get: (o, k) => (k in o ? o[k] : (...args) => ops.push({ op: k, args, fill: state.fillStyle })),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it('inks a number in the colour its format gives it', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '-1500');
  wb.setInput(id, 1, 0, '1500');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { fmt: 'custom', code: '#,##0;[Red]-#,##0' });
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  const inkOf = (text) => ops.find((o) => o.op === 'fillText' && o.args[0] === text)?.fill;
  expect(inkOf('-1,500')).toBe(fontColorCss('#ff0000') || '#ff0000');
  expect(inkOf('1,500')).toBe('#000000');
});
