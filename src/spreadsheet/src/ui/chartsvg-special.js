/**
 * The newer chart types drawn as SVG: treemap, sunburst, box and whisker, funnel, stock and surface
 * (3-D surface and wireframe as a projected mesh, contour as a 2-D map of value bands). Pure like
 * chartsvg.js: data in, markup out. A chart in the default style draws in its appearance's fonts,
 * colours and layout; an older app chart in the theme's own colours.
 */
import { axisLabel, niceScale, chartPointStyle } from '../core/charts.js';
import { chartAxisScale } from '../core/chart-axis-scale.js';
import { formatValue, fontStack } from '../core/format.js';
import { bandPolygon, boxGroups, boxStats, buildHierarchy, hierarchyDepth, hierarchyNodes, isoSegment, stockSeries, sunburstLayout,
  surfaceBands, surfaceGrid, surfaceTriangles, topAncestor, treemapLayout } from '../core/chart-special.js';
import { seriesColor, seriesPaint, inkOn, svgEsc as esc, svgNum as f, chartTipText as tipText, layoutLegend, chartAreaRect, elementEffectDefs,
  effectAttr, chartTextBox, legendBoxRect, axisTextWidth, scaleTicks, chartMarker, categoryShortener, shadeColor, PLOT_STYLE, MAX_LEGEND, MARK_BUDGET } from './chartsvg.js';

export const SPECIAL_CHART_TYPES = new Set(['treemap', 'sunburst', 'boxWhisker', 'funnel', 'stock', 'surface']);

const TYPE_NAMES = { treemap: 'Treemap', sunburst: 'Sunburst', boxWhisker: 'Box and whisker chart', funnel: 'Funnel chart', stock: 'Stock chart', surface: 'Surface chart' };

/** Text styles: the appearance's, or the theme's ink for an app chart without one. */
function textStyles(a) {
  if (a) {
    return { title: a.titleStyle, legend: a.legendStyle, axis: a.xStyle, value: a.yStyle,
      label: a.valueLabels?.find(l => l?.style)?.style || { ...a.xStyle, color: a.xStyle.color } };
  }
  return { title: { size: 15, color: 'var(--ink)', bold: true }, legend: { size: 12, color: 'var(--ink-2)' },
    axis: { size: 11, color: 'var(--ink-3)' }, value: { size: 11, color: 'var(--ink-3)' }, label: { size: 11, color: 'var(--ink-2)' } };
}

function textAttrs(style) {
  return `${style.font ? ` font-family="${esc(fontStack(style.font))}"` : ''} font-size="${style.size}"${style.bold ? ' font-weight="700"' : ''}${style.italic ? ' font-style="italic"' : ''} fill="${esc(style.color)}"`;
}
const text = (value, x, y, style, anchor = 'start', extra = '') => `<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}"${textAttrs(style)}${extra ? ` ${extra}` : ''}>${esc(value)}</text>`;
/** Cut `value` to fit `width` at `style`'s size, by whole characters, with an ellipsis; '' when not even one fits. */
function fitText(value, width, style) {
  const s = String(value ?? '');
  if (axisTextWidth(s, style) <= width) return s;
  const chars = Array.from(s);
  for (let n = chars.length - 1; n > 0; n--) {
    const cut = `${chars.slice(0, n).join('')}…`;
    if (axisTextWidth(cut, style) <= width) return cut;
  }
  return '';
}

/**
 * The frame every type shares: the chart area, title and legend, and the plot box left for the
 * picture. `entries` are the legend's: { name, i, paint, key: 'box' | 'line' | 'marker', stroke }.
 */
function chartFrame(chart, width, height, entries, describe) {
  const W = Math.max(120, width), H = Math.max(80, height), a = chart.appearance || null, st = textStyles(a);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(chart.description || chart.title || TYPE_NAMES[chart.type] || 'Chart')}" style="${PLOT_STYLE}">`];
  if (describe) parts.push(`<desc>${esc(describe)}</desc>`);
  parts.push(a ? chartAreaRect(a, W, H) + elementEffectDefs(a) : `<rect width="${W}" height="${H}" fill="var(--surface)"/>`);
  let titleBottom = 0;
  if (chart.title) {
    const x = a?.title ? a.title.x * W : W / 2, y = (a?.title?.y ?? .035) * H + st.title.size;
    if (a) parts.push(chartTextBox(a.titleBox, a.effects?.title, chart.title, x, y, st.title, a.title ? 'start' : 'middle', 'title'));
    parts.push(text(fitText(chart.title, W - 16, st.title), x, y, st.title, a?.title ? 'start' : 'middle', 'data-el="title"'));
    titleBottom = y + st.title.size * .35;
  }
  const shown = entries.filter(e => !a?.legendHidden?.includes(e.i)).slice(0, MAX_LEGEND).map(e => ({ ...e, keyWidth: e.key === 'line' ? st.legend.size * 1.6 : st.legend.size * .7 }));
  const manual = a?.legend && a.legendPos === chart.legendPos ? a.legend : null;
  const box = manual ? { x: manual.x * W, y: manual.y * H, w: (manual.w ?? .25) * W, h: (manual.h ?? .1) * H }
    : chart.legendPos === 'right' ? { x: W * .78, y: Math.max(titleBottom + 12, H * .15), w: W * .21 } : null;
  const legend = chart.legend !== false && shown.length ? layoutLegend(shown, st.legend, W, H, chart.legendPos, titleBottom, box, chart.legendPos === 'right') : null;
  const top = Math.max(titleBottom + 10, legend && !manual && chart.legendPos === 'top' ? legend.y + legend.h + st.legend.size / 2 : 0, 8);
  const bottom = legend && !manual && chart.legendPos !== 'top' && chart.legendPos !== 'right' ? legend.y - st.legend.size / 2 : H - 8;
  const right = legend && !manual && chart.legendPos === 'right' ? legend.x - 10 : W - 10;
  const plot = a?.plot ? { x: a.plot.x * W, y: a.plot.y * H, w: (a.plot.w ?? .8) * W, h: (a.plot.h ?? .7) * H }
    : { x: 10, y: top, w: Math.max(10, right - 10), h: Math.max(10, bottom - top) };
  const drawLegend = () => {
    if (!legend) return '';
    const out = [`<g data-el="legend"${a ? effectAttr(a, 'legend') : ''}>`, a ? legendBoxRect(a.legendBox, legend, st.legend.size) : ''];
    for (const e of legend.entries) {
      const k = e.keyWidth;
      if (e.key === 'line') out.push(`<line x1="${f(e.x)}" y1="${f(e.y)}" x2="${f(e.x + k)}" y2="${f(e.y)}" stroke="${esc(e.paint)}" stroke-width="2"/>`);
      else if (e.key === 'marker') out.push(chartMarker(e.symbol || 'circle', e.x + k / 2, e.y, Math.min(k, 7), e.paint, e.stroke || e.paint, '', 'chart-legend-marker'));
      else out.push(`<rect x="${f(e.x)}" y="${f(e.y - k / 2)}" width="${f(k)}" height="${f(k)}" fill="${esc(e.paint)}"${e.stroke ? ` stroke="${esc(e.stroke)}"` : ''}/>`);
      e.lines.forEach((line, i) => out.push(text(line, e.textX, e.baseline + i * legend.lineH, st.legend, 'start', 'class="chart-legend-label"')));
    }
    out.push('</g>');
    return out.join('');
  };
  return { W, H, a, st, parts, plot, drawLegend };
}

