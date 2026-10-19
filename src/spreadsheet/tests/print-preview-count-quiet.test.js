// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// The preview's "Page 1 of 3" is a live region, so a screen reader says it when it changes. It was written afresh on
// every key typed into the dialog (a header, a scale, rows to repeat), each time read out again over the typing,
// though nothing about the pages had changed.
// (A sheet of 150 rows: a page count that a change of orientation changes.)
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it('leaves the page count alone while typing changes nothing about the pages, and says a change', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 150 }, (_, r) => ({ r, c: 0, cell: { v: r } })));
  const modal = openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  modal.panel.querySelector('[aria-label="Scale"] [data-key="actual"]').click();
  await vi.advanceTimersByTimeAsync(5);
  const count = modal.panel.querySelector('.print-preview-count');
  expect(count.getAttribute('aria-live')).toBe('polite');
  const before = count.textContent;
  expect(before).toMatch(/^Page 1 of \d+$/);
  const changes = [];
  new MutationObserver((records) => changes.push(...records)).observe(count, { childList: true, characterData: true, subtree: true });
  const header = modal.panel.querySelector('[aria-label="Header text"]');
  for (const text of ['Q', 'Q3', 'Q3 r', 'Q3 report']) { header.value = text; header.dispatchEvent(new Event('input', { bubbles: true })); await vi.advanceTimersByTimeAsync(5); }
  await Promise.resolve();
  expect(changes).toHaveLength(0);
  modal.panel.querySelector('[aria-label="Orientation"] [data-key="landscape"]').click();
  await vi.advanceTimersByTimeAsync(5);
  await Promise.resolve();
  expect(count.textContent).not.toBe(before);
  expect(changes.length).toBeGreaterThan(0);
});
