// @vitest-environment jsdom
import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as X from '../src/vendor/xlsx.mjs';
import { Workbook } from '../src/core/workbook.js';
import { chartData } from '../src/core/charts.js';
import { newExcelChart } from '../src/core/chart-subtypes.js';
import { chartElementPatch, chartElementState, elementFormatPatch, trendlinePatch } from '../src/core/chart-design.js';
import { chartElementKeys, elementLabel } from '../src/ui/chart-ribbon.js';
import { renderChartSvg } from '../src/ui/chartsvg.js';
import { workbookFromFile, workbookToXlsx } from '../src/core/io.js';

afterEach(() => vi.unstubAllGlobals());

// The app drew a straight trendline only, with no equation: Excel's other kinds, their forecast and their
// label are drawn here, chosen from Add Chart Element and the Format pane, and kept in the workbook file.
const ROWS = [['Month', 'Squares', 'Tens'], ['Jan', '1', '10'], ['Feb', '4', '20'], ['Mar', '9', '30'], ['Apr', '16', '40']];
function sheet(subtype = 'lineMarkers', patch = {}) {
  const wb = new Workbook(), id = wb.activeSheetId;
  ROWS.forEach((row, r) => row.forEach((v, c) => wb.setInput(id, r, c, v)));
  const chartId = subtype ? wb.addChart(id, newExcelChart(wb, id, { r1: 0, c1: 0, r2: 4, c2: 2 }, subtype))
    : wb.addChart(id, { type: 'line', range: { r1: 0, c1: 0, r2: 4, c2: 2 }, anchor: { r: 6, c: 0 } });
  wb.updateChart(id, chartId, patch);
  const chart = () => wb.chartById(id, chartId);
  const draw = () => new DOMParser().parseFromString(renderChartSvg(chartData(wb, id, chart()), chart(), 480, 288), 'image/svg+xml');
  return { wb, id, chartId, chart, draw };
}
const vertices = node => [...node.getAttribute('d').matchAll(/[ML] ([-\d.]+) ([-\d.]+)/g)].map(m => [+m[1], +m[2]]);
const trendlines = doc => [...doc.querySelectorAll('.chart-trendline')];

