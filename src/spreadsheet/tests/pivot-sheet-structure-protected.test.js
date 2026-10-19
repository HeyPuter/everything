// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import * as S from '../src/core/selection.js';
import { openPivotDialog } from '../src/ui/pivotdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// With Protect Workbook on no sheet can be added, and the pivot table dialog went on to write its cells
// to the sheet it never got: OK threw a TypeError, and the dialog stayed up with nothing said about why.
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

it('adds no pivot sheet and leaves the dialog open when the workbook structure is protected', () => {
  const wb = new Workbook({ sheets: [{ name: 'Sales' }] });
  const id = wb.activeSheetId;
  [['Region', 'Amount'], ['East', '10'], ['West', '20']].forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  wb.clearHistory();
  wb.setStructureProtected(true);
  const refusals = [];
  wb.addEventListener('change', (e) => { if (e.detail?.type === 'protected' && e.detail.structure) refusals.push(e.detail); });
  const range = parseRange('A1:B3');
  const ctx = { wb, sheetId: () => id, range: () => range, selection: () => S.fromRange(range), grid: { focus: vi.fn() } };
  const { panel } = openPivotDialog(ctx);
  expect(() => panel.querySelector('form').requestSubmit()).not.toThrow();
  expect(wb.sheets).toHaveLength(1);
  expect(wb.canUndo()).toBe(false);
  expect(refusals).toHaveLength(1);
  expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/Pivot table added/), expect.anything());
  expect(panel.isConnected).toBe(true);
});
