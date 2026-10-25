// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { openChartDialog } from '../src/ui/chartdialog.js';
import { closeAllModals } from '../src/ui/modal.js';

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

const sheet = () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Month', 'Sales', 'Costs'], ['Jan', '1', '10'], ['Feb', '4', '15'], ['Mar', '9', '20'], ['Apr', '16', '30']]
    .forEach((row, r) => row.forEach((value, c) => wb.setInput(id, r, c, value)));
  return { wb, id };
};
const ctxFor = (wb, id, range) => ({ wb, sheetId: () => id, range: () => range, grid: { focus: vi.fn(), selectChart: vi.fn() } });
const field = label => document.querySelector(`[aria-label="${label}"]`);
const check = label => [...document.querySelectorAll('label.check')].find(n => n.textContent === label).querySelector('input');
const pick = (input, value) => { input.value = value; input.dispatchEvent(new Event('change', { bubbles: true })); };
const preview = () => document.querySelector('.chart-preview').innerHTML;

// The Edit chart view offered a trendline checkbox and nothing more: no other kind of fit, and no way to see its equation.
it('inserts a chart with a polynomial trendline whose equation and R² show on the chart', () => {
  const { wb, id } = sheet();
  openChartDialog(ctxFor(wb, id, { r1: 0, c1: 0, r2: 4, c2: 2 }));
  document.querySelector('[data-type="line"]').click();
  expect(field('Order').closest('label').hidden).toBe(true);
  pick(field('Trendline'), 'poly');
  expect(field('Order').closest('label').hidden).toBe(false);
  pick(field('Order'), '2');
  check('Show equation').click();
  check('Show R² value').click();
  // Sales are the squares of the months, counted from 1: the fit is exact.
  expect(preview()).toContain('R² = 1');
  expect(document.querySelector('.chart-preview .chart-trendline-label').textContent).toContain('y = x2');
  document.querySelector('form').requestSubmit();
  const chart = wb.sheet(id).charts[0];
  expect(chart.trendline).toBe(true);
  expect(chart.trendlines).toHaveLength(2);
  for (const t of chart.trendlines) expect(t).toMatchObject({ type: 'poly', order: 2, dispEq: true, dispRSqr: true });
  wb.undo();
  expect(wb.sheet(id).charts).toHaveLength(0);
});

it('asks for a whole period for a moving average', () => {
  const { wb, id } = sheet();
  openChartDialog(ctxFor(wb, id, { r1: 0, c1: 0, r2: 4, c2: 2 }));
  document.querySelector('[data-type="line"]').click();
  pick(field('Trendline'), 'movingAvg');
  expect(check('Show equation').closest('.field').hidden).toBe(true);
  pick(field('Period'), '1.5');
  field('Period').dispatchEvent(new Event('input', { bubbles: true }));
  expect(document.querySelector('.field-error').textContent).toMatch(/period/i);
  document.querySelector('form').requestSubmit();
  expect(wb.sheet(id).charts).toHaveLength(0);
  pick(field('Period'), '3');
  document.querySelector('form').requestSubmit();
  expect(wb.sheet(id).charts[0].trendlines[0]).toMatchObject({ type: 'movingAvg', period: 3 });
});

it('keeps each series\' own trendline when the edit leaves the trendline alone, and removes them all with None', () => {
  const { wb, id } = sheet();
  const chartId = wb.addChart(id, { type: 'line', range: { r1: 0, c1: 0, r2: 4, c2: 2 }, anchor: { r: 6, c: 0 }, trendline: true,
    trendlines: [{ type: 'exp', dispEq: true }, { type: 'log', forward: 2 }] });
  const open = () => openChartDialog(ctxFor(wb, id, wb.chartById(id, chartId).range), { chart: wb.chartById(id, chartId) });
  open();
  expect(field('Trendline').value).toBe('exp');
  expect(check('Show equation').checked).toBe(true);
  field('Title').value = 'Growth';
  document.querySelector('form').requestSubmit();
  expect(wb.chartById(id, chartId).trendlines.map(t => t.type)).toEqual(['exp', 'log']);
  expect(wb.chartById(id, chartId).trendlines[1].forward).toBe(2);
  open();
  pick(field('Trendline'), 'none');
  document.querySelector('form').requestSubmit();
  expect(wb.chartById(id, chartId).trendline).toBe(false);
  expect(wb.chartById(id, chartId).trendlines).toBeUndefined();
});