function message(chart, width, height, note) {
  const fr = chartFrame(chart, width, height, [], note);
  fr.parts.push(text(note, fr.W / 2, fr.plot.y + fr.plot.h / 2, { ...fr.st.axis, size: Math.max(11, fr.st.axis.size) }, 'middle'), '</svg>');
  return fr.parts.join('');
}

/** A value as its data label or tooltip writes it, in the cells' format. */
const valueText = (v, style) => (v == null ? '' : style?.fmt === 'custom' ? formatValue(v, style) : tipText(v, style));
const labelsOn = chart => !!chart.labels;
/** Labels sit in the label style of the series, white or dark ink where they fall on a fill. */
const inkFor = (fill, style) => (/^#[0-9a-f]{6}/i.test(fill) ? inkOn(fill) : style.color);

export function renderSpecialChart(data, chart, width, height) {
  switch (chart.type) {
    case 'treemap': return renderTreemap(data, chart, width, height);
    case 'sunburst': return renderSunburst(data, chart, width, height);
    case 'boxWhisker': return renderBoxWhisker(data, chart, width, height);
    case 'funnel': return renderFunnel(data, chart, width, height);
    case 'stock': return renderStock(data, chart, width, height);
    case 'surface': return renderSurface(data, chart, width, height);
    default: return message(chart, width, height, 'This chart type cannot be drawn');
  }
}

/* ---------- Treemap and sunburst ---------- */

function hierarchyOf(data) {
  const values = data.series[0]?.values || [];
  const paths = data.levels || data.categories.map(c => [String(c ?? '')]);
  return buildHierarchy(paths, values);
}
/** The colour of a node: its level-1 branch's, the chart's own choice for that branch over the palette. */
const branchColor = (chart, root, node) => seriesColor(chart, Math.max(0, root.children.indexOf(topAncestor(node))));
const branchPaint = (chart, root, node) => seriesPaint(chart, Math.max(0, root.children.indexOf(topAncestor(node))));
const pathTip = (node, style) => `${node.path.join(' › ')}: ${valueText(node.value, style)}`;

function renderTreemap(data, chart, width, height) {
  const root = hierarchyOf(data);
  if (!root.children.length) return message(chart, width, height, 'No positive numbers to chart');
  const nodes = hierarchyNodes(root), leaves = nodes.filter(n => !n.children.length);
  const style = data.series[0]?.style ?? data.valueStyle ?? null;
  const entries = root.children.map((n, i) => ({ name: n.name, i, paint: branchPaint(chart, root, n) }));
  const fr = chartFrame(chart, width, height, entries, `Treemap of ${leaves.length} ${leaves.length === 1 ? 'item' : 'items'}${root.children.length > 1 && hierarchyDepth(root) > 1 ? ` in ${root.children.length} groups` : ''}, ${pathTip(root.children[0], style)} the largest group.`);
  const { parts, plot, st, a } = fr;
  const mode = chart.treemapLabels || 'overlapping', labelStyle = st.label;
  const layout = treemapLayout(root, plot, { labels: mode, bannerHeight: labelStyle.size * 1.6, gap: 2 });
  const stroke = a ? (a.background === 'none' ? '#ffffff' : a.background) : 'var(--surface)';
  const marks = [], names = [], leafColors = new Map((a?.pointColors?.[0] || []).map(p => [p.index, p.color]));
  layout.forEach(item => {
    const { node } = item, leaf = !node.children.length;
    const row = node.rows[0] ?? 0, own = leaf ? leafColors.get(row) : null;
    const color = own && own !== 'none' ? own : branchColor(chart, root, node), paint = own || branchPaint(chart, root, node);
    if (leaf) {
      marks.push(`<rect class="chart-treemap-leaf" x="${f(item.x)}" y="${f(item.y)}" width="${f(item.w)}" height="${f(item.h)}" fill="${esc(paint)}" stroke="${esc(stroke)}" stroke-width=".5" data-el="series" data-series="0" data-point="${row}"${a ? effectAttr(a, 'series:0') : ''}><title>${esc(pathTip(node, style))}</title></rect>`);
      if (!labelsOn(chart) || item.w < 14 || item.h < labelStyle.size + 4) return;
      const ink = { ...labelStyle, color: inkFor(color, labelStyle) };
      // A leaf in the top-left corner of its branch leaves room for the branch's overlapping name.
      const branch = topAncestor(node), corner = branch !== node && layout.find(p => p.node === branch);
      const parentLabel = mode === 'overlapping' && corner && Math.abs(corner.x - item.x) < 2 * node.depth && Math.abs(corner.y - item.y) < 2 * node.depth;
      const top = item.y + (parentLabel ? labelStyle.size * 1.4 : 0);
      const lines = [fitText(node.name, item.w - 8, ink), valueText(node.value, node.children.length || node.rows.length !== 1 ? style : chartPointStyle(data.series[0] || {}, row, style))];
      lines.forEach((line, i) => {
        const y = top + 4 + labelStyle.size * (1 + i * 1.2);
        if (line && y < item.y + item.h - 3) names.push(text(i ? fitText(line, item.w - 8, ink) : line, item.x + 4, y, ink, 'start', 'class="chart-data-label" data-el="dataLabels" data-series="0"'));
      });
    } else if (item.header) {
      const banner = shadeColor(color, -.25);
      marks.push(`<rect class="chart-treemap-banner" x="${f(item.x)}" y="${f(item.y)}" width="${f(item.w)}" height="${f(item.header)}" fill="${esc(banner)}"><title>${esc(pathTip(node, style))}</title></rect>`);
      names.push(text(fitText(node.name, item.w - 8, labelStyle), item.x + 4, item.y + item.header / 2 + labelStyle.size * .35, { ...labelStyle, color: inkOn(banner), bold: true }, 'start', 'class="chart-treemap-parent"'));
    } else if (mode === 'overlapping' && node.depth === 1 && item.w > 24 && item.h > labelStyle.size * 2) {
      // Only the top-level branches are named over their boxes; deeper names would pile into the same corner.
      const big = { ...labelStyle, size: labelStyle.size * 1.15, bold: true, color: inkFor(color, labelStyle) };
      names.push(text(fitText(node.name, item.w - 8, big), item.x + 4, item.y + 4 + big.size, big, 'start', 'class="chart-treemap-parent"'));
    }
  });
  parts.push('<g class="chart-treemap">', ...marks, '</g>', ...names, fr.drawLegend(), '</svg>');
  return parts.join('');
}

function arcPath(cx, cy, r0, r1, a0, a1) {
  // Angles run clockwise from the top.
  const pt = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  const full = a1 - a0 >= Math.PI * 2 - 1e-9;
  if (full) {
    const ring = (r, sweep) => `M ${f(cx)} ${f(cy - r)} A ${f(r)} ${f(r)} 0 1 ${sweep} ${f(cx)} ${f(cy + r)} A ${f(r)} ${f(r)} 0 1 ${sweep} ${f(cx)} ${f(cy - r)} Z`;
    return ring(r1, 1) + (r0 > 0 ? ` ${ring(r0, 0)}` : '');
  }
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x1, y1] = pt(r1, a0), [x2, y2] = pt(r1, a1), [x3, y3] = pt(r0, a1), [x4, y4] = pt(r0, a0);
  return `M ${f(x1)} ${f(y1)} A ${f(r1)} ${f(r1)} 0 ${large} 1 ${f(x2)} ${f(y2)} L ${f(x3)} ${f(y3)}${r0 > 0 ? ` A ${f(r0)} ${f(r0)} 0 ${large} 0 ${f(x4)} ${f(y4)}` : ''} Z`;
}