describe('drawing', () => {
  it('draws a polynomial through every point of the series it fits exactly', () => {
    const { draw } = sheet('lineMarkers', { trendline: true, trendlines: [{ type: 'poly', order: 2 }, false] });
    const doc = draw(), [curve] = trendlines(doc);
    expect(trendlines(doc)).toHaveLength(1);
    expect(curve.tagName).toBe('path');
    expect(curve.getAttribute('data-series')).toBe('0');
    // 96 steps from January to April: the months fall on every 32nd.
    const at = vertices(curve), markers = [...doc.querySelectorAll('[data-series="0"][data-point]')];
    expect(markers).toHaveLength(4);
    markers.forEach((m, i) => {
      const box = m.tagName === 'circle' ? [+m.getAttribute('cx'), +m.getAttribute('cy')] : null;
      if (box) { expect(at[i * 32][0]).toBeCloseTo(box[0], 1); expect(at[i * 32][1]).toBeCloseTo(box[1], 1); }
    });
    expect(curve.querySelector('title').textContent).toBe('Poly. (Squares): y = x^2, R² = 1');
  });

  it('writes the equation and R² by the end of the line, counting the categories from 1', () => {
    const { draw } = sheet('columnClustered', { trendline: true, trendlines: [false, { type: 'linear', dispEq: true, dispRSqr: true }] });
    const doc = draw(), label = doc.querySelector('.chart-trendline-label');
    expect(label.getAttribute('data-el')).toBe('trendlineLabel');
    expect([...label.querySelectorAll('text')].map(t => t.textContent)).toEqual(['y = 10x', 'R² = 1']);
    for (const t of label.querySelectorAll('text')) {
      expect(+t.getAttribute('x')).toBeLessThanOrEqual(480);
      expect(+t.getAttribute('y')).toBeGreaterThan(0);
    }
  });

  it('raises an exponent in the label', () => {
    const { draw } = sheet('lineMarkers', { trendline: true, trendlines: [{ type: 'poly', order: 2, dispEq: true }, false] });
    const spans = [...draw().querySelectorAll('.chart-trendline-label tspan')];
    expect(spans.map(s => s.textContent)).toEqual(['y = x', '2']);
    expect(+spans[1].getAttribute('dy')).toBeLessThan(0);
  });

  it('draws the kinds in a chart of the app\'s own style too', () => {
    const { draw } = sheet(null, { trendline: true, trendlines: [{ type: 'exp', dispEq: true }, { type: 'movingAvg', period: 2 }] });
    const doc = draw(), [exp, average] = trendlines(doc);
    expect(exp.tagName).toBe('path');
    expect(doc.querySelector('.chart-trendline-label').textContent).toMatch(/^y = [\d.]+e[\d.]+x$/);
    // A moving average over two of four points has three.
    expect(vertices(average)).toHaveLength(3);
  });

  it('runs a forecast past the last category', () => {
    const { draw } = sheet('lineMarkers', { trendline: true, trendlines: [false, { type: 'linear', forward: 1 }] });
    const doc = draw(), line = trendlines(doc)[0];
    const last = Math.max(...[...doc.querySelectorAll('[data-series="1"][data-point]')].map(m => +(m.getAttribute('cx') ?? m.getAttribute('x'))));
    expect(+line.getAttribute('x2')).toBeGreaterThan(last + 20);
  });

  it('bends a straight fit on a logarithmic value axis, which curves it', () => {
    const { wb, id, chartId, chart, draw } = sheet('lineMarkers', { trendline: true, trendlines: [false, {}] });
    expect(trendlines(draw())[0].tagName).toBe('line');
    wb.updateChart(id, chartId, { appearance: { ...chart().appearance, yLogBase: 10 } });
    expect(trendlines(draw())[0].tagName).toBe('path');
  });

  it('draws nothing for a kind the values cannot take, and keeps the line\'s own colour, width and dash', () => {
    const { wb, id, draw } = sheet('lineMarkers', { trendline: true, trendlines: [{ type: 'exp', color: '#ff0000', width: 3, dash: 'sysDot' }, { type: 'log' }] });
    wb.setInput(id, 1, 1, '-1');
    const doc = draw();
    expect(trendlines(doc).map(t => t.getAttribute('data-series'))).toEqual(['1']);
    wb.setInput(id, 1, 1, '1');
    const line = trendlines(draw())[0];
    expect(line.getAttribute('stroke')).toBe('#ff0000');
    expect(line.getAttribute('stroke-width')).toBe('3');
    expect(line.getAttribute('stroke-dasharray')).toBe('3 3');
  });

  it('draws a horizontal bar chart\'s curve down its categories', () => {
    const { draw } = sheet('barClustered', { trendline: true, trendlines: [{ type: 'power' }, false] });
    const pts = vertices(trendlines(draw())[0]);
    // The first category lies lowest on a bar chart; the curve climbs to the last.
    expect(pts[0][1]).toBeGreaterThan(pts.at(-1)[1]);
    expect(pts.at(-1)[0]).toBeGreaterThan(pts[0][0]);
  });
});

describe('Add Chart Element and the Format pane', () => {
  it('gives every series the kind picked, keeping each one\'s label and forecast', () => {
    const { chart } = sheet('lineMarkers', { trendline: true, trendlines: [{ type: 'linear', dispEq: true }, { type: 'log', forward: 2 }] });
    expect(chartElementState(chart()).trendline).toBe('mixed');
    const patch = chartElementPatch(chart(), 'trendline', 'exp', { seriesCount: 2 });
    expect(patch.trendlines).toMatchObject([{ type: 'exp', dispEq: true }, { type: 'exp', forward: 2 }]);
    expect(chartElementState({ ...chart(), ...patch }).trendline).toBe('exp');
    expect(chartElementPatch(chart(), 'trendline', 'none')).toMatchObject({ trendline: false, trendlines: undefined });
    expect(chartElementPatch(chart(), 'trendline', 'quadratic')).toBeNull();
  });

  it('takes one series\' trendline away, and the chart\'s last turns trendlines off', () => {
    const { wb, id, chartId, chart } = sheet('lineMarkers', chartElementPatch({ type: 'line' }, 'trendline', 'linear'));
    expect(chart().trendlines).toBeUndefined();
    wb.updateChart(id, chartId, trendlinePatch(chart(), 1, null, 2));
    expect(chart().trendlines).toEqual([expect.objectContaining({ type: 'linear' }), false]);
    wb.updateChart(id, chartId, trendlinePatch(chart(), 0, null, 2));
    expect(chart().trendline).toBe(false);
    expect(trendlinePatch({ type: 'pie' }, 0, {}, 1)).toBeNull();
  });

  it('formats a trendline\'s line, Automatic giving back its series\' colour', () => {
    const { chart } = sheet('lineMarkers', { trendline: true });
    const red = elementFormatPatch(chart(), 'trendline:1', { outline: '#ff0000', outlineWidth: 2 });
    expect(red.trendlines[1]).toMatchObject({ color: '#ff0000', width: 2 });
    expect(red.trendlines[0]).not.toHaveProperty('color');
    expect(elementFormatPatch({ ...chart(), ...red }, 'trendline:1', { outline: undefined, outlineWidth: 2 }).trendlines[1].color).toBe('#ff0000');
    expect(elementFormatPatch({ ...chart(), ...red }, 'trendline:1', { outline: null }).trendlines[1]).not.toHaveProperty('color');
  });

  it('lists each trendline and its label among the chart\'s elements', () => {
    const { chart } = sheet('lineMarkers', { trendline: true, trendlines: [{ dispEq: true }, false] });
    const keys = chartElementKeys(chart(), 2);
    expect(keys.filter(k => /^trendline/.test(k))).toEqual(['trendline:0', 'trendlineLabel:0']);
    expect(elementLabel('trendline:0', ['Squares'])).toBe('Series "Squares" Trendline 1');
    expect(elementLabel('trendlineLabel:0', ['Squares'])).toBe('Series "Squares" Trendline 1 Label');
  });
});

