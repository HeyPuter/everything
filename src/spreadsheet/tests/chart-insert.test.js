import { describe, expect, it } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import * as X from '../src/vendor/xlsx.mjs';
import { CHART_GALLERIES, CHART_SUBTYPES, CHART_TEXT_GREY, CHART_LINE_GREY, changeSubtypePatch, chartSubtype, defaultChartTitle,
  excelChartAppearance, newExcelChart, subtypeOf } from '../src/core/chart-subtypes.js';

function book(rows = [['Month', 'North', 'South'], ['Jan', 12, 9], ['Feb', 15, 11], ['Mar', 9, 14]]) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  return { wb, id };
}
const range = { r1: 0, c1: 0, r2: 3, c2: 2 };

async function nativeCycle(wb, { meta = false } = {}) {
  const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  const xml = new TextDecoder().decode(X.CFB.find(zip, '/xl/charts/chart1_1.xml').content);
  if (!meta) {
    const part = X.CFB.find(zip, '/xl/workbook.xml');
    X.CFB.utils.cfb_add(zip, '/xl/workbook.xml', new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
  }
  return { wb: await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' })), xml };
}

describe('Insert ▸ Charts galleries', () => {
  it('offers the subtypes under each button, every one a chart the model can draw', () => {
    expect(CHART_GALLERIES.map(g => g.label)).toEqual(['Column', 'Line', 'Pie', 'Bar', 'Area', 'Scatter', 'Hierarchy', 'Statistic', 'Other Charts', 'Combo']);
    const labels = id => CHART_GALLERIES.find(g => g.id === id).groups.flatMap(g => g.items.map(i => i.label));
    expect(labels('column')).toEqual(['Clustered Column', 'Stacked Column', '100% Stacked Column']);
    expect(labels('line')).toContain('Line with Markers');
    expect(labels('pie')).toEqual(['Pie', 'Exploded Pie', 'Pie of Pie', 'Bar of Pie', 'Doughnut', 'Exploded Doughnut']);
    expect(labels('hierarchy')).toEqual(['Treemap', 'Sunburst']);
    expect(labels('other')).toEqual(['Waterfall', 'Funnel', 'High-Low-Close', 'Open-High-Low-Close', 'Volume-High-Low-Close',
      'Volume-Open-High-Low-Close', '3-D Surface', 'Wireframe 3-D Surface', 'Contour', 'Wireframe Contour', 'Radar', 'Radar with Markers', 'Filled Radar']);
    expect(labels('scatter')).toEqual(['Scatter', 'Scatter, smooth lines and markers', 'Scatter, smooth lines',
      'Scatter, straight lines and markers', 'Scatter, straight lines', 'Bubble']);
    const { wb, id } = book();
    for (const s of CHART_SUBTYPES) {
      const chart = newExcelChart(wb, id, range, s.id);
      const chartId = wb.addChart(id, chart);
      const stored = wb.chartById(id, chartId);
      expect(subtypeOf(stored)).toBe(s.id);
      expect(renderChartSvg(chartData(wb, id, stored), stored, stored.w, stored.h)).toMatch(/^<svg/);
    }
  });

  it('makes a chart in the default style, size, place and title', () => {
    const { wb, id } = book();
    const chart = newExcelChart(wb, id, range, 'columnClustered');
    expect(chart).toMatchObject({ type: 'column', stacked: false, w: 480, h: 288, anchor: { r: 0, c: 3 }, title: 'Chart title', legend: true, legendPos: 'bottom' });
    expect(chart.appearance).toMatchObject({ gapWidth: 219, overlap: -27, background: '#ffffff', borderColor: CHART_LINE_GREY, roundedCorners: false,
      titleStyle: { size: 18.67, color: CHART_TEXT_GREY }, xStyle: { size: 12, color: CHART_TEXT_GREY }, gridlineStyles: { y: { color: CHART_LINE_GREY } } });
    const id2 = wb.addChart(id, chart), stored = wb.chartById(id, id2);
    const svg = renderChartSvg(chartData(wb, id, stored), stored, stored.w, stored.h);
    expect(svg).toContain('data-el="title"');
    expect(svg).toContain(`stroke="${CHART_LINE_GREY}"`); // the chart area's light grey border
    expect(svg).toContain('data-el="plotArea"');
    expect(svg.match(/data-el="series" data-series="1"/g)).toHaveLength(3);
  });

  it('titles a single series with its name and leaves out the legend', () => {
    const { wb, id } = book();
    const one = newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'line');
    expect(one).toMatchObject({ title: 'North', legend: false });
    expect(newExcelChart(wb, id, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'pie')).toMatchObject({ title: 'North', legend: true });
    expect(defaultChartTitle({ series: [{ name: 'Series1' }] }, 'column')).toBe('Chart title');
  });

  it('places the chart below the data when the sheet has no room to its right', () => {
    const { wb, id } = book();
    const sheet = wb.sheet(id);
    const chart = newExcelChart(wb, id, { r1: 0, c1: sheet.cols - 3, r2: 3, c2: sheet.cols - 1 }, 'columnClustered');
    expect(chart.anchor).toEqual({ r: 5, c: sheet.cols - 3 });
  });

  it('changes a chart’s type keeping its title and formatting', () => {
    const { wb, id } = book();
    const chartId = wb.addChart(id, { ...newExcelChart(wb, id, range, 'columnClustered'), title: 'Sales' });
    wb.updateChart(id, chartId, { appearance: { ...wb.chartById(id, chartId).appearance, background: '#fff2cc' } });
    wb.updateChart(id, chartId, changeSubtypePatch(wb.chartById(id, chartId), 'lineMarkers'));
    const chart = wb.chartById(id, chartId);
    expect(chart).toMatchObject({ type: 'line', title: 'Sales', appearance: { background: '#fff2cc' } });
    expect(subtypeOf(chart)).toBe('lineMarkers');
    wb.updateChart(id, chartId, changeSubtypePatch(wb.chartById(id, chartId), 'columnStacked'));
    expect(wb.chartById(id, chartId).appearance).toMatchObject({ gapWidth: 150, overlap: 100 });
    expect(subtypeOf(wb.chartById(id, chartId))).toBe('columnStacked');
  });
});

describe('Inserted charts in XLSX', () => {
  it.each(['columnClustered', 'columnStacked100', 'barStacked', 'lineStacked', 'lineMarkers', 'areaStacked', 'pie', 'doughnut',
    'scatter', 'scatterSmooth', 'scatterLinesMarkers'])('keeps a new %s chart through a native-only cycle', async subtype => {
    const { wb, id } = book();
    wb.addChart(id, newExcelChart(wb, id, subtype.startsWith('scatter') ? { r1: 0, c1: 1, r2: 3, c2: 2 } : range, subtype));
    const { wb: back, xml } = await nativeCycle(wb);
    expect(xml).toContain('<c:roundedCorners val="0"/>');
    expect(xml).toContain('<a:srgbClr val="D9D9D9"');
    const chart = back.sheets[0].charts[0];
    expect(subtypeOf(chart)).toBe(subtype);
    const s = chartSubtype(subtype);
    expect(chart.type).toBe(s.type);
    expect(!!chart.stacked).toBe(!!s.stacked);
    expect(!!chart.stack100).toBe(!!s.stack100);
    expect(chart.appearance.borderColor).toBe(CHART_LINE_GREY);
    if (s.type === 'column') expect(chart.appearance).toMatchObject(s.stacked ? { gapWidth: 150, overlap: 100 } : { gapWidth: 219, overlap: -27 });
    expect(chartData(back, back.sheets[0].id, chart).series.length).toBe(['pie', 'donut'].includes(s.type) ? 1 : s.type === 'scatter' ? 1 : 2);
  });

  it('keeps title and legend boxes, effects and blank-cell plotting through a native-only cycle', async () => {
    const { wb, id } = book();
    const chart = newExcelChart(wb, id, range, 'lineMarkers');
    chart.appearance = { ...chart.appearance, titleBox: { fill: '#ffeeaa', stroke: '#333333' }, legendBox: { fill: '#eeeeee', stroke: null },
      effects: { chartArea: { shadow: true }, 'series:1': { glow: '#ff0000' } }, blanks: 'span' };
    wb.addChart(id, chart);
    const { wb: back, xml } = await nativeCycle(wb);
    expect(xml).toContain('<c:dispBlanksAs val="span"/>');
    expect(xml).toContain('<a:outerShdw');
    expect(back.sheets[0].charts[0].appearance).toMatchObject({ titleBox: { fill: '#ffeeaa', stroke: '#333333' }, legendBox: { fill: '#eeeeee' },
      effects: { chartArea: { shadow: true }, 'series:1': { glow: '#ff0000' } }, blanks: 'span' });
  });

  it('keeps everything through the app’s own sidecar', async () => {
    const { wb, id } = book();
    wb.addChart(id, newExcelChart(wb, id, range, 'lineStackedMarkers'));
    const before = wb.sheet(id).charts[0];
    const { wb: back } = await nativeCycle(wb, { meta: true });
    const after = back.sheets[0].charts[0];
    expect(after.appearance.lineDefault).toEqual(before.appearance.lineDefault);
    expect(after.appearance.excelLayout).toBe(true);
    expect(after.range).toEqual(before.range);
  });

  it('builds appearances whose sizes are set in points', () => {
    const a = excelChartAppearance('pie');
    expect(a.pie.holeSize).toBe(75);
    expect(excelChartAppearance('doughnut').pie.holeSize).toBe(75);
    expect(a.legendStyle.size * 3 / 4).toBeCloseTo(9, 1);
  });
});
