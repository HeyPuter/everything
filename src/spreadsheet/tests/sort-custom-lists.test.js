// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openSortDialog, sortLists } from '../src/ui/sortdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { Workbook } from '../src/core/workbook.js';
import { setLocale, getLocale } from '../src/core/format.js';

// Sorting a column of month or weekday names could only go A to Z, which puts Apr before Jan; Excel's Order
// offers its custom lists (Sun … Sat, Jan … Dec). A key can now sort by a list's order, or the reverse, the
// values the list does not name following its entries and blanks last.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let locale;
beforeEach(() => { locale = getLocale(); setLocale('en-US'); vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); setLocale(locale); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function book(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setCells(id, [{ r, c, cell: { v } }])));
  const col = (c, r1, r2) => Array.from({ length: r2 - r1 + 1 }, (_, i) => wb.getValue(id, r1 + i, c));
  return { wb, id, col };
}

it('sorts rows by a custom list, in its order or reversed, other values after it and blanks last', () => {
  const { wb, id, col } = book([['Mar', 3], ['jan', 1], ['Other', 0], [null, 9], ['Dec', 12], ['Feb', 2]]);
  expect(wb.sortRangeBy(id, { r1: 0, c1: 0, r2: 5, c2: 1 }, [{ col: 0, list: MONTHS }])).toBe(true);
  expect(col(0, 0, 5)).toEqual(['jan', 'Feb', 'Mar', 'Dec', 'Other', null]);
  expect(col(1, 0, 5)).toEqual([1, 2, 3, 12, 0, 9]);
  wb.sortRangeBy(id, { r1: 0, c1: 0, r2: 5, c2: 1 }, [{ col: 0, list: MONTHS, ascending: false }]);
  expect(col(0, 0, 5)).toEqual(['Dec', 'Mar', 'Feb', 'jan', 'Other', null]);
});

it('sorts columns left to right by a custom list', () => {
  const { wb, id } = book([['Wed', 'Mon', 'Tue'], [3, 1, 2]]);
  wb.sortColumnsBy(id, { r1: 0, c1: 0, r2: 1, c2: 2 }, [{ row: 0, list: sortLists()[0].items }]);
  expect([0, 1, 2].map((c) => wb.getValue(id, 1, c))).toEqual([1, 2, 3]);
});

it('offers the weekday and month lists in the Order of a sort level', () => {
  const { wb, id, col } = book([['Month'], ['Mar'], ['Jan'], ['Feb']]);
  const modal = openSortDialog({ wb, sheetId: () => id, active: () => ({ r: 1, c: 0 }), grid: { focus() {} } }, { r1: 0, c1: 0, r2: 3, c2: 0 });
  const order = modal.panel.querySelector('[aria-label="Order"]');
  const labels = [...order.options].map((o) => o.textContent);
  expect(labels).toContain('Jan, Feb, Mar, … Dec');
  expect(labels).toContain('Saturday, Friday, Thursday, … Sunday');
  order.value = [...order.options].find((o) => o.textContent === 'Jan, Feb, Mar, … Dec').value;
  const header = modal.panel.querySelector('input[type="checkbox"]');
  header.checked = true;
  header.dispatchEvent(new Event('change'));
  modal.panel.querySelector('form').requestSubmit();
  expect(col(0, 0, 3)).toEqual(['Month', 'Jan', 'Feb', 'Mar']);
});
