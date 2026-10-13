import { chartAxisScale, chartAxisTransferBounds } from '../core/chart-axis-scale.js';
import { chartDateAxis } from '../core/chart-date-axis.js';
/**
 * Draw a chart as SVG markup. Pure: data in, a string out, so it can be
 * tested without a browser and placed anywhere (the grid, the dialog
 * preview). Colors are CSS variables so charts follow the theme.
 */

import { authoredBarGapWidth, chartPointStyle, niceScale, axisLabel, histogramBins, waterfallSteps, dateKindOf, CHART_LINE_DASHES } from '../core/charts.js';
import { formatValue, formatGeneral, fontStack, numFmtToStyle } from '../core/format.js';
import { wrapLines } from '../core/textfit.js';
import { SPECIAL_CHART_TYPES, renderSpecialChart } from './chartsvg-special.js';

// The light theme's --series-* tokens in tokens.css, in order: every fill reads at 3:1 on white.
export const SERIES_COLORS = ['#337bfc', '#eb6834', '#0f8f61', '#b57a00', '#c4417a', '#4a3aa7', '#0e7490', '#8a5a00', '#918f88'];
// The token each palette colour is kept in. The stylesheet numbers them 1–5 and 7 (the reference
// highlights in the grid borrow the same six), and has none for the teal, brown and grey past them,
// which are drawn as they are. Each theme redefines the six, and print redefines them all to the light
// palette, so a chart follows the theme on screen and prints on white paper either way.
const SERIES_TOKENS = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-7'];

/**
 * The paint for series (or pie slice) `i`: the theme's own token, with the light palette's colour as the
 * fallback, so an SVG that leaves the page — copied as a picture, exported — still names a real colour
 * where no stylesheet can answer for the variable. A colour the chart chose itself is used as it is.
 */
export function seriesPaint(chart, i) {
  const color = seriesColor(chart, i);
  return !themeSeries && !chart?.colors?.[i] && i < SERIES_TOKENS.length ? `var(${SERIES_TOKENS[i]}, ${color})` : color;
}

/**
 * Label ink that reads on a fill: white where it reaches 4.5:1 (pink, purple, teal, brown), dark ink
 * elsewhere (green, amber, grey, and the mid blue and orange). A themed paint is judged by the colour
 * inside it, since only the stylesheet knows which way the token went.
 */
export function inkOn(hex) {
  const m = /#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})\b/i.exec(String(hex || ''));
  if (!m) return '#ffffff';
  const lin = (v) => { const c = parseInt(v, 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const luminance = 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
  return luminance > 0.183 ? '#0b0b0b' : '#ffffff'; // white on a fill this light falls under 4.5:1
}

// The workbook theme's six accents, once a theme other than the default is chosen (Page Layout ▸ Themes):
// series without colours of their own take them in order. Null keeps the app's palette.
let themeSeries = null;
export function setThemeSeriesColors(colors) {
  themeSeries = Array.isArray(colors) && colors.length && colors.every(c => /^#[0-9a-f]{6}$/i.test(c)) ? colors.slice() : null;
}
/** What a drawn chart's picture depends on besides its data: the theme's accents in use. */
export const themeSeriesKey = () => themeSeries ? themeSeries.join(',') : '';

/** The color of series (or pie slice) `i`: the chart's own choice, else the palette. */
export function seriesColor(chart, i) {
  if (chart?.colors?.[i]) return chart.colors[i];
  const palette = themeSeries || SERIES_COLORS;
  const base = palette[i % palette.length];
  // Past the palette the hues come round again lighter, then darker, so the tenth slice of a
  // pie does not repeat the first one's colour beside it.
  const lap = Math.floor(i / palette.length);
  return lap ? shade(base, lap % 2 ? 0.3 : -0.28) : base;
}

/** A hex colour mixed toward white (amount > 0) or black (amount < 0). */
function shade(hex, amount) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  const to = amount > 0 ? 255 : 0;
  const k = Math.abs(amount);
  return `#${[m[1], m[2], m[3]].map((h) => Math.round(parseInt(h, 16) * (1 - k) + to * k).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A smooth path through points, as cubic Béziers whose tangents are monotone (Fritsch–Carlson): between
 * two points the curve stays between their values, so a rise from zero never dips under the baseline into
 * the labels and a run of equal values draws flat. `open` skips the leading M.
 */
export function smoothPath(pts, open = false) {
  if (pts.length < 2) return pts.length ? `${open ? 'L' : 'M'} ${f(pts[0][0])} ${f(pts[0][1])}` : '';
  const n = pts.length;
  const h = [];
  const secant = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(pts[i + 1][0] - pts[i][0]);
    secant.push(h[i] ? (pts[i + 1][1] - pts[i][1]) / h[i] : 0);
  }
  // A tangent at an inner point is the weighted harmonic mean of its two secants, or flat at a peak,
  // a trough or a level step; the ends take their one secant.
  const tangent = new Array(n);
  tangent[0] = secant[0];
  tangent[n - 1] = secant[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (secant[i - 1] * secant[i] <= 0 || !h[i - 1] || !h[i]) { tangent[i] = 0; continue; }
    const w1 = 2 * h[i] + h[i - 1];
    const w2 = h[i] + 2 * h[i - 1];
    tangent[i] = (w1 + w2) / (w1 / secant[i - 1] + w2 / secant[i]);
  }
  const out = [`${open ? 'L' : 'M'} ${f(pts[0][0])} ${f(pts[0][1])}`];
  for (let i = 0; i < n - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const dx = h[i] / 3;
    out.push(`C ${f(x1 + dx)} ${f(y1 + tangent[i] * dx)} ${f(x2 - dx)} ${f(y2 - tangent[i + 1] * dx)} ${f(x2)} ${f(y2)}`);
  }
  return out.join(' ');
}

// Windows High Contrast replaces every fill and stroke with its own two colours, which turns a chart
// into one flat shape and a sparkline into a blank; the colours here are the picture itself, so the plot
// keeps them, as the cell-style swatches and the grid's checkboxes already do.
const PLOT_STYLE = 'forced-color-adjust: none';
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MAX_LEGEND = 12;
// Past this many marks a chart drops per-mark tooltips (a 5000-row range would otherwise put tens of
// megabytes of <title> into the page) and thins its marks to what the plot can show anyway.
const MARK_BUDGET = 2000;
// Past this many series no colour tells one from the next; a tall range charted with its rows as series
// (5,000 of them over 199 categories: a million <rect>s, 81 MB) draws this many and the legend counts the rest.
const MAX_SERIES = 60;
const f = (n) => (Math.round(n * 100) / 100).toString();
/**
 * A value as a tooltip writes it: in its cells' own format (a date, currency or percent, to their
 * decimals), else the General way, so a sum of 0.1 and 0.2 reads 0.3 rather than 0.30000000000000004.
 */
function tipText(v, style) {
  if (v == null) return '';
  if (dateKindOf(style)) return axisLabel(v, style);
  if (style?.fmt === 'custom') return formatValue(v, style);
  if (style?.fmt === 'currency') return formatValue(v, { fmt: 'currency', cur: style.cur || 'USD', dec: style.dec });
  if (style?.fmt === 'percent') return formatValue(v, { fmt: 'percent', dec: style.dec });
  return formatGeneral(v);
}
// Custom codes carry units, literals and sections that compact axis labels cannot preserve.
const pointValueText = (v, style) => style?.fmt === 'custom' ? formatValue(v, style) : axisLabel(v, style);
// A series read from cells carries their format (null when they have none); data built without one takes the chart's.
const seriesStyle = (s, chartStyle) => (s.style === undefined ? chartStyle : s.style);
// Imported chart ranges can exceed JavaScript's function-argument limit.
const minOf = (values) => values.reduce((min, value) => Math.min(min, value), Infinity);
const maxOf = (values) => values.reduce((max, value) => Math.max(max, value), -Infinity);

/** Index ticks so a sub-precision step cannot leave an addition loop stuck. */
function scaleTicks({ min, max, step }) {
  if (![min, max, step].every(Number.isFinite) || step <= 0 || max < min) return [];
  const ticks = [];
  // A tick may pass the top only by rounding noise: a fixed maximum off the step's grid ends the axis where it is.
  const limit = max + step * 1e-6;
  // Scales normally have about six ticks. Bound even malformed imported axes.
  for (let i = 0; i < 1000; i++) {
    let value = min + i * step;
    if (!Number.isFinite(value) || value > limit) break;
    // A sum that lands within rounding noise of the step's own grid is that grid point, so an axis from
    // -0.3 puts its fourth tick at exactly 0 rather than 5.55E-17; a tick a fixed bound sets off the grid
    // (1.5, 3.5, …) is left where it is.
    const snapped = Math.round(value / step) * step;
    if (Math.abs(snapped - value) <= step * 1e-9) value = snapped;
    if (!ticks.length || value > ticks[ticks.length - 1]) ticks.push(value);
  }
  return ticks;
}

// Labels are cut by code point, so an emoji or other astral character is never left as half a surrogate pair.
function truncate(text, max) {
  const t = String(text ?? '');
  const chars = Array.from(t);
  return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join('')}…` : t;
}

/**
 * Category labels cut to `max` characters. They are cut at the end, unless
 * the long ones share a start so long that cutting there would leave them
 * all reading the same ("Department of…"); then the shared start goes
 * instead and the parts that tell them apart stay ("…Finance", "…Health").
 */
function categoryShortener(categories, max) {
  const long = categories.map((c) => Array.from(String(c ?? ''))).filter((c) => c.length > max);
  if (long.length < 2) return (c) => truncate(c, max);
  let prefix = long[0];
  for (const c of long) {
    let i = 0;
    while (i < prefix.length && i < c.length && prefix[i] === c[i]) i++;
    prefix = prefix.slice(0, i);
  }
  if (prefix.length < max - 1) return (c) => truncate(c, max);
  // Drop whole words of the shared start, so a label does not begin mid-word.
  const cut = prefix.includes(' ') ? prefix.lastIndexOf(' ') + 1 : prefix.length;
  return (c) => {
    const t = String(c ?? '');
    const chars = Array.from(t);
    return chars.length > max ? `…${truncate(chars.slice(cut).join(''), max - 1)}` : t;
  };
}

/**
 * Rough text width for layout decisions (no DOM available here): Latin and similar
 * characters run about half an em, CJK and other full-width characters a whole one,
 * emoji a little more. Counting code points keeps an emoji from measuring as two.
 */
const WIDE_RE = /\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}|[！-｠￠-￦]/u;
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const textW = (text, size = 12) => {
  let ems = 0;
  for (const ch of String(text ?? '')) ems += EMOJI_RE.test(ch) ? 1.2 : WIDE_RE.test(ch) ? 1 : 0.56;
  return ems * size;
};

let axisTextContext;
function axisTextWidth(text, style) {
  // Imported charts often fit a dozen small category labels on one line.
  // Measure their actual font instead of rotating them on a fixed-width estimate.
  if (typeof OffscreenCanvas === 'undefined') return textW(text, style.size);
  axisTextContext ||= new OffscreenCanvas(1, 1).getContext('2d');
  if (!axisTextContext) return textW(text, style.size);
  axisTextContext.font = `${style.italic ? 'italic ' : ''}${style.bold ? '700 ' : ''}${style.size}px ${fontStack(style.font)}`;
  return axisTextContext.measureText(String(text)).width;
}

function rotatedTextSize(width, height, angle) {
  const radians = angle * Math.PI / 180, cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  return { width: width * cos + height * sin, height: width * sin + height * cos, cos, sin };
}

/** Bounds around the SVG baseline, including the native sign-dependent anchor. */
function axisTextBox(width, size, angle, above = false, height = size, ascent = .8 * size) {
  const radians = angle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
  let anchor = !angle ? 'middle' : Math.abs(cos) < 1e-10 ? sin < 0 ? 'end' : 'start'
    : (angle < 0) === (cos > 0) ? 'end' : 'start';
  if (above && anchor !== 'middle') anchor = anchor === 'end' ? 'start' : 'end';
  const x1 = anchor === 'end' ? -width : anchor === 'middle' ? -width / 2 : 0, x2 = x1 + width;
  const y1 = -ascent, y2 = height - ascent;
  return { anchor, left: -(Math.min(x1 * cos, x2 * cos) + Math.min(-y1 * sin, -y2 * sin)),
    right: Math.max(x1 * cos, x2 * cos) + Math.max(-y1 * sin, -y2 * sin),
    top: Math.min(x1 * sin, x2 * sin) + Math.min(y1 * cos, y2 * cos),
    bottom: Math.max(x1 * sin, x2 * sin) + Math.max(y1 * cos, y2 * cos) };
}

/** A label is one text box, even when its baseline contains several lines.
 * Word wrapping leaves indivisible words intact; explicit breaks also apply
 * when DrawingML disables automatic wrapping. Oblique labels interleave, so
 * their text width is not constrained to a category's axis-aligned slot.
 */
function categoryTextLayout(text, style, width, wrap) {
  text = String(text ?? '').replace(/\r\n?/g, '\n');
  const lines = wrap !== 'none' && Number.isFinite(width)
    ? wrapChartText(text, Math.max(1, width), style) : text.split('\n');
  const widthPx = Math.max(0, ...lines.map(line => axisTextWidth(line, style)));
  // Width measurement configured the context with this label's font. Font
  // bounds include blank lines and accents; actual glyph bounds do not.
  const metrics = typeof OffscreenCanvas !== 'undefined' ? axisTextContext?.measureText('Mg') : null;
  const ascent = Number.isFinite(metrics?.fontBoundingBoxAscent) ? metrics.fontBoundingBoxAscent : style.size * .8;
  const descent = Number.isFinite(metrics?.fontBoundingBoxDescent) ? metrics.fontBoundingBoxDescent : style.size * .2;
  return { lines, width: widthPx, ascent, height: ascent + descent + (lines.length - 1) * style.size * 1.2 };
}

/** Measure one legend grid for automatic and saved manual layouts. Automatic
 * legends are compact and centered; manual legends distribute the same measured
 * keys/text within their box. Entries fill rows first and their columns align.
 */
function layoutLegend(entries, style, W, H, position, titleBottom, box = null, vertical = false) {
  const gap = style.size / 2, keyGap = style.size / 4, lineH = style.size * 1.2;
  const available = Math.max(1, (box?.w ?? W) - gap * 2);
  const items = entries.map(e => {
    const textWidth = Math.max(...String(e.name).split(/\r?\n/).map(t => axisTextWidth(t, style)));
    return { ...e, textWidth, width: e.keyWidth + keyGap + textWidth };
  });
  const columnWidths = count => {
    const result = Array(count).fill(0);
    items.forEach((e, i) => { result[i % count] = Math.max(result[i % count], e.width); });
    return result;
  };
  const gridWidth = widths => widths.reduce((sum, w) => sum + w, 0) + gap * (widths.length - 1);
  let columns = vertical ? Math.min(1, items.length) : items.length, widths = [];
  for (; columns > 0; columns--) {
    widths = columnWidths(columns);
    if (columns === 1 || gridWidth(widths) <= available) break;
  }
  if (!columns) return null;
  // Balance partially filled rows without increasing their count. Automatic
  // legends should not span four columns just to leave one item on a second row.
  const rowCount = Math.ceil(items.length / columns);
  for (let count = columns - 1; count > 0 && Math.ceil(items.length / count) === rowCount; count--) {
    const candidate = columnWidths(count);
    if (gridWidth(candidate) < gridWidth(widths)) { columns = count; widths = candidate; }
  }
  widths = widths.map(w => Math.min(available, w));
  const rows = [];
  items.forEach((e, i) => {
    const row = Math.floor(i / columns), col = i % columns;
    // Retain the measured width when the whole entry fits. Subtracting key
    // geometry from its sum can lose an ULP and wrap exactly fitting text.
    const textWidth = widths[col] >= e.width ? e.textWidth : Math.max(1, widths[col] - e.keyWidth - keyGap);
    // Share the grid's bounded, grapheme-aware word wrapping rather than
    // truncating a long series name or splitting joined emoji/combining marks.
    e.lines = wrapLines(String(e.name).replace(/\r\n?/g, '\n'), textWidth, text => axisTextWidth(text, style));
    (rows[row] ||= []).push({ ...e, col });
  });
  const heights = rows.map(row => Math.max(...row.map(e => e.lines.length)) * lineH);
  const contentH = heights.reduce((sum, height) => sum + height, 0);
  const w = box?.w ?? gridWidth(widths);
  const h = Math.max(contentH + gap * (rows.length - 1), box?.h ?? 0);
  const x = box?.x ?? (W - w) / 2, y = box?.y ?? (position === 'top' ? titleBottom + gap : H - gap - h);
  const columnGap = box ? Math.max(gap, (w - widths.reduce((sum, width) => sum + width, 0)) / (columns + 1)) : gap;
  const rowSpace = box ? (h - contentH) / rows.length : 0;
  let rowY = y;
  const placed = rows.flatMap((row, ri) => {
    let colX = x + (box ? columnGap : 0);
    const result = row.map(e => {
      const placed = { ...e, x: colX, y: rowY + rowSpace / 2 + style.size / 2, textX: colX + e.keyWidth + keyGap, baseline: rowY + rowSpace / 2 + style.size * .8 };
      colX += widths[e.col] + columnGap;
      return placed;
    });
    rowY += heights[ri] + (box ? rowSpace : gap);
    return result;
  });
  return { x, y, w, h, entries: placed, lineH };
}

const NAMED_COLORS = { red: '#c22a2a', green: '#1baf7a', blue: '#337bfc', orange: '#eb6834', gray: '#918f88', grey: '#918f88', black: '#0b0b0b', purple: '#4a3aa7', yellow: '#eda100' };

function sparkColor(c, fallback) {
  if (!c) return fallback;
  const t = String(c).trim().toLowerCase();
  if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/.test(t)) return t;
  return NAMED_COLORS[t] || fallback;
}

