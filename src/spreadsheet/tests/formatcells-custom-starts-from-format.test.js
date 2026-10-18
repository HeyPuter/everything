// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// Choosing Custom in Format Cells showed an empty code field (and a bare "Preview"), so adding " kg" to a
// cell's #,##0.00 meant writing the whole code from memory. Custom now starts from the code of the format
// chosen before it, as Excel's does; left unedited it changes nothing.
function open(style) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '-1234.5');
  if (style) wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, style);
  const run = vi.fn();
  const { panel } = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), style: () => wb.getCell(id, 0, 0).s || {}, run, grid: { focus() {} } });
  const field = (label) => panel.querySelector(`[aria-label="${label}"]`);
  const choose = (label, value) => { field(label).value = value; field(label).dispatchEvent(new Event('change')); };
  const type = (label, value) => { field(label).value = value; field(label).dispatchEvent(new Event('input')); };
  return { panel, field, choose, type, run, submit: () => panel.querySelector('form').requestSubmit() };
}

it('starts Custom from the Number format chosen before it', () => {
  const { panel, field, choose, type, run, submit } = open({ fmt: 'number', dec: 2 });
  choose('Category', 'custom');
  expect(field('Format code').value).toBe('#,##0.00');
  expect(panel.querySelector('.numfmt-preview').textContent).toBe('Preview: -1,234.50');
  type('Format code', '#,##0.00 "kg"');
  submit();
  expect(run).toHaveBeenCalledWith('applyFormat', expect.objectContaining({ patch: expect.objectContaining({ fmt: 'custom', code: '#,##0.00 "kg"' }) }));
});

it('follows the options picked on the way, such as a currency with no decimals', () => {
  const { field, choose, type } = open(null);
  choose('Category', 'currency');
  type('Decimal places', '0');
  choose('Category', 'custom');
  expect(field('Format code').value).toBe('"$"#,##0');
});

it('shows General for a cell without a format, and applies nothing when the code is left as it is', () => {
  const { panel, field, choose, run, submit } = open(null);
  choose('Category', 'custom');
  expect(field('Format code').value).toBe('General');
  expect(panel.querySelector('.numfmt-preview').textContent).toBe('Preview: -1234.5');
  submit();
  expect(panel.querySelector('.field-error').hidden).toBe(true);
  expect(run).not.toHaveBeenCalled();
});

it('applies nothing for an unedited code started from the cell\'s own Number format either', () => {
  const { choose, run, submit } = open({ fmt: 'number', dec: 2 });
  choose('Category', 'custom');
  submit();
  expect(run).not.toHaveBeenCalled();
});
