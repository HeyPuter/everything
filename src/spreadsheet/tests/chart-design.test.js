import { afterEach, describe, expect, it, vi } from 'vitest';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import * as X from '../src/vendor/xlsx.mjs';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { CHART_STYLES, chartElementPatch, chartElementState, chartSeriesSources, chartStylePatch, colorPalettes, colorsPatch, detachedChart,
  elementFormatPatch, quickLayoutPatch, quickLayoutsFor, recommendedSubtypes, seriesSourcesPatch, switchRowColumnPatch } from '../src/core/chart-design.js';

function setup(subtype = 'columnClustered', rows = [['Month', 'North', 'South'], ['Jan', 12, 9], ['Feb', 15, 11], ['Mar', 9, 14]]) {
  const wb = new Workbook();
  const id = wb.activeSheetId;
  rows.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, String(v))));
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: rows.length - 1, c2: rows[0].length - 1 }, subtype));
  const chart = () => wb.chartById(id, chartId);
  const apply = patch => { expect(patch).toBeTruthy(); wb.updateChart(id, chartId, patch); return chart(); };
  const svg = () => renderChartSvg(chartData(wb, id, chart()), chart(), chart().w, chart().h);
  return { wb, id, chartId, chart, apply, svg };
}

describe('Add Chart Element', () => {
  it('adds and removes titles, labels, gridlines, the legend and a data table', () => {
    const { chart, apply, svg } = setup();
    expect(chartElementState(chart())).toMatchObject({ chartTitle: 'above', legend: 'bottom', dataLabels: 'none', gridlines: { horizontal: true, vertical: false } });
    apply(chartElementPatch(chart(), 'axisTitles', { axis: 'vertical', on: true }));
    expect(chart().yTitle).toBe('Axis Title');
    expect(svg()).toContain('data-el="yTitle"');
    apply(chartElementPatch(chart(), 'dataLabels', 'outEnd', { seriesCount: 2 }));
    expect(chart().labels).toBe(true);
    expect(chart().appearance.valueLabels.map(l => l.position)).toEqual(['outEnd', 'outEnd']);
    expect(svg().match(/data-el="dataLabels"/g)).toHaveLength(6);
    apply(chartElementPatch(chart(), 'legend', 'right'));
    expect(chart()).toMatchObject({ legend: true, legendPos: 'right' });
    apply(chartElementPatch(chart(), 'gridlines', { axis: 'vertical', on: true }));
    expect(chart().appearance.xGridlines).toBe(true);
    expect(svg()).toContain('data-el="gridlines-x"');
    apply(chartElementPatch(chart(), 'dataTable', 'keys'));
    expect(chart().appearance.dataTable).toMatchObject({ keys: true });
    apply(chartElementPatch(chart(), 'chartTitle', 'none'));
    expect(chart().title).toBe('');
    apply(chartElementPatch(chart(), 'axes', { axis: 'vertical', on: false }));
    expect(chart().appearance.hideYAxis).toBe(true);
    expect(chartElementState(chart())).toMatchObject({ chartTitle: 'none', legend: 'right', dataLabels: 'outEnd', dataTable: 'keys', axes: { vertical: false } });
  });

  it('labels line points to the right and pie slices at the best fit', () => {
    const line = setup('lineMarkers');
    line.apply(chartElementPatch(line.chart(), 'dataLabels', 'r', { seriesCount: 2 }));
    expect(line.svg()).toMatch(/text-anchor="start"[^>]*data-el="dataLabels"/);
    const pie = setup('pie', [['Fruit', 'Sold'], ['Apples', 5], ['Pears', 3]]);
    pie.apply(chartElementPatch(pie.chart(), 'dataLabels', 'bestFit'));
    expect(pie.chart().appearance.pie.labels).toMatchObject({ value: true, position: 'bestFit' });
    expect(pie.svg()).toContain('>5</tspan>');
  });

  it('refuses elements a chart cannot have', () => {
    const pie = setup('pie', [['Fruit', 'Sold'], ['Apples', 5], ['Pears', 3]]);
    expect(chartElementPatch(pie.chart(), 'axes', { axis: 'vertical', on: false })).toBeNull();
    expect(chartElementPatch(pie.chart(), 'trendline', 'linear')).toBeNull();
  });
});

