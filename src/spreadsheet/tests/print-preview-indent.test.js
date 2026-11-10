// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// A cell indented from the Home tab prints its text that many indent steps in from its edge (from the right for
// right-aligned text). The preview drew it against the cell's edge, as if it had no indent. It now indents it.
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

it('indents text from its edge as the print does', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Plain');
  wb.setInput(id, 1, 0, 'Indented');
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { indent: 2 });
  wb.setInput(id, 2, 0, 'Right');
  wb.applyStyle(id, { r1: 2, c1: 0, r2: 2, c2: 0 }, { align: 'right' });
  wb.setInput(id, 3, 0, 'Right indented');
  wb.applyStyle(id, { r1: 3, c1: 0, r2: 3, c2: 0 }, { align: 'right', indent: 2 });
  wb.setInput(id, 4, 0, 'Centred');
  wb.applyStyle(id, { r1: 4, c1: 0, r2: 4, c2: 0 }, { align: 'center', indent: 2 });
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  const xOf = (text) => ops.find((o) => o.op === 'fillText' && o.args[0] === text)?.args[1];
  const unit = xOf('Indented') - xOf('Plain');
  expect(unit).toBeGreaterThan(5);
  expect(xOf('Right') - xOf('Right indented')).toBeCloseTo(unit, 5);
  expect(xOf('Centred')).toBeGreaterThan(xOf('Plain'));
});
