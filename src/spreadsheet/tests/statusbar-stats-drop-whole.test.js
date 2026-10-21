// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { createStatusBar } from '../src/ui/statusbar.js';
import { stylesheet, declared } from './helpers/css.js';

// Where the bar was too narrow for the selection's statistics (an upright tablet, a window with the assistant open)
// they were cut off at its edge, mid-number: a Sum of 607.5 read "Sum: 60". Statistics that do not fit now leave
// the bar whole, the first of them (Average) first, as in Excel: they are laid out from the right, the Sum first,
// and those that wrap past the bar's one line are out of sight. The order they are read in is unchanged.
beforeEach(() => {
  localStorage.setItem('spreadsheet:status-bar', JSON.stringify({ min: true, max: true, numCount: true }));
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); localStorage.clear(); });

it('lays the statistics out from the Sum leftward on one line, keeping their reading order', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [13.5, 27, 40.5, 54, 67.5].forEach((v, r) => wb.setInput(id, r, 1, String(v)));
  const range = { r1: 0, c1: 1, r2: 4, c2: 1 };
  const status = createStatusBar({ wb, sheetId: () => id, subscribe: () => () => {}, grid: { range, selection: { ...S.fromRange(range), active: { r: 0, c: 1 } }, zoom: 1 } });
  document.querySelector('#app').append(status.el);
  const stats = [...status.el.querySelectorAll('.status-right .status-stat')];
  expect(stats.map((n) => n.textContent.split(':')[0])).toEqual(['Average', 'Count', 'Numerical Count', 'Minimum', 'Maximum', 'Sum']);
  const order = stats.map((n) => Number(n.style.order));
  expect(order).toEqual([...order].sort((a, b) => b - a));
  expect(order.at(-1)).toBeLessThan(order[0]);
  status.destroy();
  const css = declared(stylesheet('editor.css'), '.status-right');
  expect(css['flex-direction']).toBe('row-reverse');
  expect(css['flex-wrap']).toBe('wrap');
  expect(css['max-height']).toBe('1lh');
  expect(css.overflow).toBe('hidden');
});
