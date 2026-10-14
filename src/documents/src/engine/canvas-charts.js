import { paintDoughnutChart } from './canvas-doughnut-charts.js';
import { paintPieChart } from './canvas-pie-charts.js';
import { paintXYChart } from './canvas-xy-charts.js';
import { columnTitleLayout, paintColumnTitle } from './canvas-chart-titles.js';
// Original cached-chart preview. Automatic axis bounds are an application layout
// choice; OOXML leaves those bounds to the consumer when none are specified.
import { setCanvasTextStyle, setCanvasFontAlternatives, loadCanvasFonts, measureCanvasText } from './canvas-text.js';
import { kerningEnabled } from './kerning.js';

const metricSize = 1536;
const decodedCharts = new WeakMap();

export function paintDecodedChart(ctx, image, x, y, width, height) {
  const source = decodedCharts.get(image);
  if (!source) return false;
  // These canvas operations apply to the whole decoded image. Applying them
  // separately to chart fills, outlines and labels would change compositing.
  if (ctx.globalAlpha !== 1 || ctx.globalCompositeOperation !== 'source-over' ||
      ctx.filter !== 'none' || ctx.shadowColor !== 'rgba(0, 0, 0, 0)' ||
      !ctx.imageSmoothingEnabled) return false;
  ctx.save();
  try {
    ctx.translate(x, y);
    const frame = new Path2D(); frame.rect(0, 0, width, height); ctx.clip(frame);
    setCanvasFontAlternatives(ctx, source.fontAlternatives);
    paintChart(ctx, source.chart, width, height);
  } finally { ctx.restore(); }
  return true;
}
const metricStyle = style => ({ ...style, fontSize: metricSize, kerning: kerningEnabled(style) ? 1 : 0 });

// The automatic plot layout reserves text-sized axis bands inside fixed
// chart-area padding. These are consumer layout defaults, not OOXML lengths.
// Original chart-layout controls vary frame dimensions and declared font size.
export function axisMetrics(ctx, style, labels, fallbackSize) {
  const resolved = { fontAscii: 'Arial', fontSize: fallbackSize * .75, ...style };
  const natural = measureCanvasText(ctx, 'Mg', resolved);
  setCanvasTextStyle(ctx, metricStyle(resolved));
  const baseline = ctx.textBaseline; ctx.textBaseline = 'alphabetic';
  const box = ctx.measureText('Mg');
  const scale = resolved.fontSize * 4 / 3 / 2048;
  const ascent = Number.isFinite(box.fontBoundingBoxAscent) ? box.fontBoundingBoxAscent * scale : natural.ascent;
  const descent = Number.isFinite(box.fontBoundingBoxDescent) ? box.fontBoundingBoxDescent * scale : natural.descent;
  const boxHeight = ascent + descent;
  // Automatic chart labels use the face box, rather than CSS paragraph line
  // height. Original reference controls vary size and family independently: the
  // category band includes two thirds of an ascent; the value-axis gap is
  // half that band. Tick centering discounts a quarter of internal leading.
  const labelBand = boxHeight + ascent * 2 / 3;
  const centerBaseline = (ascent - descent) / 2 - (boxHeight - resolved.fontSize * 4 / 3) / 4;
  // Embedded small-size bitmap strikes can quantize advances (Cambria's 9pt
  // digits are one example). Use outline-scale advances for chart geometry.
  const width = Math.max(0, ...labels.map(label => ctx.measureText(label).width * resolved.fontSize / metricSize));
  ctx.textBaseline = baseline;
  setCanvasTextStyle(ctx, resolved);
  return { labelBand, centerBaseline, boxHeight, ascent, descent, width };
}

