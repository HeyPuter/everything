// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';
import { chartData, normalizeChart } from '../src/core/charts.js';
import { chartElementPatch, chartElementState } from '../src/core/chart-design.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { errorBarAmountInput, errorBarExtents, errorBarsPatch, normalizeErrorBars } from '../src/core/error-bars.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';

afterEach(() => vi.unstubAllGlobals());

// Issue #144: an XY chart had no error bars at all, horizontal or vertical, fixed or from cells.
const sheet = (errors = [1, 2, 3, 4]) => {
  const wb = new Workbook(), id = wb.activeSheetId;
  wb.renameSheet(id, 'Data');
  [['X', 'Y', 'Err'], ...[1, 2, 3, 4].map((x, i) => [x, x * 10, errors[i]])]
    .forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v == null ? '' : String(v))));
  return { wb, id };
};
const scatter = (wb, id, patch = {}) => wb.addChart(id, { type: 'scatter', range: { r1: 0, c1: 0, r2: 4, c2: 1 }, anchor: { r: 0, c: 4 }, ...patch });
const svgOf = (wb, id, chartId) => {
  const chart = wb.chartById(id, chartId);
  return new DOMParser().parseFromString(renderChartSvg(chartData(wb, id, chart), chart, 480, 300), 'image/svg+xml');
};
const bars = (doc, axis = null) => [...doc.querySelectorAll(`.chart-error-bar${axis ? `[data-axis="${axis}"]` : ''}`)];
const numbers = d => d.match(/-?\d+(\.\d+)?/g).map(Number);

describe('error bar amounts', () => {
  const points = [{ i: 0, x: 1, y: 10 }, { i: 1, x: 2, y: 20 }, { i: 2, x: 3, y: 30 }];
  const run = (bar, custom = null) => errorBarExtents(points, { direction: 'both', ...bar }, 'y', custom).map(e => [e.low, e.high]);

  it('measures a fixed value, a percentage and the standard error from each point', () => {
    expect(run({ type: 'fixedVal', value: 2 })).toEqual([[8, 12], [18, 22], [28, 32]]);
    expect(run({ type: 'percentage', value: 10 })).toEqual([[9, 11], [18, 22], [27, 33]]);
    // The sample deviation of 10, 20, 30 is 10; its standard error 10 / √3.
    const se = 10 / Math.sqrt(3);
    run({ type: 'stdErr' }).forEach(([low, high], i) => { expect(low).toBeCloseTo((i + 1) * 10 - se); expect(high).toBeCloseTo((i + 1) * 10 + se); });
  });

  it('centres standard deviation bars on the mean of the series, as Excel does', () => {
    expect(run({ type: 'stdDev', value: 2 })).toEqual([[0, 40], [0, 40], [0, 40]]);
  });

  it('reads custom amounts point by point, a single amount for every point, and a blank as none', () => {
    expect(run({ type: 'cust' }, { plus: [1, 2, 3], minus: [4, 5, 6] })).toEqual([[6, 11], [15, 22], [24, 33]]);
    expect(run({ type: 'cust' }, { plus: [0.5], minus: [] })).toEqual([[10, 10.5], [20, 20.5], [30, 30.5]]);
    // The second point has no amount on either side, so no bar.
    expect(run({ type: 'cust' }, { plus: [1, null, 3], minus: [] })).toEqual([[10, 11], [30, 33]]);
  });

  it('runs one way only for Plus or Minus', () => {
    expect(run({ type: 'fixedVal', value: 2, direction: 'plus' })[0]).toEqual([10, 12]);
    expect(run({ type: 'fixedVal', value: 2, direction: 'minus' })[0]).toEqual([8, 10]);
  });
});

