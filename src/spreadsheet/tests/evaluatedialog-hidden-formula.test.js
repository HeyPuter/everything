// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openEvaluateDialog } from '../src/ui/evaluatedialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { toast } from '../src/ui/toast.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// A formula formatted as hidden on a protected sheet is left out of the formula bar, yet Evaluate Formula showed it
// in full, every part of it with its value: one command undid the protection. As Excel cannot evaluate a hidden
// formula, the command says it is hidden and opens nothing.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  toast.mockClear();
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); });

function open({ hidden = true, protect = true } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '0.07');
  wb.setInput(id, 1, 0, '=A1*100+12345');
  if (hidden) wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { formulaHidden: true });
  if (protect) wb.setSheetProtected(id, true);
  return openEvaluateDialog({ wb, sheetId: () => id, active: () => ({ r: 1, c: 0 }), grid: { focus() {} } });
}

it('does not show a formula the protected sheet hides', () => {
  expect(open()).toBeNull();
  expect(document.body.textContent).not.toContain('12345');
  expect(toast).toHaveBeenCalledWith('The formula in A2 is hidden while the sheet is protected.', expect.anything());
});

it('evaluates it once the sheet is unprotected, and a formula that is not hidden on a protected sheet', () => {
  for (const options of [{ protect: false }, { hidden: false }]) {
    const modal = open(options);
    expect(modal).not.toBeNull();
    expect(modal.panel.textContent).toContain('=A1*100+12345');
    closeAllModals();
  }
});
