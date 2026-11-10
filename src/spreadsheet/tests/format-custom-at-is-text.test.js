// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { numFmtToStyle } from '../src/core/format.js';
import { numberPatch } from '../src/ui/formatcells.js';
import { openCustomFormatDialog } from '../src/ui/numfmtdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// The custom code @ is Excel's Text format (built-in 49), and an .xlsx carrying it opens as Text here. Written
// as a custom code in Format Cells or Custom number format, though, it stayed a code that only showed text: a
// 00123 typed into the cell became the number 123 and a 1/2 became January 2, until the file was saved and
// opened again, when the same cell kept them as typed.
it('applies the custom code @ as the Text format from Format Cells', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 1, c2: 0 }, numberPatch({ category: 'custom', code: '@' }));
  wb.setInput(id, 0, 0, '00123');
  wb.setInput(id, 1, 0, '1/2');
  expect(wb.getCell(id, 0, 0).v).toBe('00123');
  expect(wb.getCell(id, 1, 0).v).toBe('1/2');
  // The style an .xlsx's @ opens as.
  expect(wb.styleAt(id, 0, 0)).toEqual(numFmtToStyle('@'));
  // Any other code stays custom.
  expect(numberPatch({ category: 'custom', code: '@" units"' })).toMatchObject({ fmt: 'custom', code: '@" units"' });
});

it('applies the custom code @ as the Text format from the Custom number format dialog', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const runs = [];
  const modal = openCustomFormatDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), style: () => ({}), run: (cmd, arg) => runs.push([cmd, arg]), grid: { focus: vi.fn() } });
  const input = modal.panel.querySelector('input[aria-label="Format code"]');
  input.value = ' @ ';
  input.dispatchEvent(new Event('input'));
  modal.panel.querySelector('form').requestSubmit();
  expect(runs).toHaveLength(1);
  const [cmd, patch] = runs[0];
  expect(cmd).toBe('fmt');
  expect(patch).toMatchObject({ fmt: 'text', code: null });
  wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, patch);
  wb.setInput(id, 0, 0, '00123');
  expect(wb.getCell(id, 0, 0).v).toBe('00123');
});