it('keeps only bars it can draw, and moves a bubble chart’s old error bars onto the chart', () => {
  expect(normalizeErrorBars([{ y: { type: 'custom' }, x: { type: 'fixedVal', value: -1, width: 99, color: 'url(x)', dash: 'nope', capWidth: 4 } }, null])).toEqual(
    [{ x: { type: 'fixedVal', value: 1, direction: 'both', caps: true, width: 1, capWidth: 4 } }]);
  expect(normalizeErrorBars([null, {}])).toBeNull();
  const chart = normalizeChart({ type: 'bubble', range: { r1: 0, c1: 0, r2: 1, c2: 1 }, anchor: { r: 0, c: 0 },
    appearance: { bubble: { series: [{ errors: [{ axis: 'y', type: 'percentage', value: 7, direction: 'plus', caps: false, color: '#112233', width: 2 }] }] } } });
  expect(chart.errorBars).toEqual([{ y: { type: 'percentage', value: 7, direction: 'plus', caps: false, color: '#112233', width: 2 } }]);
  expect(chart.appearance.bubble.series[0].errors).toBeUndefined();
});

it('takes a custom amount as a range on one row or column, or as numbers', () => {
  const { wb, id } = sheet();
  expect(errorBarAmountInput(wb, id, '=C2:C5', 'plus')).toEqual({ plus: 'Data!$C$2:$C$5', plusValues: undefined });
  expect(errorBarAmountInput(wb, id, 'C2', 'minus')).toEqual({ minus: 'Data!$C$2', minusValues: undefined });
  expect(errorBarAmountInput(wb, id, '0.5', 'plus')).toEqual({ plus: undefined, plusValues: [0.5] });
  expect(errorBarAmountInput(wb, id, '={1, 2, 3}', 'plus')).toEqual({ plus: undefined, plusValues: [1, 2, 3] });
  expect(errorBarAmountInput(wb, id, 'A1:B5', 'plus').error).toMatch(/one row or one column/);
  expect(errorBarAmountInput(wb, id, 'not a range', 'plus').error).toMatch(/range of cells/);
});

it('draws vertical bars from cells on an XY chart, with caps of the width asked for, and fits the axis to them', () => {
  const { wb, id } = sheet([1, 2, 3, 40]);
  const chartId = scatter(wb, id);
  wb.updateChart(id, chartId, errorBarsPatch(wb.chartById(id, chartId), 0, 'y', { type: 'cust', plus: 'Data!$C$2:$C$5', minus: 'Data!$C$2:$C$5', capWidth: 10, color: '#ff0000' }));
  const doc = svgOf(wb, id, chartId), drawn = bars(doc, 'y');
  expect(drawn).toHaveLength(4);
  expect(drawn[0].getAttribute('stroke')).toBe('#ff0000');
  // A vertical bar, then a 10 px cap across each end.
  const [x1, y1, x2, y2, capX1, capY1, capX2] = numbers(drawn[0].getAttribute('d'));
  expect(x1).toBe(x2);
  expect(y1).toBeGreaterThan(y2);
  expect([capY1, capX2 - capX1]).toEqual([y1, 10]);
  // The last point's bar reaches 40 + 40 = 80: the value axis goes at least that far.
  const ticks = [...doc.querySelectorAll('text')].map(t => Number(t.textContent)).filter(Number.isFinite);
  expect(Math.max(...ticks)).toBeGreaterThanOrEqual(80);
  // The amounts are live: a new value in the cells moves the bar.
  wb.setInput(id, 1, 2, '5');
  expect(numbers(bars(svgOf(wb, id, chartId), 'y')[0].getAttribute('d'))[1]).not.toBe(y1);
});