function renderSunburst(data, chart, width, height) {
  const root = hierarchyOf(data);
  if (!root.children.length) return message(chart, width, height, 'No positive numbers to chart');
  const style = data.series[0]?.style ?? data.valueStyle ?? null;
  const depth = hierarchyDepth(root), arcs = sunburstLayout(root);
  const entries = root.children.map((n, i) => ({ name: n.name, i, paint: branchPaint(chart, root, n) }));
  const fr = chartFrame(chart, width, height, entries, `Sunburst of ${depth} ${depth === 1 ? 'ring' : 'rings'} around ${root.children.length} ${root.children.length === 1 ? 'branch' : 'branches'}; ${pathTip(root.children[0], style)} the largest.`);
  const { parts, plot, st, a } = fr;
  const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2, R = Math.max(10, Math.min(plot.w, plot.h) / 2);
  const hole = R / (depth + 1) * .45, ring = (R - hole) / Math.max(1, depth);
  const stroke = a ? (a.background === 'none' ? '#ffffff' : a.background) : 'var(--surface)';
  const marks = [], labels = [];
  const many = arcs.length > MARK_BUDGET;
  for (const arc of arcs) {
    if (arc.a1 - arc.a0 < 1e-4) continue;
    const { node } = arc, base = branchColor(chart, root, node);
    // Deeper rings take lighter tints of their branch, so each ring reads apart from the next.
    const fill = node.depth === 1 ? branchPaint(chart, root, node) : shadeColor(base, Math.min(.55, (node.depth - 1) * .2));
    const r0 = hole + (node.depth - 1) * ring, r1 = r0 + ring, row = node.rows[0] ?? 0;
    marks.push(`<path class="chart-sunburst-arc" d="${arcPath(cx, cy, r0, r1, arc.a0, arc.a1)}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="1"${node.children.length ? '' : ` data-el="series" data-series="0" data-point="${row}"`}>${many ? '' : `<title>${esc(pathTip(node, style))}</title>`}</path>`);
    if (!labelsOn(chart)) continue;
    const mid = (arc.a0 + arc.a1) / 2, rm = (r0 + r1) / 2, room = Math.min(ring - 4, 2 * rm * Math.sin(Math.min(Math.PI / 2, (arc.a1 - arc.a0) / 2)) - 4);
    const color = /^#/.test(fill) ? fill : base, ink = { ...st.label, color: inkFor(color, st.label) };
    const name = fitText(node.name, Math.max(0, room), ink);
    if (name && ring >= st.label.size + 4) labels.push(text(name, cx + rm * Math.sin(mid), cy - rm * Math.cos(mid) + st.label.size * .35, ink, 'middle', 'class="chart-data-label" data-el="dataLabels" data-series="0"'));
  }
  parts.push('<g class="chart-sunburst">', ...marks, '</g>', ...labels, fr.drawLegend(), '</svg>');
  return parts.join('');
}

/* ---------- Axes shared by box and whisker, stock and contour charts ---------- */

