// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openAdvancedFilter } from '../src/ui/advanced-filter.js';
import { closeAllModals } from '../src/ui/modal.js';

// The Advanced Filter's two actions were radio buttons of two groups of their own (each named afresh), so
// choosing "Copy to another location" left "Filter the list, in-place" ticked as well, choosing in-place again
// could not untick Copy (the filter went on copying, its Copy to field open), and the arrow keys did not move
// between them. They are now one group, as their fieldset says.
vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => { closeAllModals(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

it('makes the in-place and copy actions one group of radio buttons', () => {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [['Name', 'Qty'], ['a', 1], ['b', 2]].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  openAdvancedFilter({ wb, sheetId: () => id, dataRange: () => ({ r1: 0, c1: 0, r2: 2, c2: 1 }), resolveRange: () => null, grid: { focus() {} } });
  const panel = document.querySelector('.modal-panel');
  const radio = (text) => [...panel.querySelectorAll('label')].find((l) => l.textContent.includes(text)).querySelector('input');
  const inPlace = radio('in-place');
  const copy = radio('Copy to another location');
  const copyTo = panel.querySelector('[id^="af-copy-to"]');
  expect(inPlace.name).toBe(copy.name);
  copy.click();
  expect([inPlace.checked, copy.checked, copyTo.disabled]).toEqual([false, true, false]);
  inPlace.click();
  expect([inPlace.checked, copy.checked, copyTo.disabled]).toEqual([true, false, true]);
});
