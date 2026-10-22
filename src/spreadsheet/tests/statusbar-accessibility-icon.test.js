// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import * as S from '../src/core/selection.js';
import { createStatusBar } from '../src/ui/statusbar.js';
import { icon } from '../src/ui/icons.js';

// The status bar's accessibility status drew its figure with a green check beside "Review suggested", which
// said all was well while the words said otherwise. Its icon now carries a warning while a review is suggested.
const drawn = (name) => { const span = document.createElement('span'); span.innerHTML = icon(name, 15); return span.innerHTML; };
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('shows a warning on its icon while a review is suggested, and the check once none is', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, [{ r: 0, c: 0, cell: { v: 'Title' } }]);
  wb.mergeCells(id, { r1: 0, c1: 0, r2: 0, c2: 2 });
  const range = { r1: 0, c1: 0, r2: 0, c2: 0 };
  let refresh = null;
  const status = createStatusBar({ wb, sheetId: () => id, subscribe: (fn) => { refresh = fn; return () => {}; }, grid: { range, selection: S.fromRange(range), zoom: 1 }, activeCell: () => null });
  document.querySelector('#app').append(status.el);
  vi.advanceTimersByTime(1);
  const button = status.el.querySelector('.status-a11y');
  expect(button.textContent).toBe('Accessibility: Review suggested');
  expect(button.querySelector('.status-a11y-icon').innerHTML).toBe(drawn('accessibilityReview'));
  expect(icon('accessibilityReview', 15)).not.toBe(drawn('accessibility'));
  wb.undo();
  refresh();
  vi.advanceTimersByTime(500);
  expect(button.textContent).toBe('Accessibility: No issues');
  expect(button.querySelector('.status-a11y-icon').innerHTML).toBe(drawn('accessibility'));
  status.destroy();
});
