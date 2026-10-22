// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { splitSourceText } from '../src/core/text-split.js';
import { openTextToColumnsDialog } from '../src/ui/textcolumnsdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

// Text to Columns took only text: a column of typed numbers such as dates written 20240115, cut at fixed widths
// into year, month and day as Excel cuts them, split nothing ("No text with a separator to split"), and the
// dialog's preview showed none of it. A number is now split by the digits of its value.
beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

function book(texts) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  texts.forEach((t, r) => wb.setInput(id, r, 0, t));
  return { wb, id, row: (r) => [0, 1, 2].map((c) => wb.getValue(id, r, c)) };
}

it('cuts typed numbers at fixed widths', () => {
  const { wb, id, row } = book(['20240115', '20231231']);
  expect(wb.splitTextToColumns(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, { mode: 'fixed', breaks: [4, 6] })).toEqual({ rows: 2, cols: 3 });
  expect(row(0)).toEqual([2024, 1, 15]);
  expect(row(1)).toEqual([2023, 12, 31]);
  wb.undo();
  expect(row(0)).toEqual([20240115, null, null]);
});

it('splits a number at a separator in its digits and leaves numbers without one untouched', () => {
  const { wb, id, row } = book(['3.25', '$1,500.00', '7']);
  expect(wb.splitTextToColumns(id, { r1: 0, c1: 0, r2: 2, c2: 0 }, '.')).toEqual({ rows: 1, cols: 2 });
  expect(row(0)).toEqual([3, 25, null]);
  expect(row(1)).toEqual([1500, null, null]);
  expect(wb.getDisplay(id, 1, 0)).toBe('$1,500.00');
  expect(row(2)).toEqual([7, null, null]);
});

it('leaves dates, formulas and logical values alone', () => {
  expect(splitSourceText({ v: 45296, s: { fmt: 'date' } })).toBe(null);
  expect(splitSourceText({ v: null, f: 'A1' })).toBe(null);
  expect(splitSourceText({ v: true })).toBe(null);
  expect(splitSourceText({ v: 0.1 + 0.2 })).toBe('0.3');
  expect(splitSourceText({ v: 'a,b' })).toBe('a,b');
});

it('previews typed numbers in the dialog', () => {
  const { wb, id } = book(['20240115', '20231231']);
  openTextToColumnsDialog({ wb, sheetId: () => id, grid: { focus() {} } }, { range: { r1: 0, c1: 0, r2: 1, c2: 0 }, onSplit() {}, resolve: () => null });
  expect(document.body.textContent).toContain('20240115');
});
