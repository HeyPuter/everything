// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { printPreviewLayout } from '../src/ui/print-preview.js';
import { PRINT_DEFAULTS, printPaperBox } from '../src/ui/print.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// Fit to page width prints a block narrower than the page stretched across it: its columns widen to fill the line,
// its rows and text stay as they are. The preview drew such a block at its own width, three columns in a quarter of
// the page, over a print that came out the page's full width.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let lines;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  lines = [];
  const g = new Proxy({ lineTo: (x, y) => lines.push([x, y]) }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 30 }, (_, r) => [0, 1, 2].map((c) => ({ r, c, cell: { v: r ? r * 10 + c : `Head ${c}` } }))).flat());
  return { wb, id };
}

it('stretches a narrow block across the page when fitted to its width, and only then', () => {
  const { wb, id } = book();
  const box = printPaperBox(PRINT_DEFAULTS);
  const contentW = box.width - box.margins.left - box.margins.right;
  const blockW = [0, 1, 2].reduce((n, c) => n + wb.colWidth(id, c), 0);
  expect(printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, fit: 'width' }).stretch).toBeCloseTo(contentW / blockW, 6);
  expect(printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, fit: 'width', headers: true }).stretch).toBeCloseTo(contentW / (blockW + 36), 6);
  expect(printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, fit: 'actual' }).stretch).toBe(1);
  expect(printPreviewLayout(wb, id, { ...PRINT_DEFAULTS, fit: 'scale', scale: 50 }).stretch).toBe(1);
});

it('draws the stretched block out to the right margin', async () => {
  const { wb, id } = book();
  const modal = openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  const stage = modal.panel.querySelector('.print-preview-stage');
  Object.defineProperty(stage, 'clientWidth', { configurable: true, get: () => 300 });
  Object.defineProperty(stage, 'clientHeight', { configurable: true, get: () => 400 });
  modal.panel.querySelector('[aria-label="Scale"] [data-key="width"]').click();
  await vi.advanceTimersByTimeAsync(5);
  const box = printPaperBox(PRINT_DEFAULTS);
  const k = Math.min(292 / box.width, 392 / box.height);
  const right = Math.max(...lines.map(([x]) => x));
  expect(right).toBeCloseTo((box.width - box.margins.right) * k, 3);
});