/** A vertical value axis down the left (or right) of `plot`: gridlines, tick labels; narrows the plot to make room. */
function valueAxis(fr, chart, scale, style, { side = 'left', grid = true, format = null } = {}) {
  const { a, st } = fr;
  const ticks = scaleTicks(scale);
  const label = v => (format ? format(v) : a?.yFormat && side === 'left' ? formatValue(v, { fmt: 'custom', code: a.yFormat }) : axisLabel(v, style, scale.step));
  const width = Math.max(0, ...ticks.map(v => axisTextWidth(label(v), st.value))) + 8;
  return { ticks, label, width, draw(plot, y) {
    const out = [];
    const gridStyle = a?.gridlineStyles?.y, gridColor = gridStyle?.color && gridStyle.color !== 'none' ? gridStyle.color : a ? '#d9d9d9' : 'var(--grid)';
    for (const v of ticks) {
      const yy = y(v);
      if (grid && side === 'left') out.push(`<line class="chart-gridline" x1="${f(plot.x)}" y1="${f(yy)}" x2="${f(plot.x + plot.w)}" y2="${f(yy)}" stroke="${esc(gridColor)}" stroke-width="${gridStyle?.width ?? 1}"/>`);
      if (side === 'left' && !a?.hideYAxis) out.push(text(label(v), plot.x - 6, yy + st.value.size * .35, st.value, 'end', 'class="chart-axis-label"'));
      if (side === 'right') out.push(text(label(v), plot.x + plot.w + 6, yy + st.value.size * .35, st.value, 'start', 'class="chart-axis-label chart-axis-y2"'));
    }
    return out.join('');
  } };
}

/** Category labels under slots across `plot`, every k-th where they would collide. */
function categoryAxis(fr, categories, plot, slot) {
  const { a, st } = fr;
  if (a?.hideXAxis || a?.xLabelPosition === 'none') return '';
  const short = categoryShortener(categories, 18);
  const widest = Math.max(0, ...categories.map(c => axisTextWidth(short(c), st.axis)));
  const every = Math.max(1, Math.ceil((widest + 8) / Math.max(1, slot)));
  const axisColor = a?.axisStyles?.x?.color && a.axisStyles.x.color !== 'none' ? a.axisStyles.x.color : a ? '#d9d9d9' : 'var(--grid)';
  const out = [`<line class="chart-axis-line" x1="${f(plot.x)}" y1="${f(plot.y + plot.h)}" x2="${f(plot.x + plot.w)}" y2="${f(plot.y + plot.h)}" stroke="${esc(axisColor)}" stroke-width="1" data-el="xAxis"/>`];
  categories.forEach((c, i) => {
    if (i % every || !c) return;
    out.push(text(short(c), plot.x + slot * (i + .5), plot.y + plot.h + st.axis.size * 1.3, st.axis, 'middle', 'class="chart-axis-label"'));
  });
  return out.join('');
}

/* ---------- Box and whisker ---------- */

function renderBoxWhisker(data, chart, width, height) {
  const opts = chart.box || { quartiles: 'exclusive', meanMarkers: true, meanLine: false, innerPoints: false, outliers: true, gapWidth: 100 };
  const grouped = boxGroups(data);
  const stats = grouped.series.map(s => s.groups.map(values => boxStats(values, opts.quartiles)));
  if (!stats.some(list => list.some(Boolean))) return message(chart, width, height, 'No numbers to chart');
  const entries = grouped.series.map((s, i) => ({ name: s.name, i, paint: seriesPaint(chart, i) }));
  const first = stats.flat().find(Boolean);
  const fr = chartFrame(chart, width, height, entries,
    `Box and whisker chart of ${grouped.series.length} ${grouped.series.length === 1 ? 'series' : 'series'} over ${grouped.categories.length} ${grouped.categories.length === 1 ? 'group' : 'groups'}; first median ${valueText(first.median, data.valueStyle)}.`);
  const { parts, plot, st, a } = fr;
  const all = stats.flat().filter(Boolean);
  const lo = Math.min(...all.map(s => s.min)), hi = Math.max(...all.map(s => s.max));
  const scale = chartAxisScale(lo, hi, { min: chart.yMin, max: chart.yMax, step: a?.yStep, ticks: 5 });
  const axis = valueAxis(fr, chart, scale, data.valueStyle, { grid: chart.gridlines !== false });
  const named = grouped.categories.some(Boolean);
  plot.x += axis.width; plot.w = Math.max(10, plot.w - axis.width - 4);
  if (named) plot.h = Math.max(10, plot.h - st.axis.size * 1.7);
  const y = v => plot.y + plot.h - (v - scale.min) / (scale.max - scale.min || 1) * plot.h;
  parts.push(axis.draw(plot, y));
  const n = grouped.categories.length, slot = plot.w / Math.max(1, n), count = grouped.series.length;
  const gap = Math.max(0, opts.gapWidth ?? 100) / 100, boxW = slot / (count + gap), clip = `box-${Math.random().toString(36).slice(2, 8)}`;
  parts.push(`<clipPath id="${clip}"><rect x="${f(plot.x)}" y="${f(plot.y - 2)}" width="${f(plot.w)}" height="${f(plot.h + 4)}"/></clipPath><g clip-path="url(#${clip})">`);
  const labels = [];
  grouped.series.forEach((series, j) => {
    const style = series.style ?? data.valueStyle, pointColors = new Map((a?.pointColors?.[j] || []).map(p => [p.index, p.color]));
    const means = [];
    stats[j].forEach((s, i) => {
      if (!s) return;
      // A box coloured on its own (Format Data Point) keeps that colour; the rest take the series'.
      const own = pointColors.get(i), color = own && own !== 'none' ? own : seriesColor(chart, j), paint = own || seriesPaint(chart, j), dark = shadeColor(color, -.35);
      const x0 = plot.x + slot * i + boxW * gap / 2 + boxW * j, cxm = x0 + boxW / 2, w = boxW * .8, left = cxm - w / 2;
      const tip = `${series.name}${grouped.categories[i] ? ` · ${grouped.categories[i]}` : ''}: median ${valueText(s.median, style)}, quartiles ${valueText(s.q1, style)}–${valueText(s.q3, style)}, mean ${valueText(s.mean, style)}, ${s.n} ${s.n === 1 ? 'value' : 'values'}`;
      parts.push(`<g class="chart-box" data-el="series" data-series="${j}" data-point="${i}"><title>${esc(tip)}</title>`,
        `<path class="chart-whisker" d="M ${f(cxm)} ${f(y(s.high))} V ${f(y(s.q3))} M ${f(cxm)} ${f(y(s.q1))} V ${f(y(s.low))} M ${f(cxm - w / 4)} ${f(y(s.high))} H ${f(cxm + w / 4)} M ${f(cxm - w / 4)} ${f(y(s.low))} H ${f(cxm + w / 4)}" stroke="${esc(dark)}" stroke-width="1" fill="none"/>`,
        `<rect class="chart-box-body" x="${f(left)}" y="${f(y(s.q3))}" width="${f(w)}" height="${f(Math.max(.75, y(s.q1) - y(s.q3)))}" fill="${esc(paint)}" stroke="${esc(dark)}" stroke-width="1"/>`,
        `<line class="chart-box-median" x1="${f(left)}" y1="${f(y(s.median))}" x2="${f(left + w)}" y2="${f(y(s.median))}" stroke="${esc(inkOn(color))}" stroke-width="1.5"/>`);
      if (opts.meanMarkers) parts.push(chartMarker('x', cxm, y(s.mean), Math.min(8, w / 2), 'none', inkOn(color), '', 'chart-box-mean'));
      if (opts.innerPoints) for (const v of s.inner.slice(0, 400)) parts.push(`<circle class="chart-box-point" cx="${f(cxm)}" cy="${f(y(v))}" r="1.8" fill="${esc(dark)}"/>`);
      if (opts.outliers) for (const v of s.outliers.slice(0, 400)) parts.push(`<circle class="chart-box-outlier" cx="${f(cxm)}" cy="${f(y(v))}" r="2.5" fill="none" stroke="${esc(dark)}" stroke-width="1"><title>${esc(`${series.name}: outlier ${valueText(v, style)}`)}</title></circle>`);
      parts.push('</g>');
      means.push([cxm, y(s.mean)]);
      if (labelsOn(chart) && w >= 4) {
        const ls = st.label;
        for (const v of [s.q3, s.median, s.q1, ...(opts.meanMarkers ? [s.mean] : [])]) labels.push(text(valueText(v, style), left + w + 3, y(v) + ls.size * .35, ls, 'start', `class="chart-data-label" data-el="dataLabels" data-series="${j}"`));
      }
    });
    if (opts.meanLine && means.length > 1) parts.push(`<polyline class="chart-box-mean-line" points="${means.map(p => p.map(f).join(',')).join(' ')}" fill="none" stroke="${esc(shadeColor(seriesColor(chart, j), -.35))}" stroke-width="1.5"/>`);
  });
  parts.push('</g>', ...labels);
  if (named) parts.push(categoryAxis(fr, grouped.categories, plot, slot));
  parts.push(fr.drawLegend(), '</svg>');
  return parts.join('');
}