export function chartText(ctx, text, x, y, width, style) {
  if (!style) { ctx.fillText(text, x, y, width); return; }
  const scale = style.fontSize / metricSize;
  ctx.save(); setCanvasTextStyle(ctx, metricStyle(style)); ctx.scale(scale, scale);
  ctx.fillText(text, x / scale, y / scale, width / scale); ctx.restore();
}
export function chartSegments(series, grouping = 'clustered') {
  if (grouping === 'clustered') return series.map(s => s.values.map(value => ({ start: 0, end: value })));
  const positive = series[0].values.map(() => 0), negative = [...positive];
  const totals = grouping === 'percentStacked' ? positive.map((_, i) => series.reduce((sum, s) => sum + Math.abs(s.values[i]), 0)) : null;
  return series.map(s => s.values.map((value, i) => {
    const amount = grouping === 'percentStacked' ? (totals[i] ? value / totals[i] : 0) : value;
    const stack = amount < 0 ? negative : positive, start = stack[i];
    stack[i] += amount;
    return { start, end: stack[i] };
  }));
}
export function chartScale(series, grouping = 'clustered', intervals) {
  const values = grouping === 'clustered' ? series.flatMap(s => s.values) : chartSegments(series, grouping).flatMap(s => s.map(v => v.end));
  let low = Math.min(0, ...values), high = Math.max(0, ...values);
  const percent = grouping === 'percentStacked';
  if (percent && low === high) high = 1;
  const positiveCluster = grouping === 'clustered' && low === 0 && high > 0;
  if (positiveCluster) high *= 1.05;
  const rough = (high - low || 1) / (intervals || (percent || positiveCluster ? 10 : 5)), power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].find(n => n * power >= rough) * power;
  if (grouping === 'stacked') {
    const extra = (high - low) * .05;
    if (low < 0) low -= extra;
    if (high > 0) high += extra;
  }
  const epsilon = grouping === 'clustered' ? 0 : 1e-10;
  return { min: Math.floor(low / step + epsilon) * step || 0, max: low === high ? step : Math.ceil(high / step - epsilon) * step || 0, step };
}
// Automatic bottom legends use the font face box for keys and entry spacing.
// Original reference controls cover sizes, families, widths and multi-row legends.
function bottomLegendLayout(ctx, chart, width, height, fallbackSize) {
  const style = chart.legendText, labels = chart.series.map(s => s.name);
  const metrics = axisMetrics(ctx, style, labels, fallbackSize), h = metrics.boxHeight;
  setCanvasTextStyle(ctx, metricStyle(style));
  const widths = labels.map(t => ctx.measureText(t).width * style.fontSize / metricSize + .9 * h);
  const available = width * .9, total = widths.reduce((a,b) => a+b, 0);
  const multiple = total > available, max = Math.max(...widths);
  const columns = multiple ? Math.max(1, Math.floor(available / max)) : labels.length;
  const rows = Math.ceil(labels.length / columns), rowHeight = .99 * h + 8;
  const boxWidth = multiple ? columns * max : Math.min(available, total * 1.2);
  const boxHeight = rows * rowHeight - (rows > 1 ? 2 : 0);
  const x = (width - boxWidth) / 2, y = height - 8 - boxHeight;
  const gap = multiple ? 0 : (boxWidth - total) / (labels.length + 1);
  const indices = labels.map((_,i) => i);
  if (columns === 1 && chart.grouping !== 'clustered') indices.reverse();
  let at = x + gap;
  const entries = indices.map((index, i) => {
    const left = multiple ? x + (i % columns) * max : at;
    at += widths[index] + gap;
    return { index, x: left, y: y + 4 + Math.floor(i / columns) * rowHeight };
  });
  return { h, metrics, entries, height: boxHeight, style };
}
function paintBottomLegend(ctx, chart, box) {
  const { h, style, metrics } = box;
  for (const entry of box.entries) {
    const series = chart.series[entry.index], keyX = entry.x + .225 * h + 1, keyY = entry.y + .27 * h, size = .45 * h;
    if (series.fill) { ctx.fillStyle = series.fill; ctx.fillRect(keyX, keyY, size, size); }
    if (series.line) { ctx.strokeStyle = series.line; ctx.lineWidth = 1; ctx.strokeRect(keyX, keyY, size, size); }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#' + style.color;
    chartText(ctx, series.name, entry.x + .9 * h + .5, entry.y + metrics.centerBaseline + h / 2, 1e6, style);
  }
}
export function paintChart(ctx, chart, width, height) {
  // Generated doughnut titles and legend-free doughnuts keep their native-referenced painter.
  if (chart.type === 'pie' || chart.type === 'doughnut' && (chart.legend || chart.title?.paragraphs)) return paintPieChart(ctx, chart, width, height);
  if (chart.type === 'doughnut') return paintDoughnutChart(ctx,chart,width,height);
  if (chart.type && chart.type !== 'column') return paintXYChart(ctx, chart, width, height);
  const { series, categoryAxis, valueAxis } = chart;
  let scale = chartScale(series, chart.grouping);
  const segments = chart.grouping && chart.grouping !== 'clustered' ? chartSegments(series, chart.grouping) : null;
  const fontSize = Math.max(8, Math.min(13, height / 18));
  ctx.save(); ctx.font = `${fontSize}px Arial, sans-serif`; ctx.textBaseline = 'middle';
  const textStyle = style => {
    if (style) setCanvasTextStyle(ctx, { fontAscii: 'Arial', fontSize: fontSize * .75, ...style });
    else ctx.font = `${fontSize}px Arial, sans-serif`;
    ctx.fillStyle = style?.color ? `#${style.color}` : '#222222';
  };
  const fill = (color, x, y, w, h) => { if (color) { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); } };
  const stroke = (color, x1, y1, x2, y2) => { if (color) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); } };
  fill(chart.background.fill, 0, 0, width, height);
  textStyle(chart.legendText);
  const bottomLegend = chart.legend && chart.legendPosition === 'b' ? bottomLegendLayout(ctx, chart, width, height, fontSize) : null;
  const legendWidth = chart.legend && !bottomLegend ? Math.min(width * .3, Math.max(...series.map(s => ctx.measureText(s.name).width)) + 28) : 0;
  const percentLabels = valueAxis.numberFormat === '0%' || !valueAxis.numberFormat && chart.grouping === 'percentStacked';
  const label = v => percentLabels ? `${Math.round(v * 100)}%` : Number(v.toPrecision(8)).toString();
  const valueText = valueAxis.text && axisMetrics(ctx, valueAxis.text, [], fontSize);
  const categoryText = categoryAxis.text && axisMetrics(ctx, categoryAxis.text, series[0].categories, fontSize);
  const titleBox = chart.title && columnTitleLayout(ctx, chart.title, width);
  const axisTop = valueText ? Math.max(11 * 4 / 3, 5 * 4 / 3 + valueText.boxHeight / 2) : fontSize;
  const top = Math.max(axisTop, titleBox && !chart.title.overlay ? titleBox.plotTop + Math.max(0, axisTop - 11 * 4 / 3) : 0);
  const right = width - legendWidth - (valueText ? 11 * 4 / 3 : fontSize);
  // Labels next to a zero axis inside/above the plot do not consume a bottom
  // category band. Reserve the bottom value tick's half-box instead.
  const bottomInset = categoryText ? scale.min < 0 && valueText ? axisTop : 6.5 * 4 / 3 + categoryText.labelBand : fontSize * 2.5;
  const bottom = height - bottomInset - (bottomLegend ? bottomLegend.height + 8 : 0);
  const plotHeight = Math.max(1, bottom - top);
  if (valueText && chart.grouping === 'clustered' && scale.min === 0 && series.some(s => s.values.some(v => v > 0))) {
    const intervals = Math.max(2, Math.min(10, Math.floor(plotHeight / (valueText.boxHeight * 1.1))));
    scale = chartScale(series, chart.grouping, intervals);
  }
  const ticks = Array.from({ length: Math.round((scale.max - scale.min) / scale.step) + 1 }, (_, i) => scale.min + i * scale.step);
  if (valueText) {
    setCanvasTextStyle(ctx, metricStyle(valueAxis.text));
    valueText.width = Math.max(0, ...ticks.map(v => ctx.measureText(label(v)).width * valueAxis.text.fontSize / metricSize));
  }
  const left = valueText ? 6.5 * 4 / 3 + valueText.width + valueText.labelBand / 2 : fontSize * 3.5;
  const plotWidth = Math.max(1, right - left);
  const y = v => bottom - (v - scale.min) / (scale.max - scale.min) * plotHeight;
  fill(chart.plot.fill, left, top, plotWidth, plotHeight);
  ctx.textAlign = 'right'; textStyle(valueAxis.text);
  ctx.textBaseline = valueText ? 'alphabetic' : 'middle';
  for (let i = 0; i <= Math.round((scale.max - scale.min) / scale.step); i++) {
    const value = scale.min + i * scale.step, at = y(value);
    stroke(valueAxis.grid, left, at, right, at); if (valueAxis.ticks) stroke(valueAxis.line, left - 4, at, left, at);
    chartText(ctx, label(value), left - (valueText ? valueText.labelBand / 2 : 7), at + (valueText ? valueText.centerBaseline : 0), valueText ? Math.max(1, valueText.width) : left - 8, valueText ? { fontAscii: 'Arial', fontSize: fontSize * .75, ...valueAxis.text } : null);
  }
  const overlap = (chart.overlap || 0) / 100, stride = 1 - overlap;
  const clusterUnits = 1 + (series.length - 1) * stride;
  const slot = plotWidth / series[0].values.length, barWidth = slot / (clusterUnits + chart.gap / 100), cluster = barWidth * clusterUnits;
  series[0].categories.forEach((_, i) => { const x = left + (i + .5) * slot; stroke(categoryAxis.grid, x, top, x, bottom); });
  series.forEach((s, si) => s.values.forEach((value, i) => {
    const from = segments ? segments[si][i].start : 0, to = segments ? segments[si][i].end : value;
    const x = left + i * slot + (slot - cluster) / 2 + si * barWidth * stride, upper = Math.min(y(from), y(to)), h = Math.abs(y(to) - y(from));
    if (!h) return;
    const inverted = value < 0 && s.invertIfNegative && s.fill;
    fill(inverted ? '#ffffff' : s.fill, x, upper, barWidth, h);
    const line = s.line || (inverted ? '#000000' : null);
    if (line) { ctx.strokeStyle = line; ctx.lineJoin = s.lineJoin || 'miter'; ctx.strokeRect(x, upper, barWidth, h); }
  }));
  stroke(valueAxis.line, left, top, left, bottom); stroke(categoryAxis.line, left, y(0), right, y(0));
  ctx.textAlign = 'center'; textStyle(categoryAxis.text);
  ctx.textBaseline = categoryText ? 'alphabetic' : 'middle';
  series[0].categories.forEach((name, i) => {
    const x = left + (i + .5) * slot;
    if (categoryAxis.ticks) stroke(categoryAxis.line, x, y(0), x, y(0) + 4);
    chartText(ctx, name, x, categoryText ? y(0) + categoryText.labelBand - categoryText.descent : Math.min(height - fontSize, y(0) + fontSize * 1.3), slot - 4, categoryText ? { fontAscii: 'Arial', fontSize: fontSize * .75, ...categoryAxis.text } : null);
  });
  if (chart.plot.line) { ctx.strokeStyle = chart.plot.line; ctx.lineJoin = chart.plot.lineJoin || 'miter'; ctx.strokeRect(left, top, plotWidth, plotHeight); }
  if (bottomLegend) paintBottomLegend(ctx, chart, bottomLegend);
  else if (chart.legend) series.forEach((s, i) => {
    const x = right + fontSize, at = height / 2 + (i - (series.length - 1) / 2) * fontSize * 1.7;
    fill(s.fill, x, at - 4, 9, 9); textStyle(chart.legendText); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillText(s.name, x + 14, at, legendWidth - 20);
  });
  if (titleBox) paintColumnTitle(ctx, chart.title, titleBox);
  if (chart.background.line) { ctx.strokeStyle = chart.background.line; ctx.lineJoin = chart.background.lineJoin || 'miter'; ctx.strokeRect(.5, .5, width - 1, height - 1); }
  ctx.restore();
}
export async function decodeChart(asset, fontAlternatives) {
  // Scatter X axes are value axes; present them where the font collector looks.
  const fonts = asset.chart.xAxis ? { ...asset, chart: { ...asset.chart, categoryAxis: asset.chart.xAxis } } : asset;
  if (asset.chart.title?.style || asset.chart.text || fonts.chart.categoryAxis?.text || asset.chart.valueAxis?.text || asset.chart.legendText) await loadCanvasFonts({ paragraphs: [], assets: { chart: fonts }, styles: { fontAlternatives } });
  const canvas = new OffscreenCanvas(asset.width * 2, asset.height * 2), ctx = canvas.getContext('2d');
  setCanvasFontAlternatives(ctx, fontAlternatives);
  ctx.scale(2, 2); paintChart(ctx, asset.chart, asset.width, asset.height);
  const bitmap = canvas.transferToImageBitmap();
  decodedCharts.set(bitmap, {chart: asset.chart, fontAlternatives});
  return bitmap;
}
