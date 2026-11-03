// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createGrid } from '../src/ui/grid.js';
import { Workbook } from '../src/core/workbook.js';
import { closeAllModals } from '../src/ui/modal.js';
import * as S from '../src/core/selection.js';

let grid;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', fn => setTimeout(fn, 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ measureText: t => ({ width: t.length * 7 }), font: '' });
  Element.prototype.scrollTo = () => {};
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { grid?.destroy(); grid = null; closeAllModals(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// Ctrl+Enter skips the rows a filter hides and the covered cells of a merged block: it writes nothing there.
// The rules were still checked in those cells first, so a strict rule on a filtered-out row (or under a merged
// block) refused a fill that would never have touched it.
it('checks only the cells Ctrl+Enter writes: not the rows a filter hides, nor the cells under a merge', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['Kind', 'a', 'b', 'a', 'a'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.setFilterRange(id, { r1: 0, c1: 0, r2: 4, c2: 0 });
  wb.setFilterCriteria(id, 0, { values: ['a'] });
  expect(wb.sheet(id).filterHidden.has(2)).toBe(true);
  wb.addValidation(id, { type: 'whole', operator: 'between', min: 1, max: 10, range: { r1: 2, c1: 1, r2: 2, c2: 1 }, strict: true });
  wb.mergeCells(id, { r1: 6, c1: 1, r2: 7, c2: 1 });
  wb.addValidation(id, { type: 'whole', operator: 'between', min: 1, max: 10, range: { r1: 7, c1: 1, r2: 7, c2: 1 }, strict: true });
  grid = createGrid({ wb, sheetId: id, validate: (r, c, t, origin) => { const v = wb.validateInput(id, r, c, t, origin); return { ...v, strict: v.rule?.strict !== false }; } });
  document.querySelector('#app').append(grid.el);
  grid.setSelection(S.fromRange({ r1: 1, c1: 1, r2: 7, c2: 1 }));
  grid.beginEdit({ text: '50', mode: 'type' });
  expect(grid.commitEdit({ fillSelection: true })).toBe(true);
  expect(document.querySelector('.modal-panel')).toBeNull();
  expect([1, 2, 3, 4, 5, 6, 7].map((r) => wb.getValue(id, r, 1))).toEqual([50, null, 50, 50, 50, 50, null]);
});
