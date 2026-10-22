// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { createStatusBar } from '../src/ui/statusbar.js';

// In Page Layout view the status bar names the printed page the active cell is on. A cell above or left of a print
// area that starts further down or across is on none of them: it read "Page: 0 of 5" above the area (pages counted
// back from its first), and beside it the number of another, real page. The bar now names no page there.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function book(area) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < 300; r++) for (let c = 0; c < 40; c++) entries.push({ r, c, cell: { v: r } });
  wb.setCells(id, entries);
  wb.setPrintSettings(id, { ...wb.sheet(id).printSettings, areas: [area], pageOrder: 'overThenDown' });
  return { wb, id };
}
function pageAt(wb, id, r, c) {
  const range = { r1: r, c1: c, r2: r, c2: c };
  const status = createStatusBar({ wb, sheetId: () => id, subscribe: () => () => {}, viewMode: () => 'pageLayout',
    grid: { range, selection: S.fromRange(range), active: { r, c }, zoom: 1 }, activeCell: () => null });
  document.querySelector('#app').append(status.el);
  const page = status.el.querySelector('.status-page');
  const shown = page.hidden ? null : page.textContent;
  status.destroy();
  return shown;
}

it('names no page for a cell above or left of the print area', () => {
  const { wb, id } = book({ r1: 100, c1: 20, r2: 250, c2: 39 });
  expect(pageAt(wb, id, 0, 0)).toBeNull();
  expect(pageAt(wb, id, 0, 25)).toBeNull();
  expect(pageAt(wb, id, 150, 0)).toBeNull();
  expect(pageAt(wb, id, 100, 20)).toMatch(/^Page: 1 of \d+$/);
});
