// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook, MAX_ROWS } from '../src/core/workbook.js';
import { openSubtotalDialog } from '../src/ui/subtotaldialog.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const selectedColumns = () => [...document.querySelectorAll('input[data-col]')].filter((input) => input.checked).map((input) => Number(input.dataset.col));

// To suggest the columns worth totalling, Subtotal listed every value spilled anywhere on the sheet, so beside an
// array formula entered over the rest of the sheet (seventeen billion results) choosing Subtotal for columns A:C ran
// the tab out of memory. It reads only what spills into the columns it is offered.
it('opens for whole columns beside an array spilled over the rest of the sheet', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['Region', 'Units', 'Notes'].forEach((value, c) => wb.setInput(id, 0, c, value));
  wb.setInput(id, 1, 0, 'East');
  wb.setInput(id, 1, 1, '4');
  wb.setInput(id, 2, 0, 'West');
  wb.setInput(id, 2, 1, '6');
  wb.setInput(id, 2, 2, 'late');
  expect(wb.setArrayFormula(id, { r1: 0, c1: 4, r2: MAX_ROWS - 1, c2: 16383 }, '=B2*2')).toBe(true);
  const modal = openSubtotalDialog({ wb, sheetId: () => id, grid: { focus: vi.fn(), setSelection: vi.fn() } }, { r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: 2 });
  expect(modal.panel.getAttribute('aria-label')).toBe('Subtotals');
  expect(selectedColumns()).toEqual([1]);
});

it('still counts the results an array spills into the offered columns', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['Region', 'Units'].forEach((value, c) => wb.setInput(id, 0, c, value));
  wb.setInput(id, 1, 0, 'East');
  wb.setInput(id, 1, 1, '=SEQUENCE(3)');
  openSubtotalDialog({ wb, sheetId: () => id, grid: { focus: vi.fn(), setSelection: vi.fn() } }, { r1: 0, c1: 0, r2: MAX_ROWS - 1, c2: 1 });
  expect(selectedColumns()).toEqual([1]);
});
