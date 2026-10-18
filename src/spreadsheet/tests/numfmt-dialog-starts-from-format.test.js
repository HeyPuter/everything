// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openCustomFormatDialog } from '../src/ui/numfmtdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// Custom format… from the number format menu opened with an empty code on a Number, Currency or Percent cell,
// so adjusting its #,##0.00 meant writing it again. It now starts from the cell's format as a code.
function open(style) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '1234.5');
  const modal = openCustomFormatDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), style: () => style, run: vi.fn(), grid: { focus: vi.fn() } });
  return { input: modal.panel.querySelector('input[aria-label="Format code"]'), preview: modal.panel.querySelector('.numfmt-preview') };
}

it.each([
  [{ fmt: 'number', dec: 2 }, '#,##0.00', '1,234.50'],
  [{ fmt: 'currency', dec: 2 }, '"$"#,##0.00', '$1,234.50'],
  [{ fmt: 'percent', dec: 1, group: false }, '0.0%', '123450.0%'],
  [{ fmt: 'custom', code: '0.0" kg"' }, '0.0" kg"', '1234.5 kg'],
])('starts %j at %s', (style, code, shown) => {
  const { input, preview } = open(style);
  expect(input.value).toBe(code);
  expect(preview.textContent).toBe(`1234.5 → ${shown}`);
});

it('starts a cell in no format empty', () => {
  expect(open({}).input.value).toBe('');
});