/** A tiny chart for one cell: line, column, bar (stacked), or win/loss. */
export function renderSparklineSvg(spark, width, height) {
  const W = Math.max(8, width);
  const H = Math.max(6, height);
  const pad = 2;
  const values = spark.values || [];
  const nums = values.filter((v) => v !== null);
  const color = sparkColor(spark.color, 'var(--series-1)');
  const neg = sparkColor(spark.negColor, 'var(--critical)');
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true" focusable="false" style="${PLOT_STYLE}">`];
  if (!nums.length) { out.push('</svg>'); return out.join(''); }
  const n = values.length;
  if (spark.type === 'line') {
    const lo = minOf(nums);
    const hi = maxOf(nums);
    const span = hi - lo || 1;
    const x = (i) => pad + (n === 1 ? (W - 2 * pad) / 2 : (i / (n - 1)) * (W - 2 * pad));
    const y = (v) => H - pad - ((v - lo) / span) * (H - 2 * pad);
    const pts = values.map((v, i) => (v === null ? null : `${f(x(i))},${f(y(v))}`));
    let run = [];
    const runs = [];
    pts.forEach((p) => { if (p) run.push(p); else if (run.length) { runs.push(run); run = []; } });
    if (run.length) runs.push(run);
    for (const r of runs) {
      if (r.length === 1) out.push(`<circle cx="${r[0].split(',')[0]}" cy="${r[0].split(',')[1]}" r="1.5" fill="${color}"/>`);
      else out.push(`<polyline points="${r.join(' ')}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
  } else if (spark.type === 'column' || spark.type === 'winloss') {
    const vals = spark.type === 'winloss' ? values.map((v) => (v === null ? null : v > 0 ? 1 : v < 0 ? -1 : 0)) : values;
    const present = vals.filter((v) => v !== null);
    const hi = Math.max(0, maxOf(present));
    const lo = Math.min(0, minOf(present));
    const span = hi - lo || 1;
    const zero = pad + (hi / span) * (H - 2 * pad);
    const slot = (W - 2 * pad) / n;
    const bw = Math.max(1, slot * 0.7);
    vals.forEach((v, i) => {
      if (v === null) return;
      const hgt = Math.max(0.75, (Math.abs(v) / span) * (H - 2 * pad));
      const yTop = v >= 0 ? zero - hgt : zero;
      out.push(`<rect x="${f(pad + slot * i + (slot - bw) / 2)}" y="${f(yTop)}" width="${f(bw)}" height="${f(hgt)}" fill="${v < 0 ? neg : color}" rx="0.5"/>`);
    });
  } else {
    // bar: one horizontal bar, values stacked left to right by size.
    const total = nums.reduce((a, b) => a + Math.abs(b), 0) || 1;
    let x = pad;
    nums.forEach((v, i) => {
      const w = (Math.abs(v) / total) * (W - 2 * pad);
      out.push(`<rect x="${f(x)}" y="${f(pad)}" width="${f(Math.max(0, w - 1))}" height="${f(H - 2 * pad)}" fill="${i % 2 ? neg : color}" rx="1"/>`);
      x += w;
    });
  }
  out.push('</svg>');
  return out.join('');
}

/**
 * Make chart markup stand on its own: CSS variables (theme colors) become
 * literal values via `resolve(name)`, and the font is named. For files.
 */
export function standaloneSvg(svg, resolve, font = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif') {
  let out = svg;
  // var(--a, fallback) with nesting: resolve innermost first, a few passes.
  for (let i = 0; i < 6 && out.includes('var('); i++) {
    out = out.replace(/var\((--[\w-]+)\s*(?:,\s*([^()]*?))?\)/g, (m, name, fallback) => {
      const v = resolve(name);
      return v && String(v).trim() ? String(v).trim() : (fallback ?? '').trim() || '#888888';
    });
  }
  return out.replace(/^<svg /, `<svg font-family="${font}" `);
}

// OOXML encodes a corner toggle, not a radius. Use the existing chart frame's
// small radius (tokens.css --r-sm) consistently in grid, print and pictures.
// A native chart without the element is rounded too; retain that
// implicit default without writing an explicit setting back into the file.
export function chartCornerRadius(chart) {
  return chart.appearance ? chart.appearance.roundedCorners === false ? 0 : 8 : null;
}

export function renderChartSvg(data, chart, width, height) {
  const svg = renderChartContent(data, chart, width, height), radius = chartCornerRadius(chart);
  if (!radius) return svg;
  const id = `chart-area-${Math.random().toString(36).slice(2, 10)}`;
  // Clip the entire area, including annotations at an edge. Keeping this in the
  // SVG also preserves corners in standalone SVG and rasterized clipboard PNGs.
  return svg.replace('<svg ', `<svg clip-path="url(#${id})" `).replace(/<\/svg>$/,
    `<defs><clipPath id="${id}" clipPathUnits="userSpaceOnUse"><rect width="100%" height="100%" rx="${radius}"/></clipPath></defs></svg>`);
}

function renderChartContent(data, chart, width, height) {
  // The data snapshot owns resolved linked text; literal titles remain editable
  // without rereading the potentially large chart series.
  if (data.titles) chart = { ...chart, ...Object.fromEntries(Object.entries(data.titles).filter(([key]) => chart[`${key}Ref`])) };
  if (SPECIAL_CHART_TYPES.has(chart.type)) return renderSpecialChart(data, chart, width, height);
  if (chart.type === 'radar' && chart.appearance?.radar) return renderNativeRadar(data, chart, width, height);
  if (['pie', 'donut'].includes(chart.type) && chart.appearance?.pie) return renderStyledPie(data, chart, width, height);
  if (['line', 'area', 'column', 'bar', 'combo', 'scatter', 'bubble'].includes(chart.type) && chart.appearance
    && (chart.type !== 'line' || (!chart.stacked && !chart.stack100) || chart.appearance.excelLayout)) return renderStyledCartesian(data, chart, width, height);
  const W = Math.max(120, width);
  const H = Math.max(80, height);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(chart.description || chart.title || `${chart.type} chart`)}" style="${PLOT_STYLE}">`];
  parts.push(`<rect x="0" y="0" width="${W}" height="${H}" fill="var(--surface)"/>`);
  let top = 10;
  if (chart.title) {
    parts.push(`<text x="${W / 2}" y="${top + 14}" text-anchor="middle" font-size="15" font-weight="600" fill="var(--ink)">${esc(truncate(chart.title, Math.floor(W / 9)))}</text>`);
    top += 30;
  }
  let { categories } = data;
  let series = data.series;
  const pieLike = chart.type === 'pie' || chart.type === 'donut';
  if (!series.length || (!series.some((s) => s.values.some((v) => v != null)) && !chart.appearance?.dataTable)) {
    parts.push(`<text x="${W / 2}" y="${H / 2}" text-anchor="middle" font-size="13" fill="var(--ink-3)">No numbers to chart</text></svg>`);
    return parts.join('');
  }
  const isHistogram = chart.type === 'histogram';
  const isWaterfall = chart.type === 'waterfall';
  if (isHistogram) {
    // Every number in the range, counted into bins; the bins become the categories. The bin edges read
    // in the cells' own format, so bins over priced cells read $5–$16.75 and bins
    // over dates read dates. The counts are plain numbers whatever the cells hold, so neither they nor
    // their axis take the cells' currency or percent.
    const binned = histogramBins(series.flatMap((s) => s.values), chart.bins, data.valueStyle || null);
    categories = binned.categories;
    series = [{ name: 'Count', values: binned.counts, style: null }];
  }
  let wf = null;
  if (isWaterfall) {
    wf = waterfallSteps(series[0].values);
    categories = [...categories.slice(0, series[0].values.length), 'Total'];
    series = [series[0]];
  }
  const wfColor = (kind) => (kind === 'increase' ? seriesPaint(chart, 0) : kind === 'decrease' ? chart.colors?.[1] || 'var(--critical, #c22a2a)' : chart.colors?.[2] || 'var(--ink-3)');

  // Legend: along the bottom (default), along the top, or stacked on the right.
  let bottom = H - 8;
  let right = W;
  // A pie's legend names its slices, including negative values plotted by magnitude.
  const sliceValues = pieLike ? series[0].values : null;
  const allItems = pieLike ? categories.map((c, i) => ({ name: c, color: seriesPaint(chart, i), drawn: Number.isFinite(sliceValues[i]) && sliceValues[i] !== 0 })).filter((it) => it.drawn)
    : isWaterfall ? [{ name: 'Increase', color: wfColor('increase') }, { name: 'Decrease', color: wfColor('decrease') }, { name: 'Total', color: wfColor('total') }]
      : series.map((s, i) => ({ name: s.name, color: seriesPaint(chart, i) }));
  // Past a dozen entries the legend keeps its first eleven and counts the rest, rather than vanishing.
  const legendItems = allItems.length > MAX_LEGEND ? [...allItems.slice(0, MAX_LEGEND - 1), { name: `…and ${allItems.length - (MAX_LEGEND - 1)} more`, color: null }] : allItems;
  const showLegend = chart.legend !== false && legendItems.length > 0;
  const swatch = (it, x, y) => (it.color ? `<rect x="${f(x)}" y="${f(y - 5)}" width="10" height="10" rx="2" fill="${it.color}"/>` : '');
  if (showLegend && chart.legendPos === 'right') {
    const items = legendItems.map((it) => ({ ...it, label: truncate(it.name, 20) }));
    const legendW = Math.min(W * 0.35, maxOf(items.map((it) => 14 + textW(it.label, 12))));
    const x0 = W - 8 - legendW;
    const rowsFit = Math.max(1, Math.floor((bottom - top) / 18));
    // Where the height holds fewer rows than there are entries, the last row counts the rest, as the bottom legend does.
    const shown = items.length > rowsFit ? [...items.slice(0, rowsFit - 1), { color: null, label: `…and ${allItems.length - (rowsFit - 1)} more` }] : items;
    shown.forEach((it, i) => {
      const y = top + 8 + i * 18;
      parts.push(swatch(it, x0, y));
      parts.push(`<text x="${f(x0 + 14)}" y="${f(y + 4)}" font-size="12" fill="var(--ink-2)">${esc(it.label)}</text>`);
    });
    right = x0 - 10;
  } else if (showLegend) {
    const items = legendItems.map((it) => ({ ...it, label: truncate(it.name, 24) }));
    const widths = items.map((it) => 14 + textW(it.label, 12) + 14);
    const rowsOfItems = [];
    let row = [];
    let used = 0;
    items.forEach((it, i) => {
      if (used + widths[i] > W - 20 && row.length) { rowsOfItems.push(row); row = []; used = 0; }
      row.push({ ...it, w: widths[i] });
      used += widths[i];
    });
    if (row.length) rowsOfItems.push(row);
    const lines = rowsOfItems.slice(0, 3);
    const atTop = chart.legendPos === 'top';
    let y0;
    if (atTop) { y0 = top + 6; top += lines.length * 18 + 4; } else { bottom = H - 8 - lines.length * 18; y0 = bottom + 12; }
    lines.forEach((line, li) => {
      const total = line.reduce((a, it) => a + it.w, 0);
      let x = (W - total) / 2;
      const y = y0 + li * 18;
      for (const it of line) {
        parts.push(swatch(it, x, y));
        parts.push(`<text x="${f(x + 14)}" y="${f(y + 4)}" font-size="12" fill="var(--ink-2)">${esc(it.label)}</text>`);
        x += it.w;
      }
    });
  }

  if (pieLike) {
    parts.push(renderPie(data, chart, right, top, bottom));
    parts.push('</svg>');
    return parts.join('');
  }
  if (chart.type === 'radar') {
    parts.push(renderRadar(data, chart, right, top, bottom));
    parts.push('</svg>');
    return parts.join('');
  }

  // Cartesian charts. Which series are bars and which are lines depends on the type.
  const horizontal = chart.type === 'bar';
  const isCombo = chart.type === 'combo';
  const isLineType = chart.type === 'line' || chart.type === 'area';
  let barIdx = isLineType || chart.type === 'scatter' || chart.type === 'bubble' ? [] : isCombo && series.length > 1 ? series.map((_, i) => i).slice(0, -1) : series.map((_, i) => i);
  let lineIdx = isLineType ? series.map((_, i) => i) : isCombo && series.length > 1 ? [series.length - 1] : [];
  const stacked = chart.stacked && (chart.type === 'column' || chart.type === 'bar' || chart.type === 'area' || isCombo);
  const stack100 = stacked && !!chart.stack100;
  const secondary = isCombo && !!chart.secondaryAxis && lineIdx.length > 0;
  if (stack100) {
    // 100% stacked: each category's values become their share of its total.
    const stackIdx = isCombo ? barIdx : series.map((_, i) => i);
    const totals = categories.map((_, i) => stackIdx.reduce((sum, si) => sum + Math.abs(series[si].values[i] ?? 0), 0));
    // The values themselves stay as `raw`, so a tooltip names the value with its share, not the share alone.
    series = series.map((s, si) => (stackIdx.includes(si) ? { ...s, raw: s.values, values: s.values.map((v, i) => (v == null ? null : totals[i] ? (v / totals[i]) * 100 : 0)) } : s));
  }
  let n = categories.length;
  let lo = Infinity;
  let hi = -Infinity;
  const acc = (v) => { if (Number.isFinite(v) && ((isHistogram || wf) || ((chart.yMin == null || v >= chart.yMin) && (chart.yMax == null || v <= chart.yMax)))) { lo = Math.min(lo, v); hi = Math.max(hi, v); } };
  if (wf) {
    for (const b of wf) { acc(b.from); acc(b.to); }
  } else if (stacked) {
    const stackIdx = isCombo ? barIdx : series.map((_, i) => i);
    for (let i = 0; i < n; i++) {
      let pos = 0;
      let neg = 0;
      for (const si of stackIdx) { const v = series[si].values[i]; if (v == null) continue; if (v >= 0) { pos += v; acc(pos); } else { neg += v; acc(neg); } }
    }
    if (isCombo && !secondary) for (const si of lineIdx) series[si].values.forEach(acc);
  } else {
    for (const [si, s] of series.entries()) if (!(secondary && lineIdx.includes(si))) s.values.forEach(acc);
  }
  // A combo chart's line may read against its own axis on the right, so a small series beside big bars stays legible.
  let lo2 = Infinity;
  let hi2 = -Infinity;
  if (secondary) for (const si of lineIdx) for (const v of series[si].values) if (v != null) { lo2 = Math.min(lo2, v); hi2 = Math.max(hi2, v); }
  if (secondary && !Number.isFinite(lo)) { lo = 0; hi = 0; }
  if (chart.appearance?.dataTable && !Number.isFinite(lo)) { lo = 0; hi = 0; }
  const isScatter = chart.type === 'scatter' || chart.type === 'bubble';
  // The value axis reads in the format of the series it scales (currency, percent or a date): the first
  // formatted one, or, when a combo's line has its own axis on the right, the first formatted one among
  // the bars, so a percent line beside plain bars does not put its percent on the bars' axis. A histogram's
  // axis counts cells, in plain numbers.
  const vs = isHistogram ? null : (secondary ? series.find((s, i) => !lineIdx.includes(i) && s.style)?.style : data.valueStyle) || null;
  // The right-hand axis reads in its line series' own format.
  const vs2 = secondary ? seriesStyle(series[lineIdx[0]], null) : null;
  // Histogram counts and waterfall extents retain their chart-specific scale.
  // Ordinary Cartesian charts use the shared automatic range policy below.
  if ((isHistogram || wf) && !dateKindOf(vs)) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const fixedBounds = chart.yMin != null || chart.yMax != null;
  let yLo = chart.yMin ?? lo;
  let yHi = chart.yMax ?? hi;
  if (!(yHi > yLo)) {
    // One fixed bound lies at or past all the data: open the free bound a data span (or a
    // tenth of the bound, or one unit) beyond it, so the axis keeps a positive extent.
    const spread = Math.max(hi - lo, Math.abs(chart.yMin ?? chart.yMax ?? 0) / 10, 1);
    if (chart.yMax == null) yHi = yLo + spread;
    else if (chart.yMin == null) yLo = yHi - spread;
  }
  const yScale = isHistogram || wf ? niceScale(yLo, yHi, 5)
    : chartAxisScale(lo, hi, { min: chart.yMin, max: chart.yMax, ticks: 5, numeric: isScatter, percent: stack100 });
  if (isHistogram || wf) {
    if (chart.yMin != null) yScale.min = chart.yMin;
    if (chart.yMax != null) yScale.max = chart.yMax;
    if (fixedBounds) yScale.step = niceScale(yScale.min, yScale.max, 5).step;
  }
  // A date axis (no time of day) steps in whole days, or neighbouring ticks would read the same date.
  if (dateKindOf(vs) === 'date' && yScale.step < 1) {
    yScale.step = 1;
    if (chart.yMin == null) yScale.min = Math.floor(yScale.min);
    if (chart.yMax == null) yScale.max = Math.max(Math.ceil(yScale.max), yScale.min + 1);
  }
  const xs = isScatter ? (data.x || categories.map((_, i) => i + 1)) : null;
  const xStyle = isScatter ? data.xStyle || null : null; // the x column's own format: dates read as dates
  let xScale = null;
  if (isScatter) {
    const finite = xs.filter((v) => v != null);
    xScale = chartAxisScale(minOf(finite), maxOf(finite), { ticks: 6, numeric: true });
    if (dateKindOf(xStyle) === 'date' && xScale.step < 1) {
      xScale.step = 1;
      xScale.min = Math.floor(xScale.min);
      xScale.max = Math.max(Math.ceil(xScale.max), xScale.min + 1);
    }
  }

  const valueLabels = scaleTicks(yScale);
  const valueLabelW = maxOf(valueLabels.map((v) => textW(axisLabel(v, vs, yScale.step), 11))) + 10;
  const y2Scale = secondary ? chartAxisScale(lo2, hi2, { ticks: 5 }) : null;
  const value2Labels = secondary ? scaleTicks(y2Scale) : [];
  const value2LabelW = secondary ? maxOf(value2Labels.map((v) => textW(axisLabel(v, vs2, y2Scale.step), 11))) + 10 : 0;
  const catLabelH = 22;
  // Axis titles: the vertical one runs up the left edge, the horizontal one sits under the labels.
  const leftTitle = horizontal ? chart.xTitle : chart.yTitle;
  const bottomTitle = horizontal ? chart.yTitle : chart.xTitle;
  const titleL = leftTitle ? 18 : 0;
  const titleB = bottomTitle ? 18 : 0;
  const titleR = secondary && chart.y2Title ? 18 : 0;
  const shortCategory = categoryShortener(categories, horizontal ? 18 : 14);
  const padL = (horizontal ? Math.min(W * 0.35, maxOf(categories.map((c) => textW(shortCategory(c), 11))) + 12) : valueLabelW) + titleL;
  const padB = (horizontal ? 22 : catLabelH) + titleB;
  const plot = { x: padL + 6, y: top + (chart.labels && !horizontal ? 14 : 6), w: right - padL - 18 - (chart.labels && horizontal ? 30 : 0) - value2LabelW - titleR, h: bottom - top - padB - 10 - (chart.labels && !horizontal ? 8 : 0) };
  const table = layoutChartDataTable(data, chart, plot, bottom - titleB, true, horizontal ? catLabelH : 0);
  if (plot.w < 20 || plot.h < 20) { if (table) parts.push(renderChartDataTable(data, chart, table)); parts.push('</svg>'); return parts.join(''); }
  // With fixed axis bounds, marks outside the plot are clipped instead of spilling over the labels.
  const plotClipId = `plot-${Math.random().toString(36).slice(2, 8)}`;
  if (fixedBounds) parts.push(`<clipPath id="${plotClipId}"><rect x="${f(plot.x - 1)}" y="${f(plot.y - 1)}" width="${f(plot.w + 2)}" height="${f(plot.h + 2)}"/></clipPath>`);
  const openMarks = () => parts.push(fixedBounds ? `<g clip-path="url(#${plotClipId})">` : '<g>');
  if (leftTitle) parts.push(`<text transform="translate(12 ${f(plot.y + plot.h / 2)}) rotate(-90)" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--ink-2)">${esc(truncate(leftTitle, Math.floor(plot.h / 7)))}</text>`);
  if (bottomTitle) parts.push(`<text x="${f(plot.x + plot.w / 2)}" y="${f(bottom - 2)}" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--ink-2)">${esc(truncate(bottomTitle, Math.floor(plot.w / 7)))}</text>`);
  if (titleR) parts.push(`<text transform="translate(${f(plot.x + plot.w + value2LabelW + 14)} ${f(plot.y + plot.h / 2)}) rotate(-90)" text-anchor="middle" font-size="11.5" font-weight="600" fill="var(--ink-2)">${esc(truncate(chart.y2Title, Math.floor(plot.h / 7)))}</text>`);
  // A value label, in its own series' format (a series' cells decide it, as they do its tooltips); a share
  // on a 100% stack reads as the percent it is, while a combo's line beside such a stack keeps its own.
  const valueText = (v, s = null, i = null) => {
    if (stack100 && (!s || s.raw)) return `${Math.round(v)}%`;
    const style = s ? chartPointStyle(s, i, vs) : vs;
    if (s?.pointStyles?.[i]) return formatValue(v, style);
    const text = pointValueText(v, style);
    return style?.fmt === 'custom' ? text : text.replace(/\.0(?=\D*$)/, '');
  };
  const gridText = (v) => (stack100 ? `${Math.round(v)}%` : axisLabel(v, vs, yScale.step));
  // A mark's tooltip: the series, the category and the value in its own cells' format (with its share on a 100% stack).
  const tipFor = (s, i) => `${s.name} · ${categories[i]}: ${tipText(s.raw ? s.raw[i] : s.values[i], chartPointStyle(s, i, vs))}${s.raw ? ` (${Math.round(s.values[i])}%)` : ''}`;
  // Trendlines: a dashed least-squares line per series, clipped to the plot.
  const clipId = `clip-${Math.random().toString(36).slice(2, 8)}`;
  if (chart.trendline) parts.push(`<clipPath id="${clipId}"><rect x="${f(plot.x)}" y="${f(plot.y)}" width="${f(plot.w)}" height="${f(plot.h)}"/></clipPath>`);
  const trend = (points, toX, color) => {
    const fit = linearFit(points);
    if (!fit) return;
    const xsAll = points.filter((p) => p && p[0] != null && p[1] != null).map((p) => p[0]);
    const x1 = minOf(xsAll);
    const x2 = maxOf(xsAll);
    parts.push(`<line x1="${f(toX(x1))}" y1="${f(vy(fit.intercept + fit.slope * x1))}" x2="${f(toX(x2))}" y2="${f(vy(fit.intercept + fit.slope * x2))}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 4" clip-path="url(#${clipId})"><title>${esc(`Trend: ${axisLabel(fit.slope)} per step`)}</title></line>`);
  };

  // Where the axis spans more than a double can hold, measure in halves so the fraction stays finite. A value far
  // outside fixed bounds (the largest double over an axis of 0 to 1) is held to a few plot heights past the edge,
  // where the clip hides it, rather than becoming an infinite coordinate.
  const held = (t) => (t > 11 ? 11 : t < -10 ? -10 : t);
  const ySpan = yScale.max - yScale.min;
  const yFrac = Number.isFinite(ySpan) ? (v) => held((v - yScale.min) / ySpan) : (v) => held((v / 2 - yScale.min / 2) / (yScale.max / 2 - yScale.min / 2));
  const vy = (v) => plot.y + plot.h - yFrac(v) * plot.h;
  const vx = (v) => plot.x + yFrac(v) * plot.w;
  const vy2 = secondary ? (v) => plot.y + plot.h - held((v - y2Scale.min) / (y2Scale.max - y2Scale.min)) * plot.h : vy;
  // The right-hand axis, in the line's color so it reads as that series' scale.
  if (secondary) {
    const lineColor = seriesPaint(chart, lineIdx[0]);
    for (const v of value2Labels) parts.push(`<text class="y2" x="${f(plot.x + plot.w + 6)}" y="${f(vy2(v) + 4)}" text-anchor="start" font-size="11" fill="${lineColor}">${esc(axisLabel(v, vs2, y2Scale.step))}</text>`);
    parts.push(`<line x1="${f(plot.x + plot.w)}" y1="${f(plot.y)}" x2="${f(plot.x + plot.w)}" y2="${f(plot.y + plot.h)}" stroke="${lineColor}" stroke-opacity="0.5" stroke-width="1"/>`);
  }

  // Gridlines and value labels.
  const grid = chart.gridlines !== false;
  for (const v of valueLabels) {
    if (horizontal) {
      const x = vx(v);
      if (grid) parts.push(`<line x1="${f(x)}" y1="${f(plot.y)}" x2="${f(x)}" y2="${f(plot.y + plot.h)}" stroke="var(--grid)" stroke-width="1"/>`);
      parts.push(`<text x="${f(x)}" y="${f(plot.y + plot.h + 15)}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${esc(gridText(v))}</text>`);
    } else {
      const y = vy(v);
      if (grid) parts.push(`<line x1="${f(plot.x)}" y1="${f(y)}" x2="${f(plot.x + plot.w)}" y2="${f(y)}" stroke="var(--grid)" stroke-width="1"/>`);
      parts.push(`<text x="${f(plot.x - 6)}" y="${f(y + 4)}" text-anchor="end" font-size="11" fill="var(--ink-3)">${esc(gridText(v))}</text>`);
    }
  }
  if (!grid) parts.push(horizontal
    ? `<line x1="${f(plot.x)}" y1="${f(plot.y + plot.h)}" x2="${f(plot.x + plot.w)}" y2="${f(plot.y + plot.h)}" stroke="var(--grid)" stroke-width="1"/>`
    : `<line x1="${f(plot.x)}" y1="${f(plot.y)}" x2="${f(plot.x)}" y2="${f(plot.y + plot.h)}" stroke="var(--grid)" stroke-width="1"/>`);
  // Zero line.
  if (yScale.min < 0 && yScale.max > 0) {
    if (horizontal) parts.push(`<line x1="${f(vx(0))}" y1="${f(plot.y)}" x2="${f(vx(0))}" y2="${f(plot.y + plot.h)}" stroke="var(--ink-3)" stroke-width="1"/>`);
    else parts.push(`<line x1="${f(plot.x)}" y1="${f(vy(0))}" x2="${f(plot.x + plot.w)}" y2="${f(vy(0))}" stroke="var(--ink-3)" stroke-width="1"/>`);
  }

  const categoryAxisValue = Math.min(yScale.max, Math.max(yScale.min, 0));
  const categoryLabelX = isHistogram || wf ? plot.x : vx(categoryAxisValue);
  const categoryLabelY = isHistogram || wf ? plot.y + plot.h : vy(categoryAxisValue);
  const categoryLabels = [];
  if (isScatter) {
    const sx = (v) => plot.x + ((v - xScale.min) / (xScale.max - xScale.min)) * plot.w;
    for (const v of scaleTicks(xScale)) {
      categoryLabels.push(`<text x="${f(sx(v))}" y="${f(categoryLabelY + 15)}" text-anchor="middle" font-size="11" fill="var(--ink-3)">${esc(axisLabel(v, xStyle, xScale.step))}</text>`);
    }
    openMarks();
    // Bubbles: area follows the size column, the largest at about an eighth of the plot.
    const sizes = chart.type === 'bubble' ? data.sizes : null;
    const maxSize = sizes ? Math.max(0, maxOf(sizes.filter((v) => v != null && v > 0))) : 0;
    const maxR = Math.max(6, Math.min(plot.w, plot.h) / 8);
    // A cloud denser than the budget reads the same drawn from every k-th point; the trendline still fits every point.
    const points = series.reduce((sum, s) => sum + s.values.filter((v, i) => v != null && xs[i] != null).length, 0);
    const every = Math.max(1, Math.ceil(points / MARK_BUDGET));
    series.forEach((s, si) => {
      const color = seriesPaint(chart, si);
      s.values.forEach((v, i) => {
        const x = xs[i];
        if (v == null || x == null || i % every) return;
        const size = sizes ? sizes[i] : null;
        const r = sizes ? (size != null && size > 0 && maxSize ? Math.max(2.5, Math.sqrt(size / maxSize) * maxR) : 2.5) : 4;
        const point = `${s.name}: (${tipText(x, xStyle)}, ${tipText(v, chartPointStyle(s, i, vs))})`;
        const tip = sizes ? `${point}, size ${size == null ? 'blank' : tipText(size, data.sizePointStyles?.[i] || data.sizeStyle)}` : point;
        parts.push(`<circle cx="${f(sx(x))}" cy="${f(vy(v))}" r="${f(r)}" fill="${color}" fill-opacity="${sizes ? 0.55 : 0.85}"${sizes ? ` stroke="${color}" stroke-width="1"` : ''}><title>${esc(tip)}</title></circle>`);
        // Labels name the values, or on a bubble chart the sizes: a point whose size is blank gets none,
        // rather than one that means something else than its neighbours'.
        const label = sizes ? (size != null ? data.sizePointStyles?.[i] ? formatValue(size, data.sizePointStyles[i]) : pointValueText(size, data.sizeStyle || null) : null) : valueText(v, s, i);
        if (chart.labels && label != null) parts.push(`<text x="${f(sx(x))}" y="${f(vy(v) - r - 3)}" text-anchor="middle" font-size="10" fill="var(--ink-2)">${esc(label)}</text>`);
      });
    });
    if (chart.trendline) series.forEach((s, si) => trend(s.values.map((v, i) => [xs[i], v]), sx, seriesPaint(chart, si)));
    parts.push('</g>', ...categoryLabels);
    if (table) parts.push(renderChartDataTable(data, chart, table));
    parts.push('</svg>');
    return parts.join('');
  }

  // Past one category per pixel the marks could not be told apart anyway.
  const px = Math.max(1, Math.floor(horizontal ? plot.h : plot.w));
  if (wf && n > px) {
    // A waterfall cannot leave bars out, since each floats on the running total of those before it: the
    // categories sharing a pixel merge into one bar for their combined change, named for the run it
    // covers, so the running total and the total bar stay exact.
    const changes = n - 1;
    const per = Math.ceil(changes / Math.max(1, px - 1));
    const steps = [];
    const names = [];
    for (let start = 0; start < changes; start += per) {
      const end = Math.min(changes, start + per) - 1;
      const delta = wf[end].to - wf[start].from;
      steps.push({ from: wf[start].from, to: wf[end].to, delta, kind: delta < 0 ? 'decrease' : 'increase' });
      names.push(end > start ? `${categories[start]}–${categories[end]}` : categories[start]);
    }
    steps.push(wf[changes]);
    names.push(categories[changes]);
    wf = steps;
    categories = names;
    n = names.length;
  } else if (!wf && n > px) {
    ({ categories, series } = thinToPixels(categories, series, px));
    n = categories.length;
  }
  // Series past the cap are not drawn (the legend already counts them); a stack, of bars or of areas, keeps
  // its totals true by folding them into one segment holding their sum, drawn last in the neutral ink, as a
  // pie gathers its smallest slices, so the top of the stack meets the total the axis was computed for.
  const fold = (rest) => {
    const sum = (of) => categories.map((_, i) => rest.reduce((acc, si) => { const v = of(series[si])[i]; return v == null ? acc : (acc ?? 0) + v; }, null));
    const raw = rest.some((si) => series[si].raw) ? { raw: sum((s) => s.raw || s.values) } : {};
    series = [...series, { name: `…and ${rest.length} more`, values: sum((s) => s.values), ...raw, style: series[rest[0]].style, fold: true }];
    return series.length - 1;
  };
  if (barIdx.length > MAX_SERIES) {
    const rest = barIdx.slice(MAX_SERIES);
    barIdx = barIdx.slice(0, MAX_SERIES);
    if (stacked) barIdx.push(fold(rest));
  }
  if (lineIdx.length > MAX_SERIES) {
    const rest = lineIdx.slice(MAX_SERIES);
    lineIdx = lineIdx.slice(0, MAX_SERIES);
    if (stacked && !isCombo) lineIdx.push(fold(rest));
  }
  const tooltips = n * (barIdx.length + lineIdx.length) <= MARK_BUDGET;

  // Category positions.
  const slot = horizontal ? plot.h / Math.max(1, n) : plot.w / Math.max(1, n);
  const catPos = (i) => (horizontal ? plot.y + slot * i : plot.x + slot * i);
  const labelEvery = Math.max(1, Math.ceil((horizontal ? 14 : maxOf(categories.map((c) => textW(shortCategory(c), 11))) + 8) / slot));
  categories.forEach((c, i) => {
    if (table && !horizontal) return;
    if (i % labelEvery) return;
    const label = esc(shortCategory(c));
    if (horizontal) categoryLabels.push(`<text x="${f(categoryLabelX - 6)}" y="${f(catPos(i) + slot / 2 + 4)}" text-anchor="end" font-size="11" fill="var(--ink-2)">${label}</text>`);
    else categoryLabels.push(`<text x="${f(catPos(i) + slot / 2)}" y="${f(categoryLabelY + 15)}" text-anchor="middle" font-size="11" fill="var(--ink-2)">${label}</text>`);
  });

  openMarks();
  if (wf) {
    // Waterfall: floating bars from the running total, joined by thin connectors, then the total.
    const gap = slot * 0.25;
    const barW = Math.max(1, slot - gap);
    wf.forEach((b, i) => {
      const x = catPos(i) + gap / 2;
      const y1 = vy(Math.max(b.from, b.to));
      const y2 = vy(Math.min(b.from, b.to));
      const color = wfColor(b.kind);
      const text = b.kind === 'total' ? valueText(b.to, series[0]) : `${b.delta > 0 ? '+' : b.delta < 0 ? '−' : ''}${valueText(Math.abs(b.delta), series[0], i)}`;
      const title = tooltips ? `<title>${esc(`${categories[i]}: ${text}`)}</title>` : '';
      parts.push(`<rect x="${f(x)}" y="${f(y1)}" width="${f(barW)}" height="${f(Math.max(0.75, y2 - y1))}" fill="${color}" rx="1">${title}</rect>`);
      if (i < wf.length - 1) parts.push(`<line x1="${f(x + barW)}" y1="${f(vy(b.to))}" x2="${f(catPos(i + 1) + gap / 2)}" y2="${f(vy(b.to))}" stroke="var(--ink-3)" stroke-width="1" stroke-dasharray="2 2"/>`);
      if (chart.labels && barW >= 6) parts.push(`<text x="${f(x + barW / 2)}" y="${f(b.to >= b.from ? y1 - 4 : y2 + 11)}" text-anchor="middle" font-size="10" fill="var(--ink-2)">${esc(text)}</text>`);
    });
  } else if (barIdx.length) {
    const groups = stacked ? 1 : barIdx.length;
    const gapWidth = authoredBarGapWidth(groups) / 100;
    const gap = isHistogram ? slot * .06 : slot * gapWidth / (groups + gapWidth);
    // Fractional widths keep dense clusters within their category slot.
    // Expanding each bar to a pixel would overlap neighboring categories.
    const barW = isHistogram ? Math.max(1, (slot - gap) / groups) : (slot - gap) / groups;
    const stackPos = new Array(n).fill(0);
    const stackNeg = new Array(n).fill(0);
    barIdx.forEach((si, gi) => {
      const s = series[si];
      const color = s.fold ? 'var(--ink-3)' : seriesPaint(chart, si);
      s.values.forEach((v, i) => {
        if (v == null) return;
        let from = 0;
        let to = v;
        if (stacked) {
          if (v >= 0) { from = stackPos[i]; to = stackPos[i] + v; stackPos[i] = to; } else { from = stackNeg[i]; to = stackNeg[i] + v; stackNeg[i] = to; }
        }
        const title = tooltips ? `<title>${esc(tipFor(s, i))}</title>` : '';
        if (horizontal) {
          const y = catPos(i) + gap / 2 + (stacked ? 0 : gi * barW);
          const x1 = vx(Math.min(from, to));
          const x2 = vx(Math.max(from, to));
          parts.push(`<rect x="${f(x1)}" y="${f(y)}" width="${f(Math.max(0.5, x2 - x1))}" height="${f(barW)}" fill="${color}" rx="1">${title}</rect>`);
          if (chart.labels && barW >= 9) {
            const inside = stacked && x2 - x1 > textW(valueText(v, s, i), 10) + 6;
            parts.push(`<text x="${f(inside ? (x1 + x2) / 2 : v >= 0 ? x2 + 4 : x1 - 4)}" y="${f(y + barW / 2 + 3.5)}" text-anchor="${inside ? 'middle' : v >= 0 ? 'start' : 'end'}" font-size="10" fill="${inside ? inkOn(color) : 'var(--ink-2)'}">${esc(valueText(v, s, i))}</text>`);
          }
        } else {
          const x = catPos(i) + gap / 2 + (stacked ? 0 : gi * barW);
          const y1 = vy(Math.max(from, to));
          const y2 = vy(Math.min(from, to));
          parts.push(`<rect x="${f(x)}" y="${f(y1)}" width="${f(barW)}" height="${f(Math.max(0.5, y2 - y1))}" fill="${color}" rx="1">${title}</rect>`);
          if (chart.labels && barW >= 6) {
            // Narrow bars get a smaller label rather than none; the tallest bars matter most.
            const size = barW >= textW(valueText(v, s, i), 10) - 4 ? 10 : 8.5;
            const inside = stacked && y2 - y1 > 14;
            parts.push(`<text x="${f(x + barW / 2)}" y="${f(inside ? (y1 + y2) / 2 + 3.5 : v >= 0 ? y1 - 4 : y2 + 11)}" text-anchor="middle" font-size="${size}" fill="${inside ? inkOn(color) : 'var(--ink-2)'}">${esc(valueText(v, s, i))}</text>`);
          }
        }
      });
    });
  }
  if (lineIdx.length) {
    // Line and area (and the line of a combo chart, on the right-hand axis when it has one).
    const vy = vy2; // eslint-disable-line no-shadow
    const base = new Array(n).fill(0);
    const showPoints = n <= 60;
    const lineStacked = stacked && !isCombo;
    lineIdx.forEach((si) => {
      const s = series[si];
      const color = s.fold ? 'var(--ink-3)' : seriesPaint(chart, si);
      const pts = [];
      const lows = [];
      s.values.forEach((v, i) => {
        if (v == null) { pts.push(null); lows.push(null); return; }
        const x = catPos(i) + slot / 2;
        const from = lineStacked ? base[i] : 0;
        const to = lineStacked ? base[i] + v : v;
        if (lineStacked) base[i] = to;
        pts.push([x, vy(to)]);
        lows.push([x, vy(from)]);
      });
      // Break the line at gaps.
      const runs = [];
      let run = [];
      pts.forEach((p, i) => { if (p) run.push(i); else if (run.length) { runs.push(run); run = []; } });
      if (run.length) runs.push(run);
      for (const idx of runs) {
        const line = idx.map((i) => `${f(pts[i][0])},${f(pts[i][1])}`).join(' ');
        if (chart.smooth && idx.length > 1) {
          // Curved: a Bézier through the points; the area closes back along the (equally curved) lower edge.
          const topPath = smoothPath(idx.map((i) => pts[i]));
          if (chart.type === 'area') {
            const backPath = smoothPath([...idx].reverse().map((i) => lows[i]), true);
            parts.push(`<path d="${topPath} ${backPath} Z" fill="${color}" fill-opacity="0.22"/>`);
          }
          parts.push(`<path d="${topPath}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
          continue;
        }
        if (chart.type === 'area' && idx.length) {
          const back = [...idx].reverse().map((i) => `${f(lows[i][0])},${f(lows[i][1])}`).join(' ');
          parts.push(`<polygon points="${line} ${back}" fill="${color}" fill-opacity="0.22"/>`);
        }
        if (idx.length === 1) parts.push(`<circle cx="${f(pts[idx[0]][0])}" cy="${f(pts[idx[0]][1])}" r="3.5" fill="${color}"/>`);
        else parts.push(`<polyline points="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`);
      }
      if (showPoints) {
        pts.forEach((p, i) => {
          if (!p) return;
          parts.push(`<circle cx="${f(p[0])}" cy="${f(p[1])}" r="3" fill="${color}"><title>${esc(tipFor(s, i))}</title></circle>`);
          if (chart.labels && (n <= 24 || i % Math.ceil(n / 24) === 0)) parts.push(`<text x="${f(p[0])}" y="${f(p[1] - 7)}" text-anchor="middle" font-size="10" fill="var(--ink-2)">${esc(valueText(s.values[i], s, i))}</text>`);
        });
      }
    });
  }
  if (chart.trendline && !stacked && !horizontal && (chart.type === 'column' || chart.type === 'line')) {
    for (const si of chart.type === 'line' ? lineIdx : barIdx) trend(series[si].values.map((v, i) => [i, v]), (i) => catPos(i) + slot / 2, seriesPaint(chart, si));
  }
  parts.push('</g>', ...categoryLabels);
  if (table) parts.push(renderChartDataTable(data, chart, table));
  parts.push('</svg>');
  return parts.join('');
}

/** A native chart's explicit plot layout, colors, axes and spacing travel with it. */
function bubblePoints(series, options) {
  return series.values.flatMap((y, i) => {
    const x = series.x?.[i], size = series.sizes?.[i];
    return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(size) && (size > 0 || options.showNegative && size < 0) ? [{ x, y, size: Math.abs(size), i }] : [];
  });
}

function bubbleErrorBars(points, errors) {
  return errors.flatMap(error => {
    const values = points.map(p => p[error.axis]);
    let mean = 0, sumSquares = 0, count = 0;
    for (const v of values) { const delta = v - mean; mean += delta / ++count; sumSquares += delta * (v - mean); }
    const deviation = count > 1 ? Math.sqrt(Math.max(0, sumSquares / (count - 1))) : 0;
    const common = error.type === 'stdErr' ? deviation / Math.sqrt(count || 1) : error.type === 'stdDev' ? deviation * error.value : error.value;
    return points.flatMap(p => {
      const v = p[error.axis], amount = error.type === 'percentage' ? Math.abs(v) * error.value / 100 : common;
      if (!Number.isFinite(amount)) return [];
      return [{ ...error, i: p.i, x: p.x, y: p.y, low: v - (error.direction === 'plus' ? 0 : amount), high: v + (error.direction === 'minus' ? 0 : amount) }];
    });
  });
}

/** The chart area: its fill, and its outline when the chart names one (a light grey border). */
function chartAreaRect(a, W, H) {
  const stroke = a.border !== false && a.borderColor && a.borderColor !== 'none' ? a.borderColor : null, w = a.borderWidth ?? 1;
  return `<rect data-el="chartArea" width="${W}" height="${H}" fill="${esc(a.background)}"/>`
    + (stroke ? `<rect class="chart-area-border" x="${f(w / 2)}" y="${f(w / 2)}" width="${f(Math.max(0, W - w))}" height="${f(Math.max(0, H - w))}" fill="none" stroke="${esc(stroke)}" stroke-width="${w}" pointer-events="none"/>` : '');
}
/** Format ▸ Shape Effects: a soft shadow below and right of the element, or a glow around it. */
function elementEffectDefs(a) {
  const used = Object.values(a.effects || {});
  if (!used.length) return '';
  const glows = [...new Set(used.map(e => e.glow).filter(Boolean))];
  return `<defs>${used.some(e => e.shadow) ? '<filter id="chart-fx-shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="2" dy="2" stdDeviation="2" flood-color="#000000" flood-opacity=".4"/></filter>' : ''}${glows.map(c => `<filter id="chart-fx-glow-${c.slice(1)}" x="-30%" y="-30%" width="160%" height="160%"><feMorphology in="SourceAlpha" operator="dilate" radius="2" result="grow"/><feGaussianBlur in="grow" stdDeviation="2.5" result="blur"/><feFlood flood-color="${c}" flood-opacity=".6"/><feComposite in2="blur" operator="in" result="glow"/><feMerge><feMergeNode in="glow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`).join('')}</defs>`;
}
function effectAttr(a, key) {
  const e = a.effects?.[key];
  return e?.glow ? ` filter="url(#chart-fx-glow-${e.glow.slice(1)})"` : e?.shadow ? ' filter="url(#chart-fx-shadow)"' : '';
}
/** A title's own fill and outline (Format ▸ Shape Fill/Outline), sized to its text. */
function textBox(box, effect, text, x, y, style, anchor, key) {
  if (!box || (!box.fill && !box.stroke) || (box.fill === 'none' && box.stroke === 'none')) return '';
  const w = textW(text, style.size) + style.size, h = style.size * 1.5;
  const left = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w + style.size / 2 : x - style.size / 2;
  const filter = effect?.glow ? ` filter="url(#chart-fx-glow-${effect.glow.slice(1)})"` : effect?.shadow ? ' filter="url(#chart-fx-shadow)"' : '';
  return `<rect data-el="${key}" x="${f(left)}" y="${f(y - style.size * 1.1)}" width="${f(w)}" height="${f(h)}" fill="${esc(box.fill && box.fill !== 'none' ? box.fill : 'transparent')}" stroke="${esc(box.stroke || 'none')}"${filter}/>`;
}
function legendBoxRect(box, b, size) {
  if (!box || (!box.fill && !box.stroke) || (box.fill === 'none' && box.stroke === 'none')) return '';
  const pad = size / 3;
  return `<rect x="${f(b.x - pad)}" y="${f(b.y - pad)}" width="${f(b.w + pad * 2)}" height="${f(b.h + pad * 2)}" fill="${esc(box.fill && box.fill !== 'none' ? box.fill : 'transparent')}" stroke="${esc(box.stroke || 'none')}"/>`;
}

/**
 * The automatic layout for a new chart: the plot fills the chart area under the title (or from the
 * top edge without one), leaving room for the axis labels the renderer measures, and the legend's band.
 */
function excelPlotLayout(chart, a, W, H, legend, categoryLabels) {
  const top = chart.title ? (a.title?.y ?? .035) * H + a.titleStyle.size * 1.7 : 10;
  const legendTop = legend && chart.legendPos === 'top' ? legend.y + legend.h + a.legendStyle.size / 2 : 0;
  const y = Math.max(top, legendTop);
  const right = chart.legend && chart.legendPos === 'right' ? W * .77 - 8 : W - 12;
  const bottom = H - 8 - (categoryLabels && chart.type !== 'bar' ? a.xStyle.size * 1.6 : 0);
  return { x: 10 / W, y: y / H, w: Math.max(10, right - 10) / W, h: Math.max(10, bottom - y) / H };
}

function renderStyledCartesian(data, chart, width, height) {
  const W = Math.max(120, width), H = Math.max(24, height), a = chart.appearance;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(chart.description || chart.title || `${chart.type} chart`)}" style="${PLOT_STYLE}">`,
    chartAreaRect(a, W, H), elementEffectDefs(a)];
  const axisLabels = [];
  let labelTarget = parts;
  const label = (value, x, y, style, anchor = 'start', extra = '') => {
    const multiline = Array.isArray(value) && value.length > 1;
    // Whitespace between tspans becomes a trailing SVG space and changes the
    // rotated bounds. Keep the accessible word separators in aria-label.
    const content = multiline ? value.map((line, i) => `<tspan x="${f(x)}" y="${f(y + i * style.size * 1.2)}">${esc(line)}</tspan>`).join('')
      : esc(Array.isArray(value) ? value[0] : value);
    labelTarget.push(`<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-family="${esc(fontStack(style.font))}" font-size="${style.size}"${style.bold ? ' font-weight="700"' : ''}${style.italic ? ' font-style="italic"' : ''} fill="${esc(style.color)}"${multiline ? ` aria-label="${esc(value.join(' '))}"` : ''} ${extra}>${content}</text>`);
  };
  if (chart.title) {
    const x = a.title ? a.title.x * W : W / 2, y = (a.title?.y ?? .035) * H + a.titleStyle.size;
    parts.push(textBox(a.titleBox, a.effects?.title, chart.title, x, y, a.titleStyle, a.title ? 'start' : 'middle', 'title'));
    label(chart.title, x, y, a.titleStyle, a.title ? 'start' : 'middle', 'data-el="title"');
  }
  // A bubble chart read from a range shares its x and size columns across its series; file series carry their own.
  const series = data.series.slice(0, MAX_SERIES).map(s => chart.type === 'bubble' && (!s.x || !s.sizes)
    ? { ...s, x: s.x || data.x, sizes: s.sizes || data.sizes, ...(!s.sizePointStyles && data.sizePointStyles ? { sizePointStyles: data.sizePointStyles } : {}),
      ...(s.sizeStyle === undefined && data.sizeStyle ? { sizeStyle: data.sizeStyle } : {}) } : s), n = data.categories.length;
  const layered = chart.type === 'combo' && a.seriesTypes?.length === series.length;
  const pureArea = chart.type === 'area';
  // Stacked lines accumulate as stacked areas do; only the fill is missing.
  const stackedLine = chart.type === 'line' && !!chart.stacked;
  const horizontal = chart.type === 'bar';
  const bottomTitle = horizontal ? chart.yTitle : chart.xTitle;
  const bottomTitleStyle = horizontal ? a.yStyle : a.xStyle;
  const crossings = a.axisCrossings || {};
  const crossingValue = (crossing, min, max, automatic = 0) => Math.min(max, Math.max(min,
    Number.isFinite(crossing) ? crossing : crossing === 'max' ? max : crossing === 'min' ? min : automatic));
  // The explicit maximum setting exchanges the outside of an axis; reversing
  // its perpendicular scale exchanges it again. Numeric crossings retain the
  // ordinary side, even at/beyond an endpoint.
  const categoryAxisHigh = (crossings.x === 'max') !== !!a.reverseValues;
  const valueAxisHigh = crossings.y != null ? (crossings.y === 'max') !== a.reverseCategories
    : a.yPosition === (horizontal ? 't' : 'r');
  const secondAxisHigh = (crossings.y2 == null || crossings.y2 === 'max') !== a.reverseCategories;
  const bubble = chart.type === 'bubble' ? a.bubble : null;
  // High/low select an end of the perpendicular scale. Reversing that scale
  // exchanges the physical side; nextTo follows the actual axis crossing.
  const fixedLabelSide = position => position === 'high' || position === 'low';
  const valueHigh = fixedLabelSide(a.yLabelPosition) ? (a.yLabelPosition === 'high') !== a.reverseCategories : valueAxisHigh;
  const secondHigh = fixedLabelSide(a.y2LabelPosition) ? (a.y2LabelPosition === 'high') !== a.reverseCategories : secondAxisHigh;
  const categoryLabels = !a.hideXAxis && a.xLabelPosition !== 'none';
  const categoryHigh = fixedLabelSide(a.xLabelPosition) ? (a.xLabelPosition === 'high') !== a.reverseValues : categoryAxisHigh;
  const valueLabels = !a.hideYAxis && a.yLabelPosition !== 'none';
  const numericX = chart.type === 'scatter' || !!bubble;
  const bubbles = bubble ? series.map(s => bubblePoints(s, bubble)) : [];
  const errors = bubble ? bubbles.map((points, i) => bubbleErrorBars(points, bubble.series[i]?.errors || [])) : [];
  const columnIndices = layered ? series.flatMap((_, i) => a.seriesTypes[i] === 'column' ? [i] : []) : null;
  const columnCount = layered ? columnIndices.length : chart.type === 'column' || horizontal ? series.length : chart.type === 'combo' ? Math.max(0, series.length - 1) : 0;
  const secondary = !layered && chart.type === 'combo' && chart.secondaryAxis && series.length > 1;
  const secondaryLabels = secondary && !a.hideY2Axis && a.y2LabelPosition !== 'none';
  const stacked = !layered && columnCount > 0 && chart.stacked, percent = stacked && chart.stack100;
  const positive = new Array(n).fill(0), negative = new Array(n).fill(0);
  const totals = percent ? data.categories.map((_, i) => series.slice(0, columnCount).reduce((sum, s) => sum + Math.abs(s.values[i] || 0), 0)) : null;
  // Each column segment starts at the preceding segment's end; negative values
  // accumulate separately. A combo's line keeps its own values and axis.
  const stacks = stacked ? series.slice(0, columnCount).map(s => s.values.map((raw, i) => {
    if (!Number.isFinite(raw)) return null;
    const value = percent ? totals[i] ? raw / totals[i] : 0 : raw;
    const running = value < 0 ? negative : positive, from = running[i];
    running[i] += value;
    return { from, to: running[i], value };
  })) : null;
  // Area stacks accumulate algebraically: a positive band above a negative
  // baseline must end at their sum, unlike positive/negative column stacks.
  const areaGroups = new Map();
  const areaGrouping = chart.stack100 ? 'percentStacked' : chart.stacked ? 'stacked' : 'standard';
  const areaStacks = layered || pureArea || stackedLine ? series.map((s, j) => {
    const group = pureArea || stackedLine ? { id: 0, grouping: areaGrouping } : a.seriesGroups?.[j];
    if ((!pureArea && !stackedLine && a.seriesTypes[j] !== 'area') || !['stacked', 'percentStacked'].includes(group?.grouping)) return null;
    let state = areaGroups.get(group.id);
    if (!state) {
      const members = pureArea || stackedLine ? series : series.filter((_, k) => a.seriesTypes[k] === 'area' && a.seriesGroups[k].id === group.id);
      state = { running: new Array(n).fill(0), totals: group.grouping === 'percentStacked'
        ? data.categories.map((_, i) => members.reduce((sum, s) => sum + Math.abs(s.values[i] || 0), 0)) : null };
      areaGroups.set(group.id, state);
    }
    return s.values.map((raw, i) => {
      if (!Number.isFinite(raw)) return null;
      const from = state.running[i], value = state.totals ? state.totals[i] ? raw / state.totals[i] : 0 : raw;
      state.running[i] += value;
      return { from, to: state.running[i] };
    });
  }) : [];
  const values = [...(stacked ? stacks.flatMap(points => points.filter(Boolean).map(p => p.to)) : []),
    ...series.flatMap((s, i) => (stacked && i < columnCount) || (secondary && i === series.length - 1) ? []
      : areaStacks[i] ? areaStacks[i].filter(Boolean).map(p => p.to) : bubble ? bubbles[i].map(p => p.y) : s.values.filter(Number.isFinite)),
    ...errors.flat().filter(e => e.axis === 'y').flatMap(e => [e.low, e.high])];
  const percentAxis = percent || (pureArea || stackedLine) && chart.stack100 || layered && series.every((_, i) => areaStacks[i] && a.seriesGroups[i]?.grouping === 'percentStacked');
  const axisScale = (values, options) => {
    // Out-of-range label helpers must not determine an automatic bound.
    const inBounds = values.filter(v => (options.min == null || v >= options.min) && (options.max == null || v <= options.max));
    return chartAxisScale(minOf(inBounds), maxOf(inBounds), options);
  };
  const primaryOptions = { min: chart.yMin, max: chart.yMax, step: a.yStep, ticks: 9, numeric: numericX, percent: percentAxis };
  const secondaryOptions = { min: a.y2Min, max: a.y2Max, step: a.y2Step, ticks: 10 };
  const secondValues = secondary ? series.at(-1).values.filter(Number.isFinite) : [];
  let categoryScale = axisScale(values, primaryOptions);
  let scale = categoryScale, scale2 = axisScale(secondValues, secondaryOptions);
  if (secondary && a.hideYAxis !== a.hideY2Axis) {
    // The surviving axis's bounds are shared, including all series/stack
    // extents, when exactly one value axis is deleted. Each axis retains its
    // direction and grid interval; the category axis still crosses its original
    // primary scale. Both deleted axes (and a sole deleted axis) stay independent.
    const combined = [...values, ...secondValues];
    if (a.hideYAxis) {
      // Transfer the primary range before rounding it to ticks. The secondary
      // then scales the union of those bounds and all actual series values;
      // its data can dominate, including values outside saved primary bounds.
      combined.push(...chartAxisTransferBounds(minOf(values), maxOf(values), primaryOptions));
      scale2 = axisScale(combined, secondaryOptions);
      scale = { ...scale2, step: scale.step };
    } else {
      categoryScale = scale = axisScale(combined, primaryOptions);
      scale2 = { ...scale, step: scale2.step };
    }
  }
  let categoryCrossing = crossingValue(crossings.x, scale.min, scale.max);
  const sameLegend = chart.legendPos === a.legendPos;
  const legendEntries = series.map((s, i) => ({ s, i, name: s.name,
    keyWidth: a.legendStyle.size * (bubble || pureArea || (layered ? ['area', 'column'].includes(a.seriesTypes[i]) : i < columnCount) ? .65 : 2) }))
    .filter(({ i }) => !a.legendHidden?.includes(i)).slice(0, MAX_LEGEND);
  const automaticLegend = chart.legend && chart.legendPos !== 'right' && !(sameLegend && a.legend)
    ? layoutLegend(legendEntries, a.legendStyle, W, H, chart.legendPos,
      chart.title ? (a.title?.y ?? .035) * H + a.titleStyle.size : 0) : null;
  const p = a.plot || (chart.pareto && !chart.title && !chart.legend
    ? { x: .04, y: .02, w: .91, h: .922 }
    : a.excelLayout ? excelPlotLayout(chart, a, W, H, automaticLegend, !a.hideXAxis && a.xLabelPosition !== 'none')
      : { x: .09, y: chart.legendPos === 'top' ? .24 : .17, w: chart.legendPos === 'right' ? .66 : .85, h: .65 });
  const plot = { x: p.x * W, y: p.y * H, w: (p.w ?? .85) * W, h: (p.h ?? .65) * H };
  const labelWidthLimit = (angle, horizontalAxis) => {
    const { cos, sin } = rotatedTextSize(0, 0, angle);
    const slot = (horizontalAxis ? plot.w : plot.h) / Math.max(1, a.categoryBetween === false ? n - 1 : n);
    if (horizontalAxis ? cos > 1 - 1e-10 : sin > 1 - 1e-10) return slot * (a.xLabelSkip || 1) - a.xStyle.size / 2;
    if (!horizontalAxis && cos > 1 - 1e-10) {
      // Saved inner plots already define the available outside-label margin.
      return (a.plot ? categoryHigh ? W - plot.x - plot.w : plot.x : W * .4) - 12;
    }
    return Infinity;
  };
  if (horizontal && !a.plot) {
    // Reserve labels in pixels so a compact progress bar keeps a readable axis.
    const rotatedLabels = data.categories.map(c => {
      const text = categoryTextLayout(c, a.xStyle, labelWidthLimit(a.xRotation, false), a.xWrap);
      return rotatedTextSize(text.width, text.height, a.xRotation);
    });
    const labelOverhang = categoryLabels && a.xRotation ? Math.max(0, ...rotatedLabels.map(s => s.height)) / 2 : 0;
    const categorySpace = Math.min(W * .4, Math.max(30, ...rotatedLabels.map(s => s.width + 12)));
    const atLeft = fixedLabelSide(a.xLabelPosition) ? !categoryHigh : !categoryHigh && categoryCrossing === (a.reverseValues ? scale.max : scale.min);
    const left = categoryLabels && atLeft ? categorySpace : Math.max(18, a.yStyle.size * 1.5);
    const right = categoryLabels && categoryHigh ? categorySpace + (chart.legend && chart.legendPos === 'right' ? W * .24 : 0)
      : chart.legend && chart.legendPos === 'right' ? W * .24 : Math.max(22, a.yStyle.size * 1.7);
    const top = (chart.title ? a.titleStyle.size + 18 : chart.legend && chart.legendPos === 'top' ? a.legendStyle.size * 2.5 : 6)
      + (valueLabels && valueHigh ? a.yStyle.size * 1.8 : 0) + labelOverhang;
    const bottom = (!valueLabels || valueHigh ? 8 : a.yStyle.size * 1.8 + 6) + (chart.legend && chart.legendPos === 'bottom' ? a.legendStyle.size * 2 : 0) + labelOverhang;
    Object.assign(plot, { x: left, y: top, w: Math.max(10, W - left - right), h: Math.max(8, H - top - bottom) });
  }
  if (chart.pareto && !a.plot) {
    const labelWidth = Math.max(a.xStyle.size, ...data.categories.map(c => axisTextWidth(c, a.xStyle)));
    const labelHeight = labelWidth > plot.w / Math.max(1, n) ? labelWidth / Math.SQRT2 + a.xStyle.size * 2 : a.xStyle.size * 2.5;
    plot.h = Math.max(20, Math.min(plot.h, H - plot.y - labelHeight));
  }
  if (automaticLegend && !a.plot) {
    if (chart.legendPos === 'top') {
      const extra = Math.max(0, automaticLegend.y + automaticLegend.h + a.legendStyle.size / 2 - plot.y);
      plot.y += extra; plot.h = Math.max(10, plot.h - extra);
    } else {
      const axisSpace = (horizontal ? valueLabels ? a.yStyle.size * 1.8 + 6 : 0 : categoryLabels && !categoryHigh ? a.xStyle.size * 1.5 + 6 : 0)
        + (bottomTitle ? bottomTitleStyle.size * 1.6 : 0);
      plot.h = Math.max(10, Math.min(plot.h, automaticLegend.y - a.legendStyle.size / 2 - axisSpace - plot.y));
    }
  }
  // Axis identities stay category/value when bars rotate. Reserve the physical
  // bottom title separately from labels, including saved inner-plot layouts.
  const horizontalTitleLimit = horizontal && bottomTitle
    ? (automaticLegend && chart.legendPos === 'bottom' ? automaticLegend.y - a.legendStyle.size / 2 : H) - bottomTitleStyle.size * 1.6 : H;
  if (horizontal && bottomTitle) plot.h = Math.max(10, Math.min(plot.h, horizontalTitleLimit - plot.y));
  let bottom = plot.y + plot.h;
  const valueFraction = (v, domain, reverse) => {
    const fraction = (v - domain.min) / (domain.max - domain.min || 1);
    return reverse ? 1 - fraction : fraction;
  };
  const sy = v => bottom - valueFraction(v, scale, a.reverseValues) * plot.h;
  const valueX = v => plot.x + valueFraction(v, scale, a.reverseValues) * plot.w;
  const categoryFraction = i => a.categoryBetween === false ? n > 1 ? i / (n - 1) : .5 : (i + .5) / Math.max(1, n);
  const categoryY = (i, s) => dates ? datePosition((s?.x || data.x)?.[i])
    : plot.y + plot.h * (a.reverseCategories ? categoryFraction(i) : 1 - categoryFraction(i));
  const sy2 = v => bottom - valueFraction(v, scale2, a.reverseSecondaryValues) * plot.h;
  const dateValues = bubble ? [...bubbles.flat().map(p => p.x), ...errors.flat().filter(e => e.axis === 'x').flatMap(e => [e.low, e.high])]
    : series.flatMap(s => s.x || data.x || []);
  const dates = a.dateAxis && !numericX ? chartDateAxis(dateValues, {
    min: a.xMin, max: a.xMax, baseUnit: a.xBaseTimeUnit, between: a.categoryBetween !== false,
  }) : null;
  const xInBounds = dateValues.filter(v => Number.isFinite(v) && (a.xMin == null || v >= a.xMin) && (a.xMax == null || v <= a.xMax));
  const xScale = numericX ? chartAxisScale(minOf(xInBounds), maxOf(xInBounds), { min: a.xMin, max: a.xMax, step: a.xStep, ticks: 7, numeric: true }) : null;
  const xMin = numericX ? xScale.min : dates ? dates.min : layered ? 1 : 0;
  const xMax = numericX ? xScale.max : dates ? dates.max : layered ? Math.max(1, n, maxOf(dateValues.filter(Number.isFinite))) : Math.max(0, n - 1);
  // Between-category axes leave half a base unit at each edge, including date gaps.
  const inset = numericX || a.categoryBetween === false ? 0 : .5;
  const sx = v => {
    const fraction = dates ? dates.fraction(v) : xMax === xMin && !inset ? .5 : (v - xMin + inset) / (xMax - xMin + 2 * inset || 1);
    return plot.x + (a.reverseCategories ? 1 - fraction : fraction) * plot.w;
  };
  const dateCoordinate = fraction => horizontal ? plot.y + plot.h * (a.reverseCategories ? fraction : 1 - fraction)
    : plot.x + plot.w * (a.reverseCategories ? 1 - fraction : fraction);
  const datePosition = (v, boundary = false) => dateCoordinate(dates.fraction(v, boundary ? -dates.inset : 0));
  const xValue = (i, s) => dates || numericX ? (s?.x || data.x)?.[i] : layered ? s ? s.x?.[i] : i + 1 : i;
  const xAt = (i, s) => sx(xValue(i, s));
  const between = a.categoryBetween !== false;
  const categoryTickPosition = i => {
    const fraction = between ? i / Math.max(1, n) : n > 1 ? i / (n - 1) : .5;
    return horizontal ? plot.y + plot.h * (a.reverseCategories ? fraction : 1 - fraction)
      : plot.x + plot.w * (a.reverseCategories ? 1 - fraction : fraction);
  };
  const valueAxisOrigin = (crossing, high) => {
    if (crossing == null) return horizontal ? high ? plot.y : bottom : high ? plot.x + plot.w
      : numericX ? sx(crossingValue(null, xMin, xMax)) : plot.x;
    // A between-date crossing selects the leading boundary of that day,
    // just as a category index selects its leading boundary. Numeric scatter
    // crossings have no category offset. Fractional values are retained.
    if (dates) return dateCoordinate(dates.crossing(crossing));
    if (numericX) return sx(crossingValue(crossing, xMin, xMax));
    // Fractional category indices are accepted. Between-category crossings
    // count the boundary preceding category 1; on-category crossings count
    // the category centers. Clamp before reversing the coordinate system.
    const last = Math.max(1, between ? n : n - 1);
    return categoryTickPosition(crossingValue(crossing, 1, last + 1, 1) - 1);
  };
  const formatted = (v, code, step, units) => {
    const divisor = units?.divisor || 1;
    return code ? formatValue(v / divisor, { fmt: 'custom', code }) : axisLabel(v / divisor, null, step / divisor);
  };
  if (horizontal && valueLabels) {
    // An automatic major unit must fit the formatted labels along the physical
    // axis. A fixed tick count ignores currency prefixes, font size and narrow
    // saved plots. Keep fixed bounds and authored major units unchanged; round
    // automatic bounds with the new unit so headroom still has a labeled tick.
    {
      while (true) {
        const ticks = scaleTicks(scale);
        const widths = ticks.map(v => axisTextWidth(formatted(v, percent ? '0%' : a.yFormat || (percentAxis ? '0%' : ''), scale.step, a.yUnits).trim(), a.yStyle));
        // Centered end labels need space outside the plot. Solve each edge's
        // movement by its fractional contribution to the label position, as
        // for an interior axis crossing. Keep sufficient authored margins.
        let left = 0, right = 0;
        ticks.forEach((v, i) => {
          if (!widths[i]) return;
          const fraction = valueFraction(v, scale, a.reverseValues), x = valueX(v);
          left = Math.max(left, (6 - x + widths[i] / 2) / Math.max(1e-9, 1 - fraction));
          right = Math.max(right, (x + widths[i] / 2 + 6 - W) / Math.max(1e-9, fraction));
        });
        const available = Math.max(0, plot.w - 10), total = left + right;
        if (total > available) { left *= available / total; right *= available / total; }
        plot.x += left; plot.w -= left + right;
        if (a.yStep > 0) break;
        const crowded = ticks.some((v, i) => i > 0 && Math.abs(valueX(v) - valueX(ticks[i - 1]))
          < (widths[i - 1] + widths[i]) / 2 + a.yStyle.size / 2);
        if (!crowded) break;
        const step = niceScale(0, scale.step * 2, 1).step;
        if (!Number.isFinite(step) || step <= scale.step || step > scale.max - scale.min) break;
        Object.assign(scale, axisScale(values, { ...primaryOptions, step }));
      }
      categoryCrossing = crossingValue(crossings.x, scale.min, scale.max);
    }
    const texts = scaleTicks(scale).map(v => formatted(v, percent ? '0%' : a.yFormat || (percentAxis ? '0%' : ''), scale.step, a.yUnits).trim()).filter(Boolean);
    if (texts.length) {
      const boxes = texts.map(t => categoryTextLayout(t, a.yStyle, Infinity, 'none'));
      const ascent = Math.max(...boxes.map(b => b.ascent)), descent = Math.max(...boxes.map(b => b.height - b.ascent));
      const origin = fixedLabelSide(a.yLabelPosition) ? valueHigh ? plot.y : bottom : valueAxisOrigin(crossings.y, valueAxisHigh);
      const fraction = (origin - plot.y) / plot.h;
      const overflow = valueHigh ? ascent + a.yStyle.size * .5 + 6 - origin
        : origin + a.yStyle.size * 1.5 + descent + 6 - horizontalTitleLimit;
      // Constrain a saved inner plot only when its value labels cross the
      // chart frame. An interior crossing moves by a fraction of the changed
      // edge, so solve that constraint while preserving the opposite edge.
      const movement = valueHigh ? 1 - fraction : fraction;
      const extra = Math.min(Math.max(0, plot.h - 10), Math.max(0, overflow) / Math.max(1e-9, movement));
      if (valueHigh) plot.y += extra;
      plot.h -= extra;
      bottom = plot.y + plot.h;
    }
  }
  const primaryLabelWidth = !horizontal && valueLabels ? Math.max(0, ...scaleTicks(scale).map(v =>
    axisTextWidth(formatted(v, percent ? '0%' : a.yFormat || (percentAxis ? '0%' : ''), scale.step, a.yUnits).trim(), a.yStyle))) : 0;
  const secondaryLabelWidth = secondaryLabels ? Math.max(0, ...scaleTicks(scale2).map(v =>
    axisTextWidth(formatted(v, a.y2Format, scale2.step, a.y2Units).trim(), a.y2Style))) : 0;
  const primaryTitleSpace = !horizontal && chart.yTitle ? a.yStyle.size * 1.6 : 0;
  const secondaryTitleSpace = secondary && chart.y2Title ? a.y2Style.size * 1.6 : 0;
  const valueLabelColumns = () => {
    const column = (position, high, crossing, axisHigh, width, gap) => {
      const origin = fixedLabelSide(position) ? high ? plot.x + plot.w : plot.x : valueAxisOrigin(crossing, axisHigh);
      return { x: origin + (high ? gap : -gap), fraction: (origin - plot.x) / plot.w, width, high };
    };
    const primary = column(a.yLabelPosition, valueHigh, crossings.y, valueAxisHigh, primaryLabelWidth, 18);
    const second = column(a.y2LabelPosition, secondHigh, crossings.y2 ?? 'max', secondAxisHigh, secondaryLabelWidth, 10);
    const bounds = c => c.high ? [c.x, c.x + c.width] : [c.x - c.width, c.x];
    const p = bounds(primary), q = bounds(second);
    // The secondary labels go outside the primary labels when both
    // occupy the same side. Measure their text; do not overlap the columns.
    if (valueLabels && secondaryLabels && valueHigh === secondHigh && p[0] < q[1] && q[0] < p[1]) {
      second.x = primary.x + (secondHigh ? 1 : -1) * (primary.width + 10 + primaryTitleSpace);
      second.fraction = primary.fraction;
    }
    return { primary, secondary: second };
  };
  if (!horizontal && (valueLabels || primaryTitleSpace)) {
    // Even a manually positioned inner plot is constrained to fit visible
    // axis labels. Keep sufficient saved margins and the opposite plot edge;
    // this is a rendering constraint, not a change to the stored layout.
    const space = primaryLabelWidth + 28 + primaryTitleSpace;
    const extra = Math.min(Math.max(0, plot.w - 10), Math.max(0, space - (valueHigh ? W - plot.x - plot.w : plot.x)));
    if (!valueHigh) plot.x += extra;
    plot.w = Math.max(10, plot.w - extra);
  }
  if (secondaryLabels || secondaryTitleSpace) {
    const column = valueLabelColumns().secondary;
    const overflow = secondHigh ? column.x + column.width + 10 + secondaryTitleSpace - W : 10 + secondaryTitleSpace - column.x + column.width;
    // Moving one plot edge moves an interior crossing by only its fractional
    // share. Solve that constraint while retaining the opposite plot edge.
    const movement = secondHigh ? column.fraction : 1 - column.fraction;
    const extra = Math.min(Math.max(0, plot.w - 10), Math.max(0, overflow) / Math.max(1e-9, movement));
    if (!secondHigh) plot.x += extra;
    plot.w -= extra;
  }
  const xStep = dates || numericX ? xScale?.step || a.xStep || (dates && a.xTimeUnit !== 'days' ? 1
    : Math.max(1, niceScale(dates ? dates.unitOf(xMin) : xMin, dates ? dates.unitOf(xMax) : xMax,
      Math.max(2, Math.floor((horizontal ? plot.h : plot.w) / 130))).step)) : 1;
  const xTicks = dates ? dates.ticks(xStep, a.xTimeUnit) : numericX ? scaleTicks({ min: xMin, max: xMax, step: xStep }) : [];
  const dateMajor = dates?.ticks(xStep, a.xTimeUnit, true);
  const categoryTexts = dates || numericX ? xTicks.map(v => formatted(v, a.xFormat || data.xStyle?.code, xStep, numericX ? a.xUnits : null)) : data.categories.map((text, i) =>
    a.xFormat && !a.xSourceLinked && data.categoryValues?.[i] != null ? formatValue(data.categoryValues[i], { fmt: 'custom', code: a.xFormat }) : text);
  let categoryLayouts = categoryTexts.map(c => categoryTextLayout(c, a.xStyle,
    dates || numericX ? Infinity : labelWidthLimit(a.xRotation, !horizontal), a.xWrap));
  const categoryWidth = Math.max(a.xStyle.size, ...categoryLayouts.map(c => c.width));
  const categoryAngle = a.xRotation || (!horizontal && !dates && !numericX && a.xRotationAuto !== false && columnCount > 0
    && categoryWidth > plot.w / Math.max(1, n) ? -45 : 0);
  if (categoryAngle !== a.xRotation) categoryLayouts = categoryTexts.map(c => categoryTextLayout(c, a.xStyle,
    labelWidthLimit(categoryAngle, !horizontal), a.xWrap));
  const categoryHeight = Math.max(a.xStyle.size, ...categoryLayouts.map(c => c.height));
  const categoryMultiline = categoryLayouts.some(c => c.lines.length > 1);
  const categoryText = rotatedTextSize(Math.max(a.xStyle.size, ...categoryLayouts.map(c => c.width)), categoryHeight, categoryAngle);
  if (horizontal && chart.xTitle) {
    // Fit the vertical category title outside its label column. Interior
    // crossings move by only a fraction of a changed plot edge.
    const fraction = fixedLabelSide(a.xLabelPosition) ? Number(categoryHigh)
      : valueFraction(crossingValue(crossings.x, categoryScale.min, categoryScale.max), categoryScale, a.reverseValues);
    const origin = plot.x + fraction * plot.w;
    const space = (categoryLabels ? categoryText.width + 10 : 0) + a.xStyle.size * 2 + 6;
    const overflow = space - (categoryHigh ? W - origin : origin);
    const movement = categoryHigh ? fraction : 1 - fraction;
    const extra = Math.min(Math.max(0, plot.w - 10), Math.max(0, overflow) / Math.max(1e-9, movement));
    if (!categoryHigh) plot.x += extra;
    plot.w -= extra;
  }
  if (!horizontal && !dates && !numericX && categoryLabels && !a.dataTable && !a.plot && n > 1) {
    const overhang = text => axisTextBox(text.width, a.xStyle.size, categoryAngle, categoryHigh, text.height, text.ascent);
    const left = overhang(categoryLayouts[a.reverseCategories ? n - 1 : 0]).left + 6;
    const right = W - overhang(categoryLayouts[a.reverseCategories ? 0 : n - 1]).right - 6;
    // End labels are inset by half a category band on between-category axes.
    // Solve their two edge constraints together: shrinking the plot also
    // shrinks that inset, so subtracting the old inset alone under-reserves it.
    const inset = a.categoryBetween === false ? 0 : .5 / n, outer = 1 - inset;
    let l = Math.max(plot.x, (left - inset * (plot.x + plot.w)) / outer);
    let r = Math.min(plot.x + plot.w, (right - inset * l) / outer);
    if (outer * l + inset * r < left) {
      l = Math.max(l, (outer * left - inset * right) / (outer - inset));
      r = Math.min(r, (outer * right - inset * left) / (outer - inset));
    }
    plot.x = Math.min(plot.x + Math.max(0, plot.w - 10), l);
    plot.w = Math.max(10, r - plot.x);
  }
  // Parallel angled labels can interleave: their line height, projected onto
  // the axis, determines spacing rather than the full enclosing rectangle.
  const projection = horizontal ? categoryText.cos : categoryText.sin;
  const extent = horizontal ? categoryText.height : categoryText.width;
  const labelSpacing = projection > 1e-6 ? Math.min(extent, (categoryHeight + a.xStyle.size * .2) / projection) : extent;
  const categorySkip = a.xLabelSkip || Math.max(1, Math.ceil(n / Math.max(1, Math.floor((horizontal ? plot.h : plot.w)
    / (horizontal ? Math.max(a.xStyle.size * 1.5, labelSpacing) : labelSpacing)))));
  if (!horizontal && !dates && !numericX && categoryLabels && !a.dataTable && !categoryHigh
    && ((!a.plot && categoryAngle) || categoryMultiline)) {
    const limit = chart.legend && chart.legendPos === 'bottom'
      ? (automaticLegend?.y ?? (sameLegend && a.legend ? a.legend.y : .91) * H) - a.legendStyle.size
      : H - (chart.xTitle ? a.xStyle.size * 1.6 : 6);
    // Multiline horizontal labels extend below their first baseline, including
    // descenders. Constrain even saved inner plots when that box would be cut
    // off by the chart frame; retain the saved top and horizontal geometry.
    const depth = categoryAngle ? categoryText.height + 6 : categoryHeight + a.xStyle.size * .7;
    plot.h = Math.max(10, Math.min(plot.h, limit - plot.y - depth));
    bottom = plot.y + plot.h;
  }
  if (!horizontal && categoryLabels && categoryHigh) {
    const furniture = a.plot ? 0 : Math.max(chart.title ? (a.title?.y ?? .035) * H + a.titleStyle.size * 1.2 : 0,
      automaticLegend && chart.legendPos === 'top' ? automaticLegend.y + automaticLegend.h : 0);
    const required = furniture + (categoryAngle ? categoryText.height + 6
      : Math.max(a.xStyle.size, ...categoryLayouts.map(t => t.height + t.ascent - a.xStyle.size * .5)) + 6);
    const extra = Math.min(Math.max(0, plot.h - 10), Math.max(0, required - plot.y));
    plot.y += extra; plot.h -= extra; // Retain the opposite plot edge.
  }
  const tableLimit = chart.legend && chart.legendPos === 'bottom'
    ? Math.min(H, (automaticLegend?.y ?? (sameLegend && a.legend ? a.legend.y : .91) * H) - a.legendStyle.size)
    : H - (bottomTitle ? bottomTitleStyle.size * 1.6 : a.dataTable?.style.size / 2 || 0);
  const table = layoutChartDataTable(data, chart, plot, tableLimit, !a.plot, horizontal ? a.yStyle.size * 2 : numericX ? a.xStyle.size * 2 : 0);
  if (table) bottom = plot.y + plot.h;
  // The plot area answers a click even when it has no fill of its own, so it can be selected and formatted.
  parts.push(`<rect data-el="plotArea" x="${f(plot.x)}" y="${f(plot.y)}" width="${f(plot.w)}" height="${f(plot.h)}" fill="${a.plotFill && a.plotFill !== 'none' ? esc(a.plotFill) : 'transparent'}"${effectAttr(a, 'plotArea')}/>`);
  // Plot-area formatting sits behind its gridlines, axes and data.
  if (a.plotStroke !== 'none' && (a.plotStroke || a.plotStrokeWidth != null || a.plotStrokeDash)) {
    const width = a.plotStrokeWidth ?? 1, dash = CHART_LINE_DASHES[a.plotStrokeDash] || [];
    parts.push(`<rect class="chart-plot-border" x="${f(plot.x)}" y="${f(plot.y)}" width="${f(plot.w)}" height="${f(plot.h)}" fill="none" stroke="${esc(a.plotStroke || '#000000')}" stroke-width="${width || 1}"${width === 0 ? ' vector-effect="non-scaling-stroke"' : ''}${dash.length ? ` stroke-dasharray="${dash.map(v => v * (width || 1)).join(' ')}"` : ''}/>`);
  }
  const gridline = (axis, x1, y1, x2, y2) => {
    const style = a.gridlineStyles?.[axis], legacyColor = axis === 'x' ? bubble?.xGridColor : axis === 'y' ? bubble?.yGridColor : null;
    const color = style?.color && style.color !== 'none' ? style.color : legacyColor;
    // A zero/omitted DrawingML line width is a device-unit hairline.
    parts.push(`<line class="chart-gridline chart-gridline-${axis}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" stroke="${esc(color || (axis === 'x' ? a.xStyle : axis === 'y2' ? a.y2Style : a.yStyle).color)}" stroke-opacity="${color ? 1 : .15}" stroke-width="${style?.width || 1}"${style?.width === 0 ? ' vector-effect="non-scaling-stroke"' : ''} data-el="gridlines-${axis}"/>`);
  };
  const minorTicks = (axis, major, ticks, date = false) => {
    const style = a.axisStyles?.[axis];
    if (!style || style.color === 'none' || style.minorTick === 'none') return [];
    const unit = style.minorTimeUnit || 'days';
    // Numeric major intervals divide into fifths; date minor intervals
    // use calendar units (one day when unspecified), not fractions of months.
    const step = style.minorUnit || (date ? 1 : major.step / 5);
    const candidates = date ? dates.ticks(step, unit, true)
      : scaleTicks({ ...major, step });
    let index = 0;
    return candidates.filter(v => {
      while (index + 1 < ticks.length && ticks[index + 1] <= v) index++;
      // Compare locally, without rounding large values to fewer significant
      // digits (which could merge distinct, closely spaced ticks).
      return ![ticks[index], ticks[index + 1]].some(t => t != null && Math.abs(v - t)
        <= Math.max(Math.min(step, major.step) * 1e-8, Number.EPSILON * Math.max(Math.abs(v), Math.abs(t))));
    });
  };
  const axis = (key, vertical, origin, start, end, major, minor, hidden) => {
    const style = a.axisStyles?.[key];
    if (!style || hidden || style.color === 'none') return;
    const width = style.width ?? 1, dash = CHART_LINE_DASHES[style.dash] || [];
    const attrs = `stroke="${esc(style.color || '#000000')}" stroke-width="${width || 1}"${width === 0 ? ' vector-effect="non-scaling-stroke"' : ''}`;
    const segment = (cls, x1, y1, x2, y2, dashed = false) => parts.push(`<line class="${cls} chart-axis-${key}" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}" ${attrs}${dashed && dash.length ? ` stroke-dasharray="${dash.map(v => v * (width || 1)).join(' ')}"` : ''} data-el="${key === 'x' ? 'xAxis' : key === 'y' ? 'yAxis' : 'y2Axis'}"/>`);
    if (vertical) segment('chart-axis-line', origin, start, origin, end, true);
    else segment('chart-axis-line', start, origin, end, origin, true);
    const high = key === 'x' ? categoryAxisHigh : key === 'y2' ? secondAxisHigh : valueAxisHigh;
    const outward = (vertical ? 1 : -1) * (high ? 1 : -1);
    const ticks = (positions, kind, length, name) => {
      // An omitted or empty tick-mark setting uses crossing ticks.
      if (kind === 'none') return;
      const from = kind === 'out' ? 0 : -length, to = kind === 'in' ? 0 : length;
      for (const position of positions) {
        if (vertical) segment(`chart-axis-tick chart-axis-tick-${name}`, origin + outward * from, position, origin + outward * to, position);
        else segment(`chart-axis-tick chart-axis-tick-${name}`, position, origin + outward * from, position, origin + outward * to);
      }
    };
    ticks(major, style.majorTick, 5, 'major');
    ticks(minor, style.minorTick, 3, 'minor');
  };
  const primaryTicks = scaleTicks(scale), secondaryTicks = secondary ? scaleTicks(scale2) : [];
  const tickSkip = a.axisStyles?.x?.tickSkip || 1;
  const categoryTicks = offset => !a.axisStyles?.x || dates || numericX || !n ? [] : Array.from({
    length: Math.min(5001, Math.max(0, Math.floor(((between ? n : n - 1) - offset) / tickSkip) + 1)),
  }, (_, i) => categoryTickPosition(offset + i * tickSkip));
  // One minor tick goes halfway between category major ticks,
  // including fractional category positions when tickMarkSkip is odd.
  const categoryMajor = categoryTicks(0), categoryMinor = categoryTicks(tickSkip / 2);
  const crossingFraction = valueFraction(crossingValue(crossings.x, categoryScale.min, categoryScale.max), categoryScale, a.reverseValues);
  const xOrigin = horizontal ? plot.x + crossingFraction * plot.w : bottom - crossingFraction * plot.h;
  axis('x', horizontal, xOrigin, horizontal ? plot.y : plot.x, horizontal ? bottom : plot.x + plot.w,
    dates ? dateMajor.map(v => datePosition(v, true)) : numericX ? xTicks.map(sx) : categoryMajor,
    dates || numericX ? minorTicks('x', { min: xMin, max: xMax, step: xStep }, dateMajor || xTicks, !!dates)
      .map(v => dates ? datePosition(v, true) : sx(v)) : categoryMinor, a.hideXAxis);
  if (!horizontal && !a.hideXAxis && !a.axisStyles?.x) parts.push(`<line x1="${f(plot.x)}" y1="${f(xOrigin)}" x2="${f(plot.x + plot.w)}" y2="${f(xOrigin)}" stroke="${esc(a.xStyle.color)}" stroke-opacity=".1" stroke-width=".5"/>`);
  const yOrigin = valueAxisOrigin(crossings.y, valueAxisHigh);
  const y2Origin = valueAxisOrigin(crossings.y2 ?? 'max', secondAxisHigh);
  const valueColumns = valueLabelColumns();
  const valueLabelOrigin = fixedLabelSide(a.yLabelPosition) ? horizontal ? valueHigh ? plot.y : bottom : valueHigh ? plot.x + plot.w : plot.x : yOrigin;
  axis('y', !horizontal, yOrigin, horizontal ? plot.x : plot.y, horizontal ? plot.x + plot.w : bottom,
    primaryTicks.map(horizontal ? valueX : sy), minorTicks('y', scale, primaryTicks).map(horizontal ? valueX : sy), a.hideYAxis);
  if (secondary) axis('y2', true, y2Origin, plot.y, bottom,
    secondaryTicks.map(sy2), minorTicks('y2', scale2, secondaryTicks).map(sy2), a.hideY2Axis);
  if (a.xGridlines ?? (bubble?.xGrid && chart.gridlines)) {
    if (dates) for (const v of dateMajor) {
      const position = datePosition(v, true);
      if (horizontal) gridline('x', plot.x, position, plot.x + plot.w, position);
      else gridline('x', position, plot.y, position, bottom);
    }
    else if (numericX) for (const v of xTicks) gridline('x', sx(v), plot.y, sx(v), bottom);
    else if (a.categoryBetween !== false) for (let i = 0; i <= n; i++) {
      const position = i / Math.max(1, n);
      if (horizontal) gridline('x', plot.x, plot.y + position * plot.h, plot.x + plot.w, plot.y + position * plot.h);
      else gridline('x', plot.x + position * plot.w, plot.y, plot.x + position * plot.w, bottom);
    } else data.categories.forEach((_, i) => {
      if (horizontal) gridline('x', plot.x, categoryY(i), plot.x + plot.w, categoryY(i));
      else gridline('x', xAt(i), plot.y, xAt(i), bottom);
    });
  }
  labelTarget = axisLabels;
  for (const v of primaryTicks) {
    if (horizontal) {
      const x = valueX(v);
      if (chart.gridlines) gridline('y', x, plot.y, x, bottom);
      if (!a.axisStyles?.y && !a.hideYAxis && a.valueTicks) {
        const topAxis = valueAxisHigh, y = yOrigin;
        parts.push(`<line x1="${f(x)}" y1="${f(y)}" x2="${f(x)}" y2="${f(y + (topAxis ? -5 : 5))}" stroke="${esc(a.yStyle.color)}"/>`);
      }
      if (valueLabels) label(formatted(v, percent ? '0%' : a.yFormat || (percentAxis ? '0%' : ''), scale.step, a.yUnits).trim(), x,
        valueLabelOrigin + (valueHigh ? -a.yStyle.size * .5 : a.yStyle.size * 1.5), a.yStyle, 'middle', 'data-el="yAxis"');
      continue;
    }
    const y = sy(v);
    if (chart.gridlines) gridline('y', plot.x, y, plot.x + plot.w, y);
    if (valueLabels) label(formatted(v, percent ? '0%' : a.yFormat || (percentAxis ? '0%' : ''), scale.step, a.yUnits).trim(), valueColumns.primary.x,
      y + a.yStyle.size * .35, a.yStyle, valueHigh ? 'start' : 'end', 'data-el="yAxis"');
  }
  if (secondary) for (const v of secondaryTicks) {
    if (a.y2Gridlines) gridline('y2', plot.x, sy2(v), plot.x + plot.w, sy2(v));
    if (secondaryLabels) label(formatted(v, a.y2Format, scale2.step, a.y2Units).trim(), valueColumns.secondary.x, sy2(v) + a.y2Style.size * .35, a.y2Style, secondHigh ? 'start' : 'end', 'data-el="y2Axis"');
  }
  if (horizontal) {
    if (categoryLabels) {
      const origin = fixedLabelSide(a.xLabelPosition) ? categoryHigh ? plot.x + plot.w : plot.x : xOrigin;
      const side = categoryHigh ? 1 : -1;
      (dates ? xTicks : data.categories).forEach((c, i) => {
        if (!dates && i % categorySkip) return;
        const text = categoryLayouts[i];
        const centerY = dates ? datePosition(c) : categoryY(i);
        let x = origin + side * 10, y = centerY + text.ascent - text.height / 2 + a.xStyle.size * .05;
        if (categoryAngle) {
          // Align the rotated bounding box beside the chosen axis/plot edge.
          // SVG rotates around the baseline, not the text center.
          const w = text.width, center = text.ascent - text.height / 2;
          const radians = categoryAngle * Math.PI / 180, cos = Math.cos(radians), sin = Math.sin(radians);
          x += side * (rotatedTextSize(w, text.height, categoryAngle).width - w * cos) / 2 - center * sin;
          y = centerY - side * w * sin / 2 + center * cos;
        }
        label(text.lines, x, y, a.xStyle, categoryHigh ? 'start' : 'end', `data-el="xAxis"${categoryAngle ? ` transform="rotate(${categoryAngle} ${f(x)} ${f(y)})"` : ''}`);
      });
    }
  } else if (categoryLabels && (!table || numericX)) {
    const origin = fixedLabelSide(a.xLabelPosition) ? categoryHigh ? plot.y : bottom : xOrigin;
    const baseline = (box, angle, height = a.xStyle.size) => categoryHigh ? origin - (angle ? 6 + box.bottom : a.xStyle.size * .5 + height - a.xStyle.size)
      : origin + (angle ? 6 - box.top : a.xStyle.size * 1.5);
    if (dates || numericX) {
      for (const [i, v] of xTicks.entries()) {
        const text = categoryLayouts[i];
        const box = axisTextBox(text.width, a.xStyle.size, a.xRotation, categoryHigh, text.height, text.ascent);
        const x = sx(v), y = baseline(box, a.xRotation, text.height);
        label(text.lines, x, y, a.xStyle, box.anchor,
          `data-el="xAxis"${a.xRotation ? ` transform="rotate(${a.xRotation} ${f(x)} ${f(y)})"` : ''}`);
      }
    } else {
      data.categories.forEach((c, i) => {
        if (i % categorySkip) return;
        const text = categoryLayouts[i];
        const box = axisTextBox(text.width, a.xStyle.size, categoryAngle, categoryHigh, text.height, text.ascent);
        const x = xAt(i), y = baseline(box, categoryAngle, text.height);
        label(text.lines, x, y, a.xStyle, box.anchor,
          `data-el="xAxis"${categoryAngle ? ` transform="rotate(${categoryAngle} ${f(x)} ${f(y)})"` : ''}`);
      });
    }
  }
  labelTarget = parts;
  const lineStyle = i => a.lines[i] || a.lineDefault || { width: 2, marker: true, markerSize: 5 };
  const clipId = `chart-plot-${Math.random().toString(36).slice(2, 10)}`;
  parts.push(`<defs><clipPath id="${clipId}"><rect x="${f(plot.x)}" y="${f(plot.y - 1)}" width="${f(plot.w)}" height="${f(plot.h + 2)}"/></clipPath></defs>`);
  const bubblePaint = bubble ? series.map((s, i) => {
    const gradient = bubble.series[i]?.gradient;
    if (chart.colors?.[i] || !gradient?.stops.length) return seriesColor(chart, i);
    const angle = gradient.angle * Math.PI / 180, dx = Math.cos(angle), dy = Math.sin(angle), id = `${clipId}-gradient-${i}`;
    parts.push(`<defs><linearGradient id="${id}" x1="${f((1 - dx) * 50)}%" y1="${f((1 - dy) * 50)}%" x2="${f((1 + dx) * 50)}%" y2="${f((1 + dy) * 50)}%">${gradient.stops.map(s => `<stop offset="${s.offset}" stop-color="${s.color}" stop-opacity="${s.opacity}"/>`).join('')}</linearGradient></defs>`);
    return `url(#${id})`;
  }) : [];
  const maxBubble = Math.max(1e-100, maxOf(bubbles.flat().map(p => p.size)));
  const maxBubbleRadius = bubble ? Math.min(plot.w, plot.h) / 8 * bubble.scale / 100 : 0;
  const bubbleLabels = [];
  const outsideLabels = [];
  const pointLabel = (...args) => { label(...args); outsideLabels.push(parts.pop()); };
  parts.push(`<g clip-path="url(#${clipId})">`);
  series.forEach((s, j) => {
    const color = seriesColor(chart, j), line = lineStyle(j), runs = [];
    const valueY = secondary && j === series.length - 1 ? sy2 : sy;
    if (bubble) {
      const st = bubble.series[j], labels = st?.labels;
      const hidden = new Set(labels?.points.filter(p => p.hidden).map(p => p.index));
      const every = Math.max(1, Math.ceil(n * series.length / MARK_BUDGET));
      bubbles[j].forEach(({ x, y, size, i }) => {
        if (i % every || !maxBubbleRadius) return;
        const r = maxBubbleRadius * (bubble.sizeRepresents === 'w' ? size / maxBubble : Math.sqrt(size / maxBubble));
        parts.push(`<circle class="chart-bubble" cx="${f(sx(x))}" cy="${f(sy(y))}" r="${f(r)}" fill="${bubblePaint[j]}" stroke="${st?.stroke || 'none'}" stroke-width="${st?.strokeWidth ?? 1}" data-el="series" data-series="${j}" data-point="${i}"${effectAttr(a, `series:${j}`)}><title>${esc(`${s.name}: (${tipText(x, data.xStyle)}, ${tipText(y, chartPointStyle(s, i))}), size ${tipText(s.sizes[i], chartPointStyle(s, i, null, 'sizePointStyles'))}`)}</title></circle>`);
        if (chart.labels && labels && !hidden.has(i)) {
          const values = [labels.series && s.name, labels.category && tipText(x, data.xStyle), labels.value && formatValue(y, chartPointStyle(s, i)), labels.size && formatValue(s.sizes[i], chartPointStyle(s, i, null, 'sizePointStyles'))].filter(v => v !== false);
          if (values.length && x >= xMin && x <= xMax && y >= scale.min && y <= scale.max) bubbleLabels.push({ value: values.join(', '), x: sx(x), y: sy(y), r, labels });
        }
      });
      for (const e of errors[j]) {
        if (e.i % every) continue;
        const x1 = sx(e.axis === 'x' ? e.low : e.x), x2 = sx(e.axis === 'x' ? e.high : e.x);
        const y1 = sy(e.axis === 'y' ? e.low : e.y), y2 = sy(e.axis === 'y' ? e.high : e.y);
        const caps = !e.caps ? '' : e.axis === 'x' ? ` M ${f(x1)} ${f(y1 - 3)} V ${f(y1 + 3)} M ${f(x2)} ${f(y2 - 3)} V ${f(y2 + 3)}`
          : ` M ${f(x1 - 3)} ${f(y1)} H ${f(x1 + 3)} M ${f(x2 - 3)} ${f(y2)} H ${f(x2 + 3)}`;
        parts.push(`<path class="chart-error-bar" data-axis="${e.axis}" d="M ${f(x1)} ${f(y1)} L ${f(x2)} ${f(y2)}${caps}" fill="none" stroke="${e.color}" stroke-width="${e.width}"/>`);
      }
      return;
    }
    const columnIndex = layered ? columnIndices.indexOf(j) : j < columnCount ? j : -1;
    if (columnIndex >= 0) {
      const groups = stacked ? 1 : columnCount;
      const stride = 1 - (a.overlap || 0) / 100, groupWidth = 1 + (groups - 1) * stride;
      const slot = (horizontal ? plot.h : plot.w) / (dates ? dates.span : Math.max(1, n)), barWidth = slot / (groupWidth + a.gapWidth / 100);
      const pointColors = new Map((a.pointColors?.[j] || []).map(p => [p.index, p.color]));
      const bar = a.bars?.[j], points = new Map((bar?.points || []).map(p => [p.index, p]));
      const seriesLabels = a.valueLabels?.[j], labelPoints = new Map((seriesLabels?.points || []).map(p => [p.index, p]));
      const every = Math.max(1, Math.ceil(n * columnCount / MARK_BUDGET));
      s.values.forEach((v, i) => {
        if (!Number.isFinite(v) || i % every || dates && !Number.isFinite(dates.fraction(xValue(i, s)))) return;
        const segment = stacks?.[j][i];
        const valuePos = horizontal ? valueX : sy;
        // Stacks retain their algebraic zero baseline; ordinary bars begin at
        // the category axis crossing.
        const baseline = valuePos(segment ? segment.from : categoryCrossing);
        const x = (horizontal ? categoryY(i, s) : xAt(i, s)) - barWidth * groupWidth / 2 + (stacked ? 0 : columnIndex * barWidth * stride), y = valuePos(segment ? segment.to : v);
        const point = points.get(i), normalFill = pointColors.get(i) || color;
        // ISO 29500 invertIfNegative uses the value's sign, including stacked
        // segments. The solid-fill inversion defaults to white, not transparency
        // or an RGB complement; c14:invertSolidFillFmt supplies a custom color.
        // An explicit dPt has its own default-true inversion flag. Its spPr
        // replaces the series shape formatting (including the inverted fill),
        // whereas a flag-only dPt inherits that shape.
        const ownShape = point?.shape || pointColors.has(i) || point?.stroke != null || point?.strokeWidth != null || point?.strokeDash != null;
        const invert = bar ? (point || pointColors.has(i) ? point?.invertIfNegative !== false : bar.invertIfNegative !== false) : false;
        const negativeColor = ownShape ? null : bar?.negativeColor;
        const inverted = v < 0 && invert && normalFill !== 'none';
        let paint = inverted ? negativeColor || '#ffffff' : normalFill;
        const gradient = pointColors.has(i) ? null : point?.gradient || (!chart.colors?.[j] ? bar?.gradient : null);
        if (!inverted && gradient?.stops.length) {
          const gx = horizontal ? Math.min(y, baseline) : x, gy = horizontal ? x : Math.min(y, baseline);
          const gw = horizontal ? Math.abs(baseline - y) : barWidth, gh = horizontal ? barWidth : Math.abs(baseline - y);
          const angle = gradient.angle * Math.PI / 180;
          let dx = Math.cos(angle), dy = Math.sin(angle);
          // DrawingML's unscaled angle lives in physical shape coordinates.
          // Project the rectangle onto that direction to reach both extreme stops.
          if (gradient.scaled) { dx *= gw; dy *= gh; }
          const length = Math.hypot(dx, dy) || 1; dx /= length; dy /= length;
          const half = (Math.abs(dx) * gw + Math.abs(dy) * gh) / 2;
          const id = `${clipId}-bar-gradient-${j}-${i}`;
          parts.push(`<defs><linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(gx + gw / 2 - dx * half)}" y1="${f(gy + gh / 2 - dy * half)}" x2="${f(gx + gw / 2 + dx * half)}" y2="${f(gy + gh / 2 + dy * half)}">${gradient.stops.map(stop => `<stop offset="${stop.offset}" stop-color="${stop.color}" stop-opacity="${stop.opacity}"/>`).join('')}</linearGradient></defs>`);
          paint = `url(#${id})`;
        }
        const border = ownShape ? point : bar;
        // The default white inverted fill is outlined even when the ordinary
        // series border is automatic/no-fill. A custom inverted fill keeps it off.
        const stroke = inverted && !negativeColor && (!border?.stroke || border.stroke === 'none') ? '#000000' : border?.stroke || 'none';
        const strokeWidth = border?.strokeWidth ?? 1, dash = CHART_LINE_DASHES[border?.strokeDash] || [];
        const tip = `${s.name} · ${(s.categories || data.categories)[i]}: ${tipText(v, chartPointStyle(s, i))}`;
        parts.push(`<rect class="chart-series ${horizontal ? 'chart-bar' : 'chart-column'}" x="${f(horizontal ? Math.min(y, baseline) : x)}" y="${f(horizontal ? x : Math.min(y, baseline))}" width="${f(horizontal ? Math.abs(baseline - y) : barWidth)}" height="${f(horizontal ? barWidth : Math.abs(baseline - y))}" fill="${paint}" stroke="${stroke}" stroke-width="${strokeWidth || 1}"${strokeWidth === 0 ? ' vector-effect="non-scaling-stroke"' : ''}${dash.length ? ` stroke-dasharray="${dash.map(v => v * (strokeWidth || 1)).join(' ')}"` : ''} data-el="series" data-series="${j}" data-point="${i}"${effectAttr(a, `series:${j}`)}><title>${esc(tip)}</title></rect>`);
        const override = labelPoints.get(i), options = seriesLabels && { ...seriesLabels, ...override,
          style: { ...seriesLabels.style, ...override?.style } };
        const hidden = override?.hidden ?? seriesLabels?.hidden.includes(i);
        if (chart.labels && (!dates || dates.fraction(xValue(i, s)) >= 0 && dates.fraction(xValue(i, s)) <= 1)
          && (segment ? segment.to : v) >= scale.min && (segment ? segment.to : v) <= scale.max && (!options || options.show && !hidden)) {
          const text = options?.numberFormat ? formatValue(v, { fmt: 'custom', code: options.numberFormat })
            : percent && !options ? formatValue(segment.value, { fmt: 'percent', dec: 0 }) : tipText(v, chartPointStyle(s, i));
          // MS-OI29500 21.2.2.48: omitted positions center stacked bars, while
          // clustered bars use outside-end. Keep omission in the portable model.
          const position = options ? options.position || (stacked ? 'ctr' : 'outEnd')
            : stacked && Math.abs(baseline - y) > (horizontal ? textW(text, a.yStyle.size) + 8 : a.yStyle.size * 1.5) ? 'ctr' : 'outEnd';
          const inside = ['ctr', 'inEnd', 'inBase'].includes(position);
          const style = options?.style || (inside ? { ...a.yStyle, color: inkOn(paint) } : a.yStyle);
          const direction = Math.sign(y - baseline) || Math.sign(valuePos(scale.max) - valuePos(scale.min)) || 1;
          const pad = style.size * .3;
          if (horizontal) {
            const at = position === 'ctr' ? (y + baseline) / 2 : position === 'inEnd' ? y - direction * pad
              : position === 'inBase' ? baseline + direction * pad : y + direction * 6;
            const anchor = position === 'ctr' ? 'middle' : (position === 'inEnd' ? -direction : direction) > 0 ? 'start' : 'end';
            pointLabel(text, at, x + barWidth / 2 + style.size * .35, style, anchor, `data-el="dataLabels" data-series="${j}"`);
          } else {
            const at = position === 'ctr' ? (y + baseline) / 2 + style.size * .35
              : position === 'inEnd' ? y - direction * (pad + style.size / 2) + style.size * .35
              : position === 'inBase' ? baseline + direction * (pad + style.size / 2) + style.size * .35
              : y + (direction < 0 ? -8 : style.size + 4);
            pointLabel(text, x + barWidth / 2, at, style, 'middle', `data-el="dataLabels" data-series="${j}"`);
          }
        }
      });
      return;
    }
    let run = [];
    s.values.forEach((raw, i) => {
      // Select Data ▸ Hidden and Empty Cells: a blank is a gap, a zero, or bridged by the line.
      if (!Number.isFinite(raw) && a.blanks === 'span' && Number.isFinite(xValue(i, s))) return;
      const v = !Number.isFinite(raw) && a.blanks === 'zero' ? 0 : raw;
      if (!Number.isFinite(v) || !Number.isFinite(xValue(i, s)) || dates && !Number.isFinite(dates.fraction(xValue(i, s)))) { if (run.length) runs.push(run); run = []; }
      else run.push([xAt(i, s), valueY(areaStacks[j]?.[i]?.to ?? v), i]);
    });
    if (run.length) runs.push(run);
    for (const points of runs) {
      const d = (line.smooth ?? chart.smooth) ? smoothPath(points) : points.map(([x, y], i) => `${i ? 'L' : 'M'} ${f(x)} ${f(y)}`).join(' ');
      const area = pureArea || layered && a.seriesTypes[j] === 'area';
      if (area) {
        const lower = areaStacks[j] ? [...points].reverse().map(([x, , i]) => `L ${f(x)} ${f(sy(areaStacks[j][i].from))}`).join(' ')
          : `L ${f(points.at(-1)[0])} ${f(sy(categoryCrossing))} L ${f(points[0][0])} ${f(sy(categoryCrossing))}`;
        parts.push(`<path class="chart-series chart-area" d="${d} ${lower} Z" fill="${color}"${area && line.color ? ` stroke="${line.color}" stroke-width="${line.width}"` : ''} data-el="series" data-series="${j}"${effectAttr(a, `series:${j}`)}><title>${esc(s.name)}</title></path>`);
      }
      const dash = CHART_LINE_DASHES[line.dash] || [];
      if (line.visible !== false && !(area && a.excelLayout)) parts.push(`<path class="chart-series" d="${d}" fill="none" stroke="${line.color || color}" stroke-width="${line.width}"${dash.length ? ` stroke-dasharray="${dash.map(v => v * line.width).join(' ')}"` : ''} stroke-linejoin="round" stroke-linecap="round" data-el="series" data-series="${j}"${effectAttr(a, `series:${j}`)}><title>${esc(s.name)}</title></path>`);
      const every = Math.max(1, Math.ceil(n * series.length / MARK_BUDGET));
      for (const [x, y, i] of points) {
        if (i % every) continue;
        const tip = `${s.name} · ${(s.categories || data.categories)[i]}: ${tipText(s.values[i], chartPointStyle(s, i))}`;
        if (!area && line.marker) parts.push(chartMarker(line.markerSymbol, x, y, markerPixels(line), line.markerFill || color, line.markerStroke || color, tip)
          .replace(/^<(\w+) /, `<$1 data-el="series" data-series="${j}" data-point="${i}" `));
        const options = a.valueLabels?.[j];
        if (chart.labels && s.values[i] != null && (!options?.position || options.show)) {
          const text = options?.numberFormat ? formatValue(s.values[i], { fmt: 'custom', code: options.numberFormat }) : tipText(s.values[i], chartPointStyle(s, i));
          const style = options?.position ? options.style : { ...a.yStyle, size: 12 }, pos = options?.position;
          const gap = markerPixels(line) / 2 + 4;
          if (!pos) label(text, x, y - 8, style, 'middle', 'data-el="dataLabels"');
          else label(text, x + (pos === 'r' ? gap : pos === 'l' ? -gap : 0), y + (pos === 't' ? -gap : pos === 'b' ? gap + style.size * .7 : style.size * .35), style,
            pos === 'r' ? 'start' : pos === 'l' ? 'end' : 'middle', `data-el="dataLabels" data-series="${j}"`);
        }
      }
    }
    if (chart.trendline) {
      const points = s.values.map((v, i) => [xValue(i, s), v]).filter(p => p.every(Number.isFinite)
        && (!dates || Number.isFinite(dates.fraction(p[0])))), fit = linearFit(points);
      if (fit) {
        const first = minOf(points.map(p => p[0])), last = maxOf(points.map(p => p[0]));
        parts.push(`<line x1="${f(sx(first))}" y1="${f(valueY(fit.intercept + fit.slope * first))}" x2="${f(sx(last))}" y2="${f(valueY(fit.intercept + fit.slope * last))}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 4"/>`);
      }
    }
  });
  parts.push('</g>');
  // Interior tick labels remain readable over bars, areas and other marks.
  parts.push(...axisLabels, ...outsideLabels);
  for (const l of bubbleLabels) {
    const st = l.labels.style, pos = l.labels.position;
    label(l.value, l.x + (pos === 'l' ? -l.r - 4 : pos === 'r' ? l.r + 4 : 0), l.y + (pos === 't' ? -l.r - 4 : pos === 'b' ? l.r + st.size : st.size * .35),
      st, pos === 'l' ? 'end' : pos === 'r' ? 'start' : 'middle', 'class="chart-data-label"');
  }
  if (bubble) {
    if (!a.hideXAxis && !a.axisStyles?.x && bubble.xAxisColor) parts.push(`<line x1="${f(plot.x)}" y1="${f(xOrigin)}" x2="${f(plot.x + plot.w)}" y2="${f(xOrigin)}" stroke="${bubble.xAxisColor}"/>`);
    if (!a.hideYAxis && !a.axisStyles?.y && bubble.yAxisColor) parts.push(`<line x1="${f(yOrigin)}" y1="${f(plot.y)}" x2="${f(yOrigin)}" y2="${f(bottom)}" stroke="${bubble.yAxisColor}"/>`);
  }

  // Value-from-cells labels are independent of the plotted Y values (often
  // hidden helper coordinates). Draw them above the layers, with live formatting.
  if (layered) series.forEach((s, j) => {
    const labels = a.dataLabels[j];
    if (!labels || !s.labels) return;
    const overrides = new Map(labels.points.map(p => [p.index, p]));
    const every = Math.max(1, Math.ceil(n * series.length / MARK_BUDGET));
    s.labels.forEach((value, i) => {
      const point = overrides.get(i);
      // Keep the range-present fallback for legacy charts without this setting;
      // explicit point flags override the series flag, but never undo deletion.
      if (!value || point?.hidden || (point?.showRange ?? labels.showRange) === false || i % every || !Number.isFinite(s.values[i]) || !Number.isFinite(s.x[i])
        || s.values[i] < scale.min || s.values[i] > scale.max
        || (dates ? !(dates.fraction(s.x[i]) >= 0 && dates.fraction(s.x[i]) <= 1) : s.x[i] < xMin || s.x[i] > xMax)) return;
      const position = point?.position || labels.position, size = labels.style.size;
      const dx = position === 'r' ? 6 : position === 'l' ? -6 : 0;
      const dy = position === 't' ? -size * .7 : position === 'b' ? size * 1.2 : size * .35;
      label(value, sx(s.x[i]) + dx + (point?.dx || 0) * W, sy(s.values[i]) + dy + (point?.dy || 0) * H,
        labels.style, position === 'r' ? 'start' : position === 'l' ? 'end' : 'middle', 'class="chart-data-label"');
    });
  });
  if (chart.legend && series.length) {
    const style = a.legendStyle;
    let vertical = chart.legendPos === 'right';
    const l = sameLegend && a.legend ? a.legend : { x: vertical ? .77 : .03, y: chart.legendPos === 'top' ? .12 : vertical ? .25 : .91, w: vertical ? .21 : .94, h: .06 };
    const entries = legendEntries;
    const layout = automaticLegend || (sameLegend && a.legend ? layoutLegend(entries, style, W, H, chart.legendPos, 0,
      { x: l.x * W, y: l.y * H, w: (l.w ?? .94) * W, h: l.h == null ? null : l.h * H }, vertical) : null);
    const box = layout ? { x: layout.x, y: layout.y, w: layout.w, h: layout.h }
      : { x: l.x * W, y: l.y * H, w: (l.w ?? .94) * W, h: vertical ? entries.length * style.size * 1.7 : (l.h ?? .06) * H };
    parts.push(`<g data-el="legend"${effectAttr(a, 'legend')}>`, legendBoxRect(a.legendBox, box, style.size));
    const widths = entries.map(({ s }) => 30 + textW(s.name, style.size));
    const gap = Math.max(8, ((l.w ?? .94) * W - widths.reduce((sum, w) => sum + w, 0)) / (widths.length + 1));
    let x = l.x * W + (vertical ? 0 : gap), y = l.y * H + (vertical ? style.size * .75 : (l.h ?? .06) * H / 2);
    entries.forEach(({ s, i, keyWidth }, entry) => {
      const placed = layout?.entries[entry];
      if (placed) { x = placed.x; y = placed.y; }
      const key = placed ? keyWidth : 26, keyH = placed ? style.size * .65 : 10;
      const color = seriesColor(chart, i), line = lineStyle(i);
      if (bubble) parts.push(`<circle cx="${f(x + (placed ? key / 2 : 4))}" cy="${f(y)}" r="${placed ? key / 2 : 4}" fill="${bubblePaint[i]}"/>`);
      else if (pureArea || (layered ? ['area', 'column'].includes(a.seriesTypes[i]) : i < columnCount)) parts.push(`<rect x="${f(x)}" y="${f(y - keyH / 2)}" width="${f(key)}" height="${f(keyH)}" fill="${color}"/>`);
      else {
        if (line.visible !== false) parts.push(`<line x1="${f(x)}" y1="${f(y)}" x2="${f(x + key)}" y2="${f(y)}" stroke="${color}" stroke-width="${line.width}" stroke-linecap="round"/>`);
        if (line.marker) parts.push(chartMarker(line.markerSymbol, x + key / 2, y, Math.min(markerPixels(line), style.size), line.markerFill || color, line.markerStroke || color, '', 'chart-legend-marker'));
      }
      if (placed) placed.lines.forEach((text, k) => label(text, placed.textX, placed.baseline + k * layout.lineH, style, 'start', 'class="chart-legend-label"'));
      else if (bubble && vertical) {
        const lines = wrapChartText(s.name, Math.max(20, (l.w ?? .21) * W - 14), style);
        lines.forEach((text, k) => label(text, x + 14, y + style.size * (.3 + k * 1.2), style));
        y += Math.max(0, lines.length - 1) * style.size * 1.2;
      } else label(s.name, x + (bubble ? 14 : 29), y + style.size * .3, style);
      if (vertical) y += style.size * 1.7; else x += widths[entry] + gap;
    });
    parts.push('</g>');
  }
  if (table) parts.push(renderChartDataTable(data, chart, table));
  if (bottomTitle) label(bottomTitle, plot.x + plot.w / 2, (automaticLegend && chart.legendPos === 'bottom' ? automaticLegend.y : H) - 6, bottomTitleStyle, 'middle', `data-el="${horizontal ? 'yTitle' : 'xTitle'}"`);
  if (horizontal && chart.xTitle) {
    const origin = fixedLabelSide(a.xLabelPosition) ? categoryHigh ? plot.x + plot.w : plot.x : xOrigin;
    const x = origin + (categoryHigh ? 1 : -1) * ((categoryLabels ? categoryText.width + 10 : 0) + a.xStyle.size);
    label(chart.xTitle, 0, 0, a.xStyle, 'middle', `data-el="xTitle" transform="translate(${f(x)} ${f(plot.y + plot.h / 2)}) rotate(-90)"`);
  } else if (!horizontal && chart.yTitle) {
    const column = valueLabelColumns().primary;
    const x = column.x + (valueHigh ? 1 : -1) * (column.width + a.yStyle.size);
    label(chart.yTitle, 0, 0, a.yStyle, 'middle', `data-el="yTitle" transform="translate(${f(x)} ${f(plot.y + plot.h / 2)}) rotate(-90)"`);
  }
  if (secondaryTitleSpace) {
    const column = valueLabelColumns().secondary;
    const x = column.x + (secondHigh ? 1 : -1) * (column.width + a.y2Style.size);
    // An axis title remains visible when the axis line/ticks are deleted.
    label(chart.y2Title, 0, 0, a.y2Style, 'middle', `transform="translate(${f(x)} ${f(plot.y + plot.h / 2)}) rotate(-90)"`);
  }
  for (const [units, visible, vertical, high] of [[a.yUnits, valueLabels, !horizontal, valueHigh],
    [a.xUnits, numericX && categoryLabels, false, categoryHigh], [a.y2Units, secondary && !a.hideY2Axis, true, true]]) {
    if (!units?.label || !visible) continue;
    const rotated = Math.abs(units.rotation) > 45;
    const x = units.layout ? units.layout.x * W : vertical && rotated ? high ? W - units.style.size : units.style.size * 1.5 : plot.x;
    const y = units.layout ? units.layout.y * H : vertical && rotated ? plot.y + plot.h / 2 : vertical || high ? plot.y - units.style.size : Math.min(H - 4, bottom + units.style.size * 3);
    label(units.label, 0, 0, units.style, rotated ? 'middle' : 'start',
      `class="chart-display-units" transform="translate(${f(x)} ${f(y)}) rotate(${units.rotation})"`);
  }
  for (const note of a.annotations || []) {
    const { box, style } = note, x = box.x * W, y = box.y * H, w = (box.w ?? .2) * W, h = (box.h ?? .1) * H;
    parts.push(`<rect class="chart-annotation-box" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${note.fill}" stroke="${note.stroke}"/>`);
    const lines = wrapChartText(note.text, Math.max(1, w - 8), style).slice(0, Math.max(1, Math.floor((h - 4) / (style.size * 1.2))));
    lines.forEach((text, i) => label(text, x + (note.align === 'center' ? w / 2 : note.align === 'right' ? w - 4 : 4), y + 2 + style.size * (1 + i * 1.2), style,
      note.align === 'center' ? 'middle' : note.align === 'right' ? 'end' : 'start', 'class="chart-annotation"'));
  }
  parts.push('</svg>');
  return parts.join('');
}

/** The table belongs to the plot's layout, and reads unscaled series values.
 * Unlike an axis, it must not apply display units or percent-stack transforms.
 * CT_DTable: https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.drawing.charts.datatable
 */
function layoutChartDataTable(data, chart, plot, limit, automatic, axisGap = 0) {
  const table = chart.appearance?.dataTable;
  if (!table || !data.categories.length || !data.series.length) return null;
  const { style } = table, pad = style.size / 2, keyWidth = table.keys ? style.size * 2.5 : 0;
  let desired = pad * 2 + keyWidth;
  for (const s of data.series) desired = Math.max(desired, axisTextWidth(s.name, style) + pad * 2 + keyWidth);
  // Share the available width between the row heading and category columns.
  // Imported manual plot geometry remains authoritative; its headings wrap.
  if (automatic) {
    const extra = Math.max(0, Math.min(desired + pad, (plot.x + plot.w) / 3) - plot.x);
    plot.x += extra; plot.w = Math.max(1, plot.w - extra);
  }
  const heading = Math.max(1, Math.min(desired, plot.x - pad)), column = plot.w / data.categories.length;
  const headLines = data.categories.map(c => wrapChartText(String(c), Math.max(1, column - 2 * pad), style));
  const names = data.series.map(s => wrapChartText(s.name, Math.max(1, heading - keyWidth - pad * 2), style));
  const heights = [Math.max(1, ...headLines.map(l => l.length)), ...names.map(l => Math.max(1, l.length))].map(lines => (lines * 1.2 + .6) * style.size);
  const naturalHeight = heights.reduce((a, b) => a + b, 0);
  // Extremely small charts still retain every table entry. Compress the table
  // as a unit rather than dropping rows or letting them cover the plot/legend.
  const scale = Math.min(1, Math.max(1, limit - plot.y - style.size * 2 - axisGap) / naturalHeight);
  const height = naturalHeight * scale;
  plot.h = Math.max(1, Math.min(plot.h, limit - plot.y - height - axisGap));
  return { x: plot.x - heading, y: plot.y + plot.h + axisGap, heading, column, width: heading + plot.w,
    heights, height, scale, headLines, names, pad, keyWidth };
}

function renderChartDataTable(data, chart, box) {
  const table = chart.appearance.dataTable, st = table.style;
  const { heading, column, width, heights, scale, headLines, names, pad, keyWidth } = box;
  const height = heights.reduce((a, b) => a + b, 0), parts = [`<g class="chart-data-table" role="table" aria-label="Chart data" transform="translate(${f(box.x)} ${f(box.y)}) scale(1 ${f(scale)})" font-family="${esc(fontStack(st.font))}" font-size="${st.size}" fill="${esc(st.color)}"${st.bold ? ' font-weight="700"' : ''}${st.italic ? ' font-style="italic"' : ''}>`,
    `<rect width="${f(width)}" height="${f(height)}" fill="${esc(table.fill)}"/>`];
  const text = (value, lines, x, y, w, h, start = false, inset = 0) => {
    const anchor = start ? pad + inset : w / 2;
    parts.push(`<svg x="${f(x)}" y="${f(y)}" width="${f(Math.max(0, w))}" height="${f(h)}" overflow="hidden" role="cell"><title>${esc(value)}</title>`);
    parts.push(`<text x="${f(anchor)}" y="${f((h - lines.length * st.size * 1.2) / 2 + st.size)}" text-anchor="${start ? 'start' : 'middle'}">`);
    for (let i = 0; i < lines.length; i++) parts.push(`<tspan x="${f(anchor)}" dy="${i ? f(st.size * 1.2) : 0}">${esc(lines[i])}</tspan>`);
    parts.push('</text></svg>');
  };
  parts.push('<g role="row">');
  data.categories.forEach((c, i) => text(c, headLines[i], heading + column * i, 0, column, heights[0]));
  parts.push('</g>');
  let y = heights[0];
  data.series.forEach((s, j) => {
    const h = heights[j + 1], color = seriesColor(chart, j);
    parts.push('<g role="row">');
    text(s.name, names[j], 0, y, heading, h, true, keyWidth);
    if (table.keys) {
      const x = pad, cy = y + h / 2, key = Math.min(keyWidth - pad, Math.max(0, heading - pad * 2));
      const type = chart.type === 'combo' ? chart.appearance.seriesTypes?.[j] || (j === data.series.length - 1 ? 'line' : 'column') : chart.type;
      const line = chart.appearance.lines?.[j];
      if (['line', 'scatter'].includes(type)) {
        if (line?.visible !== false) parts.push(`<line class="chart-table-key" x1="${f(x)}" y1="${f(cy)}" x2="${f(x + key)}" y2="${f(cy)}" stroke="${esc(line?.color || color)}" stroke-width="${line?.width ?? 2}"/>`);
        if (line?.marker !== false) parts.push(chartMarker(line?.markerSymbol, x + key / 2, cy, line?.markerSize == null ? st.size / 2 : Math.min(markerPixels(line), st.size), line?.markerFill || color, line?.markerStroke || color, '', 'chart-table-key chart-table-marker'));
      } else parts.push(`<rect class="chart-table-key" x="${f(x)}" y="${f(cy - st.size / 4)}" width="${f(key)}" height="${f(st.size / 2)}" fill="${esc(color)}"/>`);
    }
    data.categories.forEach((_, i) => {
      const value = s.values[i] == null ? '' : formatValue(s.values[i], chartPointStyle(s, i, data.valueStyle));
      text(value, [value], heading + column * i, y, column, h);
    });
    parts.push('</g>'); y += h;
  });
  let border = '';
  if (table.outline) border += `M ${f(heading)} 0 H ${f(width)} V ${f(height)} H 0 V ${f(heights[0])} H ${f(heading)} Z `;
  if (table.horizontal) {
    let y = 0;
    for (let r = 0; r < heights.length - 1; r++) { y += heights[r]; border += `M ${r ? 0 : f(heading)} ${f(y)} H ${f(width)} `; }
  }
  if (table.vertical) for (let i = 0; i < data.categories.length; i++) border += `M ${f(heading + i * column)} ${i ? 0 : f(heights[0])} V ${f(height)} `;
  if (border) parts.push(`<path class="chart-table-borders" d="${border.trim()}" fill="none" stroke="${esc(table.stroke)}" stroke-width="${table.width}"/>`);
  parts.push('</g>');
  return parts.join('');
}

function wrapChartText(text, width, style) {
  const lines = [];
  for (const paragraph of text.split(/\r\n?|\n/)) {
    let line = '';
    // Preserve nonbreaking, figure and narrow nonbreaking spaces as word glue.
    for (const word of paragraph.split(/[^\S\u00a0\u2007\u202f]+/)) {
      if (line && axisTextWidth(line + ' ' + word, style) > width) { lines.push(line); line = ''; }
      line += (line ? ' ' : '') + word;
    }
    lines.push(line);
  }
  return lines;
}

/**
 * Categories thinned to at most one per pixel. Each run of categories sharing a pixel is drawn as
 * the one of them whose values reach furthest, so peaks, signs and stacks survive and every drawn
 * bar or point is a real category (its label and tooltip stay true), while the mark count stays
 * bounded by the plot's size.
 */
function thinToPixels(categories, series, px) {
  const n = categories.length;
  const per = Math.ceil(n / px);
  const keep = [];
  for (let start = 0; start < n; start += per) {
    let best = start;
    let reach = -1;
    for (let i = start; i < Math.min(n, start + per); i++) {
      let sum = 0;
      for (const s of series) if (s.values[i] != null) sum += Math.abs(s.values[i]);
      if (sum > reach) { reach = sum; best = i; }
    }
    keep.push(best);
  }
  const pick = (values) => keep.map((i) => values[i]);
  return { categories: pick(categories), series: series.map((s) => ({ ...s, values: pick(s.values), ...(s.raw ? { raw: pick(s.raw) } : {}) })) };
}

// Native marker sizes are points; SVG coordinates use CSS pixels (96 dpi).
const markerPixels = line => (line?.markerSize ?? 5) * 4 / 3;

// DrawingML dot is a short horizontal bar, distinct from a circle. Share
// marker geometry across plot points, legends and chart data-table keys.
function chartMarker(symbol, x, y, size, fill, stroke, title = '', className = 'chart-marker') {
  const r = size / 2, attrs = `fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="1"`, tip = title ? `<title>${esc(title)}</title>` : '';
  if (symbol === 'none') return '';
  if (symbol === 'square') return `<rect class="${className}" x="${f(x-r)}" y="${f(y-r)}" width="${size}" height="${size}" ${attrs}>${tip}</rect>`;
  else if (symbol === 'diamond' || symbol === 'triangle') {
    const pts = symbol === 'diamond' ? [[x,y-r],[x+r,y],[x,y+r],[x-r,y]] : [[x,y-r],[x+r,y+r],[x-r,y+r]];
    return `<polygon class="${className}" points="${pts.map(p=>p.map(f).join(',')).join(' ')}" ${attrs}>${tip}</polygon>`;
  } else if (['plus','x','star','dash','dot'].includes(symbol)) {
    const lines = symbol === 'dot' ? [[x-r/2,y,x+r/2,y]] : symbol === 'dash' ? [[x-r,y,x+r,y]] : symbol === 'x' ? [[x-r,y-r,x+r,y+r],[x-r,y+r,x+r,y-r]]
      : [[x-r,y,x+r,y],[x,y-r,x,y+r], ...(symbol === 'star' ? [[x-r,y-r,x+r,y+r],[x-r,y+r,x+r,y-r]] : [])];
    return `<path class="${className}" d="${lines.map(([a,b,c,d])=>`M${f(a)} ${f(b)}L${f(c)} ${f(d)}`).join('')}" ${attrs}>${tip}</path>`;
  } else return `<circle class="${className}" cx="${f(x)}" cy="${f(y)}" r="${f(r)}" ${attrs}>${tip}</circle>`;
}

/** Radar: categories around a circle, rings for the value scale, one polygon per series. */
/** Native radar charts retain their own style; they are not Cartesian plots
 * or the app's legacy translucent filled-with-markers presentation. */

function renderNativeRadar(data, chart, width, height) {
  const W = Math.max(120, width), H = Math.max(80, height), a = chart.appearance, radar = a.radar;
  const series = data.series.slice(0, MAX_SERIES), categories = data.categories, n = categories.length;
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(chart.description || chart.title || 'Radar chart')}" style="${PLOT_STYLE}">`,
    `<rect width="${W}" height="${H}" fill="${esc(a.background)}"/>`];
  const label = (text, x, y, style, anchor = 'middle', extra = '') => parts.push(`<text x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-family="${esc(fontStack(style.font))}" font-size="${style.size}" fill="${esc(style.color)}"${style.bold ? ' font-weight="700"' : ''}${style.italic ? ' font-style="italic"' : ''} ${extra}>${esc(text)}</text>`);
  const titleBottom = chart.title ? (a.title?.y ?? .035) * H + a.titleStyle.size : 0;
  if (chart.title) label(chart.title, a.title ? a.title.x * W : W / 2, titleBottom, a.titleStyle, a.title ? 'start' : 'middle');
  const entries = series.map((s, i) => ({ name: s.name, i, keyWidth: a.legendStyle.size * 1.5 })).filter(e => !a.legendHidden.includes(e.i)).slice(0, MAX_LEGEND);
  const manualLegend = a.legend && a.legendPos === chart.legendPos ? a.legend : null;
  const legendBox = manualLegend ? { x: manualLegend.x * W, y: manualLegend.y * H, w: (manualLegend.w ?? .25) * W, h: (manualLegend.h ?? .1) * H }
    : chart.legendPos === 'right' ? { x: W * .76, y: Math.max(titleBottom + 12, H * .15), w: W * .23 } : null;
  const legend = chart.legend && entries.length ? layoutLegend(entries, a.legendStyle, W, H, chart.legendPos, titleBottom, legendBox, chart.legendPos === 'right') : null;
  const top = titleBottom + 12 + (!manualLegend && legend && chart.legendPos === 'top' ? legend.h + a.legendStyle.size : 0);
  const right = !manualLegend && legend && chart.legendPos === 'right' ? legend.x - 10 : W - 10;
  const bottom = !manualLegend && legend && chart.legendPos === 'bottom' ? legend.y - 10 : H - 10;
  const plot = a.plot ? { x: a.plot.x * W, y: a.plot.y * H, w: (a.plot.w ?? .8) * W, h: (a.plot.h ?? .7) * H }
    : { x: 10, y: top, w: Math.max(10, right - 10), h: Math.max(10, bottom - top) };
  const cx = plot.x + plot.w / 2, cy = plot.y + plot.h / 2;
  const categoryLabels = !a.hideXAxis && a.xLabelPosition !== 'none';
  const categoryRoom = categoryLabels ? Math.min(plot.w * .3, Math.max(a.xStyle.size, ...categories.map(c => axisTextWidth(c, a.xStyle))) + 10) : 0;
  const radius = Math.max(1, Math.min(plot.w / 2 - (a.plot ? 0 : categoryRoom), plot.h / 2 - (a.plot || !categoryLabels ? 0 : a.xStyle.size * 1.5)));
  const values = series.flatMap(s => s.values).filter(Number.isFinite);
  const scale = chartAxisScale(minOf(values), maxOf(values), { min: chart.yMin, max: chart.yMax, step: a.yStep, ticks: 5 });
  const angle = i => -Math.PI / 2 + (a.reverseCategories ? -1 : 1) * i / Math.max(1, n) * Math.PI * 2;
  const position = (i, fraction) => [cx + radius * fraction * Math.cos(angle(i)), cy + radius * fraction * Math.sin(angle(i))];
  const point = (i, value) => {
    const fraction = (value - scale.min) / (scale.max - scale.min || 1);
    return position(i, Math.max(0, a.reverseValues ? 1 - fraction : fraction));
  };
  const polygon = fraction => categories.map((_, i) => position(i, fraction).map(f).join(',')).join(' ');
  const strokeAttrs = (style, fallback = '#d9d9d9') => {
    const color = style?.color ?? fallback, width = style?.width ?? 1, dash = CHART_LINE_DASHES[style?.dash];
    return `stroke="${esc(color)}" stroke-width="${width}"${dash?.length ? ` stroke-dasharray="${dash.map(v => v * width).join(' ')}"` : ''}`;
  };
  if (n && a.plotFill) parts.push(`<polygon points="${polygon(1)}" fill="${esc(a.plotFill)}"/>`);
  if (n && chart.gridlines) for (const value of scaleTicks(scale)) {
    const fraction = (value - scale.min) / (scale.max - scale.min || 1);
    parts.push(`<polygon class="chart-radar-grid" points="${polygon(a.reverseValues ? 1 - fraction : fraction)}" fill="none" ${strokeAttrs(a.gridlineStyles?.y)}/>`);
  }
  const labelSkip = a.xLabelSkip || Math.max(1, Math.ceil(n * a.xStyle.size * 1.4 / (2 * Math.PI * Math.max(1, radius))));
  categories.forEach((category, i) => {
    if (a.xGridlines) {
      const p = position(i, 1); parts.push(`<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(p[0])}" y2="${f(p[1])}" ${strokeAttrs(a.gridlineStyles?.x)}/>`);
    }
    if (!categoryLabels || i % labelSkip) return;
    const p = position(i, 1 + (a.xStyle.size * .8 + 4) / radius), cos = Math.cos(angle(i));
    const value = a.xFormat && !a.xSourceLinked && data.categoryValues?.[i] != null ? formatValue(data.categoryValues[i], { fmt: 'custom', code: a.xFormat }) : category;
    label(value, p[0], p[1] + a.xStyle.size * .35, a.xStyle, Math.abs(cos) < .1 ? 'middle' : cos > 0 ? 'start' : 'end', 'class="chart-radar-category"');
  });
  if (n && !a.hideYAxis) {
    const outer = position(0, 1);
    parts.push(`<line class="chart-axis-line chart-axis-y" x1="${f(cx)}" y1="${f(cy)}" x2="${f(outer[0])}" y2="${f(outer[1])}" ${strokeAttrs(a.axisStyles?.y, a.yStyle.color)}/>`);
    if (a.yLabelPosition !== 'none') for (const value of scaleTicks(scale)) {
      const p = point(0, value), divisor = a.yUnits?.divisor || 1;
      label(a.yFormat ? formatValue(value / divisor, { fmt: 'custom', code: a.yFormat }) : axisLabel(value / divisor, data.valueStyle, scale.step / divisor), p[0] - a.yStyle.size * .5, p[1] + a.yStyle.size * .35, a.yStyle, 'end', 'class="chart-radar-value"');
    }
  }
  const id = `radar-${Math.random().toString(36).slice(2, 10)}`;
  // Clip the series at the outer radial bound. Radii cannot be negative:
  // out-of-domain values must not reflect into the opposite category.
  parts.push(`<defs><clipPath id="${id}"><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(radius)}"/></clipPath></defs>`);
  const marker = (...args) => parts.push(chartMarker(...args));
  // Resolve paint once so plot paths and legend keys use the same artwork.
  const paints = series.map((s, si) => {
    const appearance = radar.series[si] || {}, line = a.lines[si] || {}, color = seriesColor(chart, si);
    let fill = chart.colors?.[si] || appearance.fill || color;
    if (!chart.colors?.[si] && appearance.gradient?.stops.length) {
      const g = appearance.gradient, angle = g.angle * Math.PI / 180, dx = Math.cos(angle), dy = Math.sin(angle);
      const gradientId = `${id}-fill-${si}`;
      parts.push(`<defs><linearGradient id="${gradientId}" x1="${f((1-dx)*50)}%" y1="${f((1-dy)*50)}%" x2="${f((1+dx)*50)}%" y2="${f((1+dy)*50)}%">${g.stops.map(p=>`<stop offset="${p.offset}" stop-color="${p.color}" stop-opacity="${p.opacity}"/>`).join('')}</linearGradient></defs>`);
      fill = `url(#${gradientId})`;
    }
    const stroke = line.visible === false ? 'none' : (radar.style === 'filled' ? appearance.stroke : chart.colors?.[si] || appearance.stroke) || color;
    const attrs = strokeAttrs({ color: stroke, width: line.width ?? 2, dash: appearance.dash });
    return { appearance, line, color, fill, attrs };
  });
  series.forEach((s, si) => {
    const { appearance, line, color, fill, attrs } = paints[si];
    const points = categories.map((_, i) => Number.isFinite(s.values[i]) ? point(i, s.values[i]) : radar.blanks === 'zero' ? point(i, 0) : null);
    const runs = [];
    if (points.length && (radar.blanks === 'span' || points.every(Boolean))) runs.push(points.filter(Boolean));
    else if (points.length) {
      const start = points.findIndex(p => !p); let run = [];
      for (let k = 1; k <= points.length; k++) { const p = points[(start+k)%points.length]; if (p) run.push(p); else if (run.length) { runs.push(run); run=[]; } }
      if (run.length) runs.push(run);
    }
    parts.push(`<g clip-path="url(#${id})">`);
    for (const run of runs) if (run.length) {
      const close = radar.blanks === 'span' || points.every(Boolean);
      const d = run.map((p,i)=>`${i?'L':'M'}${f(p[0])} ${f(p[1])}`).join('') + (close ? 'Z' : '');
      parts.push(`<path class="chart-radar-series" d="${d}" fill="${radar.style === 'filled' ? fill : 'none'}" ${attrs}><title>${esc(s.name)}</title></path>`);
    }
    parts.push('</g>');
    if (n * series.length <= MARK_BUDGET) points.forEach((p, i) => {
      if (!p || !Number.isFinite(s.values[i]) || s.values[i] < scale.min || s.values[i] > scale.max) return;
      if (line.marker) marker(appearance.markerSymbol || 'circle', p[0], p[1], markerPixels(line), line.markerFill || color, line.markerStroke || color,
        `${s.name} · ${categories[i]}: ${tipText(s.values[i], chartPointStyle(s, i, data.valueStyle))}`, 'chart-radar-marker');
    });
    if (chart.labels && n * series.length <= MARK_BUDGET) points.forEach((p,i) => {
      const labels = a.valueLabels[si], override = labels?.points?.find(v=>v.index===i);
      if (!p || !Number.isFinite(s.values[i]) || s.values[i] < scale.min || s.values[i] > scale.max || override?.hidden || labels?.hidden.includes(i) || (override?.show ?? labels?.show) === false) return;
      const style = override?.style ? { ...labels.style, ...override.style } : labels?.style || a.yStyle;
      const code = override?.numberFormat ?? labels?.numberFormat;
      label(code ? formatValue(s.values[i], { fmt:'custom',code }) : formatValue(s.values[i], chartPointStyle(s,i,data.valueStyle)), p[0], p[1]-style.size*.6, style, 'middle', 'class="chart-data-label"');
    });
  });
  if (n && a.plotStroke && a.plotStroke !== 'none') parts.push(`<polygon points="${polygon(1)}" fill="none" ${strokeAttrs({color:a.plotStroke,width:a.plotStrokeWidth,dash:a.plotStrokeDash})}/>`);
  if (legend) for (const item of legend.entries) {
    const { appearance, line, color, fill, attrs } = paints[item.i], y = item.y;
    parts.push(`<g class="chart-radar-legend-key" data-series="${item.i}">`);
    if (radar.style === 'filled') parts.push(`<rect x="${f(item.x)}" y="${f(y-a.legendStyle.size*.25)}" width="${f(item.keyWidth)}" height="${f(a.legendStyle.size*.5)}" fill="${esc(fill)}" ${attrs}/>`);
    else parts.push(`<line x1="${f(item.x)}" y1="${f(y)}" x2="${f(item.x+item.keyWidth)}" y2="${f(y)}" ${attrs}/>`);
    // The key is a compact sample; keep large native markers inside its row.
    if (line.marker) marker(appearance.markerSymbol || 'circle', item.x + item.keyWidth / 2, y,
      Math.min(markerPixels(line), a.legendStyle.size), line.markerFill || color, line.markerStroke || color, '', 'chart-radar-legend-marker');
    parts.push('</g>');
    item.lines.forEach((text,i)=>label(text,item.textX,item.baseline+i*legend.lineH,a.legendStyle,'start'));
  }
  if (chart.xTitle) label(chart.xTitle,cx,H-4,a.xStyle);
  if (chart.yTitle) label(chart.yTitle,0,0,a.yStyle,'middle',`transform="translate(${a.yStyle.size} ${f(cy)}) rotate(-90)"`);
  for (const note of a.annotations || []) {
    const { box, style }=note,x=box.x*W,y=box.y*H,w=(box.w??.2)*W,h=(box.h??.1)*H;
    parts.push(`<rect class="chart-annotation-box" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="${note.fill}" stroke="${note.stroke}"/>`);
    wrapChartText(note.text,Math.max(1,w-8),style).slice(0,Math.max(1,Math.floor((h-4)/(style.size*1.2)))).forEach((text,i)=>label(text,x+(note.align==='center'?w/2:note.align==='right'?w-4:4),y+2+style.size*(1+i*1.2),style,note.align==='center'?'middle':note.align==='right'?'end':'start','class="chart-annotation"'));
  }
  parts.push('</svg>'); return parts.join('');
}

