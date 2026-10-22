// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';
import { openFormatCellsDialog } from '../src/ui/formatcells.js';
import { closeAllModals } from '../src/ui/modal.js';
import { ptToPx } from '../src/ui/toolbar.js';

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { setLocale('en-US'); closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function open(style = null) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Text', f: null } }]);
  if (style) wb.applyStyle(id, { r1: 0, c1: 0, r2: 0, c2: 0 }, style);
  const run = vi.fn();
  const { panel } = openFormatCellsDialog({ wb, sheetId: () => id, active: () => ({ r: 0, c: 0 }), style: () => wb.getCell(id, 0, 0).s || {}, run, grid: { focus() {} } }, { panel: 'font' });
  const size = panel.querySelector('[aria-label="Font size"]');
  return { panel, size, run, submit: () => panel.querySelector('form').requestSubmit() };
}

// Under Deutsch the Font tab showed a size of 10.5 points as "10.5" and refused "10,5" ("Enter a size from 1 to 409
// points. Decimals are supported."), where the ribbon's Custom font size takes the regional decimal mark.
it('reads and shows a font size with the regional decimal mark', () => {
  setLocale('de-DE');
  const { size, run, submit } = open();
  size.value = '10,5';
  size.dispatchEvent(new Event('input'));
  submit();
  expect(run).toHaveBeenCalledWith('applyFormat', expect.objectContaining({ patch: expect.objectContaining({ size: ptToPx(10.5) }) }));
  closeAllModals(); vi.runAllTimers();
  const again = open({ size: ptToPx(10.5) });
  expect(again.size.value).toBe('10,5');
  again.submit();
  expect(again.run).not.toHaveBeenCalled();
});

it('still takes a full stop where it is the decimal mark', () => {
  const { size, run, submit } = open();
  size.value = '10.5';
  size.dispatchEvent(new Event('input'));
  submit();
  expect(run).toHaveBeenCalledWith('applyFormat', expect.objectContaining({ patch: expect.objectContaining({ size: ptToPx(10.5) }) }));
});
