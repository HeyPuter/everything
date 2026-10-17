// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { getLocale, setLocale } from '../src/core/format.js';
import { openQuickRuleDialog } from '../src/ui/condformat-quick.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let previousLocale;
beforeEach(() => {
  previousLocale = getLocale();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  setLocale(previousLocale);
  closeAllModals();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function open(locale, key) {
  setLocale(locale);
  const wb = new Workbook();
  const id = wb.activeSheetId;
  [1.5, 2.5, 3.5].forEach((v, r) => wb.setCells(id, [{ r, c: 0, cell: { v, f: null } }]));
  openQuickRuleDialog({ wb, sheetId: () => id }, key, { r1: 0, c1: 0, r2: 2, c2: 0 });
  const form = [...document.querySelectorAll('form.cfq')].at(-1);
  const inputs = [...form.querySelectorAll('input')];
  const error = form.querySelector('[role="alert"]');
  return { wb, id, inputs, error, submit: () => form.requestSubmit() };
}

// The quick Greater Than, Less Than and Between dialogs suggested 2.5 to a user whose decimal mark is a
// comma, and refused 2,4 as no number. They now write and read numbers as the grid and the rules manager do.
it.each([
  ['de-DE', '2,5', '2,4'],
  ['en-US', '2.5', '2.4'],
])('Greater Than suggests and reads numbers in the %s locale', (locale, suggested, typed) => {
  const { wb, id, inputs, error, submit } = open(locale, 'gt');
  expect(inputs[0].value).toBe(suggested);
  inputs[0].value = typed;
  submit();
  expect(error.hidden).toBe(true);
  expect(wb.sheet(id).rules).toHaveLength(1);
  expect(wb.sheet(id).rules[0]).toMatchObject({ type: 'gt', value: 2.4 });
});

it('Between reads both numbers with a comma decimal mark', () => {
  const { wb, id, inputs, submit } = open('de-DE', 'between');
  expect(inputs.map((i) => i.value)).toEqual(['1,5', '3,5']);
  inputs[0].value = '1.000,5';
  inputs[1].value = '2,25';
  submit();
  expect(wb.sheet(id).rules[0]).toMatchObject({ type: 'between', value: 1000.5, value2: 2.25 });
});

it('still refuses text and a count that is not whole', () => {
  const gt = open('de-DE', 'gt');
  gt.inputs[0].value = 'abc';
  gt.submit();
  expect(gt.error.textContent).toBe('Enter a number');
  closeAllModals();
  const top = open('de-DE', 'top');
  expect(top.inputs[0].value).toBe('10');
  top.inputs[0].value = '2,5';
  top.submit();
  expect(top.error.textContent).toBe('Enter a whole number from 1 to 1000');
  top.inputs[0].value = '3';
  top.submit();
  expect(top.wb.sheet(top.id).rules[0]).toMatchObject({ type: 'top', value: 3 });
});
