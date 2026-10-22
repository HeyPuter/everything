// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openSeriesDialog } from '../src/ui/seriesdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// Fill Series over whole columns wrote the series into all 1,048,576 rows: column A selected with 1 in A1 wrote a
// million numbers, and a sheet selected whole with Ctrl+A took over two minutes. Whole columns (or rows) now fill as
// far as the sheet's content goes, as Fill Down takes them, and a stop value still carries the series past it.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function fill(range, { stop = '', type } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  for (let r = 0; r < 50; r++) wb.setInput(id, r, 1, `x${r}`);
  openSeriesDialog({ wb, sheetId: () => id, range: () => range, grid: { setSelection: vi.fn(), focus: vi.fn() } });
  const panel = document.querySelector('.modal-panel');
  if (type) panel.querySelector('[aria-label="Type"]').value = type;
  panel.querySelector('[aria-label="Stop value"]').value = stop;
  panel.querySelector('form').requestSubmit();
  return { wb, id };
}

it('fills a whole column through the last row of the data', () => {
  const { wb, id } = fill({ r1: 0, c1: 0, r2: 1048575, c2: 0 });
  expect(wb.getValue(id, 49, 0)).toBe(50);
  expect(wb.getCell(id, 50, 0)).toBeFalsy();
  expect(wb.sheet(id).cells.size).toBe(100);
});

it('fills a sheet selected whole as far as its data goes', () => {
  const { wb, id } = fill({ r1: 0, c1: 0, r2: 1048575, c2: 16383 });
  expect(wb.getValue(id, 49, 0)).toBe(50);
  expect(wb.sheet(id).cells.size).toBe(100);
});

it('carries a whole column past the data to the stop value', () => {
  const { wb, id } = fill({ r1: 0, c1: 0, r2: 1048575, c2: 0 }, { stop: '120' });
  expect(wb.getValue(id, 119, 0)).toBe(120);
  expect(wb.getCell(id, 120, 0)).toBeFalsy();
});

it('extends a whole column with AutoFill as far as the data goes', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1');
  wb.setInput(id, 1, 0, '2');
  for (let r = 0; r < 50; r++) wb.setInput(id, r, 1, `x${r}`);
  openSeriesDialog({ wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 1048575, c2: 0 }), grid: { setSelection: vi.fn(), focus: vi.fn() } });
  const panel = document.querySelector('.modal-panel');
  panel.querySelector('[aria-label="Type"]').value = 'autofill';
  panel.querySelector('form').requestSubmit();
  expect(wb.getValue(id, 49, 0)).toBe(50);
  expect(wb.sheet(id).cells.size).toBe(100);
});

it('still fills a block of cells as selected', () => {
  const { wb, id } = fill({ r1: 0, c1: 0, r2: 79, c2: 0 });
  expect(wb.getValue(id, 79, 0)).toBe(80);
});