function renderRadar(data, chart, right, top, bottom) {
  let { categories, series } = data;
  let n = categories.length;
  if (n < 3) return `<text x="${right / 2}" y="${(top + bottom) / 2}" text-anchor="middle" font-size="13" fill="var(--ink-3)">A radar chart needs at least three categories</text>`;
  const cx = right / 2;
  const cy = top + (bottom - top) / 2;
  // Labels need room to the sides; above and below they only take a line of text.
  let shortCategory = categoryShortener(categories, 14);
  const labelRoom = Math.min(70, maxOf(categories.map((c) => textW(shortCategory(c), 11))) + 8);
  const R = Math.max(20, Math.min(right / 2 - labelRoom - 6, (bottom - top) / 2 - 18));
  // Around the ring a category has a pixel of arc at most, as the cartesian charts give theirs.
  const px = Math.max(3, Math.floor(2 * Math.PI * R));
  if (n > px) {
    ({ categories, series } = thinToPixels(categories, series, px));
    n = categories.length;
    shortCategory = categoryShortener(categories, 14);
  }
  if (series.length > MAX_SERIES) series = series.slice(0, MAX_SERIES);
  // Past the mark budget the polygons alone tell the picture, as the lines of a line chart do without their points.
  const marks = n * series.length <= MARK_BUDGET;
  // Labels a line of text apart around the ring, with a spoke for each, so neither piles into a blur.
  const labelEvery = Math.max(1, Math.ceil((n * 14) / (2 * Math.PI * (R + 10))));
  let hi = 0;
  for (const s of series) for (const v of s.values) if (v != null && v > hi) hi = v;
  // A fixed maximum of zero (or below) would divide the radius by zero; only a positive one applies.
  const yMax = chart.yMax > 0 ? chart.yMax : null;
  const scale = niceScale(0, yMax ?? (hi || 1), 4);
  const max = yMax ?? scale.max;
  const vs = data.valueStyle || null;
  const angle = (i) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const point = (i, v) => [cx + (R * Math.max(0, v) / max) * Math.cos(angle(i)), cy + (R * Math.max(0, v) / max) * Math.sin(angle(i))];
  const out = [];
  // Rings and spokes.
  for (const v of scaleTicks({ min: scale.step, max, step: scale.step })) {
    const ring = categories.map((_, i) => point(i, v).map(f).join(',')).join(' ');
    out.push(`<polygon points="${ring}" fill="none" stroke="var(--grid)" stroke-width="1"/>`);
    // Ring values sit just right of the top spoke; the outer ring's value would collide with the top label.
    if (v < max - scale.step / 2) out.push(`<text x="${f(cx + 4)}" y="${f(cy - (R * v) / max - 2)}" font-size="10" fill="var(--ink-3)">${esc(axisLabel(v, vs))}</text>`);
  }
  categories.forEach((c, i) => {
    if (i % labelEvery) return;
    const [x, y] = point(i, max);
    out.push(`<line x1="${f(cx)}" y1="${f(cy)}" x2="${f(x)}" y2="${f(y)}" stroke="var(--grid)" stroke-width="1"/>`);
    const lx = cx + (R + 10) * Math.cos(angle(i));
    const ly = cy + (R + 10) * Math.sin(angle(i));
    const anchor = Math.abs(Math.cos(angle(i))) < 0.2 ? 'middle' : Math.cos(angle(i)) > 0 ? 'start' : 'end';
    out.push(`<text x="${f(lx)}" y="${f(ly + 4)}" text-anchor="${anchor}" font-size="11" fill="var(--ink-2)">${esc(shortCategory(c))}</text>`);
  });
  series.forEach((s, si) => {
    const color = seriesPaint(chart, si);
    const pts = s.values.map((v, i) => (v == null ? null : point(i, v)));
    if (pts.every((p) => p)) out.push(`<polygon points="${pts.map((p) => p.map(f).join(',')).join(' ')}" fill="${color}" fill-opacity="0.18" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
    else {
      const poly = pts.filter(Boolean).map((p) => p.map(f).join(',')).join(' ');
      if (poly) out.push(`<polyline points="${poly}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`);
    }
    if (marks) {
      pts.forEach((p, i) => {
        if (!p) return;
        out.push(`<circle cx="${f(p[0])}" cy="${f(p[1])}" r="3" fill="${color}"><title>${esc(`${s.name} · ${categories[i]}: ${tipText(s.values[i], chartPointStyle(s, i, vs))}`)}</title></circle>`);
        if (chart.labels) out.push(`<text x="${f(p[0])}" y="${f(p[1] - 6)}" text-anchor="middle" font-size="10" fill="var(--ink-2)">${esc(s.pointStyles?.[i] ? formatValue(s.values[i], s.pointStyles[i]) : pointValueText(s.values[i], seriesStyle(s, vs)))}</text>`);
      });
    }
  });
  return out.join('');
}

