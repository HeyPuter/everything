// Original cached-chart painter for horizontal bar, line, area and scatter
// charts. Automatic plot geometry (insets, tick density, legend placement) is a
// consumer layout choice; OOXML leaves it to the application when unspecified.
import { chartScale, chartSegments, axisMetrics, chartText } from './canvas-charts.js';
import { columnTitleLayout, paintColumnTitle } from './canvas-chart-titles.js';
import { measureCanvasText } from './canvas-text.js';

const PAD = 10;
const fallbackText = { fontAscii: 'Arial', fontSize: 9, bold: false, italic: false, color: '595959', kerning: 0 };
export const resolvedChartText = (chart, style) => ({ ...fallbackText, ...chart.text, ...style });
const labelWidth = (ctx, text, style) => measureCanvasText(ctx, text, style).width;

function paintText(ctx, text, x, y, width, style, align) {
  ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = `#${style.color}`;
  chartText(ctx, text, x, y, Math.max(1, width), style);
}
function strokeLine(ctx, color, width, points) {
  if (!color || !width || points.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(...points[0]); for (const p of points.slice(1)) ctx.lineTo(...p); ctx.stroke();
}
// Marker size is in points (c:marker/c:size); the outline is centered on the edge.
export function paintMarker(ctx, marker, x, y) {
  if (!marker) return;
  ctx.beginPath(); ctx.arc(x, y, marker.size * 2 / 3, 0, Math.PI * 2); ctx.closePath();
  if (marker.fill) { ctx.fillStyle = marker.fill; ctx.fill(); }
  if (marker.line && marker.lineWidth) { ctx.strokeStyle = marker.line; ctx.lineWidth = marker.lineWidth; ctx.stroke(); }
}

// Legends flow as one right-hand column, or as centered bottom rows.
export function chartLegendLayout(ctx, entries, style, position, width, height) {
  const metrics = axisMetrics(ctx, style, [], style.fontSize * 4 / 3), h = metrics.boxHeight;
  const keyWidth = entries.some(e => e.stroke) ? h * 1.6 : h * .7, gap = h * .4, rowHeight = h * 1.3;
  const sized = entries.map(e => ({ ...e, width: keyWidth + gap + labelWidth(ctx, e.name, style) }));
  let rows;
  if (position === 'r') rows = sized.map(e => [e]);
  else {
    rows = [[]]; let used = 0;
    for (const e of sized) {
      if (rows.at(-1).length && used + e.width > width * .9) { rows.push([]); used = 0; }
      rows.at(-1).push(e); used += e.width + h;
    }
  }
  const boxWidth = position === 'r' ? Math.min(width * .35, Math.max(...sized.map(e => e.width))) : Math.max(...rows.map(r => r.reduce((n, e) => n + e.width, 0) + h * (r.length - 1)));
  const boxHeight = rows.length * rowHeight, placed = [];
  const top = position === 'r' ? (height - boxHeight) / 2 : height - PAD - boxHeight;
  rows.forEach((row, r) => {
    let x = position === 'r' ? width - PAD - boxWidth : (width - (row.reduce((n, e) => n + e.width, 0) + h * (row.length - 1))) / 2;
    for (const e of row) { placed.push({ ...e, x, y: top + (r + .5) * rowHeight, width: position === 'r' ? boxWidth : e.width }); x += e.width + h; }
  });
  return { entries: placed, width: boxWidth, height: boxHeight, position, style, metrics, keyWidth, gap };
}
export function paintChartLegend(ctx, legend) {
  const { metrics, keyWidth, gap, style } = legend, h = metrics.boxHeight;
  for (const e of legend.entries) {
    if (e.stroke) {
      strokeLine(ctx, e.line, Math.min(e.lineWidth || 1, h / 3), [[e.x, e.y], [e.x + keyWidth, e.y]]);
      paintMarker(ctx, e.marker && { ...e.marker, size: Math.min(e.marker.size, h * .6) }, e.x + keyWidth / 2, e.y);
    } else {
      const size = h * .6;
      if (e.fill) { ctx.fillStyle = e.fill; ctx.fillRect(e.x, e.y - size / 2, size, size); }
      if (e.line) { ctx.strokeStyle = e.line; ctx.lineWidth = 1; ctx.strokeRect(e.x, e.y - size / 2, size, size); }
    }
    paintText(ctx, e.name, e.x + keyWidth + gap, e.y + metrics.centerBaseline, e.width - keyWidth - gap, style, 'left');
  }
}

const percentLabel = (axis, grouping) => axis.numberFormat === '0%' || !axis.numberFormat && grouping === 'percentStacked';
const tickLabel = percent => v => percent ? `${Math.round(v * 100)}%` : Number(v.toPrecision(8)).toString();
const ticksOf = scale => Array.from({ length: Math.round((scale.max - scale.min) / scale.step) + 1 }, (_, i) => scale.min + i * scale.step);

export function paintXYChart(ctx, chart, width, height) {
  const { type, series, valueAxis } = chart, horizontal = type === 'bar', scatter = type === 'scatter';
  const crossAxis = scatter ? chart.xAxis : chart.categoryAxis;
  const grouping = type === 'line' || scatter || type === 'area' && chart.grouping === 'standard' ? 'clustered' : chart.grouping;
  const valueStyle = resolvedChartText(chart, valueAxis.text), crossStyle = resolvedChartText(chart, crossAxis.text);
  ctx.save();
  const rect = (style, x, y, w, h) => {
    if (style?.fill) { ctx.fillStyle = style.fill; ctx.fillRect(x, y, w, h); }
    if (style?.line) { ctx.strokeStyle = style.line; ctx.lineWidth = style.lineWidth || 1; ctx.lineJoin = style.lineJoin || 'miter'; ctx.strokeRect(x, y, w, h); }
  };
  rect({ fill: chart.background.fill }, 0, 0, width, height);
  const titleBox = chart.title && columnTitleLayout(ctx, chart.title, width);
  const legendStyle = resolvedChartText(chart, chart.legendText);
  const entries = series.map(s => type === 'line' || scatter
    ? { name: s.name, stroke: true, line: s.line, lineWidth: s.lineWidth, marker: s.marker }
    : { name: s.name, fill: s.fill, line: s.line });
  const legend = chart.legend && chartLegendLayout(ctx, entries, legendStyle, chart.legendPosition || 'r', width, height);
  const valueMetrics = axisMetrics(ctx, valueStyle, [], 12), crossMetrics = axisMetrics(ctx, crossStyle, [], 12);

  // Scales: the value axis follows the grouping; scatter X has its own scale.
  const xValues = scatter ? series.flatMap(s => s.xValues) : [];
  let scale = chartScale(series, grouping), xScale = scatter ? chartScale([{ values: xValues }], 'clustered') : null;
  const percent = percentLabel(valueAxis, chart.grouping), valueLabel = tickLabel(percent), xLabel = tickLabel(false);
  const top = titleBox && !chart.title.overlay ? titleBox.plotTop : PAD + valueMetrics.boxHeight / 2;
  const bottom = height - PAD - (legend?.position === 'b' ? legend.height + PAD / 2 : 0) - (horizontal ? valueMetrics : crossMetrics).labelBand;
  const categories = scatter ? [] : series[0].categories, midCat = valueAxis.crossBetween === 'midCat' && !scatter, count = categories.length;
  const leftLabels = horizontal ? categories : ticksOf(scale).map(valueLabel);
  // Labels centered on the plot's horizontal ends (value ticks along the
  // bottom, edge categories) overhang it by half their width.
  const bottomLabels = horizontal ? ticksOf(scale).map(valueLabel) : scatter ? ticksOf(xScale).map(xLabel) : midCat ? [categories[0], categories.at(-1)] : [];
  const overhang = (text, style) => text === undefined ? 0 : labelWidth(ctx, text, style) / 2;
  const bottomStyle = horizontal ? valueStyle : crossStyle;
  const left = Math.max(PAD + overhang(bottomLabels[0], bottomStyle), PAD + Math.min(width * .3, Math.max(0, ...leftLabels.map(t => labelWidth(ctx, t, horizontal ? crossStyle : valueStyle)))) + valueMetrics.boxHeight / 2);
  const right = width - PAD - (legend?.position === 'r' ? legend.width + PAD : 0) - overhang(bottomLabels.at(-1), bottomStyle);
  const plotWidth = Math.max(1, right - left), plotHeight = Math.max(1, bottom - top);
  // Tick density follows the label size along each value axis.
  const valueLength = horizontal ? plotWidth : plotHeight;
  const spacing = horizontal ? Math.max(...ticksOf(scale).map(v => labelWidth(ctx, valueLabel(v), valueStyle))) + 2 * valueMetrics.boxHeight : valueMetrics.boxHeight * 2.2;
  scale = chartScale(series, grouping, Math.max(2, Math.min(10, Math.floor(valueLength / spacing))));
  if (scatter) xScale = chartScale([{ values: xValues }], 'clustered', Math.max(2, Math.min(10, Math.floor(plotWidth / (Math.max(...ticksOf(xScale).map(v => labelWidth(ctx, xLabel(v), crossStyle))) + 2 * crossMetrics.boxHeight)))));
  const span = scale.max - scale.min || 1;
  const valueAt = v => horizontal ? left + (v - scale.min) / span * plotWidth : bottom - (v - scale.min) / span * plotHeight;
  const xAt = v => left + (v - xScale.min) / (xScale.max - xScale.min || 1) * plotWidth;
  const slot = (horizontal ? plotHeight : plotWidth) / (midCat ? Math.max(1, count - 1) : count);
  const categoryAt = i => horizontal ? bottom - (i + .5) * slot : left + (midCat ? (count > 1 ? i * slot : plotWidth / 2) : (i + .5) * slot);
  const zero = valueAt(Math.min(scale.max, Math.max(scale.min, 0)));
  rect({ fill: chart.plot.fill }, left, top, plotWidth, plotHeight);

  // Gridlines, then data, then axis lines and labels over the data.
  for (const v of ticksOf(scale)) { const at = valueAt(v); strokeLine(ctx, valueAxis.grid, 1, horizontal ? [[at, top], [at, bottom]] : [[left, at], [right, at]]); }
  if (scatter) for (const v of ticksOf(xScale)) strokeLine(ctx, crossAxis.grid, 1, [[xAt(v), top], [xAt(v), bottom]]);
  else for (let i = 0; i < count; i++) { const at = categoryAt(i); strokeLine(ctx, crossAxis.grid, 1, horizontal ? [[left, at], [right, at]] : [[at, top], [at, bottom]]); }

  if (horizontal) {
    const segments = grouping === 'clustered' ? null : chartSegments(series, grouping), stride = 1 - (chart.overlap || 0) / 100;
    const units = 1 + (series.length - 1) * stride, thickness = slot / (units + chart.gap / 100), cluster = thickness * units;
    series.forEach((s, si) => s.values.forEach((value, i) => {
      const from = segments ? segments[si][i].start : 0, to = segments ? segments[si][i].end : value;
      const y = categoryAt(i) + cluster / 2 - (si * thickness * stride) - thickness, x = Math.min(valueAt(from), valueAt(to)), w = Math.abs(valueAt(to) - valueAt(from));
      if (w) rect({ fill: s.fill, line: s.line, lineJoin: s.lineJoin }, x, y, w, thickness);
    }));
  } else if (type === 'area') {
    const segments = chartSegments(series, grouping === 'clustered' ? 'stacked' : grouping);
    series.forEach((s, si) => {
      const upper = s.values.map((v, i) => [categoryAt(i), valueAt(grouping === 'clustered' ? v : segments[si][i].end)]);
      const lower = s.values.map((_, i) => [categoryAt(i), grouping === 'clustered' ? zero : valueAt(segments[si][i].start)]).reverse();
      ctx.beginPath(); ctx.moveTo(...upper[0]); for (const p of [...upper.slice(1), ...lower]) ctx.lineTo(...p); ctx.closePath();
      if (s.fill) { ctx.fillStyle = s.fill; ctx.fill(); }
      if (s.line) { ctx.strokeStyle = s.line; ctx.lineWidth = 1; ctx.lineJoin = s.lineJoin || 'miter'; ctx.stroke(); }
    });
  } else {
    for (const s of series) {
      const points = s.values.map((v, i) => [scatter ? xAt(s.xValues[i]) : categoryAt(i), valueAt(v)]);
      strokeLine(ctx, s.line, s.lineWidth, points);
      for (const [x, y] of points) paintMarker(ctx, s.marker, x, y);
    }
  }

  // Axis lines cross at zero (autoZero) on the opposite axis.
  const crossZero = scatter ? xAt(Math.min(xScale.max, Math.max(xScale.min, 0))) : null;
  if (horizontal) { strokeLine(ctx, crossAxis.line, 1, [[zero, top], [zero, bottom]]); strokeLine(ctx, valueAxis.line, 1, [[left, bottom], [right, bottom]]); }
  else { strokeLine(ctx, crossAxis.line, 1, [[left, zero], [right, zero]]); strokeLine(ctx, valueAxis.line, 1, scatter ? [[crossZero, top], [crossZero, bottom]] : [[left, top], [left, bottom]]); }
  for (const v of ticksOf(scale)) {
    const at = valueAt(v);
    if (horizontal) paintText(ctx, valueLabel(v), at, bottom + valueMetrics.labelBand - valueMetrics.descent, plotWidth, valueStyle, 'center');
    else paintText(ctx, valueLabel(v), left - valueMetrics.boxHeight / 2, at + valueMetrics.centerBaseline, left - PAD, valueStyle, 'right');
  }
  if (scatter) for (const v of ticksOf(xScale)) paintText(ctx, xLabel(v), xAt(v), bottom + crossMetrics.labelBand - crossMetrics.descent, plotWidth, crossStyle, 'center');
  else categories.forEach((name, i) => {
    const at = categoryAt(i);
    if (horizontal) paintText(ctx, name, left - valueMetrics.boxHeight / 2, at + crossMetrics.centerBaseline, left - PAD, crossStyle, 'right');
    else paintText(ctx, name, at, bottom + crossMetrics.labelBand - crossMetrics.descent, midCat ? plotWidth / Math.max(1, count) : slot - 4, crossStyle, 'center');
  });
  rect({ line: chart.plot.line, lineJoin: chart.plot.lineJoin }, left, top, plotWidth, plotHeight);
  if (legend) paintChartLegend(ctx, legend);
  if (titleBox) paintColumnTitle(ctx, chart.title, titleBox);
  rect({ line: chart.background.line, lineJoin: chart.background.lineJoin }, .5, .5, width - 1, height - 1);
  ctx.restore();
}