it('draws horizontal and vertical bars on a chart in the default style, each turned on and off by itself', () => {
  const { wb, id } = sheet();
  const chartId = wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 1 }, 'scatter'));
  const chart = () => wb.chartById(id, chartId);
  wb.updateChart(id, chartId, chartElementPatch(chart(), 'errorBars', 'stdErr', { seriesCount: 1 }));
  expect(chartElementState(chart()).errorBars).toEqual({ kind: 'stdErr', x: false, y: true });
  expect(bars(svgOf(wb, id, chartId), 'y')).toHaveLength(4);
  wb.updateChart(id, chartId, chartElementPatch(chart(), 'errorBars', { axis: 'x', on: true }, { seriesCount: 1 }));
  expect(chart().errorBars[0]).toMatchObject({ x: { type: 'stdErr' }, y: { type: 'stdErr' } });
  expect(bars(svgOf(wb, id, chartId), 'x')).toHaveLength(4);
  wb.updateChart(id, chartId, chartElementPatch(chart(), 'errorBars', 'percentage', { seriesCount: 1 }));
  expect(chart().errorBars[0]).toMatchObject({ x: { type: 'percentage', value: 5 }, y: { type: 'percentage', value: 5 } });
  wb.updateChart(id, chartId, chartElementPatch(chart(), 'errorBars', { axis: 'y', on: false }, { seriesCount: 1 }));
  expect(chart().errorBars[0].y).toBeUndefined();
  expect(bars(svgOf(wb, id, chartId), 'y')).toHaveLength(0);
  wb.updateChart(id, chartId, chartElementPatch(chart(), 'errorBars', 'none', { seriesCount: 1 }));
  expect(chart().errorBars).toBeUndefined();
  // Only charts with values on both axes take them.
  expect(chartElementPatch({ ...chart(), type: 'column' }, 'errorBars', 'stdErr', { seriesCount: 1 })).toBeNull();
});

it('keeps custom amounts on their cells as rows move, the sheet is renamed, and rows are hidden', () => {
  const { wb, id } = sheet();
  const chartId = scatter(wb, id, { errorBars: [{ y: { type: 'cust', plus: 'Data!$C$2:$C$5', minus: 'Data!$C$2:$C$5' } }] });
  wb.insertRows(id, 0, 1);
  wb.renameSheet(id, 'Lab');
  const chart = wb.chartById(id, chartId);
  expect(chart.errorBars[0].y).toMatchObject({ plus: 'Lab!$C$3:$C$6', minus: 'Lab!$C$3:$C$6' });
  expect(chartData(wb, id, chart).errorValues[0].y.plus).toEqual([1, 2, 3, 4]);
  // A hidden row leaves its point out of the chart, and its amount with it.
  wb.sheet(id).hiddenRows.add(3);
  const data = chartData(wb, id, chart);
  expect(data.series[0].values).toEqual([10, 30, 40]);
  expect(data.errorValues[0].y.plus).toEqual([1, 3, 4]);
});

