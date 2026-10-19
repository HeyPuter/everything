// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openValidationManager } from '../src/ui/validation.js';
import { relativeListSource } from '../src/core/validation.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

// A dependent dropdown made in the Data validation dialog, a list from =INDIRECT(A2) over B2:B5, read A2 on every
// row: with A3 = "Veg" the dropdown in B3 still offered the fruit and refused Leek. Excel reads a list source
// relative to each cell, so B3's list is INDIRECT(A3); a rule made in the dialog with a function over a relative
// reference now does the same, while a bare range typed as the options stays fixed, as it always has.
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});

function book() {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const sheet = wb.sheet(id).name;
  ['Fruit', 'Apple', 'Pear'].forEach((v, r) => wb.setInput(id, r, 5, v));
  ['Veg', 'Leek', 'Kale', 'Okra'].forEach((v, r) => wb.setInput(id, r, 6, v));
  wb.defineName('Fruit', `${sheet}!$F$2:$F$3`);
  wb.defineName('Veg', `${sheet}!$G$2:$G$4`);
  wb.setInput(id, 1, 0, 'Fruit');
  wb.setInput(id, 2, 0, 'Veg');
  return { wb, id };
}

function addListRule(wb, id, range, source) {
  const { panel } = openValidationManager({ wb, sheetId: () => id, range: () => range });
  panel.querySelector('[aria-label="Type"]').value = 'list';
  panel.querySelector('[aria-label="Type"]').dispatchEvent(new Event('change'));
  panel.querySelector('[aria-label="List options"]').value = source;
  panel.querySelector('form').requestSubmit();
}

it('makes each row of a dependent dropdown read its own category', () => {
  const { wb, id } = book();
  addListRule(wb, id, { r1: 1, c1: 1, r2: 4, c2: 1 }, '=INDIRECT(A2)');
  const rule = wb.validationAt(id, 2, 1);
  expect(wb.listOptionsFor(id, rule, { r: 1, c: 1 })).toEqual(['Apple', 'Pear']);
  expect(wb.listOptionsFor(id, rule, { r: 2, c: 1 })).toEqual(['Leek', 'Kale', 'Okra']);
  expect(wb.validateInput(id, 2, 1, 'Leek').ok).toBe(true);
  expect(wb.validateInput(id, 2, 1, 'Apple').ok).toBe(false);
});

it('keeps a typed range of options fixed for every cell', () => {
  const { wb, id } = book();
  addListRule(wb, id, { r1: 1, c1: 2, r2: 4, c2: 2 }, '=F2:F3');
  const rule = wb.validationAt(id, 3, 2);
  expect(wb.listOptionsFor(id, rule, { r: 3, c: 2 })).toEqual(['Apple', 'Pear']);
});

it('tells a relative formula source from a fixed one', () => {
  expect(relativeListSource('=INDIRECT(A2)')).toBe(true);
  expect(relativeListSource('=OFFSET($F$1,0,MATCH(A2,$F$1:$G$1,0)-1,3)')).toBe(true);
  expect(relativeListSource('=INDIRECT($A$2)')).toBe(false);
  expect(relativeListSource('=A2:A9')).toBe(false);
  expect(relativeListSource('Yes, No')).toBe(false);
});