/** Least-squares line through [[x, y], ...] points: { slope, intercept }, or null with fewer than two distinct x. */
export function linearFit(points) {
  const pts = points.filter((p) => p && p[0] != null && p[1] != null);
  if (pts.length < 2) return null;
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); }
  if (!sxx) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  // Values near the double's limit overflow the sums: no line is better than one through NaN.
  return Number.isFinite(slope) && Number.isFinite(intercept) ? { slope, intercept } : null;
}

function piePaint(chart, i, overrides) {
  return chart.colors?.[i] || overrides.get(i) || (chart.appearance?.pie?.varyColors === false && chart.appearance.pie.color) || seriesPaint(chart, i);
}

/** Native workbook pies share the slice geometry with app charts, while keeping their
 * manual layout, transparent background, theme fonts and live category/value labels.
 */
function renderStyledPie(data, chart, width, height) {
  const W = Math.max(120, width), H = Math.max(80, height), a = chart.appearance;
  const out = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(chart.description || chart.title || `${chart.type} chart`)}" style="${PLOT_STYLE}">`,
    chartAreaRect(a, W, H), elementEffectDefs(a)];
  const label = (value, x, y, style, anchor = 'start', extra = '') => `<text ${extra} x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-family="${esc(fontStack(style.font))}" font-size="${style.size}"${style.bold ? ' font-weight="700"' : ''}${style.italic ? ' font-style="italic"' : ''} fill="${esc(style.color)}">${esc(value)}</text>`;
  if (chart.title) {
    const x = a.title ? a.title.x * W : W / 2, y = (a.title?.y ?? .025) * H + a.titleStyle.size;
    out.push(textBox(a.titleBox, a.effects?.title, chart.title, x, y, a.titleStyle, a.title ? 'start' : 'middle', 'title'),
      label(chart.title, x, y, a.titleStyle, a.title ? 'start' : 'middle', 'data-el="title"'));
  }
  const sameLegend = chart.legendPos === a.legendPos, vertical = chart.legendPos === 'right';
  const colors = new Map((a.pointColors[0] || []).map(p => [p.index, p.color]));
  // Legend entries are retained for blank/zero points even though they have
  // no visible slice. Only an explicit legendEntry/delete removes an entry.
  const entries = data.categories.map((name, i) => ({ name, i })).filter(({ i }) => !a.legendHidden.includes(i));
  const shown = entries.slice(0, MAX_LEGEND);
  let top = chart.title ? a.titleStyle.size + 24 : 10, bottom = H - 10, right = W - 10;
  if (chart.legend && shown.length) {
    out.push(`<g data-el="legend"${effectAttr(a, 'legend')}>`);
    const legendStart = out.length;
    const st = a.legendStyle, lineH = st.size * 1.7;
    const manual = sameLegend && a.legend;
    const layout = manual || !vertical
      ? layoutLegend(shown.map(e => ({ ...e, keyWidth: st.size * .65 })), st, W, H, chart.legendPos,
        chart.title ? (a.title?.y ?? .025) * H + a.titleStyle.size : 0,
        manual ? { x: manual.x * W, y: manual.y * H, w: (manual.w ?? .95) * W, h: manual.h == null ? null : manual.h * H } : null, vertical) : null;
    if (layout) {
      for (const e of layout.entries) {
        out.push(`<rect x="${f(e.x)}" y="${f(e.y - e.keyWidth / 2)}" width="${f(e.keyWidth)}" height="${f(e.keyWidth)}" fill="${esc(piePaint(chart, e.i, colors))}"/>`);
        e.lines.forEach((text, k) => out.push(label(text, e.textX, e.baseline + k * layout.lineH, st, 'start', 'class="chart-legend-label"')));
      }
      out.splice(legendStart, 0, legendBoxRect(a.legendBox, layout, st.size));
      if (vertical) right = layout.x - 10;
      else if (chart.legendPos === 'top') top = Math.max(top, layout.y + layout.h + st.size / 2);
      else bottom = layout.y - st.size / 2;
    } else {
      const l = sameLegend && a.legend ? a.legend : { x: vertical ? .77 : .025, y: chart.legendPos === 'top' ? top / H : vertical ? .2 : .92, w: vertical ? .21 : .95, h: .06 };
      const legendW = (l.w ?? .95) * W;
      const widths = shown.map(e => st.size + 6 + textW(e.name, st.size));
      const rows = [[]]; let used = 0;
      shown.forEach((e, i) => {
        if (rows.at(-1).length && (vertical || used + widths[i] + 12 > legendW)) { rows.push([]); used = 0; }
        rows.at(-1).push({ ...e, width: widths[i] }); used += widths[i] + 12;
      });
      const legendY = !a.legend && chart.legendPos === 'bottom' ? H - rows.length * lineH - 8 : l.y * H;
      rows.forEach((row, ri) => {
        const gap = vertical ? 0 : Math.max(8, (legendW - row.reduce((n, e) => n + e.width, 0)) / Math.max(1, row.length - 1));
        let x = l.x * W;
        const y = legendY + ri * lineH + st.size;
        for (const { name, i, width } of row) {
          out.push(`<rect x="${f(x)}" y="${f(y - st.size * .7)}" width="${f(st.size * .65)}" height="${f(st.size * .65)}" fill="${esc(piePaint(chart, i, colors))}"/>`);
          out.push(label(name, x + st.size + 4, y, st)); x += width + gap;
        }
      });
      out.splice(legendStart, 0, legendBoxRect(a.legendBox, { x: l.x * W, y: legendY, w: legendW, h: rows.length * lineH }, st.size));
      if (vertical) right = l.x * W - 10;
      else if (chart.legendPos === 'top') top = legendY + rows.length * lineH + 8;
      else bottom = legendY - 8;
    }
    out.push('</g>');
  }
  const p = a.plot, bounds = p ? { x: p.x * W, y: p.y * H, w: (p.w ?? .85) * W, h: (p.h ?? .8) * H, W, H }
    : { x: 10, y: top, w: Math.max(20, right - 10), h: Math.max(20, bottom - top), W, H };
  if (data.series.length) out.push(renderPie(data, chart, right, top, bottom, bounds));
  else out.push(label('No numbers to chart', W / 2, H / 2, a.legendStyle, 'middle'));
  out.push('</svg>');
  return out.join('');
}

