import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// A scatter chart over names and numbers (Insert ▸ Scatter on "Name | Score"), or a file's scatter
// series saved without x values, drew empty axes running 0 to 1 and no points. Excel plots such a
// series at x = 1, 2, 3…; so does the chart now.
const points = (wb, chart) => {
  const doc = new JSDOM(renderChartSvg(chartData(wb, wb.activeSheetId, chart), chart, 480, 300)).window.document;
  return {
    marks: [...doc.querySelectorAll('circle[data-el="series"]')].map(n => ({ x: +n.getAttribute('cx'), y: +n.getAttribute('cy') })),
    line: doc.querySelector('path[data-el="series"]')?.getAttribute('d') || '',
    x: [...doc.querySelectorAll('[data-el="xAxis"]')].map(n => n.textContent).filter(Boolean),
  };
};

it('plots a scatter series beside text labels at 1, 2, 3', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Name', 'Score'], ['Ann', '2'], ['Bob', '5'], ['Cy', '8']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chart = normalizeChart({ ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'scatter'), id: 's' });
  const { marks, x } = points(wb, chart);
  expect(marks).toHaveLength(3);
  expect(marks[0].x).toBeLessThan(marks[1].x);
  expect(marks[1].x - marks[0].x).toBeCloseTo(marks[2].x - marks[1].x, 1);
  expect(marks[0].y).toBeGreaterThan(marks[2].y);
  expect(x).toContain('3.0');
  const lines = normalizeChart({ ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'scatterLines'), id: 'l' });
  expect(points(wb, lines).line).toMatch(/^M [\d.]+ [\d.]+ L [\d.]+ [\d.]+ L [\d.]+ [\d.]+$/);
});

it('plots a file\'s scatter series saved without x values', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  const made = newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'scatter');
  const chart = normalizeChart({ ...made, id: 'f', sourceRefs: [{ name: 'Y', literal: { values: [4, 1, 6, 3] } }] });
  expect(points(wb, chart).marks).toHaveLength(4);
});

it('keeps the x values a scatter series has', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['X', 'Y'], ['10', '2'], ['20', '5'], ['40', '8']].forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chart = normalizeChart({ ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'scatter'), id: 's' });
  const { marks, x } = points(wb, chart);
  expect(marks).toHaveLength(3);
  expect((marks[2].x - marks[1].x) / (marks[1].x - marks[0].x)).toBeCloseTo(2, 2);
  expect(x).toContain('40');
});
