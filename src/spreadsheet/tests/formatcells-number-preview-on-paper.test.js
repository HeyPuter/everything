// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// The Number tab's preview inks the value in its code's colour; on the dialog's dark surface in the dark theme a
// [Black] section was dark on dark. It is a sample of the cell on paper, as the other tabs' previews are.
it('draws the Number tab preview on sheet paper, so a [Black] section reads in the dark theme', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 5, f: null } }]);
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, { fmt: 'custom', code: '[Black]0.00;[Red]-0.00' });
  const { panel } = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), style: () => wb.getCell(id, 0, 0).s || {}, run: vi.fn(), grid: { focus() {} } });
  const preview = panel.querySelector('.numfmt-preview');
  expect(preview.textContent).toBe('Preview: 5.00');
  expect(preview.classList.contains('sheet-paper')).toBe(true);
});