/**
 * Pie of pie and bar of pie: the last `split` values leave the main pie for one Other slice, turned to
 * face a second, smaller pie (or a stacked bar) beside it that draws them again, joined by two lines.
 */
function renderOfPie(data, chart, right, top, bottom, bounds) {
  const s = data.series[0], o = chart.ofPie, n = s.values.length;
  const split = Math.min(Math.max(1, o.split), Math.max(1, n - 1));
  const box = bounds || { x: 10, y: top, w: Math.max(20, right - 10), h: Math.max(20, bottom - top) };
  const main = Array.from({ length: n - split }, (_, i) => i), rest = Array.from({ length: split }, (_, i) => n - split + i);
  const magnitude = i => (Number.isFinite(s.values[i]) ? Math.abs(s.values[i]) : 0);
  const restSum = rest.reduce((sum, i) => sum + magnitude(i), 0), total = main.reduce((sum, i) => sum + magnitude(i), 0) + restSum;
  // The main pie, the gap and the second plot share the width; the second plot is `secondSize` percent of the first.
  const k = o.secondSize / 100, gap = o.gap / 100, second = 2 * k * (o.kind === 'bar' ? .45 : 1);
  const r = Math.max(10, Math.min(box.h / 2, box.w / (2 + gap + second)));
  const cx = box.x + (box.w - r * (2 + gap + second)) / 2 + r, cy = box.y + box.h / 2;
  const otherFrac = total ? restSum / total : 0;
  const mainData = { ...data, categories: [...main.map(i => data.categories[i]), 'Other'],
    series: [{ ...s, values: [...main.map(i => s.values[i]), restSum], pointStyles: s.pointStyles ? [...main.map(i => s.pointStyles[i]), null] : undefined }] };
  // The Other slice is centred on the right, facing the second plot.
  const startAngle = Math.PI * otherFrac;
  const out = [renderPie(mainData, chart, right, top, bottom, bounds, { center: { cx, cy, r }, startAngle, indexMap: [...main, n], otherIndex: main.length })];
  const r2 = r * k, x2 = cx + r + r * gap + (o.kind === 'bar' ? r2 * .45 : r2);
  const ink = chart.appearance ? '#7f7f7f' : 'var(--ink-3)';
  const edge = a => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const [ax, ay] = edge(-Math.PI * otherFrac), [bx, by] = edge(Math.PI * otherFrac);
  if (o.kind === 'bar') {
    const w = r2 * .9, h = r2 * 2, x = x2 - w / 2;
    let y = cy - h / 2;
    out.push(`<line class="chart-ofpie-connector" x1="${f(ax)}" y1="${f(ay)}" x2="${f(x)}" y2="${f(cy - h / 2)}" stroke="${ink}"/><line class="chart-ofpie-connector" x1="${f(bx)}" y1="${f(by)}" x2="${f(x)}" y2="${f(cy + h / 2)}" stroke="${ink}"/>`);
    const colors = new Map((chart.appearance?.pointColors?.[0] || []).map(p => [p.index, p.color]));
    for (const i of rest) {
      const hh = restSum ? magnitude(i) / restSum * h : 0;
      if (!hh) continue;
      const paint = chart.appearance?.pie ? piePaint(chart, i, colors) : seriesPaint(chart, i);
      out.push(`<rect class="chart-ofpie-bar" x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(hh)}" fill="${esc(paint)}" stroke="${esc(chart.appearance?.pie?.stroke ?? 'var(--surface)')}" data-el="series" data-series="0" data-point="${i}"><title>${esc(`${data.categories[i]}: ${tipText(s.values[i], chartPointStyle(s, i, data.valueStyle))}`)}</title></rect>`);
      if (chart.labels || chart.appearance?.pie?.labels?.value) out.push(`<text class="chart-data-label" x="${f(x + w / 2)}" y="${f(y + hh / 2 + 4)}" text-anchor="middle" font-size="10" fill="${inkOn(seriesColor(chart, i))}">${esc(tipText(s.values[i], chartPointStyle(s, i, data.valueStyle)))}</text>`);
      y += hh;
    }
  } else {
    out.push(`<line class="chart-ofpie-connector" x1="${f(ax)}" y1="${f(ay)}" x2="${f(x2)}" y2="${f(cy - r2)}" stroke="${ink}"/><line class="chart-ofpie-connector" x1="${f(bx)}" y1="${f(by)}" x2="${f(x2)}" y2="${f(cy + r2)}" stroke="${ink}"/>`);
    const restData = { ...data, categories: rest.map(i => data.categories[i]), series: [{ ...s, values: rest.map(i => s.values[i]), pointStyles: s.pointStyles ? rest.map(i => s.pointStyles[i]) : undefined }] };
    const restFrac = rest.length ? magnitude(rest[0]) / (restSum || 1) : 0;
    out.push(renderPie(restData, chart, right, top, bottom, bounds, { center: { cx: x2, cy, r: r2 }, startAngle: Math.PI - Math.PI * restFrac, indexMap: rest, noExplode: true }));
  }
  return out.join('');
}