/* ---------- Funnel ---------- */

function renderFunnel(data, chart, width, height) {
  const s = data.series[0];
  const points = s ? data.categories.map((c, i) => ({ c, i, v: s.values[i] })).filter(p => Number.isFinite(p.v)) : [];
  if (!points.length) return message(chart, width, height, 'No numbers to chart');
  const style = s.style ?? data.valueStyle ?? null;
  const fr = chartFrame(chart, width, height, [{ name: s.name, i: 0, paint: seriesPaint(chart, 0) }],
    `Funnel of ${points.length} stages from ${points[0].c} (${valueText(points[0].v, style)}) to ${points.at(-1).c} (${valueText(points.at(-1).v, style)}).`);
  const { parts, plot, st, a } = fr;
  const short = categoryShortener(points.map(p => p.c), 22);
  const showAxis = !a?.hideXAxis && a?.xLabelPosition !== 'none';
  const labelW = showAxis ? Math.min(plot.w * .35, Math.max(0, ...points.map(p => axisTextWidth(short(p.c), st.axis))) + 10) : 0;
  plot.x += labelW; plot.w = Math.max(10, plot.w - labelW);
  const max = Math.max(...points.map(p => Math.abs(p.v))) || 1;
  const slot = plot.h / points.length, gapWidth = a ? a.gapWidth : 6, barH = slot / (1 + gapWidth / 100), cx = plot.x + plot.w / 2;
  const colors = new Map((a?.pointColors?.[0] || []).map(p => [p.index, p.color]));
  points.forEach((p, k) => {
    const w = Math.max(1, Math.abs(p.v) / max * plot.w), x = cx - w / 2, yy = plot.y + slot * k + (slot - barH) / 2;
    const paint = colors.get(p.i) || seriesPaint(chart, 0), color = colors.get(p.i) || seriesColor(chart, 0);
    parts.push(`<rect class="chart-funnel-bar" x="${f(x)}" y="${f(yy)}" width="${f(w)}" height="${f(barH)}" fill="${esc(paint)}" data-el="series" data-series="0" data-point="${p.i}"${a ? effectAttr(a, 'series:0') : ''}><title>${esc(`${p.c}: ${valueText(p.v, chartPointStyle(s, p.i, style))}`)}</title></rect>`);
    if (showAxis) parts.push(text(short(p.c), plot.x - 8, yy + barH / 2 + st.axis.size * .35, st.axis, 'end', 'class="chart-axis-label"'));
    if (labelsOn(chart) && barH >= st.label.size) {
      const label = valueText(p.v, chartPointStyle(s, p.i, style)), inside = axisTextWidth(label, st.label) + 6 <= w;
      parts.push(text(label, inside ? cx : x + w + 4, yy + barH / 2 + st.label.size * .35, inside ? { ...st.label, color: inkFor(color, st.label) } : st.label, inside ? 'middle' : 'start', 'class="chart-data-label" data-el="dataLabels" data-series="0"'));
    }
  });
  parts.push(fr.drawLegend(), '</svg>');
  return parts.join('');
}

/* ---------- Stock ---------- */

