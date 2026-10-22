// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';
import { openCustomFormatDialog } from '../src/ui/numfmtdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { setLocale('en-US'); closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// Under Deutsch the Custom number format preview read "1234.5 → 1.234,50": the cell's value in the program's own
// notation beside the formatted result. It reads 1234,5 as the cell shows it.
it('shows the cell value in the regional format beside its formatted result', () => {
  setLocale('de-DE');
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1234,5');
  const modal = openCustomFormatDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), style: () => ({ fmt: 'number', dec: 2 }), run: vi.fn(), grid: { focus: vi.fn() } });
  expect(modal.panel.querySelector('.numfmt-preview').textContent).toBe('1234,5 → 1.234,50');
});
