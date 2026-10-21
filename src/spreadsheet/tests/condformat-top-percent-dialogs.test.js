// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { parseRange } from '../src/core/cell.js';
import { openConditionalFormatting } from '../src/ui/condformat.js';
import { conditionalFormattingItems, openQuickRuleDialog, quickRule } from '../src/ui/condformat-quick.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  document.body.innerHTML = '<div id="app"></div>';
});
afterEach(() => {
  closeAllModals();
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const book = () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  for (let r = 0; r < 20; r++) wb.setInput(id, r, 0, String(r + 1));
  return { wb, id };
};
const painted = (wb, id) => Array.from({ length: 20 }, (_, r) => r).filter((r) => wb.conditionalStyle(id, r, 0, wb.getValue(id, r, 0))?.bg).map((r) => r + 1);

// Quick Analysis' "Top 10%" tile opened the Top 10 Items dialog, and the Top/Bottom Rules menu had no percent
// rules at all. Excel's menu offers Top 10% and Bottom 10% beside the item counts, and so does this one now; the
// rules manager can make and edit a percentage rule too.
it('offers Top 10% and Bottom 10% quick rules that rank a share of the values', () => {
  const { wb, id } = book();
  const run = vi.fn();
  const topBottom = conditionalFormattingItems(run).find((item) => item.label === 'Top/Bottom Rules').submenu;
  expect(topBottom.map((item) => item.label)).toEqual(['Top 10 Items…', 'Top 10%…', 'Bottom 10 Items…', 'Bottom 10%…', 'Above Average…', 'Below Average…']);
  topBottom[3].onSelect();
  expect(run).toHaveBeenCalledWith('quickRule', 'bottomPercent');
  expect(quickRule(parseRange('A1:A20'), 'topPercent', { value: 10 })).toMatchObject({ type: 'top', value: 10, percent: true });

  const modal = openQuickRuleDialog({ wb, sheetId: () => id, grid: { focus: vi.fn() } }, 'topPercent', parseRange('A1:A20'));
  const input = modal.panel.querySelector('input');
  input.value = '150';
  modal.panel.querySelector('form').requestSubmit();
  expect(modal.panel.textContent).toContain('Enter a whole number from 1 to 100');
  input.value = '15';
  modal.panel.querySelector('form').requestSubmit();
  expect(painted(wb, id)).toEqual([18, 19, 20]);
});

it('makes and edits a percentage rule in the rules manager', () => {
  const { wb, id } = book();
  const { panel } = openConditionalFormatting({ wb, sheetId: () => id, range: () => parseRange('A1:A20'), grid: { focus: vi.fn() } });
  const condition = panel.querySelector('[aria-label="Condition"]');
  condition.value = 'bottom'; condition.dispatchEvent(new Event('change'));
  const percent = [...panel.querySelectorAll('input[type="checkbox"]')].find((box) => box.closest('label')?.textContent === '% of the values');
  expect(percent.closest('label').hidden).toBe(false);
  panel.querySelector('[aria-label="Value"]').value = '10';
  percent.checked = true;
  panel.querySelector('form').requestSubmit();
  expect(wb.sheet(id).rules[0]).toMatchObject({ type: 'bottom', value: 10, percent: true });
  expect(painted(wb, id)).toEqual([1, 2]);
  expect(panel.querySelector('.names-row').textContent).toContain('Bottom 10%');
  panel.querySelector('.names-main').click();
  expect(percent.checked).toBe(true);
  percent.checked = false;
  panel.querySelector('form').requestSubmit();
  expect(wb.sheet(id).rules[0].percent).toBeUndefined();
  expect(painted(wb, id)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
});
