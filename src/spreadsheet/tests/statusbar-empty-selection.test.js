// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { createStatusBar } from '../src/ui/statusbar.js';

// Selecting empty cells (a blank row under a list, an empty column) showed "Count: 0" in the status bar. Excel shows
// no statistics until the selection holds something; neither does the bar now.
beforeEach(() => {
  localStorage.setItem('spreadsheet:status-bar', JSON.stringify({ numCount: true }));
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { localStorage.clear(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

function stats(wb, range) {
  const id = wb.activeSheetId;
  const status = createStatusBar({ wb, sheetId: () => id, subscribe: () => () => {}, grid: { range, selection: S.fromRange(range), zoom: 1 }, activeCell: () => null });
  document.querySelector('#app').append(status.el);
  const out = [...status.el.querySelectorAll('.status-stat')].map((n) => n.textContent);
  status.destroy();
  return out;
}

it('shows no Count for a selection of empty cells', () => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 'Name' } }]);
  expect(stats(wb, { r1: 5, c1: 0, r2: 5, c2: 3 })).toEqual([]);
});

it('counts once the selection holds something, text alone included', () => {
  const wb = new Workbook();
  wb.setCells(wb.activeSheetId, [{ r: 0, c: 0, cell: { v: 'Name' } }]);
  expect(stats(wb, { r1: 0, c1: 0, r2: 3, c2: 0 })).toEqual(['Count: 1', 'Numerical Count: 0']);
});
