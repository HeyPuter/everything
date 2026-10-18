// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { ymdToSerial } from '../src/core/format.js';
import * as S from '../src/core/selection.js';
import { openPivotDialog } from '../src/ui/pivotdialog.js';
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
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it('suggests the amounts, not the order dates, as the values to summarize', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [
    { r: 0, c: 0, cell: { v: 'Region' } }, { r: 0, c: 1, cell: { v: 'Ordered' } }, { r: 0, c: 2, cell: { v: 'Amount' } },
    { r: 1, c: 0, cell: { v: 'North' } }, { r: 1, c: 1, cell: { v: ymdToSerial(2026, 1, 5), s: { fmt: 'date' } } }, { r: 1, c: 2, cell: { v: 10 } },
    { r: 2, c: 0, cell: { v: 'South' } }, { r: 2, c: 1, cell: { v: ymdToSerial(2026, 2, 10), s: { fmt: 'date' } } }, { r: 2, c: 2, cell: { v: 20 } },
  ]);
  const range = parseRange('A1:C3');
  const { panel } = openPivotDialog({ wb, sheetId: () => id, range: () => range, selection: () => S.fromRange(range), grid: { focus: vi.fn() } });
  const values = panel.querySelector('[aria-label="Values"]');
  expect(values.options[values.selectedIndex].textContent).toBe('Amount');
});
