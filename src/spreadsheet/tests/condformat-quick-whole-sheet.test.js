// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openQuickRuleDialog } from '../src/ui/condformat-quick.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// The quick rule dialogs suggest a value from the numbers selected (their average, or their lowest and highest
// for Between) and read them cell by cell over every coordinate of the selection: with A:Z selected, Highlight
// Cells Rules ▸ Between froze the tab for seven seconds, and over the whole sheet for about an hour. They now read
// only the cells that hold something, spilled results included.
it('suggests values over whole columns and the whole sheet at once', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  ['10', '20', '30'].forEach((v, r) => wb.setInput(id, r, 0, v));
  wb.setInput(id, 0, 3, '=SEQUENCE(2,1,100,100)');
  const ctx = { wb, sheetId: () => id, grid: null };
  // A whole column: a million coordinates, of which three hold numbers.
  const read = vi.spyOn(wb, 'getValue');
  openQuickRuleDialog(ctx, 'gt', { r1: 0, c1: 0, r2: 1048575, c2: 0 });
  expect(read.mock.calls.length).toBeLessThan(100);
  expect(document.querySelector('.cfq-row input').value).toBe('20');
  closeAllModals();
  const started = performance.now();
  openQuickRuleDialog(ctx, 'between', { r1: 0, c1: 0, r2: 1048575, c2: 16383 });
  expect(performance.now() - started).toBeLessThan(1000);
  const [low, high] = [...document.querySelectorAll('.cfq-row input')].slice(-2).map((input) => input.value);
  expect([low, high]).toEqual(['10', '200']);
});
