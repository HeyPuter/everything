// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// Underlined and struck-through text prints with its line, but the print preview drew it as plain text: an underlined
// header or a struck-out item of a list previewed without the line that marks it.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let ops;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  ops = [];
  const state = { measureText: (t) => ({ width: String(t).length * 5 }) };
  const g = new Proxy(state, {
    get: (o, k) => (k in o ? o[k] : (...args) => ops.push({ op: k, args })),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

// The strokes drawn after a text, before the next text: its decoration.
function linesAfter(text) {
  const at = ops.findIndex((o) => o.op === 'fillText' && o.args[0] === text);
  const next = ops.findIndex((o, i) => i > at && o.op === 'fillText');
  const between = ops.slice(at + 1, next < 0 ? undefined : next);
  return between.filter((o) => o.op === 'lineTo').length && between.some((o) => o.op === 'stroke') ? between.filter((o) => o.op === 'moveTo').map((o) => o.args) : [];
}

it('draws a line under underlined text and through struck-through text, as wide as the text', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Header');
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { underline: true });
  wb.setInput(id, 1, 0, 'Done item');
  wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { strike: true });
  wb.setInput(id, 2, 0, 'Plain');
  wb.setInput(id, 2, 3, 'x');
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  const under = linesAfter('Header');
  expect(under).toHaveLength(1);
  const text = ops.find((o) => o.op === 'fillText' && o.args[0] === 'Header').args;
  expect(under[0][0]).toBeCloseTo(text[1], 5); // from where the text starts
  expect(under[0][1]).toBeLessThan(text[2]); // under a bottom-set line of text, above the cell's foot
  expect(linesAfter('Done item')).toHaveLength(1);
  expect(linesAfter('Done item')[0][1]).toBeLessThan(under[0][1] + (ops.find((o) => o.op === 'fillText' && o.args[0] === 'Done item').args[2] - text[2]));
  expect(linesAfter('Plain')).toHaveLength(0);
});
