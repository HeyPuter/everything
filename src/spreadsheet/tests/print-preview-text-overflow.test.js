// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// Text longer than its cell prints on over the empty cells beside it, as the grid shows it. The print preview cut every
// text at the edge of its own cell, so a heading typed in A1 over empty columns previewed as its first few letters.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let ops;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  ops = [];
  const g = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : (...args) => ops.push({ op: k, args })),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

async function preview(wb, id) {
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
}
const clipOf = (text) => {
  const at = ops.findIndex((o) => o.op === 'fillText' && o.args[0] === text);
  return ops.slice(0, at).reverse().find((o) => o.op === 'rect')?.args;
};

it('lets text run on over the empty cells beside it, and stop at the next filled one', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'A heading longer than its column');
  wb.setInput(id, 1, 0, 'Stops at C');
  wb.setInput(id, 1, 2, 'here');
  wb.setInput(id, 2, 3, 'Right side');
  wb.applyStyle(id, { r1: 2, c1: 3, r2: 2, c2: 3 }, { align: 'right' });
  wb.setInput(id, 3, 0, '123456789012345678');
  wb.setInput(id, 4, 0, 'Wrapped stays in its cell');
  wb.applyStyle(id, { r1: 4, c1: 0, r2: 4, c2: 0 }, { wrap: true });
  wb.setInput(id, 5, 4, 'x');
  await preview(wb, id);
  const end = ([x, , w]) => x + w;
  const page = ops.find((o) => o.op === 'rect').args; // the page's printable area, clipped first
  const [cx] = clipOf('here');
  const ownA = clipOf('123456789012345678');
  // A1 runs on to the last column printed; A2 stops where C2's text begins.
  expect(clipOf('A heading longer than its column')[0]).toBeCloseTo(page[0], 5);
  expect(end(clipOf('A heading longer than its column'))).toBeCloseTo(end(page), 5);
  expect(end(clipOf('Stops at C'))).toBeCloseTo(cx, 5);
  // Right-aligned text in D runs on to the left, as far as A.
  expect(clipOf('Right side')[0]).toBeCloseTo(page[0], 5);
  // A number and wrapped text keep to their own cells.
  expect(ownA[2]).toBeLessThan(cx - page[0]);
  expect(clipOf('Wrapped stays in its cell')[2]).toBeCloseTo(ownA[2], 5);
});
