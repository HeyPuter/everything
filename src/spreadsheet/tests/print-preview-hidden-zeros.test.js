// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// A sheet with its zero values hidden (Show zeros turned off, or a file from Excel saved that way) shows and prints
// those cells blank. The print preview drew each cell's text without asking, so it showed the zeros the page leaves out.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let texts;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  texts = [];
  const g = new Proxy({}, {
    get: (o, k) => (k in o ? o[k] : (...args) => { if (k === 'fillText') texts.push(args[0]); }),
    set: (o, k, v) => { o[k] = v; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(g);
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

async function preview(wb, id) {
  openPrintDialog({ wb, sheetId: () => id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  await vi.advanceTimersByTimeAsync(5);
  return texts;
}

it('leaves zero values out of the preview when the sheet hides them, as the print does', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Units');
  wb.setInput(id, 1, 0, '0');
  wb.setInput(id, 2, 0, '=A2*5');
  wb.setInput(id, 3, 0, '7');
  wb.sheet(id).zeros = false;
  const shown = await preview(wb, id);
  expect(shown).toContain('Units');
  expect(shown).toContain('7');
  expect(shown).not.toContain('0');
});

it('still shows them on a sheet that shows its zeros', async () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '0');
  expect(await preview(wb, id)).toContain('0');
});