function renderPie(data, chart, right, top, bottom, bounds = null, opts = {}) {
  if (chart.ofPie && chart.type === 'pie' && !opts.center && data.series[0]?.values.length > 1) return renderOfPie(data, chart, right, top, bottom, bounds);
  const s = data.series[0];
  const at = i => (opts.indexMap ? opts.indexMap[i] : i);
  // Slice areas use magnitudes but labels use signed values/percentages.
  // Keep source values intact for editing, tooltips and native export.
  let values = s.values.map(v => Number.isFinite(v) ? Math.abs(v) : 0);
  let total = values.reduce((a, b) => a + b, 0), scale = 1;
  if (!Number.isFinite(total)) {
    // Finite inputs can overflow their sum. A common scale preserves ratios.
    scale = maxOf(values);
    values = values.map(v => v / scale);
    total = values.reduce((a, b) => a + b, 0);
  }
  const cx = opts.center ? opts.center.cx : bounds ? bounds.x + bounds.w / 2 : right / 2;
  const cy = opts.center ? opts.center.cy : bounds ? bounds.y + bounds.h / 2 : top + (bottom - top) / 2;
  // An exploded pie shrinks so its slices, pulled out along their middles, stay within the plot.
  const explode = opts.noExplode ? 0 : (chart.explosion || 0) / 100;
  const r = Math.max(10, opts.center ? opts.center.r : bounds ? Math.min(bounds.w, bounds.h) / 2 : Math.min(right, bottom - top) / 2 - 14) / (1 + explode);
  if (!total) return `<text x="${cx}" y="${cy}" text-anchor="middle" font-size="13" fill="var(--ink-3)">No nonzero numbers to chart</text>`;
  // Past a slice per pixel of the rim the smallest could not be seen: they gather into one Other slice,
  // drawn last, so the slices that can be told apart keep their places and the mark count stays bounded.
  const budget = Math.min(MARK_BUDGET, Math.max(1, Math.floor(2 * Math.PI * r)));
  const drawn = values.filter(Boolean).length;
  let other = null;
  if (drawn > budget) {
    const bySize = values.map((v, i) => i).filter((i) => values[i] > 0).sort((a, b) => values[b] - values[a]);
    other = { count: 0, value: 0 };
    for (const i of bySize.slice(budget - 1)) { other.count++; other.value += values[i]; values[i] = 0; }
  }
  const out = [], labelOut = [], pie = bounds ? chart.appearance.pie : null;
  const colors = new Map((chart.appearance?.pointColors?.[0] || []).map(p => [p.index, p.color]));
  const pointLabels = new Map((pie?.labels.points || []).map(p => [p.index, p]));
  const pointBorders = new Map((pie?.points || []).map(p => [p.index, p]));
  let angle = opts.startAngle != null ? opts.startAngle : -Math.PI / 2 + (pie?.firstSliceAngle || 0) * Math.PI / 180;
  const inner = chart.type === 'donut' ? r * (pie ? pie.holeSize / 100 : .58) : 0;
  const slice = (v, color, tip, i) => {
    const frac = v / total;
    const a2 = angle + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x1 = cx + r * Math.cos(angle);
    const y1 = cy + r * Math.sin(angle);
    const x2 = cx + r * Math.cos(a2);
    const y2 = cy + r * Math.sin(a2);
    let d;
    if (frac >= 0.9999) {
      d = inner
        ? `M ${f(cx + r)} ${f(cy)} A ${f(r)} ${f(r)} 0 1 1 ${f(cx - r)} ${f(cy)} A ${f(r)} ${f(r)} 0 1 1 ${f(cx + r)} ${f(cy)} M ${f(cx + inner)} ${f(cy)} A ${f(inner)} ${f(inner)} 0 1 0 ${f(cx - inner)} ${f(cy)} A ${f(inner)} ${f(inner)} 0 1 0 ${f(cx + inner)} ${f(cy)} Z`
        : `M ${f(cx + r)} ${f(cy)} A ${f(r)} ${f(r)} 0 1 1 ${f(cx - r)} ${f(cy)} A ${f(r)} ${f(r)} 0 1 1 ${f(cx + r)} ${f(cy)} Z`;
    } else if (inner) {
      const ix1 = cx + inner * Math.cos(a2);
      const iy1 = cy + inner * Math.sin(a2);
      const ix2 = cx + inner * Math.cos(angle);
      const iy2 = cy + inner * Math.sin(angle);
      d = `M ${f(x1)} ${f(y1)} A ${f(r)} ${f(r)} 0 ${large} 1 ${f(x2)} ${f(y2)} L ${f(ix1)} ${f(iy1)} A ${f(inner)} ${f(inner)} 0 ${large} 0 ${f(ix2)} ${f(iy2)} Z`;
    } else {
      d = `M ${f(cx)} ${f(cy)} L ${f(x1)} ${f(y1)} A ${f(r)} ${f(r)} 0 ${large} 1 ${f(x2)} ${f(y2)} Z`;
    }
    const signedFraction = i != null && s.values[i] < 0 ? -frac : frac;
    const pct = `${Math.round(signedFraction * 100)}%`;
    const border = pointBorders.get(at(i));
    const shift = explode ? ` transform="translate(${f(r * explode * Math.cos((angle + a2) / 2))} ${f(r * explode * Math.sin((angle + a2) / 2))})"` : '';
    out.push(`<path d="${d}" fill="${esc(color)}" stroke="${esc(border?.stroke ?? pie?.stroke ?? 'var(--surface)')}" stroke-width="${border?.strokeWidth ?? pie?.strokeWidth ?? 1.5}"${inner ? ' fill-rule="evenodd"' : ''}${shift}${i == null || at(i) == null || i === opts.otherIndex ? '' : ` data-el="series" data-series="0" data-point="${at(i)}"`}${pie ? effectAttr(chart.appearance, 'series:0') : ''}><title>${esc(`${tip(v)} (${pct})`)}</title></path>`);
    const dxe = explode ? r * explode * Math.cos((angle + a2) / 2) : 0, dye = explode ? r * explode * Math.sin((angle + a2) / 2) : 0;
    if (pie && i != null) {
      const l = pointLabels.get(at(i)) || pie.labels, st = l.style;
      const valueStyle = l.numberFormat ? numFmtToStyle(l.numberFormat) : chartPointStyle(s, i, data.valueStyle || null);
      const fields = { category: data.categories[i] || '', value: formatValue(s.values[i], valueStyle),
        percent: l.numberFormat ? formatValue(signedFraction, valueStyle) : pct, series: s.name || '' };
      const value = l.content ? l.content.map(c => c.kind === 'text' ? c.text : fields[c.kind]).join('')
        : ['series', 'category', 'value', 'percent'].filter(k => l[k]).map(k => fields[k]).join(l.separator);
      if (!l.hidden && value) {
        const mid = (angle + a2) / 2, outside = l.position === 'outEnd';
        const lr = outside ? r + st.size : l.position === 'inEnd' ? r - st.size : inner ? (r + inner) / 2 : r * .68;
        const x = cx + dxe + lr * Math.cos(mid) + (l.dx || 0) * bounds.W, y = cy + dye + lr * Math.sin(mid) + (l.dy || 0) * bounds.H;
        const lines = value.split(/\r?\n/), anchor = outside ? Math.cos(mid) >= 0 ? 'start' : 'end' : 'middle';
        if (outside && l.leaderLines) labelOut.push(`<path d="M ${f(cx + r * Math.cos(mid))} ${f(cy + r * Math.sin(mid))} L ${f(x)} ${f(y)}" fill="none" stroke="${esc(st.color)}"/>`);
        labelOut.push(`<text class="chart-data-label" x="${f(x)}" y="${f(y)}" text-anchor="${anchor}" font-family="${esc(fontStack(st.font))}" font-size="${st.size}"${st.bold ? ' font-weight="700"' : ''}${st.italic ? ' font-style="italic"' : ''} fill="${esc(st.color)}" data-el="dataLabels" data-series="0">${lines.map((line, j) => `<tspan x="${f(x)}" dy="${f(j ? st.size * 1.2 : st.size * .35 - (lines.length - 1) * st.size * .6)}">${esc(line)}</tspan>`).join('')}</text>`);
      }
    } else if (!pie && frac >= 0.06) {
      const mid = (angle + a2) / 2;
      const lr = inner ? (r + inner) / 2 : r * 0.68;
      labelOut.push(`<text x="${f(cx + dxe + lr * Math.cos(mid))}" y="${f(cy + dye + lr * Math.sin(mid) + 4)}" text-anchor="middle" font-size="11" font-weight="600" fill="${inkOn(color)}">${pct}</text>`);
    }
    angle = a2;
  };
  const style = seriesStyle(s, data.valueStyle || null);
  // The Other slice of a pie of pie takes the next colour after the slices of the main pie.
  values.forEach((v, i) => { if (v) slice(v, pie ? piePaint(chart, at(i), colors) : seriesPaint(chart, at(i)), () => `${data.categories[i]}: ${tipText(s.values[i], chartPointStyle(s, i, style))}`, i); });
  if (other) slice(other.value, 'var(--ink-3)', (v) => `Other (${other.count.toLocaleString('en-US')} slices)${Number.isFinite(v * scale) ? `: ${(v * scale).toLocaleString('en-US')}` : ''}`);
  return out.join('') + labelOut.join('');
}

// The pieces of the chart frame the newer chart types (chartsvg-special.js) draw with too.
export { esc as svgEsc, f as svgNum, tipText as chartTipText, layoutLegend, chartAreaRect, elementEffectDefs, effectAttr, textBox as chartTextBox,
  legendBoxRect, axisTextWidth, wrapChartText, scaleTicks, chartMarker, categoryShortener, shade as shadeColor, PLOT_STYLE, MAX_LEGEND, MARK_BUDGET };
