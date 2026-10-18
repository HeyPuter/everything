import { expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

// A chart inserted over percentages, prices or dates labelled its value axis with bare numbers
// (0.05, 0.10 … for 5%, 10%; 1,000 for $1,000; 45.3K for a date), because an axis without a number
// format of its own ignored the cells' format. Like Excel's "Linked to source", it now reads them.
function axisTexts(values, subtype = 'columnClustered', patch = {}) {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Item'); wb.setInput(id, 0, 1, 'Value'); wb.setInput(id, 0, 2, 'Other');
  values.forEach((v, i) => { wb.setInput(id, i + 1, 0, ['North', 'South', 'East'][i]); wb.setInput(id, i + 1, 1, v); wb.setInput(id, i + 1, 2, String(i + 1)); });
  const c2 = patch.secondaryAxis ? 2 : 1;
  const made = newExcelChart(wb, id, { r1: 0, c1: 0, r2: values.length, c2 }, subtype);
  const chart = normalizeChart({ ...made, id: 'c', ...patch, appearance: { ...made.appearance, ...patch.appearance } });
  const doc = new JSDOM(renderChartSvg(chartData(wb, id, chart), chart, 480, 300)).window.document;
  return {
    y: [...doc.querySelectorAll('[data-el="yAxis"]')].map(n => n.textContent),
    y2: [...doc.querySelectorAll('[data-el="y2Axis"]')].map(n => n.textContent),
    x: [...doc.querySelectorAll('[data-el="xAxis"]')].map(n => n.textContent),
  };
}

it.each(['columnClustered', 'line', 'barClustered'])('labels a %s value axis over percentages as percentages', subtype => {
  const { y } = axisTexts(['10%', '20%', '35%'], subtype);
  expect(y).toContain('0%');
  expect(y).toContain('20%');
  expect(y.some(t => /^0\.\d/.test(t))).toBe(false);
});

it('labels a value axis over prices in their currency', () => {
  const { y } = axisTexts(['$1,000', '$2,500', '$1,800']);
  expect(y).toContain('$1,000');
  expect(y).toContain('$2,500');
});

it('labels a value axis over dates as dates', () => {
  const { y } = axisTexts(['1/1/2024', '2/1/2024', '3/1/2024'], 'line');
  expect(y.some(t => /K$/.test(t))).toBe(false);
  expect(y.some(t => /2024/.test(t))).toBe(true);
});

it('labels a scatter chart\'s x axis over dates as dates', () => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.setInput(id, 0, 0, 'Day'); wb.setInput(id, 0, 1, 'Sales');
  ['1/1/2024', '2/1/2024', '3/1/2024'].forEach((d, i) => { wb.setInput(id, i + 1, 0, d); wb.setInput(id, i + 1, 1, String(5 + i)); });
  const chart = normalizeChart({ ...newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'scatter'), id: 'c' });
  const doc = new JSDOM(renderChartSvg(chartData(wb, id, chart), chart, 480, 300)).window.document;
  const x = [...doc.querySelectorAll('[data-el="xAxis"]')].map(n => n.textContent).filter(Boolean);
  expect(x.length).toBeGreaterThan(1);
  expect(x.some(t => /K$/.test(t))).toBe(false);
  expect(x.every(t => /202[34]/.test(t))).toBe(true);
});

it('gives the secondary axis the format of the series it plots', () => {
  const { y, y2 } = axisTexts(['10%', '20%', '35%'], 'comboColumnLineSecondary', { secondaryAxis: true });
  expect(y).toContain('20%');
  expect(y2.some(t => t.includes('%'))).toBe(false);
});

it('keeps an axis format of its own and plain numbers over unformatted cells', () => {
  const own = axisTexts(['10%', '20%', '35%'], 'columnClustered', { appearance: { yFormat: '0.00' } }).y;
  expect(own).toContain('0.20');
  expect(own.some(t => t.includes('%'))).toBe(false);
  const plain = axisTexts(['0.5', '0.75', '1.25']).y;
  expect(plain).toContain('0.4');
  expect(plain.some(t => t.includes('%'))).toBe(false);
});
