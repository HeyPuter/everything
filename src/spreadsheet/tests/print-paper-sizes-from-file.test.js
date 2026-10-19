// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { buildPrintRoot, sheetPrintPrefs, printSettingsFromPrefs, printPaperBox } from '../src/ui/print.js';
import { paperInches } from '../src/ui/page-layout.js';
import { openPrintDialog } from '../src/ui/printdialog.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

// A workbook from Excel set up for A5, B5, B4, Executive, Statement or Folio paper showed those pages in the Page
// Layout view, but the Print dialog said Letter and the sheet was laid out and printed on Letter paper: the print
// knew five papers. It now knows the papers the Page Layout view draws, and prints on them.
beforeEach(() => { vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { closeAllModals(); document.body.replaceChildren(); localStorage.clear(); vi.unstubAllGlobals(); });

function sheetOn(paperSize, orientation = 'portrait') {
  const wb = new Workbook({ sheets: [{ name: 'Report', cells: { '0,0': { v: 1 } }, printSettings: { paperSize, orientation } }] });
  return { wb, sheet: wb.activeSheet };
}
const pageRule = (wb, sheet) => buildPrintRoot(wb, sheet.id, 'Doc', {}).querySelector('style').textContent.split('\n')[0];

it.each([[11, 'a5', 'A5'], [12, 'b4', 'B4'], [13, 'b5', 'B5'], [7, 'executive', 'Executive'], [6, 'statement', 'Statement'], [14, 'folio', 'Folio']])(
  'prints a sheet set up for paper %i on that paper, and keeps it through the dialog', (code, key, label) => {
    const { wb, sheet } = sheetOn(code);
    const prefs = sheetPrintPrefs(sheet);
    expect(prefs.paper).toBe(key);
    // The paper the print lays the sheet out on is the one the Page Layout view draws (to the millimetre).
    const [w, h] = paperInches(sheet.printSettings);
    const box = printPaperBox(prefs);
    expect(Math.abs(box.width / 96 - w)).toBeLessThan(0.05);
    expect(Math.abs(box.height / 96 - h)).toBeLessThan(0.05);
    expect(printSettingsFromPrefs(sheet, prefs).paperSize).toBe(code);
    expect(printSettingsFromPrefs(sheet, { ...prefs, paper: 'letter' }).paperSize).toBe(1);
    expect(printSettingsFromPrefs({ printSettings: null }, { ...prefs })).toMatchObject({ paperSize: code });
    const modal = openPrintDialog({ wb, sheetId: () => sheet.id, selection: () => S.single(0, 0), range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus() {} } });
    const select = modal.panel.querySelector('[aria-label="Paper size"]');
    expect(select.value).toBe(key);
    expect(select.selectedOptions[0].textContent).toBe(label);
    closeAllModals();
  });

it('asks the browser for the paper by its name where CSS has one, else by its two lengths, turned for landscape', () => {
  expect(pageRule(...Object.values(sheetOn(11)))).toMatch(/^@page \{ size: A5 portrait; /);
  expect(pageRule(...Object.values(sheetOn(11, 'landscape')))).toMatch(/^@page \{ size: A5 landscape; /);
  expect(pageRule(...Object.values(sheetOn(7)))).toMatch(/^@page \{ size: 7\.25in 10\.5in; /);
  expect(pageRule(...Object.values(sheetOn(7, 'landscape')))).toMatch(/^@page \{ size: 10\.5in 7\.25in; /);
});
