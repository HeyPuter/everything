// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); });

// A header or footer holds up to 255 characters in Excel, formatting codes and all, as the first-page and even-page
// fields beside them do. The regular header and footer took 120: one written with fonts and colours ran out of room,
// and one brought in from a workbook, longer than that, could not have a single character typed into it.
it('takes a header and footer as long as Excel does', () => {
  const header = `&L&"Arial,Bold"&14&K1F4E79Quarterly report&C&"Arial,Italic"&10Northern region, all subsidiaries and partners${'.'.repeat(60)}&R&D &T`;
  expect(header.length).toBeGreaterThan(120);
  const wb = new Workbook({ sheets: [{ name: 'Report', cells: { '0,0': { v: 1 } }, printSettings: { header } }] });
  const modal = openPrintDialog({ wb, sheetId: () => wb.activeSheetId, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
  for (const label of ['Header text', 'Footer text', 'First page header text', 'Even pages footer text']) {
    expect(modal.panel.querySelector(`[aria-label="${label}"]`).maxLength).toBe(255);
  }
  expect(modal.panel.querySelector('[aria-label="Header text"]').value).toBe(header);
});
