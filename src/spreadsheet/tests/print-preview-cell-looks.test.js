// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { fillColorCss } from '../src/core/fill-color.js';
import * as S from '../src/core/selection.js';

// The preview drew each cell from its own style and its text alone, where the print paints a table's colours (its
// header, its banded rows), the fills and colours of conditional formatting, and a tick box for a checkbox cell:
// the To-do list template, all of whose colours print, previewed as plain black text on white, "TRUE" and "FALSE"
// down its Done column where the paper shows boxes.
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
    get: (o, k) => (k in o ? o[k] : (...args) => ops.push({ op: k, args, fill: state.fillStyle, stroke: state.strokeStyle })),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

async function preview(wb, id) {
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  return { texts: ops.filter((o) => o.op === 'fillText').map((o) => o.args[0]), fills: ops.filter((o) => o.op === 'fillRect').map((o) => o.fill) };
}

it('paints a table\'s header and banded rows, and a rule\'s fill and font colour', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [['Task', 'Priority'], ['Brief', 'High'], ['Venue', 'Low'], ['Badges', 'Low']].flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  expect(wb.addTable(id, parseRange('A1:B4'))).toBeTruthy();
  wb.addRule(id, { range: parseRange('B2:B4'), type: 'eq', value: 'High', style: { bg: '#ffeeaa', color: '#c00000' } });
  const header = fillColorCss(wb.conditionalStyle(id, 0, 0, 'Task').bg);
  const band = fillColorCss(wb.conditionalStyle(id, 1, 0, 'Brief').bg);
  expect(header).toBeTruthy();
  const { fills } = await preview(wb, id);
  expect(fills).toContain(header);
  expect(fills).toContain(band);
  expect(fills).toContain(fillColorCss('#ffeeaa'));
  const high = ops.find((o) => o.op === 'fillText' && o.args[0] === 'High');
  expect(high.fill).toBe('#c00000');
});

it('draws a checkbox cell as a tick box, not as TRUE or FALSE', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: true } }, { r: 1, c: 0, cell: { v: false } }, { r: 0, c: 1, cell: { v: 'Set up' } }, { r: 1, c: 1, cell: { v: 'Brief' } }]);
  wb.addValidation(id, { type: 'checkbox', range: parseRange('A1:A2') });
  const { texts } = await preview(wb, id);
  expect(texts).toContain('Set up');
  expect(texts).not.toContain('TRUE');
  expect(texts).not.toContain('FALSE');
  // Two boxes, one of them filled and ticked.
  expect(ops.filter((o) => o.op === 'roundRect' || o.op === 'rect').length).toBeGreaterThanOrEqual(2);
  expect(ops.filter((o) => o.op === 'fill' && o.fill === '#356d49')).toHaveLength(1);
});
