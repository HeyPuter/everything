// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// Text turned in Format Cells (Orientation), a column heading set at 45° or up the cell, prints turned. The print
// preview drew it level across its cell. It now turns it by the same angle.
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
    get: (o, k) => (k in o ? o[k] : k === 'measureText' ? (t) => ({ width: String(t).length * 6 }) : (...args) => ops.push({ op: k, args })),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it('turns text set at an angle by that angle', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Level');
  wb.setInput(id, 0, 1, 'Slanted');
  wb.applyStyle(id, { r1: 0, c1: 1, r2: 0, c2: 1 }, { rot: 45 });
  wb.setInput(id, 0, 2, 'Upward');
  wb.applyStyle(id, { r1: 0, c1: 2, r2: 0, c2: 2 }, { rot: 90 });
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  // The turn made just before each text is drawn.
  const turnBefore = (text) => {
    const at = ops.findIndex((o) => o.op === 'fillText' && o.args[0] === text);
    expect(at).toBeGreaterThan(-1);
    for (let k = at - 1; k >= 0 && ops[k].op !== 'fillText'; k--) if (ops[k].op === 'rotate') return ops[k].args[0];
    return 0;
  };
  expect(turnBefore('Level')).toBe(0);
  expect(turnBefore('Slanted')).toBeCloseTo(-Math.PI / 4, 6);
  expect(turnBefore('Upward')).toBeCloseTo(-Math.PI / 2, 6);
});
