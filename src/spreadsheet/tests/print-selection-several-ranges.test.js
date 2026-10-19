// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPrintRoot, printSheet } from '../src/ui/print.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// A selection of several ranges (Ctrl+click) printed only the range selected last: Print said "Selection (D1:E3)"
// and the other blocks were left off the paper without a word. As in Excel, each range of the selection now prints
// on pages of its own, in the order they were selected, and the preview counts them all.
vi.mock('../src/ui/print.js', async (original) => ({ ...await original(), printSheet: vi.fn(() => true) }));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(new Proxy({}, { get: () => () => {}, set: () => true }));
  document.body.innerHTML = '<div id="app"></div>';
  printSheet.mockClear();
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, Array.from({ length: 10 }, (_, r) => [0, 1, 2, 3, 4].map((c) => ({ r, c, cell: { v: `${'ABCDE'[c]}${r + 1}` } }))).flat());
  return { wb, id };
}
const first = { r1: 0, c1: 0, r2: 2, c2: 1 }, second = { r1: 5, c1: 3, r2: 7, c2: 4 };

it('prints each range of the selection on pages of its own, in the order they were selected', () => {
  const { wb, id } = book();
  const root = buildPrintRoot(wb, id, 'Doc', { area: 'selection', range: second, ranges: [first, second] });
  const sections = [...root.querySelectorAll('.print-section')];
  expect(sections).toHaveLength(2);
  expect(sections[1].classList.contains('page-break')).toBe(true);
  const texts = sections.map((s) => [...s.querySelectorAll('.print-table td')].map((td) => td.textContent).filter(Boolean));
  expect(texts[0]).toEqual(['A1', 'B1', 'A2', 'B2', 'A3', 'B3']);
  expect(texts[1]).toEqual(['D6', 'E6', 'D7', 'E7', 'D8', 'E8']);
});

it('offers the whole selection in the dialog, previews its pages and prints them all', async () => {
  const { wb, id } = book();
  const modal = openPrintDialog({ wb, sheetId: () => id, selection: () => S.fromRange(second, { r: 5, c: 3 }), range: () => second, ranges: () => [first, second], grid: { focus() {} } });
  const choice = modal.panel.querySelector('[aria-label="Print"] [data-key="selection"]');
  expect(choice.textContent).toBe('Selection (A1:B3, D6:E8)');
  choice.click();
  await vi.advanceTimersByTimeAsync(5);
  expect(modal.panel.querySelector('.print-preview-count').textContent).toBe('Page 1 of 2');
  modal.panel.querySelector('form').requestSubmit();
  await vi.advanceTimersByTimeAsync(5);
  expect(printSheet).toHaveBeenCalledWith(wb, id, undefined, expect.objectContaining({ area: 'selection', ranges: [first, second] }));
});
