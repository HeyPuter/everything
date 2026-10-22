// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 800; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 400; } });
  HTMLCanvasElement.prototype.getContext = () => ({ measureText: (t) => ({ width: t.length * 7 }), font: '' });
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {} });
  globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
});
afterEach(() => { document.body.replaceChildren(); });

const flush = () => new Promise((r) => setTimeout(r, 5));

// Each sheet keeps its own zoom, and the grid remembers where each sheet was scrolled to, in pixels at that
// zoom. Coming back to a sheet, the editor zoomed it after the grid had put that place back at the zoom of
// the sheet just left: a sheet left at row 481 at 100%, after a visit to a sheet at 50%, came back far
// below. The sheet's own zoom is now laid out before its place is restored.
it('comes back to a sheet where it was left, after a visit to a sheet at another zoom', async () => {
  const wb = new Workbook();
  const a = wb.sheets[0].id;
  wb.addSheet('B');
  const b = wb.sheets[1].id;
  const zooms = [];
  const grid = createGrid({ wb, sheetId: a, onZoom: (z) => zooms.push(z) });
  document.body.replaceChildren(grid.el);
  const vp = grid.viewport;
  let sl = 0, st = 0;
  Object.defineProperty(vp, 'scrollLeft', { configurable: true, get: () => sl, set: (v) => { sl = v; } });
  Object.defineProperty(vp, 'scrollTop', { configurable: true, get: () => st, set: (v) => { st = v; } });
  vp.scrollTo = (o) => { sl = o.left; st = o.top; vp.dispatchEvent(new Event('scroll')); };
  await flush();
  wb.setSheetView(a, { viewZoom: 1 });
  grid.selectByName('A500');
  await flush();
  const topRow = () => grid.cellAtPoint(5, 5).r;
  const left = topRow();
  expect(left).toBeGreaterThan(400);

  grid.setSheet(b);
  grid.setZoom(0.5);
  await flush();
  expect(grid.zoom).toBe(0.5);

  // As the editor switches sheets: the grid first, then the sheet's own zoom.
  grid.setSheet(a);
  grid.setZoom(wb.sheet(a).viewZoom, true);
  await flush();
  expect(grid.zoom).toBe(1);
  expect(topRow()).toBe(left);
  expect(zooms.at(-1)).toBe(1);
  grid.destroy();
});