describe('Quick Layout, Chart Styles and Change Colors', () => {
  it('applies every quick layout and style and still draws', () => {
    const { chart, apply, svg } = setup();
    for (const layout of quickLayoutsFor(chart())) { apply(quickLayoutPatch(chart(), layout.id, { seriesCount: 2 })); expect(svg()).toMatch(/^<svg/); }
    for (const style of CHART_STYLES) { apply(chartStylePatch(chart(), style.id, { seriesCount: 2 })); expect(svg()).toMatch(/^<svg/); }
    apply(chartStylePatch(chart(), 6, { seriesCount: 2 }));
    expect(chart().appearance.background).toBe('#404040');
    apply(chartStylePatch(chart(), 1, { seriesCount: 2 }));
    expect(chart().appearance.background).toBe('#ffffff');
  });

  it('colours series from a palette built on the theme accents', () => {
    const { chart, apply } = setup();
    const { colorful, monochromatic } = colorPalettes(['#4472c4', '#ed7d31', '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47']);
    expect(colorful).toHaveLength(4);
    expect(monochromatic).toHaveLength(6);
    expect(colorful[0].colors[0]).toBe('#4472c4');
    apply(colorsPatch(chart(), monochromatic[1].colors, 2));
    expect(chart().colors).toEqual(monochromatic[1].colors.slice(0, 2));
  });
});

describe('Select Data and Switch Row/Column', () => {
  it('switches series between columns and rows', () => {
    const { wb, id, chart, apply } = setup();
    expect(chartData(wb, id, chart()).series.map(s => s.name)).toEqual(['North', 'South']);
    apply(switchRowColumnPatch(wb, id, chart()));
    expect(chartData(wb, id, chart()).series.map(s => s.name)).toEqual(['Jan', 'Feb', 'Mar']);
  });

  it('lists the series as references and edits them one by one', () => {
    const { wb, id, chart, apply } = setup();
    const sources = chartSeriesSources(wb, id, chart());
    expect(sources).toEqual([
      { name: 'North', nameRef: 'Sheet1!$B$1', categories: 'Sheet1!$A$2:$A$4', values: 'Sheet1!$B$2:$B$4' },
      { name: 'South', nameRef: 'Sheet1!$C$1', categories: 'Sheet1!$A$2:$A$4', values: 'Sheet1!$C$2:$C$4' }]);
    const before = chartData(wb, id, chart()).series.map(s => s.values);
    apply(seriesSourcesPatch(chart(), [...sources].reverse()));
    expect(chartData(wb, id, chart()).series.map(s => s.values)).toEqual([...before].reverse());
    expect(switchRowColumnPatch(wb, id, chart())).toBeNull();
    wb.setInput(id, 1, 2, '100');
    expect(chartData(wb, id, chart()).series[0].values[0]).toBe(100);
  });

  it('keeps edited series through a native-only XLSX cycle', async () => {
    const { wb, id, chart, apply } = setup();
    const sources = chartSeriesSources(wb, id, chart());
    apply(seriesSourcesPatch(chart(), [sources[1]]));
    const zip = X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
    const part = X.CFB.find(zip, '/xl/workbook.xml');
    X.CFB.utils.cfb_add(zip, '/xl/workbook.xml', new TextEncoder().encode(new TextDecoder().decode(part.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, '')));
    const back = await workbookFromFile(X.CFB.write(zip, { type: 'array', fileType: 'zip' }));
    const data = chartData(back, back.sheets[0].id, back.sheets[0].charts[0]);
    expect(data.series.map(s => s.name)).toEqual(['South']);
    expect(data.series[0].values).toEqual([9, 11, 14]);
  });

  it('detaches a range chart onto references for a chart sheet', () => {
    const { wb, id, chart } = setup();
    const detached = detachedChart(wb, id, chart());
    const other = wb.addSheet('Elsewhere');
    const moved = wb.addChart(other.id, { ...detached, id: undefined });
    expect(chartData(wb, other.id, wb.chartById(other.id, moved)).series.map(s => s.values)).toEqual(chartData(wb, id, chart()).series.map(s => s.values));
  });
});

