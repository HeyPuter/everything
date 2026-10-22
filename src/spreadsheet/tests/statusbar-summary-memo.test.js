// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { createStatusBar } from '../src/ui/statusbar.js';

// The status bar refreshes on every keystroke typed into a cell and on every move of the active cell. Its Sum,
// Average and Count are worked out again only when the selection or the workbook changes: summing a selection of
// 150,000 cells on each key held typing up by 100 ms a key.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

function mount(wb, range) {
  const id = wb.activeSheetId;
  const grid = { range, selection: { ...S.fromRange(range), active: { r: range.r1, c: range.c1 } }, zoom: 1, editState: null };
  const status = createStatusBar({ wb, sheetId: () => id, subscribe: () => () => {}, grid, activeCell: () => null });
  document.querySelector('#app').append(status.el);
  const sum = () => [...status.el.querySelectorAll('.status-item')].map((n) => n.textContent).find((t) => t.startsWith('Sum'));
  return { status, grid, sum, id };
}

it('sums the selection once while typing in it and moving within it', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const entries = [];
  for (let r = 0; r < 200; r++) entries.push({ r, c: 0, cell: { v: 1 } }, { r, c: 1, cell: { f: `A${r + 1}*2` } });
  wb.setCells(id, entries);
  const { status, grid, sum } = mount(wb, { r1: 0, c1: 0, r2: 199, c2: 1 });
  expect(sum()).toBe('Sum: 600');
  const reads = vi.spyOn(wb, 'getValue');
  // Typing into the active cell, then Tab and Enter moving the active cell within the selection.
  grid.editState = { mode: 'type', text: '4' };
  status.refresh();
  grid.editState = { mode: 'type', text: '42' };
  status.refresh();
  grid.editState = null;
  grid.selection = { ...grid.selection, active: { r: 0, c: 1 } };
  status.refresh();
  expect(reads.mock.calls.length).toBeLessThan(10);
  expect(sum()).toBe('Sum: 600');
  status.destroy();
});

it('sums again once the workbook changes or is recalculated', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 1 } }, { r: 1, c: 0, cell: { v: 2 } }]);
  const { status, grid, sum } = mount(wb, { r1: 0, c1: 0, r2: 1, c2: 0 });
  expect(sum()).toBe('Sum: 3');
  wb.setInput(id, 0, 0, '10');
  status.refresh();
  expect(sum()).toBe('Sum: 12');
  grid.selection = { ...S.fromRange({ r1: 0, c1: 0, r2: 2, c2: 0 }), active: { r: 0, c: 0 } };
  grid.range = { r1: 0, c1: 0, r2: 2, c2: 0 };
  wb.setInput(id, 2, 0, '=RAND()');
  status.refresh();
  const first = sum();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  wb.recalculate();
  status.refresh();
  expect(sum()).toBe('Sum: 12.5');
  expect(first).not.toBe(sum());
  status.destroy();
});
