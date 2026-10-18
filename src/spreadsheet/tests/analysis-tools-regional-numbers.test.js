// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { setLocale } from '../src/core/format.js';
import { openAnalysisTool } from '../src/ui/analysis-tools.js';
import { closeAllModals } from '../src/ui/modal.js';

vi.mock('../src/ui/toast.js', () => ({ toast: vi.fn() }));
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  setLocale('de-DE');
});
afterEach(() => { setLocale('en-US'); closeAllModals(); vi.unstubAllGlobals(); document.body.replaceChildren(); });

const panel = () => [...document.querySelectorAll('.modal-root:not(.closing) .modal-panel')].at(-1);
const field = (label) => panel().querySelector(`[aria-label="${label}"]`);
const check = (text) => [...panel().querySelectorAll('label.check')].find((l) => l.textContent.trim() === text).querySelector('input');
const submit = () => panel().querySelector('form').requestSubmit();
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const error = () => panel()?.querySelector('.field-error')?.textContent || '';

function setup(rows) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  wb.setCells(id, rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v } }))));
  const ctx = { wb, sheetId: () => id, range: () => ({ r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }), grid: { focus: vi.fn(), setSelection: vi.fn() }, run: vi.fn() };
  return { wb, id, ctx };
}
const toRange = () => {
  check('Output range').checked = true;
  check('Output range').dispatchEvent(new Event('change'));
  field('Output range').value = 'D1';
};

it('shows its numbers in the regional format and reads them back with a decimal comma', async () => {
  const { wb, id, ctx } = setup([[4], [8], [6], [10], [7]]);
  openAnalysisTool(ctx, 'descriptive');
  check('Confidence level for mean (%)').checked = true;
  check('Confidence level for mean (%)').dispatchEvent(new Event('change'));
  expect(field('Confidence level for mean (%) value').value).toBe('95');
  field('Confidence level for mean (%) value').value = '97,5';
  toRange();
  submit();
  await settle();
  expect(error()).toBe('');
  expect(wb.getValue(id, 13, 3)).toBe('Count');
  expect(wb.getValue(id, 14, 3)).toBe('Confidence Level(97.5%)');
});

it('takes an alpha and a damping factor written with a decimal comma', async () => {
  const { wb, id, ctx } = setup([[1, 2], [3, 5], [5, 4], [7, 9]]);
  openAnalysisTool(ctx, 'anova1');
  expect(field('Alpha').value).toBe('0,05');
  field('Alpha').value = '0,1';
  toRange();
  submit();
  await settle();
  expect(error()).toBe('');
  expect(wb.getValue(id, 0, 3)).toBe('Anova: Single Factor');

  const two = setup([[3], [5], [4], [9], [6]]);
  openAnalysisTool(two.ctx, 'smoothing');
  field('Damping factor').value = '0,5';
  check('Output range').checked = true;
  check('Output range').dispatchEvent(new Event('change'));
  field('Output range').value = 'C1';
  submit();
  await settle();
  expect(error()).toBe('');
  expect(two.wb.getValue(two.id, 2, 2)).toBe(4); // 0,5 × 5 + 0,5 × 3
});

it('takes a forecast confidence interval written with a decimal comma', async () => {
  const { openForecastSheet } = await import('../src/ui/forecast-sheet.js');
  const wb = new Workbook();
  const id = wb.activeSheetId;
  const rows = [['Month', 'Sales'], ...Array.from({ length: 12 }, (_, i) => [45292 + 31 * i, 100 + 7 * i + (i % 3)])];
  wb.setCells(id, rows.flatMap((row, r) => row.map((v, c) => ({ r, c, cell: { v, ...(r && !c ? { s: { fmt: 'date' } } : {}) } }))));
  const range = { r1: 0, c1: 0, r2: rows.length - 1, c2: 1 };
  openForecastSheet({ wb, sheetId: () => id, range: () => range, dataRange: () => range, grid: { focus: vi.fn() } });
  const conf = panel().querySelector('[aria-label="Confidence Interval"]');
  expect(conf.value).toBe('95%');
  conf.value = '97,5%';
  submit();
  expect(error()).toBe('');
  const sheet = wb.sheets.at(-1);
  expect(sheet.id).not.toBe(id);
  expect(wb.getCell(sheet.id, 13, 3)?.f).toContain(',0.975,');
});
