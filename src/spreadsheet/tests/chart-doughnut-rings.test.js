import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { Workbook } from '../src/core/workbook.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { elementFormatPatch } from '../src/core/chart-design.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { elementForNode } from '../src/ui/chart-format-pane.js';
import * as X from '../src/vendor/xlsx.mjs';
import { pieXlsx } from './helpers/xlsx-pie-fixture.js';

const { DOMParser } = new JSDOM('').window;

// Three number columns: Insert ▸ Doughnut over A1:D4 charts North, South and West as three rings.
function book() {
  const wb = new Workbook(), id = wb.activeSheetId;
  [['Item', 'North', 'South', 'West'], ['Jan', 12, 9, 4], ['Feb', 15, 11, 8], ['Mar', 9, 14, 10]]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const chart = normalizeChart(newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 3 }, 'doughnut'));
  chart.appearance.pie.labels = { ...chart.appearance.pie.labels, value: true };
  wb.addChart(id, chart);
  return { wb, id, chart: () => wb.sheet(id).charts[0] };
}
const svgOf = (wb, id, chart) => new DOMParser().parseFromString(renderChartSvg(chartData(wb, id, chart), chart, 480, 360), 'image/svg+xml');
const slices = doc => [...doc.querySelectorAll('[data-el="series"]')];
/** The outer radius of a ring slice: its first arc's radius. */
const outerRadius = path => Number(/A ([\d.]+)/.exec(path.getAttribute('d'))[1]);

async function nativeCycle(wb) {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const xml = new TextDecoder().decode(X.CFB.find(zip, '/xl/charts/chart1_1.xml').content);
  const part = X.CFB.find(zip, '/xl/workbook.xml');
  X.CFB.utils.cfb_add(zip, '/xl/workbook.xml', new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
  return { wb: await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), xml };
}

describe('a doughnut of several series', () => {
  it('draws a ring per series, the first innermost, each with its points, labels and tooltips', () => {
    const { wb, id, chart } = book();
    expect(chart().title).toBe('Chart title');
    const doc = svgOf(wb, id, chart());
    const rings = [0, 1, 2].map(j => slices(doc).filter(p => p.getAttribute('data-series') === String(j)));
    expect(rings.map(r => r.map(p => p.getAttribute('data-point')))).toEqual([['0', '1', '2'], ['0', '1', '2'], ['0', '1', '2']]);
    const radii = rings.map(r => outerRadius(r[0]));
    expect(radii[0]).toBeLessThan(radii[1]);
    expect(radii[1]).toBeLessThan(radii[2]);
    // Each ring's labels show its own values.
    const labels = j => [...doc.querySelectorAll(`[data-el="dataLabels"][data-series="${j}"]`)].map(t => t.textContent);
    expect([labels(0), labels(1), labels(2)]).toEqual([['12', '15', '9'], ['9', '11', '14'], ['4', '8', '10']]);
    expect(rings[2][0].querySelector('title').textContent).toBe('West · Jan: 4 (18%)');
    // The legend names the categories once.
    expect([...doc.querySelectorAll('.chart-legend-label, [data-el="legend"] text')].map(t => t.textContent)).toEqual(['Jan', 'Feb', 'Mar']);
  });

  it('draws every ring in the app style too, its legend naming the slices of any ring', () => {
    const { wb, id } = book();
    const data = chartData(wb, id, wb.sheet(id).charts[0]);
    data.series[0].values = [0, 0, 0];
    const doc = new DOMParser().parseFromString(renderChartSvg(data, { type: 'donut', legend: true }, 480, 360), 'image/svg+xml');
    expect(new Set(slices(doc).map(p => p.getAttribute('data-series')))).toEqual(new Set(['1', '2']));
    expect([...doc.querySelectorAll('text')].map(t => t.textContent)).toEqual(expect.arrayContaining(['Jan', 'Feb', 'Mar']));
  });

  it('selects a ring, then a point of it, and colours only that point of that ring', () => {
    const { wb, id, chart } = book();
    const point = slices(svgOf(wb, id, chart())).find(p => p.getAttribute('data-series') === '1' && p.getAttribute('data-point') === '2');
    expect(elementForNode(point)).toBe('series:1');
    expect(elementForNode(point, 'series:1')).toBe('point:1:2');
    wb.updateChart(id, chart().id, elementFormatPatch(chart(), 'point:1:2', { fill: '#ff0000', rings: 3 }));
    const fills = slices(svgOf(wb, id, chart())).filter(p => p.getAttribute('data-point') === '2').map(p => [p.getAttribute('data-series'), p.getAttribute('fill')]);
    expect(fills.filter(([, fill]) => fill === '#ff0000')).toEqual([['1', '#ff0000']]);
    // A lone ring's point still takes the colour for its category.
    expect(elementFormatPatch(chart(), 'point:0:2', { fill: '#00ff00', rings: 1 }).colors[2]).toBe('#00ff00');
  });

  it('saves every ring with its own point colours, and opens them again', async () => {
    const { wb, id, chart } = book();
    wb.updateChart(id, chart().id, elementFormatPatch(chart(), 'point:2:0', { fill: '#ff0000', rings: 3 }));
    const { wb: back, xml } = await nativeCycle(wb);
    const group = /<c:doughnutChart>([\s\S]*)<\/c:doughnutChart>/.exec(xml)[1];
    expect(group.match(/<c:ser>/g)).toHaveLength(3);
    expect(group).toContain('&apos;Sheet1&apos;!D2:D4');
    const reopened = back.sheets[0].charts[0];
    expect(reopened.type).toBe('donut');
    expect(chartData(back, back.sheets[0].id, reopened).series.map(s => [s.name, s.values])).toEqual([['North', [12, 15, 9]], ['South', [9, 11, 14]], ['West', [4, 8, 10]]]);
    expect(reopened.appearance.pointColors[2].find(p => p.index === 0).color).toBe('#ff0000');
    expect(reopened.appearance.pointColors[1].find(p => p.index === 0).color).not.toBe('#ff0000');
  });

  it('opens an Excel doughnut of two series as two rings', async () => {
    const second = '<c:ser><c:idx val="1"/><c:order val="1"/><c:dPt><c:idx val="2"/><c:spPr><a:solidFill><a:srgbClr val="00B050"/></a:solidFill></c:spPr></c:dPt>'
      + '<c:cat><c:strRef><c:f>Helper!$A$1:$A$4</c:f></c:strRef></c:cat><c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="4"/>'
      + [5, 6, 7, 8].map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('') + '</c:numLit></c:val></c:ser>';
    const wb = await workbookFromFile(pieXlsx({ editChart: xml => xml.replace('</c:ser><c:dLbls>', `</c:ser>${second}<c:dLbls>`) }), 'rings.xlsx');
    const sheet = wb.sheets[0], chart = sheet.charts[0];
    expect(chart.type).toBe('donut');
    expect(chartData(wb, sheet.id, chart).series.map(s => s.values)).toEqual([[900, 240, 10, 850], [5, 6, 7, 8]]);
    expect(chart.appearance.pointColors[1]).toEqual([{ index: 2, color: '#00b050' }]);
    const doc = new DOMParser().parseFromString(renderChartSvg(chartData(wb, sheet.id, chart), chart, chart.w, chart.h), 'image/svg+xml');
    expect(slices(doc).filter(p => p.getAttribute('data-series') === '1')).toHaveLength(4);
    expect(slices(doc).find(p => p.getAttribute('data-series') === '1' && p.getAttribute('data-point') === '2').getAttribute('fill')).toBe('#00b050');
  });
});
