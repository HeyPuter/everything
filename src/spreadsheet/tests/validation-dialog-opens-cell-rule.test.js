// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openValidationManager } from '../src/ui/validation.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function open(wb, id, range, type = null) {
  const g = parseRange(range);
  const { panel } = openValidationManager({ wb, sheetId: () => id, range: () => g, active: () => ({ r: g.r1, c: g.c1 }), grid: { focus: vi.fn() } }, type ? { type } : {});
  vi.runAllTimers();
  return { panel, field: (label) => panel.querySelector(`[aria-label="${label}"]`), submit: () => panel.querySelector('form').requestSubmit() };
}

// Opened on a cell with a dropdown, the dialog showed an empty Add rule form, so changing the dropdown's
// options laid a second rule over the first. It now opens on the cell's rule, as Excel's dialog does.
it('opens on the rule of the selected cells, ready to change it', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.addValidation(id, { range: parseRange('A1:A10'), type: 'list', source: 'Yes, No' });
  const { field, panel, submit } = open(wb, id, 'A3:A4');
  expect(field('Type').value).toBe('list');
  expect(field('List options').value).toBe('Yes, No');
  expect(field('Apply to range').value).toBe('A1:A10');
  expect(panel.querySelector('button[type="submit"]').textContent).toBe('Save rule');
  field('List options').value = 'Yes, No, Maybe';
  submit();
  expect(wb.sheet(id).validations).toHaveLength(1);
  expect(wb.sheet(id).validations[0]).toMatchObject({ range: parseRange('A1:A10'), source: 'Yes, No, Maybe' });
});

it('starts a new rule where the selection reaches past the cell\'s rule, or none covers it', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.addValidation(id, { range: parseRange('A1:A10'), type: 'list', source: 'Yes, No' });
  for (const range of ['A9:A12', 'B1']) {
    const { field, panel } = open(wb, id, range);
    expect(field('Apply to range').value).toBe(range);
    expect(panel.querySelector('button[type="submit"]').textContent).toBe('Add rule');
    closeAllModals(); vi.runAllTimers();
  }
  const { field } = open(wb, id, 'A2', 'checkbox');
  expect(field('Type').value).toBe('checkbox');
});
