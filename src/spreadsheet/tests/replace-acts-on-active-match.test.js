// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFindBar } from '../src/ui/findbar.js';
import { Workbook } from '../src/core/workbook.js';

// Replace rewrote the match Find had last shown even after the active cell had been moved off it with a click on
// the sheet: a cell out of sight changed, and the selection jumped to the next match. As in Excel, Replace now
// rewrites the match under the active cell, and from anywhere else it first finds the next match.
let bar;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { bar?.destroy(); vi.clearAllTimers(); vi.useRealTimers(); document.body.replaceChildren(); });

function setup() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 5, 0, 'Target');
  wb.setInput(id, 30, 0, 'Target');
  const grid = { active: { r: 0, c: 0 }, range: { r1: 0, c1: 0, r2: 0, c2: 0 }, setHighlights: vi.fn(), setSelection: vi.fn((s) => { grid.active = s.active; }), focus: vi.fn() };
  bar = createFindBar({ wb, grid, sheetId: () => id, activeCell: () => null, announce: vi.fn(), subscribe: () => vi.fn() });
  document.body.append(bar.el);
  bar.open({ replace: true });
  const query = bar.el.querySelector('[aria-label="Find"]');
  query.value = 'Target'; query.dispatchEvent(new Event('input'));
  vi.advanceTimersByTime(150);
  bar.el.querySelector('[aria-label="Replace with"]').value = 'Done';
  const replace = [...bar.el.querySelectorAll('button')].find((b) => b.textContent === 'Replace');
  return { wb, id, grid, replace };
}

it('finds the next match from the active cell before replacing, once the active cell has moved off the match', () => {
  const { wb, id, grid, replace } = setup();
  expect(grid.active).toEqual({ r: 5, c: 0 });
  grid.active = { r: 20, c: 3 }; // a click on the sheet
  replace.click();
  expect(wb.getValue(id, 5, 0)).toBe('Target');
  expect(wb.getValue(id, 30, 0)).toBe('Target');
  expect(grid.active).toEqual({ r: 30, c: 0 });
  replace.click();
  expect(wb.getValue(id, 30, 0)).toBe('Done');
  expect(wb.getValue(id, 5, 0)).toBe('Target');
  expect(grid.active).toEqual({ r: 5, c: 0 });
});

it('replaces the match under the active cell, even one stepped to by clicking it', () => {
  const { wb, id, grid, replace } = setup();
  grid.active = { r: 30, c: 0 };
  replace.click();
  expect(wb.getValue(id, 30, 0)).toBe('Done');
  expect(wb.getValue(id, 5, 0)).toBe('Target');
});
