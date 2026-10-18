// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { printPreviewLayout, printPreviewJob } from '../src/ui/print-preview.js';
import { PRINT_DEFAULTS } from '../src/ui/print.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// Print ▸ All sheets prints every visible sheet, and a print area of several blocks prints each, but the preview
// counted and drew the active sheet's first block alone: "Page 1 of 3" for a job of five pages.
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

function fill(wb, id, rows, label) {
  const entries = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < 4; c++) entries.push({ r, c, cell: { v: c ? r * 10 + c : `${label} ${r + 1}` } });
  wb.setCells(id, entries);
}
function book() {
  const wb = new Workbook(), first = wb.activeSheetId;
  fill(wb, first, 120, 'First');
  const second = wb.addSheet('Second').id;
  fill(wb, second, 90, 'Second');
  const hidden = wb.addSheet('Hidden').id;
  fill(wb, hidden, 90, 'Hidden');
  wb.setSheetHidden(hidden, true);
  wb.setActiveSheet(first);
  return { wb, first, second };
}
const prefs = { ...PRINT_DEFAULTS, fit: 'actual', title: false };
const count = (wb, id, p) => printPreviewLayout(wb, id, p).pages.length;

it('takes in every visible sheet for All sheets, each with its own page setup', () => {
  const { wb, first, second } = book();
  wb.setPrintSettings(second, { orientation: 'landscape' });
  const job = printPreviewJob(wb, first, { ...prefs, area: 'workbook' });
  const own = count(wb, first, prefs), theirs = count(wb, second, { ...prefs, orientation: 'landscape' });
  expect(theirs).toBeGreaterThan(count(wb, second, prefs));
  expect(job).toHaveLength(own + theirs);
  expect(job.map((p) => p.sheetId)).toEqual([...Array(own).fill(first), ...Array(theirs).fill(second)]);
  // This sheet alone, as before.
  expect(printPreviewJob(wb, first, prefs)).toHaveLength(own);
});

it('takes in each block of a print area of several', () => {
  const { wb, first } = book();
  wb.setPrintSettings(first, { areas: [{ r1: 0, c1: 0, r2: 9, c2: 3 }, { r1: 60, c1: 0, r2: 119, c2: 3 }] });
  const job = printPreviewJob(wb, first, { ...prefs, area: 'printArea' });
  expect(job.map((p) => p.page.rows[0])).toEqual([0, 60, ...job.slice(2).map((p) => p.page.rows[0])]);
  expect(job.length).toBeGreaterThanOrEqual(3);
  expect(job.at(-1).page.rows[1]).toBe(119);
});

it('counts, numbers and draws the pages of every sheet in the dialog', async () => {
  const { wb, first } = book();
  wb.setPrintSettings(first, { firstPageNumber: 7, useFirstPageNumber: true, footer: 'Page &P of &N' });
  const ctx = { wb, sheetId: () => first, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} }, doc: { name: 'Stock' } };
  const modal = openPrintDialog(ctx);
  modal.panel.querySelector('[aria-label="Scale"] [data-key="actual"]').click();
  await vi.advanceTimersByTimeAsync(5);
  const shown = () => modal.panel.querySelector('.print-preview-count').textContent;
  const one = Number(shown().match(/of (\d+)/)[1]);
  modal.panel.querySelector('[aria-label="Print"] [data-key="workbook"]').click();
  await vi.advanceTimersByTimeAsync(5);
  const all = Number(shown().match(/of (\d+)/)[1]);
  expect(all).toBeGreaterThan(one);
  // The last page is the second sheet's, numbered on from the first sheet's starting number.
  const next = modal.panel.querySelector('[aria-label="Next page"]');
  for (let i = 2; i < all; i++) next.click();
  drawn.length = 0;
  next.click();
  expect(shown()).toBe(`Page ${all} of ${all}`);
  expect(drawn.some((t) => /^Second \d+$/.test(t))).toBe(true);
  expect(drawn.some((t) => t.startsWith('Hidden'))).toBe(false);
  expect(drawn).toContain(`Page ${6 + all} of ${all}`);
});
