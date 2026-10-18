// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';
import { openConditionalFormatting } from '../src/ui/condformat.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('matchMedia', () => ({ matches: true })); document.body.innerHTML = '<div id="app"></div>'; });
afterEach(() => { setLocale('en-US'); closeAllModals(); vi.runAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

// A date typed into Greater than (3/15/2024) is stored as its serial, which the rules list and the form showed
// as such: "Greater than 45366". Over cells showing dates the number is written as a date that reads back the
// same in every regional format; over numbers it stays a number.
it.each(['en-US', 'de-DE'])('lists and edits a date condition as a date in %s', (locale) => {
  setLocale(locale);
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, '2024-03-14'); wb.setInput(id, 1, 0, '2024-03-16 12:30'); wb.setInput(id, 0, 2, '45366');
  const ctx = { wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: 1, c2: 0 }), grid: { focus: vi.fn() } };
  wb.addRule(id, { type: 'gt', value: 45366, range: { r1: 0, c1: 0, r2: 1, c2: 0 }, style: { bg: '#ffcc00' } });
  wb.addRule(id, { type: 'between', value: 45366, value2: 45367.5, range: { r1: 0, c1: 0, r2: 1, c2: 0 }, style: { bg: '#ffcc00' } });
  wb.addRule(id, { type: 'gt', value: 45366, range: { r1: 0, c1: 2, r2: 1, c2: 2 }, style: { bg: '#ffcc00' } });
  const { panel } = openConditionalFormatting(ctx);
  const rows = [...panel.querySelectorAll('.names-ref')].map(e => e.textContent);
  expect(rows).toContain('Greater than 2024-03-15');
  expect(rows).toContain('Between 2024-03-15 and 2024-03-16 12:00:00');
  expect(rows).toContain('Greater than 45366');
  panel.querySelectorAll('.names-main')[rows.indexOf('Greater than 2024-03-15')].click();
  const value = panel.querySelector('input[aria-label="Value"]');
  expect(value.value).toBe('2024-03-15');
  panel.querySelector('form').requestSubmit();
  expect(wb.sheet(id).rules.find(r => r.type === 'gt' && r.range.c1 === 0).value).toBe(45366);
});
