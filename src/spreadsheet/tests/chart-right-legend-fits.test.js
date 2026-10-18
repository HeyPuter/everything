import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch } from '../src/core/chart-design.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// A legend at the right (Quick Layout 1, 6 or 7, or Legend ▸ Right) wrote each series name on one line from
// its key, so a name longer than the legend's column ran off the chart's edge and was cut: "Revenue (thousa".
// Names now wrap within the room left to the edge, and a single word too long for it is shortened with "…".
// A pie's legend did the same with its category names.
const estimate = (text, size) => [...text].length * .56 * size; // the renderer's estimate without a canvas
function legend(names, subtype = 'columnClustered') {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Quarter', ...names], ['Q1', '12', '8', '3'], ['Q2', '15', '9', '4'], ['Q3', '11', '7', '5'], ['Q4', '18', '10', '6']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const made = normalizeChart({ ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: names.length }, subtype), id: 'c' });
  const chart = normalizeChart({ ...made, ...chartElementPatch(made, 'legend', 'right') });
  const doc = new JSDOM(renderChartSvg(chartData(wb, id, chart), chart, 480, 288)).window.document;
  return [...doc.querySelectorAll('[data-el="legend"] text')].map((n) => ({ text: n.textContent, x: +n.getAttribute('x'), y: +n.getAttribute('y'), size: +n.getAttribute('font-size') }));
}

it.each(['columnClustered', 'line'])('keeps every %s legend name inside the chart', (subtype) => {
  const texts = legend(['Revenue from subscriptions', 'Costs', 'Subscriptionrevenueworldwide'], subtype);
  for (const t of texts) expect(t.x + estimate(t.text, t.size)).toBeLessThanOrEqual(480);
  expect(texts.map((t) => t.text)).toContain('Costs');
  expect(texts.some((t) => t.text.endsWith('…'))).toBe(true);
  expect(texts.length).toBeGreaterThan(3); // the long name took a second line
  // Wrapped lines stack: no two lines share a baseline.
  expect(new Set(texts.map((t) => t.y)).size).toBe(texts.length);
});

it('keeps every pie legend name inside the chart', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Region', 'Revenue'], ['North America and the Caribbean', '12'], ['Europe, Middle East and Africa', '9'], ['Asia', '5']]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const made = normalizeChart({ ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'pie'), id: 'c' });
  const chart = normalizeChart({ ...made, ...chartElementPatch(made, 'legend', 'right') });
  const doc = new JSDOM(renderChartSvg(chartData(wb, id, chart), chart, 480, 288)).window.document;
  const texts = [...doc.querySelectorAll('[data-el="legend"] text')].map((n) => ({ text: n.textContent, x: +n.getAttribute('x'), y: +n.getAttribute('y'), size: +n.getAttribute('font-size') }));
  expect(texts.length).toBeGreaterThan(3);
  for (const t of texts) expect(t.x + estimate(t.text, t.size)).toBeLessThanOrEqual(480);
  expect(new Set(texts.map((t) => t.y)).size).toBe(texts.length);
  expect(texts.at(-1).text).toBe('Asia');
});

it('leaves names that fit on one line', () => {
  expect(legend(['North', 'South', 'East']).map((t) => t.text)).toEqual(['North', 'South', 'East']);
});
