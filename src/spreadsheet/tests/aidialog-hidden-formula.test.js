// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openAiDialog } from '../src/ui/aidialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import { toast } from '../src/ui/toast.js';
import * as P from '../src/lib/puter.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// A formula formatted as hidden on a protected sheet is left out of the formula bar, yet Explain this formula (AI)
// showed it in its dialog and sent it to the AI: protection that hides how a figure is worked out was undone by one
// menu command.
beforeEach(() => {
  closeAllModals();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  vi.spyOn(P, 'canAI').mockReturnValue(true);
  toast.mockClear();
  document.body.innerHTML = '<div id="app"></div>';
});

function sheet({ hidden = true, protect = true } = {}) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '0.07');
  wb.setInput(id, 1, 0, '=A1*SECRET_FACTOR*100');
  if (hidden) wb.applyStyle(id, { r1: 1, c1: 0, r2: 1, c2: 0 }, { formulaHidden: true });
  if (protect) wb.setSheetProtected(id, true);
  const chat = vi.spyOn(P, 'aiChat').mockResolvedValue('It multiplies.');
  const ctx = { wb, sheetId: () => id, active: () => ({ r: 1, c: 0 }), range: () => ({ r1: 1, c1: 0, r2: 1, c2: 0 }), grid: { focus() {} } };
  return { ctx, chat };
}

it('neither shows nor sends a formula the protected sheet hides', () => {
  const { ctx, chat } = sheet();
  expect(openAiDialog(ctx, { mode: 'explain' })).toBeNull();
  expect(document.body.textContent).not.toContain('SECRET_FACTOR');
  expect(chat).not.toHaveBeenCalled();
  expect(toast).toHaveBeenCalledWith('The formula in A2 is hidden while the sheet is protected.', expect.anything());
});

it('explains it once the sheet is unprotected, and a formula that is not hidden on a protected sheet', () => {
  for (const options of [{ protect: false }, { hidden: false }]) {
    const { ctx, chat } = sheet(options);
    const modal = openAiDialog(ctx, { mode: 'explain' });
    expect(modal).not.toBeNull();
    expect(modal.panel.textContent).toContain('=A1*SECRET_FACTOR*100');
    expect(chat.mock.calls[0][0]).toContain('SECRET_FACTOR');
    closeAllModals();
    chat.mockClear();
  }
});