describe('the workbook file', () => {
  const saved = async wb => {
    vi.stubGlobal('Blob', NodeBlob);
    return X.CFB.read(new Uint8Array(await (await workbookToXlsx(wb)).arrayBuffer()), { type: 'array' });
  };
  const chartPart = zip => zip.FileIndex[zip.FullPaths.findIndex(p => /\/charts\/chart[^/]*\.xml$/.test(p))];
  const chartXml = zip => new TextDecoder().decode(chartPart(zip).content);
  // The file as Excel saves it: without this app's own record of the workbook.
  const asExcelFile = (zip, edit = xml => xml) => {
    const book = X.CFB.find(zip, '/xl/workbook.xml');
    book.content = new TextEncoder().encode(new TextDecoder().decode(book.content).replace(/<sheet\b[^>]*name="_puter_meta\d*"[^>]*\/>/g, ''));
    book.size = book.content.length;
    const part = chartPart(zip);
    part.content = new TextEncoder().encode(edit(new TextDecoder().decode(part.content)));
    part.size = part.content.length;
    return X.CFB.write(zip, { type: 'array', fileType: 'zip' });
  };

  it('saves each series\' trendline with its options, and opens them again', async () => {
    const { wb } = sheet('lineMarkers', { trendline: true, trendlines: [false,
      { type: 'poly', order: 3, forward: 1.5, backward: 0.5, intercept: 2, dispEq: true, dispRSqr: true, name: 'Fit', labelFormat: '0.00', color: '#ff0000', width: 2, dash: 'sysDot' }] });
    const zip = await saved(wb), xml = chartXml(zip);
    expect(xml.match(/<c:trendline>/g)).toHaveLength(1);
    expect(xml).toContain('<c:trendline><c:name>Fit</c:name><c:spPr><a:ln w="19050"><a:solidFill><a:srgbClr val="FF0000"></a:srgbClr></a:solidFill><a:prstDash val="sysDot"/></a:ln></c:spPr>'
      + '<c:trendlineType val="poly"/><c:order val="3"/><c:forward val="1.5"/><c:backward val="0.5"/><c:intercept val="2"/><c:dispRSqr val="1"/><c:dispEq val="1"/>'
      + '<c:trendlineLbl><c:numFmt formatCode="0.00" sourceLinked="0"/></c:trendlineLbl></c:trendline>');
    const back = (await workbookFromFile(asExcelFile(zip), 'excel.xlsx')).activeSheet.charts[0];
    expect(back.trendline).toBe(true);
    expect(back.trendlines[0]).toBe(false);
    expect(back.trendlines[1]).toEqual({ type: 'poly', order: 3, period: 2, forward: 1.5, backward: 0.5, intercept: 2, dispEq: true, dispRSqr: true,
      name: 'Fit', labelFormat: '0.00', color: '#ff0000', width: 2, dash: 'sysDot' });
  });

  it('reads Excel\'s own trendline, whose flags may carry no value', async () => {
    const { wb } = sheet('lineMarkers', { trendline: true, trendlines: [{ type: 'exp' }, false] });
    const zip = await saved(wb);
    const back = (await workbookFromFile(asExcelFile(zip, xml => xml.replace('<c:trendlineType val="exp"/>',
      '<c:trendlineType val="exp"/><c:dispRSqr/><c:dispEq val="0"/><c:trendlineLbl><c:layout/><c:numFmt formatCode="General" sourceLinked="0"/></c:trendlineLbl>')), 'excel.xlsx')).activeSheet.charts[0];
    expect(back.trendlines[0]).toMatchObject({ type: 'exp', dispRSqr: true, dispEq: false });
    expect(back.trendlines[0]).not.toHaveProperty('labelFormat');
  });
});
