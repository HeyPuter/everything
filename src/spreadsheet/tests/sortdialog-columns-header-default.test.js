// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openSortDialog } from '../src/ui/sortdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

// Switching the Sort dialog to "Sort columns (left to right)" kept the header box as the first row had set it,
// now reading "Data has a header column": a list with headings in row 1 kept its column A out of a sort of its
// columns, though nothing said column A was a header. Excel's left-to-right sort takes every column; so does
// the dialog now, until the box is set by hand.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function open() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Qty', 'City'], ['b', 2, 'x'], ['a', 1, 'y']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const { panel } = openSortDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), grid: { focus: vi.fn() } }, parseRange('A1:C3'));
  const header = panel.querySelector('input[type="checkbox"]');
  const direction = panel.querySelector('[aria-label="Sort direction"]');
  const turn = (value) => { direction.value = value; direction.dispatchEvent(new Event('change')); };
  return { wb, id, panel, header, turn, firstRow: () => wb.rangeValues(id, parseRange('A1:C1'))[0] };
}

it('sorts every column left to right when the header row was only detected', () => {
  const f = open();
  expect(f.header.checked).toBe(true);
  f.turn('cols');
  expect(f.header.checked).toBe(false);
  f.panel.querySelector('form').requestSubmit();
  expect(f.firstRow()).toEqual(['City', 'Name', 'Qty']);
});

it('takes the header row back when turned to rows again, and keeps a box set by hand', () => {
  const f = open();
  f.turn('cols');
  f.turn('rows');
  expect(f.header.checked).toBe(true);
  f.header.checked = false;
  f.header.dispatchEvent(new Event('change'));
  f.turn('cols');
  f.header.checked = true;
  f.header.dispatchEvent(new Event('change'));
  f.turn('rows');
  f.turn('cols');
  expect(f.header.checked).toBe(true);
});
