// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openConditionalFormatting } from '../src/ui/condformat.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren();
});

// The dialog offers a fill, a text colour and bold, and built the edited rule's style from those three alone: a
// rule from an Excel file that also showed its cells in italic, struck through, underlined, bordered or in a number
// format of its own (12.3K) lost all of that when only its range or condition was changed.
const STYLE = { bg: '#ffc7ce', color: '#9c0006', italic: true, strike: true, underline: true, fmt: 'custom', code: '0.0,"K"', bb: true, bbBorder: { bs: 'dashDot', bc: '#ff0000' } };

function edit(style, change) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.addRule(id, { range: { r1: 0, c1: 0, r2: 4, c2: 0 }, type: 'gt', value: 1000, style });
  openConditionalFormatting({ wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus: vi.fn() } });
  document.querySelector('.names-main').click();
  change?.();
  document.querySelector('form').requestSubmit();
  expect(document.querySelector('.field-error').hidden).toBe(true);
  return wb.sheet(id).rules;
}

it('keeps the rule\'s number format, font lines and borders when only its range changes', () => {
  const rules = edit(STYLE, () => { document.querySelector('[aria-label="Apply to range"]').value = 'A1:A9'; });
  expect(rules).toHaveLength(1);
  expect(rules[0].range).toEqual({ r1: 0, c1: 0, r2: 8, c2: 0 });
  expect(rules[0].style).toEqual(STYLE);
});

it('keeps them when the condition changes, and still takes the bold the form sets', () => {
  const rules = edit({ ...STYLE, bold: false }, () => {
    document.querySelector('[aria-label="Value"]').value = '2000';
    [...document.querySelectorAll('label.find-option')].find((label) => label.textContent === 'Bold').querySelector('input').click();
  });
  expect(rules[0].value).toBe(2000);
  expect(rules[0].style).toEqual({ ...STYLE, bold: true });
});

it('keeps a rule\'s "not bold" unless the box is ticked', () => {
  expect(edit({ ...STYLE, bold: false })[0].style).toEqual({ ...STYLE, bold: false });
});

it('drops the extras when the rule becomes a colour scale', () => {
  const rules = edit(STYLE, () => {
    const condition = document.querySelector('[aria-label="Condition"]');
    condition.value = 'scale';
    condition.dispatchEvent(new Event('change'));
  });
  expect(rules[0].type).toBe('scale');
  expect(rules[0].style).toEqual({});
});

it('records nothing when such a rule is saved untouched', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.addRule(id, { range: { r1: 0, c1: 0, r2: 4, c2: 0 }, type: 'gt', value: 1000, style: STYLE });
  const before = wb.undoLabels();
  openConditionalFormatting({ wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 0, c2: 0 }), grid: { focus: vi.fn() } });
  document.querySelector('.names-main').click();
  document.querySelector('form').requestSubmit();
  expect(wb.undoLabels()).toEqual(before);
  expect(wb.sheet(id).rules[0].style).toEqual(STYLE);
});
