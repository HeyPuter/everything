// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { getLocale, setLocale } from '../src/core/format.js';
import { openQuickRuleDialog } from '../src/ui/condformat-quick.js';
import { openConditionalFormatting, equalValueOf } from '../src/ui/condformat.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
let previousLocale;
beforeEach(() => {
  previousLocale = getLocale();
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  setLocale(previousLocale);
  closeAllModals();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

// Equal To kept what was typed as text, so a number written as the grid reads one but not as a plain
// numeral (1,5 where the decimal mark is a comma, 50%, $1,200) never matched the cells holding it, while
// Greater Than read the same entry as the number. Such an entry is now the number it reads as.
function book(locale) {
  setLocale(locale);
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setInput(id, 0, 0, locale === 'de-DE' ? '1,5' : '1.5');
  wb.setInput(id, 1, 0, '50%');
  wb.setInput(id, 2, 0, '$1,200');
  wb.setInput(id, 3, 0, 'Jan 2024');
  wb.setCells(id, [{ r: 4, c: 0, cell: { v: '25:30', f: null } }]);
  return { wb, id };
}
const painted = (wb, id) => [0, 1, 2, 3, 4].filter((r) => wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0))?.bg);

it.each([['de-DE', '1,5', [0]], ['en-US', '50%', [1]], ['en-US', '$1,200', [2]], ['en-US', '1200', [2]]])('quick Equal To in %s matches %s', (locale, typed, rows) => {
  const { wb, id } = book(locale);
  openQuickRuleDialog({ wb, sheetId: () => id }, 'eq', { r1: 0, c1: 0, r2: 4, c2: 0 });
  const form = [...document.querySelectorAll('form.cfq')].at(-1);
  form.querySelector('input').value = typed;
  form.requestSubmit();
  expect(painted(wb, id)).toEqual(rows);
});

it('the rules manager reads Equal to and Not equal to values the same way', () => {
  const { wb, id } = book('de-DE');
  const { panel } = openConditionalFormatting({ wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 4, c2: 0 }), grid: { focus: vi.fn() } });
  const type = panel.querySelector('select[aria-label="Condition"]');
  type.value = 'eq'; type.dispatchEvent(new Event('change', { bubbles: true }));
  panel.querySelector('input[aria-label="Value"]').value = '1,5';
  panel.querySelector('form').requestSubmit();
  expect(wb.sheet(id).rules[0]).toMatchObject({ type: 'eq', value: 1.5 });
  expect(painted(wb, id)).toEqual([0]);
});

it('keeps text, and entries that read as dates or times, as typed', () => {
  setLocale('en-US');
  for (const text of ['Jan 2024', '25:30', '2024-01-15', 'abc', 'TRUE']) expect(equalValueOf(text)).toBe(text);
  const { wb, id } = book('en-US');
  openQuickRuleDialog({ wb, sheetId: () => id }, 'eq', { r1: 0, c1: 0, r2: 4, c2: 0 });
  const form = [...document.querySelectorAll('form.cfq')].at(-1);
  form.querySelector('input').value = '25:30';
  form.requestSubmit();
  expect(painted(wb, id)).toEqual([4]);
});
