// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { printPreviewLayout } from '../src/ui/print-preview.js';
import { PRINT_DEFAULTS } from '../src/ui/print.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// The print repeats frozen rows, and the rows and columns to repeat, on every page: the preview's pages and count
// must take the room they use, or it promises fewer pages than come out of the printer.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
const drawn = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  const data = new Map();
  vi.stubGlobal('localStorage', { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) });
  drawn.length = 0;
  const g = new Proxy({ fillText: (t) => drawn.push(t) }, { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function book(rows = 200, cols = 30) {
  const wb = new Workbook(), id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) entries.push({ r, c, cell: { v: r === 0 ? `Head ${c + 1}` : r * 100 + c } });
  wb.setCells(id, entries);
  return { wb, id };
}
const actual = { ...PRINT_DEFAULTS, fit: 'actual', title: false };
const rowsOn = (page) => [...(page.repeatRows || []), ...Array.from({ length: page.rows[1] - page.rows[0] + 1 }, (_, i) => page.rows[0] + i)];

it('repeats the frozen rows at the top of every page after the first, and counts the pages they take', () => {
  const { wb, id } = book(230, 4);
  const plain = printPreviewLayout(wb, id, actual).pages;
  wb.setFrozen(id, 10, 0);
  const pages = printPreviewLayout(wb, id, actual).pages;
  expect(pages.length).toBeGreaterThan(plain.length);
  expect(pages[0].repeatRows).toBeUndefined();
  expect(pages[0].rows[0]).toBe(0);
  for (const page of pages.slice(1)) expect(page.repeatRows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // Every row prints once as itself, and the pages run on from each other.
  expect(pages.flatMap((page) => [page.rows[0], page.rows[1]]).slice(1, -1).every((r, i, list) => i % 2 || list[i + 1] === r + 1)).toBe(true);
  expect(pages.at(-1).rows[1]).toBe(229);
  // Not repeated, they take no room.
  expect(printPreviewLayout(wb, id, { ...actual, repeatFrozen: false }).pages).toHaveLength(plain.length);
});

it('repeats the rows and columns to repeat, from above and left of the printed block too', () => {
  const { wb, id } = book(200, 30);
  const plain = printPreviewLayout(wb, id, actual).pages;
  const titled = printPreviewLayout(wb, id, { ...actual, titleRows: [0, 19], titleCols: [0, 4] }).pages;
  expect(titled.length).toBeGreaterThan(plain.length);
  for (const page of titled) {
    if (page.rows[0] > 19) expect(page.repeatRows).toEqual(Array.from({ length: 20 }, (_, i) => i));
    if (page.cols[0] > 4) expect(page.repeatCols).toEqual([0, 1, 2, 3, 4]);
  }
  expect(titled.filter((page) => !page.repeatRows && !page.repeatCols)).toHaveLength(1);
  // A print area further down still has its title rows on every page, the first included.
  const area = printPreviewLayout(wb, id, { ...actual, area: 'selection', titleRows: [0, 0] }, { r1: 100, c1: 0, r2: 199, c2: 3 }).pages;
  for (const page of area) expect(rowsOn(page)[0]).toBe(0);
  expect(area[0].rows[0]).toBe(100);
});

it('follows rows to repeat as they are typed into the dialog', async () => {
  const { wb, id } = book(200, 30);
  const ctx = { wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} }, doc: { name: 'Stock' } };
  const modal = openPrintDialog(ctx);
  modal.panel.querySelector('[aria-label="Scale"] [data-key="actual"]').click();
  await vi.advanceTimersByTimeAsync(5);
  const count = () => Number(modal.panel.querySelector('.print-preview-count').textContent.match(/of (\d+)/)[1]);
  const before = count();
  const rows = modal.panel.querySelector('[aria-label="Rows to repeat at top"]');
  rows.value = '1:30'; rows.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(5);
  expect(count()).toBeGreaterThan(before);
  // On a later page the repeated heading is drawn above that page's own rows.
  modal.panel.querySelector('[aria-label="Next page"]').click();
  expect(drawn).toContain('Head 1');
  rows.value = ''; rows.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.advanceTimersByTimeAsync(5);
  expect(count()).toBe(before);
});