function renderStock(data, chart, width, height) {
  const kind = chart.stock || 'hlc';
  const stock = stockSeries(data, kind);
  if (stock.missing) return message(chart, width, height, `A stock chart needs ${stock.missing.join(', ')} columns, in that order`);
  const n = stock.categories.length, volume = !!stock.volume, open = !!stock.open;
  const priceStyle = stock.styles.close;
  const up = chart.colors?.[volume ? 1 : 0] || (chart.appearance ? '#ffffff' : 'var(--surface)'), down = chart.colors?.[volume ? 2 : 1] || (chart.appearance ? '#404040' : 'var(--ink-2)');
  const lineInk = chart.appearance ? '#404040' : 'var(--ink-2)';
  const entries = [
    ...(volume ? [{ name: stock.names.volume, i: 0, paint: seriesPaint(chart, 0) }] : []),
    ...(open ? [{ name: stock.names.open, i: volume ? 1 : 0, paint: up, stroke: lineInk }] : []),
    { name: stock.names.high, i: (volume ? 1 : 0) + (open ? 1 : 0), paint: lineInk, key: 'line' },
    { name: stock.names.low, i: (volume ? 2 : 1) + (open ? 1 : 0), paint: lineInk, key: 'line' },
    { name: stock.names.close, i: (volume ? 3 : 2) + (open ? 1 : 0), paint: lineInk, key: 'marker', symbol: 'dash' },
  ];
  const prices = [stock.high, stock.low, stock.close, ...(open ? [stock.open] : [])].flat().filter(Number.isFinite);
  if (!prices.length) return message(chart, width, height, 'No prices to chart');
  const last = stock.close.findLastIndex(Number.isFinite);
  const fr = chartFrame(chart, width, height, entries, `Stock chart of ${n} periods; prices from ${valueText(Math.min(...prices), priceStyle)} to ${valueText(Math.max(...prices), priceStyle)}${last >= 0 ? `, last close ${valueText(stock.close[last], priceStyle)}` : ''}.`);
  const { parts, plot, st, a } = fr;
  const priceScale = chartAxisScale(Math.min(...prices), Math.max(...prices), { min: volume ? a?.y2Min : chart.yMin, max: volume ? a?.y2Max : chart.yMax, ticks: 5 });
  const volumes = volume ? stock.volume.filter(Number.isFinite) : [];
  const volumeScale = volume ? chartAxisScale(0, Math.max(0, ...volumes), { min: chart.yMin ?? 0, max: chart.yMax, step: a?.yStep, ticks: 5 }) : null;
  // Volume reads on the left; prices then take the right-hand axis, as the two scales differ by orders of magnitude.
  const left = valueAxis(fr, chart, volume ? volumeScale : priceScale, volume ? stock.styles.volume : priceStyle, { grid: chart.gridlines !== false });
  const right = volume ? valueAxis(fr, chart, priceScale, priceStyle, { side: 'right', grid: false }) : null;
  plot.x += left.width; plot.w = Math.max(10, plot.w - left.width - (right ? right.width + 4 : 4));
  plot.h = Math.max(10, plot.h - st.axis.size * 1.7);
  const yOf = scale => v => plot.y + plot.h - (v - scale.min) / (scale.max - scale.min || 1) * plot.h;
  const yp = yOf(priceScale), yv = volume ? yOf(volumeScale) : null;
  parts.push(left.draw(plot, volume ? yv : yp));
  if (right) parts.push(right.draw(plot, yp));
  const slot = plot.w / Math.max(1, n), budget = n <= MARK_BUDGET, labels = [];
  // Volume columns and up/down bars leave 150% of their width between periods.
  const barW = Math.max(1, slot / 2.5);
  for (let i = 0; i < n; i++) {
    const x = plot.x + slot * (i + .5);
    const h = stock.high[i], l = stock.low[i], c = stock.close[i], o = open ? stock.open[i] : null;
    const tip = budget ? `<title>${esc(`${stock.categories[i]}: ${[open ? `open ${valueText(o, priceStyle)}` : '', `high ${valueText(h, priceStyle)}`, `low ${valueText(l, priceStyle)}`, `close ${valueText(c, priceStyle)}`, volume ? `volume ${valueText(stock.volume[i], stock.styles.volume)}` : ''].filter(Boolean).join(', ')}`)}</title>` : '';
    parts.push(`<g class="chart-stock-period" data-el="series" data-series="${volume ? 1 : 0}" data-point="${i}">${tip}`);
    if (volume && Number.isFinite(stock.volume[i])) parts.push(`<rect class="chart-stock-volume" x="${f(x - barW / 2)}" y="${f(yv(Math.max(0, stock.volume[i])))}" width="${f(barW)}" height="${f(Math.max(0, yv(0) - yv(Math.max(0, stock.volume[i]))))}" fill="${esc(seriesPaint(chart, 0))}" fill-opacity=".85"/>`);
    if (Number.isFinite(h) && Number.isFinite(l)) parts.push(`<line class="chart-stock-hilo" x1="${f(x)}" y1="${f(yp(h))}" x2="${f(x)}" y2="${f(yp(l))}" stroke="${esc(lineInk)}" stroke-width="1"/>`);
    if (open && Number.isFinite(o) && Number.isFinite(c)) {
      // Up/down bars from the open to the close: hollow where the price rose, filled where it fell.
      const rising = c >= o, w = Math.max(2, barW * .6);
      parts.push(`<rect class="chart-stock-${rising ? 'up' : 'down'}" x="${f(x - w / 2)}" y="${f(yp(Math.max(o, c)))}" width="${f(w)}" height="${f(Math.max(.75, Math.abs(yp(o) - yp(c))))}" fill="${esc(rising ? up : down)}" stroke="${esc(lineInk)}" stroke-width="1"/>`);
    } else if (Number.isFinite(c)) {
      const tick = Math.max(2, Math.min(6, barW * .4));
      parts.push(`<line class="chart-stock-close" x1="${f(x)}" y1="${f(yp(c))}" x2="${f(x + tick)}" y2="${f(yp(c))}" stroke="${esc(lineInk)}" stroke-width="1.5"/>`);
    }
    parts.push('</g>');
    if (labelsOn(chart) && Number.isFinite(c) && slot >= 18) labels.push(text(valueText(c, priceStyle), x + 3, yp(c) - 3, st.label, 'start', 'class="chart-data-label" data-el="dataLabels" data-series="0"'));
  }
  parts.push(...labels, categoryAxis(fr, stock.categories, plot, slot), fr.drawLegend(), '</svg>');
  return parts.join('');
}

/* ---------- Surface ---------- */

