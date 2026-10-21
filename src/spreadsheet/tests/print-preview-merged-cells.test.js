// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// Merged cells print as one block, the top-left cell's text across it and no gridlines inside it. The print preview knew
// nothing of merges: it drew each cell of the block on its own, the title cut off at the edge of its first column and
// the gridlines running through it, so a sheet with a merged heading previewed otherwise than it printed.
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

async function preview(wb, id) {
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
}
// The clip a text is drawn in: the last rect before it.
const clipOf = (text) => {
  const at = ops.findIndex((o) => o.op === 'fillText' && o.args[0] === text);
  return at < 0 ? null : ops.slice(0, at).reverse().find((o) => o.op === 'rect')?.args;
};

it('sets a merged block\'s text across the whole block, with no gridlines through it', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Quarterly results for the whole team');
  expect(wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 2 })).toBeTruthy();
  wb.setInput(id, 1, 0, 'a'); wb.setInput(id, 1, 1, 'b'); wb.setInput(id, 1, 2, 'c'); wb.setInput(id, 1, 3, 'd');
  await preview(wb, id);
  const [, , merged] = clipOf('Quarterly results for the whole team');
  const [, , one] = clipOf('a');
  expect(merged).toBeCloseTo(one * 3, 5);
  // The block is painted over its inner gridlines, short of its own edges.
  const cover = ops.find((o) => o.op === 'fillRect' && o.fill === '#ffffff' && Math.abs(o.args[2] - merged) < one / 2 && o.args[2] < merged);
  expect(cover).toBeTruthy();
});

it('draws no text for the cells a block covers', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Head' } }, { r: 0, c: 1, cell: { v: 'Under the merge' } }, { r: 1, c: 0, cell: { v: 'x' } }]);
  wb.sheet(id).merges = [{ r1: 0, c1: 0, r2: 0, c2: 1 }];
  await preview(wb, id);
  const texts = ops.filter((o) => o.op === 'fillText').map((o) => o.args[0]);
  expect(texts).toContain('Head');
  expect(texts).not.toContain('Under the merge');
});