describe('Excel files', () => {
  const saved = async wb => {
    vi.stubGlobal('Blob', NodeBlob);
    return X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  };
  const chartXml = zip => new TextDecoder().decode(zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))].content);
  // The file as Excel saves it: without this app's own record of the workbook.
  const asExcelFile = zip => {
    const book = X.CFB.find(zip, '/xl/workbook.xml');
    book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
    book.size = book.content.length;
    return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
  };

  it('saves a scatter chart’s error bars, custom ones with their cells, and opens them again', async () => {
    const { wb, id } = sheet();
    scatter(wb, id, { errorBars: [{
      y: { type: 'cust', plus: 'Data!$C$2:$C$5', minus: 'Data!$C$2:$C$5', color: '#ff0000', width: 2, dash: 'dash' },
      x: { type: 'fixedVal', value: 0.25, direction: 'plus', caps: false },
    }] });
    const zip = await saved(wb), xml = chartXml(zip);
    expect(xml).toContain('<c:errBars><c:errDir val="y"/><c:errBarType val="both"/><c:errValType val="cust"/><c:noEndCap val="0"/>'
      + '<c:plus><c:numRef><c:f>Data!$C$2:$C$5</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="4"/>');
    expect(xml).toContain('<c:errBars><c:errDir val="x"/><c:errBarType val="plus"/><c:errValType val="fixedVal"/><c:noEndCap val="1"/><c:val val="0.25"/>');
    // Error bars come before the series' values, as the schema orders them.
    expect(xml.indexOf('<c:errBars>')).toBeLessThan(xml.indexOf('<c:xVal>'));
    const back = await workbookFromFile(asExcelFile(zip), 'excel.xlsx'), chart = back.activeSheet.charts[0];
    expect(chart.errorBars[0]).toEqual({
      y: { type: 'cust', value: 1, plus: 'Data!$C$2:$C$5', minus: 'Data!$C$2:$C$5', direction: 'both', caps: true, color: '#ff0000', width: 2, dash: 'dash' },
      x: { type: 'fixedVal', value: 0.25, direction: 'plus', caps: false, width: 1 },
    });
    expect(chartData(back, back.activeSheet.id, chart).errorValues[0].y.plus).toEqual([1, 2, 3, 4]);
  });

  // Error bars on a column, bar, line or area chart Excel made were dropped on opening (only scatter and bubble charts
  // read theirs), so saving the file again here lost them. They are kept and saved as the file had them.
  it.each([['columnClustered', 'c:cat'], ['barClustered', 'c:cat'], ['lineMarkers', 'c:cat'], ['area', 'c:cat']])('keeps the error bars of a %s chart from Excel through a save', async (subtype, before) => {
    const { wb, id } = sheet();
    wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 1, r2: 4, c2: 1 }, subtype));
    const zip = await saved(wb), file = zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))];
    const bars = '<c:errBars><c:errDir val="y"/><c:errBarType val="plus"/><c:errValType val="cust"/><c:noEndCap val="0"/>'
      + '<c:plus><c:numRef><c:f>Data!$C$2:$C$5</c:f></c:numRef></c:plus><c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:ln></c:spPr></c:errBars>';
    file.content = new TextEncoder().encode(new TextDecoder().decode(file.content).replace(`<${before}>`, `${bars}<${before}>`));
    file.size = file.content.length;
    const back = await workbookFromFile(asExcelFile(zip), 'excel.xlsx'), chart = back.activeSheet.charts[0];
    expect(chart.errorBars).toEqual([{ y: { type: 'cust', value: 1, plus: 'Data!$C$2:$C$5', direction: 'plus', caps: true, color: '#ff0000', width: 2 } }]);
    // Not drawn here, where only scatter and bubble charts draw them, but saved again in the series' own place.
    const xml = chartXml(await saved(back));
    expect(xml).toContain('<c:errBars><c:errDir val="y"/><c:errBarType val="plus"/><c:errValType val="cust"/><c:noEndCap val="0"/>'
      + '<c:plus><c:numRef><c:f>Data!$C$2:$C$5</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="4"/><c:pt idx="0"><c:v>1</c:v>');
    expect(xml.indexOf('<c:errBars>')).toBeLessThan(xml.indexOf(`<${before}>`));
    expect(xml.match(/<c:errBars>/g)).toHaveLength(1);
  });

  it('saves one set of error bars on a column or line series, which the file allows only one of', async () => {
    const { wb, id } = sheet();
    wb.addChart(id, { ...newExcelChart(wb, id, { r1: 0, c1: 1, r2: 4, c2: 1 }, 'columnClustered'),
      errorBars: [{ x: { type: 'fixedVal', value: 2 }, y: { type: 'percentage', value: 10 } }] });
    const xml = chartXml(await saved(wb));
    expect(xml.match(/<c:errBars>/g)).toHaveLength(1);
    expect(xml).toContain('<c:errDir val="y"/><c:errBarType val="both"/><c:errValType val="percentage"/>');
  });

  it('opens custom amounts a file keeps as numbers', async () => {
    const { wb, id } = sheet();
    scatter(wb, id, { errorBars: [{ y: { type: 'cust', plusValues: [1, 2], minusValues: [0.5] } }] });
    const xml = chartXml(await saved(wb));
    expect(xml).toContain('<c:plus><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="2"/><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt></c:numLit></c:plus>');
    const back = await workbookFromFile(asExcelFile(await saved(wb)), 'excel.xlsx');
    expect(back.activeSheet.charts[0].errorBars[0].y).toMatchObject({ type: 'cust', plusValues: [1, 2], minusValues: [0.5] });
  });
});