describe('Format: Shape Fill, Outline and Effects', () => {
  afterEach(() => vi.unstubAllGlobals());

  // A title's fill and outline were sized by a guess at its text's width, some 40% too wide: in Chrome the box around
  // "Quarterly revenue by region" ran 44px past the text on each side, not the half an em it keeps.
  it('sizes a title\'s box to its text measured in the title\'s own font', () => {
    const fonts = [];
    const context = { font: '', measureText(text) { fonts.push(this.font); return { width: [...String(text)].length * 7 }; } };
    vi.stubGlobal('OffscreenCanvas', class { getContext() { return context; } });
    for (const subtype of ['columnClustered', 'pie']) {
      const { chart, apply, svg } = setup(subtype);
      apply({ title: 'Quarterly revenue by region' });
      apply(elementFormatPatch(chart(), 'title', { fill: '#ffff00', outline: '#ff0000' }));
      const size = chart().appearance.titleStyle.size, rect = /<rect data-el="title" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"/.exec(svg());
      expect(Number(rect[2])).toBeCloseTo(27 * 7 + size, 1);
      // Centred over the title, half an em either side.
      expect(Number(rect[1]) + Number(rect[2]) / 2).toBeCloseTo(chart().w / 2, 1);
      expect(fonts.some(f => f.includes(`${size}px`))).toBe(true);
    }
  });

  it('formats the chart area, plot area, title, legend, a series and a point', () => {
    const { chart, apply, svg } = setup();
    apply(elementFormatPatch(chart(), 'chartArea', { fill: '#fff2cc', outline: '#000000' }));
    expect(chart().appearance).toMatchObject({ background: '#fff2cc', borderColor: '#000000' });
    apply(elementFormatPatch(chart(), 'plotArea', { fill: '#eeeeee' }));
    expect(svg()).toContain('data-el="plotArea" x=');
    expect(svg()).toContain('fill="#eeeeee"');
    apply(elementFormatPatch(chart(), 'title', { fill: '#ffff00', outline: '#ff0000' }));
    expect(chart().appearance.titleBox).toEqual({ fill: '#ffff00', stroke: '#ff0000' });
    apply(elementFormatPatch(chart(), 'legend', { outline: '#333333' }));
    expect(chart().appearance.legendBox.stroke).toBe('#333333');
    apply(elementFormatPatch(chart(), 'series:1', { fill: '#00ff00', outline: '#000000', outlineWidth: 2 }));
    expect(chart().colors[1]).toBe('#00ff00');
    expect(chart().appearance.bars[1]).toMatchObject({ stroke: '#000000', strokeWidth: 2 });
    apply(elementFormatPatch(chart(), 'point:0:2', { fill: '#123456' }));
    expect(chart().appearance.pointColors[0]).toEqual([{ index: 2, color: '#123456' }]);
    apply(elementFormatPatch(chart(), 'series:0', { effect: { shadow: true } }));
    expect(svg()).toContain('filter="url(#chart-fx-shadow)"');
    apply(elementFormatPatch(chart(), 'gridlines-y', { outline: '#ff0000' }));
    expect(svg()).toMatch(/stroke="#ff0000"[^>]*data-el="gridlines-y"/);
  });
});

describe('Recommended Charts', () => {
  it('recommends charts that fit the data', () => {
    const one = recommendedSubtypes({ categories: ['A', 'B'], series: [{ values: [1, 2] }] });
    expect(one).toContain('pie');
    expect(one[0]).toBe('columnClustered');
    const xy = recommendedSubtypes({ categories: ['1', '2', '3'], series: [{ values: [1, 2, 3] }, { values: [4, 5, 6] }] });
    expect(xy[0]).toBe('scatter');
  });
});
