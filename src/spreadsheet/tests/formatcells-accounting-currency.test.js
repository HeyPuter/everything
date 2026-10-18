// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';
import { accountingCode, formatEntry } from '../src/ui/toolbar.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { setLocale('en-US'); closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// Under Deutsch, Format Cells gave a cell in no currency US dollars, under Currency and under Accounting
// (preview "$ 5,00"), where the ribbon's Currency and Accounting buttons give euros; and Accounting had no
// currency or decimal places to choose, as Excel's has. The dialog now starts from the regional format's
// currency and offers both for Accounting.
function open(style = null) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 1234.5, f: null } }]);
  if (style) wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, style);
  const run = vi.fn();
  const { panel } = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), style: () => wb.getCell(id, 0, 0).s || {}, run, grid: { focus() {} } });
  const field = (label) => panel.querySelector(`[aria-label="${label}"]`);
  const choose = (label, value) => { field(label).value = value; field(label).dispatchEvent(new Event('change')); };
  const type = (label, value) => { field(label).value = value; field(label).dispatchEvent(new Event('input')); };
  const preview = () => panel.querySelector('.numfmt-preview').textContent;
  return { field, choose, type, preview, run, submit: () => panel.querySelector('form').requestSubmit() };
}
const patchOf = (run) => run.mock.calls[0][1].patch;

it('offers the regional format\'s currency under Currency and Accounting', () => {
  setLocale('de-DE');
  const currency = open();
  currency.choose('Category', 'currency');
  expect(currency.field('Currency').value).toBe('EUR');
  currency.submit();
  expect(patchOf(currency.run)).toMatchObject({ fmt: 'currency', cur: 'EUR' });
  closeAllModals();
  const accounting = open();
  accounting.choose('Category', 'accounting');
  expect(accounting.field('Currency').value).toBe('EUR');
  expect(accounting.preview()).toContain('€');
  accounting.submit();
  expect(patchOf(accounting.run)).toMatchObject({ fmt: 'custom', code: accountingCode('EUR'), cur: 'EUR' });
});

it('sets Accounting\'s currency and decimal places, and reads them back from the cell', () => {
  const first = open();
  first.choose('Category', 'accounting');
  expect(first.field('Currency').value).toBe('USD');
  expect(first.field('Decimal places').value).toBe('2');
  first.choose('Currency', 'GBP');
  first.type('Decimal places', '0');
  expect(first.preview().replace('Preview:', '').trim()).toMatch(/^£\s*1,235$/);
  first.submit();
  const code = accountingCode('GBP', 0);
  expect(patchOf(first.run)).toMatchObject({ fmt: 'custom', code, cur: 'GBP' });
  expect(formatEntry({ fmt: 'custom', code }).value).toBe('accounting');
  closeAllModals();
  const again = open({ fmt: 'custom', code, cur: 'GBP' });
  expect(again.field('Category').value).toBe('accounting');
  expect(again.field('Currency').value).toBe('GBP');
  expect(again.field('Decimal places').value).toBe('0');
  again.submit();
  expect(again.run).not.toHaveBeenCalled();
});
