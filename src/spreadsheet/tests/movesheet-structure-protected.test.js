// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openMoveSheetDialog } from '../src/ui/movesheet.js';
import { placeSheet } from '../src/core/sheet-placement.js';
import { closeAllModals } from '../src/ui/modal.js';

// Under Protect Workbook, Move or Copy closed as if the sheet had moved when it had not (the move was refused but
// the sheet itself was handed back as placed), and a copy said "The sheet or destination changed. Check your
// selection and try again", sending people to check a selection that was fine.
beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true })); });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
const dialog = () => document.querySelector('.modal-root:not(.closing) .modal-panel');
const book = () => {
  const wb = new Workbook({ sheets: ['First', 'Second', 'Third'].map((name) => ({ name })) });
  wb.setStructureProtected(true);
  return wb;
};

it('reports nothing placed when the structure is protected', () => {
  const wb = book();
  const notices = [];
  wb.addEventListener('change', (e) => { if (e.detail?.type === 'protected' && e.detail.structure) notices.push(e.detail); });
  expect(placeSheet(wb, wb.sheets[0].id, { before: null })).toBeNull();
  expect(placeSheet(wb, wb.sheets[0].id, { before: null, copy: true })).toBeNull();
  expect(wb.sheets.map((s) => s.name)).toEqual(['First', 'Second', 'Third']);
  expect(notices.length).toBeGreaterThan(0);
});

it.each([false, true])('keeps the dialog open and says the structure is protected (copy: %s)', async (copying) => {
  const wb = book();
  openMoveSheetDialog({ wb, grid: { focus() {} } }, wb.sheets[0].id);
  const panel = dialog();
  panel.querySelector('select.sheet-destinations').value = '';
  if (copying) panel.querySelector('input[type="checkbox"]').click();
  panel.querySelector('form').requestSubmit();
  await Promise.resolve();
  expect(dialog()).toBe(panel);
  expect(panel.querySelector('.field-error').textContent).toMatch(/structure is protected/);
  expect(wb.sheets.map((s) => s.name)).toEqual(['First', 'Second', 'Third']);
});