function renderSurface(data, chart, width, height) {
  const grid = surfaceGrid(data);
  if (grid.rows < 2 || grid.cols < 2) return message(chart, width, height, 'A surface needs at least two rows and two columns of numbers');
  const values = grid.z.flat().filter(Number.isFinite);
  if (!values.length) return message(chart, width, height, 'No numbers to chart');
  const a = chart.appearance;
  const bands = surfaceBands(Math.min(...values), Math.max(...values), { min: chart.yMin, max: chart.yMax, step: a?.yStep, niceScale });
  const style = data.valueStyle;
  const bandLabel = b => `${axisLabel(b.lo, style, bands.step)}–${axisLabel(b.hi, style, bands.step)}`;
  const view = chart.surfaceView || 'surface3d', wire = view === 'wireframe3d' || view === 'wireframeContour';
  const entries = bands.bands.map((b, k) => ({ name: bandLabel(b), i: k, paint: seriesPaint(chart, k), key: wire ? 'line' : 'box' }));
  const fr = chartFrame(chart, width, height, entries,
    `${view.endsWith('ontour') ? 'Contour' : 'Surface'} chart of ${grid.rows} by ${grid.cols} values from ${valueText(Math.min(...values), style)} to ${valueText(Math.max(...values), style)} in ${bands.bands.length} bands.`);
  const bandOf = z => Math.max(0, Math.min(bands.bands.length - 1, Math.floor((z - bands.min) / bands.step)));
  const tris = surfaceTriangles(grid);
  if (view === 'contour' || view === 'wireframeContour') drawContour(fr, chart, grid, bands, tris, bandOf, wire);
  else drawSurface3d(fr, chart, grid, bands, tris, bandOf, wire, style);
  fr.parts.push(fr.drawLegend(), '</svg>');
  return fr.parts.join('');
}

function drawContour(fr, chart, grid, bands, tris, bandOf, wire) {
  const { parts, plot, st, a } = fr;
  const short = categoryShortener(grid.colNames, 16);
  const leftW = Math.min(plot.w * .3, Math.max(0, ...grid.colNames.map(c => axisTextWidth(short(c), st.axis))) + 8);
  plot.x += leftW; plot.w = Math.max(10, plot.w - leftW - 4);
  plot.h = Math.max(10, plot.h - st.axis.size * 1.7);
  // Categories run across, series up the plot, as a surface seen from above.
  const X = u => plot.x + u / (grid.rows - 1) * plot.w, Y = v => plot.y + plot.h - v / (grid.cols - 1) * plot.h;
  const pts = poly => poly.map(p => `${f(X(p[0]))},${f(Y(p[1]))}`).join(' ');
  parts.push(`<rect class="chart-plot" x="${f(plot.x)}" y="${f(plot.y)}" width="${f(plot.w)}" height="${f(plot.h)}" fill="${esc(a?.plotFill && a.plotFill !== 'none' ? a.plotFill : 'none')}" stroke="${a ? '#d9d9d9' : 'var(--grid)'}" data-el="plotArea"/>`);
  bands.bands.forEach((band, k) => {
    const paint = seriesPaint(chart, k);
    if (wire) {
      // The contour line at the band's lower edge, drawn in the band's colour.
      const d = tris.map(t => isoSegment(t, band.lo)).filter(Boolean).map(([p, q]) => `M${f(X(p[0]))} ${f(Y(p[1]))}L${f(X(q[0]))} ${f(Y(q[1]))}`).join('');
      if (d) parts.push(`<path class="chart-contour-line" d="${d}" fill="none" stroke="${esc(paint)}" stroke-width="1.5" data-el="series" data-series="${k}"/>`);
      return;
    }
    const polys = tris.map(t => bandPolygon(t, band.lo, k === bands.bands.length - 1 ? Infinity : band.hi)).filter(Boolean);
    if (k === 0) polys.push(...tris.map(t => bandPolygon(t, -Infinity, band.lo)).filter(Boolean));
    if (polys.length) parts.push(`<g class="chart-contour-band" data-el="series" data-series="${k}" fill="${esc(paint)}" stroke="${esc(paint)}" stroke-width=".6" stroke-linejoin="round">${polys.map(p => `<polygon points="${pts(p)}"/>`).join('')}</g>`);
  });
  const slot = plot.w / Math.max(1, grid.rows - 1);
  grid.rowNames.forEach((name, r) => {
    const every = Math.max(1, Math.ceil((Math.max(0, ...grid.rowNames.map(c => axisTextWidth(c, st.axis))) + 8) / Math.max(1, slot)));
    if (r % every || a?.hideXAxis) return;
    parts.push(text(name, X(r), plot.y + plot.h + st.axis.size * 1.3, st.axis, 'middle', 'class="chart-axis-label"'));
  });
  grid.colNames.forEach((name, c) => parts.push(text(short(name), plot.x - 6, Y(c) + st.axis.size * .35, st.axis, 'end', 'class="chart-axis-label"')));
}

