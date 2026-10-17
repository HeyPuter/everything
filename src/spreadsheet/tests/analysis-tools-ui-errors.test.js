// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openAnalysisTool } from '../src/ui/analysis-tools.js';
import { closeAllModals } from '../src/ui/modal.js';

// A tool that threw (Descriptive Statistics on a column too long for Math.max(...values), say) left the
// dialog open with nothing said, as if OK had not been pressed. The dialog now says what went wrong.
vi.mock('../src/core/analysis-tools.js', async (importOriginal) => ({
  ...(await importOriginal()),
  descriptiveStatistics: () => { throw new RangeError('Maximum call stack size exceeded'); },
}));
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('shows the error when an analysis tool fails', async () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [4, 8, 6].forEach((v, r) => wb.setInput(id, r, 0, String(v)));
  const ctx = { wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 2, c2: 0 }), grid: { focus: vi.fn(), setSelection: vi.fn() }, run: vi.fn() };
  openAnalysisTool(ctx, 'descriptive');
  const panel = () => [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')].at(-1);
  panel().querySelector('form').requestSubmit();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const alert = panel().querySelector('[role="alert"]');
  expect(alert.hidden).toBe(false);
  expect(alert.textContent).toBe('Descriptive Statistics could not be finished: Maximum call stack size exceeded');
  expect(wb.sheets.length).toBe(1);
});
