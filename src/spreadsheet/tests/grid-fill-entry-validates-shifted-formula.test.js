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

function setup() {
  const wb = new Workbook(), id = wb.activeSheetId;
  ['5', '50', '7'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.addValidation(id, { type: 'whole', operator: 'between', min: 1, max: 10, range: { r1: 0, c1: 1, r2: 2, c2: 1 }, strict: true });
  wb.clearHistory();
  grid = createGrid({ wb, sheetId: id, validate: (r, c, t, origin) => { const v = wb.validateInput(id, r, c, t, origin); return { ...v, strict: v.rule?.strict !== false }; } });
  document.querySelector('#app').append(grid.el);
  return { wb, id };
}

// Ctrl+Enter writes a typed formula into every selected cell with its references moved, B2 taking =A2*1 from
// =A1*1 typed in B1. The validation rules were checked against the formula as typed in every cell, so a
// whole number from 1 to 10 under B1:B3 let in B2's 50 (A1 was 5), and refused nothing it should have.
it('checks each cell Ctrl+Enter fills against the formula that cell receives', () => {
  const { wb, id } = setup();
  grid.setSelection(S.fromRange({ r1: 0, c1: 1, r2: 2, c2: 1 }));
  grid.beginEdit({ text: '=A1*1', mode: 'type' });
  expect(grid.commitEdit({ fillSelection: true })).toBe(false);
  expect([0, 1, 2].map(r => wb.getValue(id, r, 1))).toEqual([null, null, null]);
  expect(document.querySelector('.modal-panel')).not.toBeNull();
});

it('lets the fill through when every moved formula meets the rule', () => {
  const { wb, id } = setup();
  wb.setInput(id, 1, 0, '6');
  grid.setSelection(S.fromRange({ r1: 0, c1: 1, r2: 2, c2: 1 }));
  grid.beginEdit({ text: '=A1*1', mode: 'type' });
  expect(grid.commitEdit({ fillSelection: true })).toBe(true);
  expect([0, 1, 2].map(r => wb.getValue(id, r, 1))).toEqual([5, 6, 7]);
  expect(wb.validateInput(id, 1, 1, '=A1*1', { r: 0, c: 1 }).ok).toBe(true);
  expect(wb.validateInput(id, 1, 1, '=A1*1').ok).toBe(true);
  wb.setInput(id, 1, 0, '60');
  expect(wb.validateInput(id, 1, 1, '=A1*1', { r: 0, c: 1 }).ok).toBe(false);
});