function drawSurface3d(fr, chart, grid, bands, tris, bandOf, wire, style) {
  const { parts, plot, st, a } = fr;
  // An oblique view from the front and a little above: categories along the front edge, series running back
  // and to the right, heights straight up. Farther rows are drawn first so nearer ones cover them.
  const height = .7, skewX = .5, skewY = .38;
  const norm = (u, v, z) => [u / (grid.rows - 1) - .5, v / (grid.cols - 1) - .5, ((Math.min(bands.max, Math.max(bands.min, z)) - bands.min) / (bands.max - bands.min || 1)) * height];
  const project = ([X, Y, Z]) => ({ x: X + (Y + .5) * skewX, y: -(Z + (Y + .5) * skewY), depth: Y - Z * .01 });
  const corners = [];
  for (const X of [-.5, .5]) for (const Y of [-.5, .5]) for (const Z of [0, height]) corners.push(project([X, Y, Z]));
  const minX = Math.min(...corners.map(c => c.x)), maxX = Math.max(...corners.map(c => c.x)), minY = Math.min(...corners.map(c => c.y)), maxY = Math.max(...corners.map(c => c.y));
  const valueW = Math.max(...[bands.min, ...bands.bands.map(b => b.hi)].map(v => axisTextWidth(axisLabel(v, style, bands.step), st.value))) + 10;
  const seriesW = Math.min(plot.w * .25, Math.max(...grid.colNames.map(c => axisTextWidth(c, st.axis))) + 10);
  const room = { x: plot.x + valueW, y: plot.y + 4, w: Math.max(10, plot.w - valueW - seriesW), h: Math.max(10, plot.h - st.axis.size * 2) };
  const k = Math.min(room.w / (maxX - minX || 1), room.h / (maxY - minY || 1));
  const ox = room.x + (room.w - (maxX - minX) * k) / 2 - minX * k, oy = room.y + (room.h - (maxY - minY) * k) / 2 - minY * k;
  const screen = p => { const q = project(p); return { sx: ox + q.x * k, sy: oy + q.y * k, depth: q.depth }; };
  const at = (u, v, z) => screen(norm(u, v, z));
  const gridInk = a ? '#d9d9d9' : 'var(--grid)', axisInk = st.axis;
  // The back walls and floor, with a line at each band edge, behind everything.
  const wall = pts => pts.map(p => { const s = screen(p); return `${f(s.sx)},${f(s.sy)}`; }).join(' ');
  const zOf = v => (v - bands.min) / (bands.max - bands.min || 1) * height;
  const backY = .5, backX = -.5;
  parts.push(`<g class="chart-surface-walls" fill="none" stroke="${gridInk}" stroke-width="1" data-el="plotArea">`,
    `<polygon points="${wall([[-.5, -.5, 0], [.5, -.5, 0], [.5, .5, 0], [-.5, .5, 0]])}"/>`,
    `<polygon points="${wall([[-.5, backY, 0], [.5, backY, 0], [.5, backY, height], [-.5, backY, height]])}"/>`,
    `<polygon points="${wall([[backX, -.5, 0], [backX, .5, 0], [backX, .5, height], [backX, -.5, height]])}"/>`);
  const levels = [bands.min, ...bands.bands.map(b => b.hi)];
  if (chart.gridlines !== false) for (const v of levels) parts.push(`<polyline points="${wall([[backX, -.5, zOf(v)], [backX, backY, zOf(v)], [.5, backY, zOf(v)]])}"/>`);
  parts.push(`<polyline points="${wall([[-.5, -.5, 0], [-.5, -.5, height]])}"/>`, '</g>');
  if (!a?.hideYAxis) for (const v of levels) {
    const s = screen([-.5, -.5, zOf(v)]);
    parts.push(text(axisLabel(v, style, bands.step), s.sx - 6, s.sy + axisInk.size * .35, st.value, 'end', 'class="chart-axis-label"'));
  }
  if (wire) {
    // Lines along each row and column of the grid, each stretch in the band of its middle.
    const segs = [];
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
      const z = grid.z[r][c];
      if (z == null) continue;
      if (r + 1 < grid.rows && grid.z[r + 1][c] != null) segs.push([[r, c, z], [r + 1, c, grid.z[r + 1][c]]]);
      if (c + 1 < grid.cols && grid.z[r][c + 1] != null) segs.push([[r, c, z], [r, c + 1, grid.z[r][c + 1]]]);
    }
    const byBand = new Map();
    for (const [p, q] of segs) {
      const b = bandOf((p[2] + q[2]) / 2), s1 = at(...p), s2 = at(...q);
      byBand.set(b, (byBand.get(b) || '') + `M${f(s1.sx)} ${f(s1.sy)}L${f(s2.sx)} ${f(s2.sy)}`);
    }
    for (const [b, d] of [...byBand].sort((x, y) => x[0] - y[0])) parts.push(`<path class="chart-surface-wire" d="${d}" fill="none" stroke="${esc(seriesPaint(chart, b))}" stroke-width="1.25" data-el="series" data-series="${b}"/>`);
  } else {
    // Each triangle cut into its value bands, painted back to front so the nearer surface covers the farther.
    const pieces = [];
    for (const t of tris) {
      const depth = t.reduce((sum, p) => sum + at(...p).depth, 0) / 3;
      bands.bands.forEach((band, b) => {
        const poly = bandPolygon(t, b === 0 ? -Infinity : band.lo, b === bands.bands.length - 1 ? Infinity : band.hi);
        if (poly) pieces.push({ depth, b, poly });
      });
    }
    pieces.sort((x, y) => y.depth - x.depth || x.b - y.b);
    const shown = pieces.slice(0, MARK_BUDGET * 4);
    parts.push('<g class="chart-surface" stroke-linejoin="round">');
    for (const { b, poly } of shown) {
      const paint = seriesPaint(chart, b);
      parts.push(`<polygon points="${poly.map(p => { const s = at(...p); return `${f(s.sx)},${f(s.sy)}`; }).join(' ')}" fill="${esc(paint)}" stroke="${esc(paint)}" stroke-width=".6" data-el="series" data-series="${b}"/>`);
    }
    // The mesh over the bands, faint, so the grid's rows and columns read.
    let mesh = '';
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) {
      const z = grid.z[r][c];
      if (z == null) continue;
      const s = at(r, c, z);
      if (r + 1 < grid.rows && grid.z[r + 1][c] != null) { const e = at(r + 1, c, grid.z[r + 1][c]); mesh += `M${f(s.sx)} ${f(s.sy)}L${f(e.sx)} ${f(e.sy)}`; }
      if (c + 1 < grid.cols && grid.z[r][c + 1] != null) { const e = at(r, c + 1, grid.z[r][c + 1]); mesh += `M${f(s.sx)} ${f(s.sy)}L${f(e.sx)} ${f(e.sy)}`; }
    }
    if (mesh && grid.rows * grid.cols <= MARK_BUDGET) parts.push(`<path class="chart-surface-mesh" d="${mesh}" fill="none" stroke="#000000" stroke-opacity=".18" stroke-width=".75"/>`);
    parts.push('</g>');
  }
  // Category names along the front edge, series names along the right-hand floor edge.
  const rowEvery = Math.max(1, Math.ceil(grid.rows * (axisInk.size * 3) / Math.max(1, room.w)));
  grid.rowNames.forEach((name, r) => {
    if (r % rowEvery || a?.hideXAxis) return;
    const s = screen([r / (grid.rows - 1) - .5, -.5, 0]);
    parts.push(text(categoryShortener(grid.rowNames, 12)(name), s.sx, s.sy + axisInk.size * 1.3, axisInk, 'middle', 'class="chart-axis-label"'));
  });
  const colEvery = Math.max(1, Math.ceil(grid.cols * axisInk.size * 1.6 / Math.max(1, room.h)));
  grid.colNames.forEach((name, c) => {
    if (c % colEvery) return;
    const s = screen([.5, c / (grid.cols - 1) - .5, 0]);
    parts.push(text(categoryShortener(grid.colNames, 12)(name), s.sx + 6, s.sy + axisInk.size * .8, axisInk, 'start', 'class="chart-axis-label"'));
  });
}
