/**
 * Error bars on the series of a scatter or bubble chart, as Format Error Bars offers them: up and down
 * (y) and to each side (x), each by a fixed amount, a percentage of the value, a number of standard
 * deviations, the standard error, or amounts read point by point from cells.
 *
 * chart.errorBars = (null | { x?: bar, y?: bar })[], one entry per series
 * bar = {
 *   type: 'fixedVal' | 'percentage' | 'stdDev' | 'stdErr' | 'cust',
 *   value: number,                   the fixed amount, the percentage, or how many standard deviations
 *   plus?, minus?: string,           custom: references to the cells holding each point's amount
 *   plusValues?, minusValues?: (number | null)[],   custom amounts kept in the chart itself (from a file)
 *   direction: 'both' | 'plus' | 'minus',
 *   caps: boolean,                   end caps, the H of the bar
 *   capWidth?: number,               the whole width of a cap, in px (6 when absent)
 *   color?: string,                  the line's colour (a dark grey when absent)
 *   width: number,                   the line's width, in px
 *   dash?: string,                   a DrawingML preset dash
 * }
 *
 * Standard deviation bars are centred on the mean of the series, as Excel draws them; the others on
 * each point. Pure but for the cell reads in errorBarValues.
 */
import { colName } from './cell.js';
import { quoteSheet } from './refs.js';
import { isError } from './formula/functions.js';
import { t } from '../i18n/index.js';

// [value, label], the label read in the interface language when it is shown.
const choice = (value, key) => Object.freeze(Object.defineProperty([value], 1, { enumerable: true, get: () => t(key) }));
export const ERROR_BAR_TYPES = Object.freeze([choice('fixedVal', 'errorBars.typeFixed'), choice('percentage', 'errorBars.typePercentage'),
  choice('stdDev', 'errorBars.typeStdDev'), choice('stdErr', 'errorBars.typeStdErr'), choice('cust', 'errorBars.typeCustom')]);
const TYPES = new Set(ERROR_BAR_TYPES.map(([id]) => id));
// The amount each kind starts at, as Excel offers it.
export const ERROR_BAR_DEFAULT_VALUES = Object.freeze({ fixedVal: 1, percentage: 5, stdDev: 1 });
export const ERROR_BAR_CAP_WIDTH = 6;
export const ERROR_BAR_COLOR = '#595959';
const DASHES = new Set(['solid', 'dot', 'dash', 'lgDash', 'dashDot', 'lgDashDot', 'lgDashDotDot', 'sysDash', 'sysDot', 'sysDashDot', 'sysDashDotDot']);
const HEX = /^#[0-9a-f]{6}$/i;
const MAX_POINTS = 5000;

/** Only charts that plot values on both axes take error bars here. */
export const errorBarsAllowed = chart => chart?.type === 'scatter' || chart?.type === 'bubble';

// The kinds of series a file can give error bars (CT_BarSer, CT_LineSer, CT_AreaSer, CT_ScatterSer, CT_BubbleSer). Those
// on columns, bars, lines and areas are not drawn or edited here, but are kept and saved again as the file had them.
const KEPT = new Set(['column', 'bar', 'line', 'area', 'scatter', 'bubble']);

/**
 * The error bars series `j`, plotted as `type` (a combo chart's series have kinds of their own), writes to a file: what
 * it has where the kind takes them, or null. A bar or line series takes one set (CT_BarSer and CT_LineSer allow one
 * c:errBars), its vertical bars before any other.
 */
export function errorBarsSaved(chart, j, type = chart?.type) {
  const bars = KEPT.has(type) ? chart?.errorBars?.[j] : null;
  if (!bars) return null;
  if (!['column', 'bar', 'line'].includes(type)) return bars;
  return bars.y ? { y: bars.y } : bars.x ? { x: bars.x } : null;
}

const between = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
const amounts = list => (Array.isArray(list) ? list.slice(0, MAX_POINTS).map(v => (Number.isFinite(v) ? v : null)) : null);
const refText = v => (typeof v === 'string' && v.trim() ? v.trim().replace(/^=/, '').slice(0, 2048) : null);

/** One bar with every option in range, or null where it is not one. */
export function normalizeErrorBar(raw) {
  if (!raw || typeof raw !== 'object' || !TYPES.has(raw.type)) return null;
  const bar = {
    type: raw.type,
    value: between(raw.value, 0, 1e100) ? raw.value : ERROR_BAR_DEFAULT_VALUES[raw.type] ?? 1,
    direction: ['plus', 'minus'].includes(raw.direction) ? raw.direction : 'both',
    caps: raw.caps !== false,
    width: between(raw.width, 0, 20) ? raw.width : 1,
  };
  if (raw.type === 'cust') {
    const plus = refText(raw.plus), minus = refText(raw.minus), plusValues = amounts(raw.plusValues), minusValues = amounts(raw.minusValues);
    if (plus) bar.plus = plus; else if (plusValues) bar.plusValues = plusValues;
    if (minus) bar.minus = minus; else if (minusValues) bar.minusValues = minusValues;
  }
  if (between(raw.capWidth, 0, 100)) bar.capWidth = raw.capWidth;
  if (HEX.test(raw.color || '')) bar.color = raw.color.toLowerCase();
  if (DASHES.has(raw.dash) && raw.dash !== 'solid') bar.dash = raw.dash;
  return bar;
}

/** A chart's error bars, one entry per series; null when no series has any. */
export function normalizeErrorBars(raw) {
  if (!Array.isArray(raw)) return null;
  const list = raw.slice(0, 255).map(entry => {
    const x = normalizeErrorBar(entry?.x), y = normalizeErrorBar(entry?.y);
    return x || y ? { ...(x ? { x } : {}), ...(y ? { y } : {}) } : null;
  });
  while (list.length && !list.at(-1)) list.pop();
  return list.length ? list : null;
}

/**
 * Error bars a bubble chart read from a file kept on its appearance before charts kept them on their own
 * ([{ axis, type, direction, value, caps, color, width }] per series): the same bars as chart.errorBars.
 */
export function legacyBubbleErrorBars(bubble) {
  const series = Array.isArray(bubble?.series) ? bubble.series : [];
  if (!series.some(s => Array.isArray(s?.errors) && s.errors.length)) return null;
  return normalizeErrorBars(series.map(s => Object.fromEntries((Array.isArray(s?.errors) ? s.errors : [])
    .filter(e => ['x', 'y'].includes(e?.axis)).map(e => [e.axis, e]))));
}

/** Series `j`'s error bars ({ x?, y? }), or null. */
export function errorBarsFor(chart, j) {
  if (!errorBarsAllowed(chart)) return null;
  return chart.errorBars?.[j] || null;
}

/**
 * Give series `j` the bar on `axis` ('x' or 'y'), merged over the one it has, or take it away (null):
 * the fields to hand `wb.updateChart`, or null where the chart takes no error bars.
 */
export function errorBarsPatch(chart, j, axis, bar, seriesCount = 1) {
  if (!errorBarsAllowed(chart) || !['x', 'y'].includes(axis)) return null;
  const list = Array.from({ length: Math.max(seriesCount, j + 1, chart.errorBars?.length || 0) }, (_, i) => ({ ...(chart.errorBars?.[i] || {}) }));
  if (bar) {
    const before = list[j][axis];
    // A new kind starts at its own amount, not the last kind's (5 % is not 5 standard deviations).
    const value = bar.type && bar.type !== before?.type && bar.value == null ? ERROR_BAR_DEFAULT_VALUES[bar.type] : undefined;
    const next = normalizeErrorBar({ ...(before || { type: 'stdErr' }), ...bar, ...(value !== undefined ? { value } : {}) });
    if (next) list[j][axis] = next;
  } else delete list[j][axis];
  return { errorBars: normalizeErrorBars(list) || undefined };
}

/** What Add Chart Element ▸ Error Bars shows: the kind every bar shares (or 'mixed', or 'none'), and which directions are on. */
export function errorBarsState(chart) {
  const bars = (errorBarsAllowed(chart) && chart.errorBars || []).filter(Boolean);
  const all = bars.flatMap(b => [b.x, b.y]).filter(Boolean);
  const kinds = new Set(all.map(b => b.type));
  return { kind: !all.length ? 'none' : kinds.size === 1 ? [...kinds][0] : 'mixed', x: bars.some(b => b.x), y: bars.some(b => b.y) };
}

/**
 * Add Chart Element ▸ Error Bars over every series: 'none' takes them all away; a kind gives each bar
 * that kind (vertical bars where there are none yet); { axis, on } turns one direction on or off.
 */
export function errorBarsElementPatch(chart, value, seriesCount = 1) {
  if (!errorBarsAllowed(chart)) return null;
  if (value === 'none') return { errorBars: undefined };
  const count = Math.max(1, seriesCount, chart.errorBars?.length || 0);
  const current = Array.from({ length: count }, (_, i) => chart.errorBars?.[i] || {});
  if (typeof value === 'string') {
    if (!TYPES.has(value) || value === 'cust') return null;
    const state = errorBarsState(chart);
    const axes = state.x || state.y ? ['x', 'y'].filter(k => state[k]) : ['y'];
    return { errorBars: normalizeErrorBars(current.map(bars => Object.fromEntries(axes.map(axis =>
      [axis, { ...(bars[axis] || {}), type: value, value: bars[axis]?.type === value ? bars[axis].value : ERROR_BAR_DEFAULT_VALUES[value] }])))) || undefined };
  }
  if (!value || !['x', 'y'].includes(value.axis)) return null;
  const other = value.axis === 'x' ? 'y' : 'x';
  return { errorBars: normalizeErrorBars(current.map(bars => {
    const next = { ...bars };
    if (!value.on) delete next[value.axis];
    // A direction turned on takes the look and amount of the bars beside it, or the standard error.
    else next[value.axis] = next[value.axis] || (bars[other] ? { ...bars[other] } : { type: 'stdErr' });
    return next;
  })) || undefined };
}

/**
 * A custom amount typed as a reference (=Sheet1!$D$2:$D$9, D2:D9) or as numbers (0.5, or 1, 2, 3): the
 * bar fields it sets ({ plus } or { plusValues } for side 'plus'), or { error }. References are kept
 * absolute and named by their sheet, as Excel keeps them, so they follow the cells when lines move.
 */
export function errorBarAmountInput(wb, sheetId, text, side) {
  const raw = String(text ?? '').trim().replace(/^=/, '').replace(/^\{(.*)\}$/, '$1');
  const key = side === 'minus' ? 'minus' : 'plus';
  if (!raw) return { [key]: undefined, [`${key}Values`]: undefined };
  const numbers = raw.split(/[,;]/).map(s => s.trim());
  if (numbers.every(s => s !== '' && Number.isFinite(Number(s)))) return { [key]: undefined, [`${key}Values`]: numbers.slice(0, MAX_POINTS).map(Number) };
  const resolved = wb.rangeFromText(sheetId, raw);
  if (!resolved) return { error: t('errorBars.enterRange') };
  const { range, sheetId: id } = resolved;
  if (range.r1 !== range.r2 && range.c1 !== range.c2) return { error: t('errorBars.oneRowOrColumn') };
  const cell = (r, c) => `$${colName(c)}$${r + 1}`;
  const ref = `${quoteSheet(wb.sheet(id).name)}!${cell(range.r1, range.c1)}${range.r1 === range.r2 && range.c1 === range.c2 ? '' : `:${cell(range.r2, range.c2)}`}`;
  return { [key]: ref, [`${key}Values`]: undefined };
}

/**
 * The amounts each custom bar reads from its cells, point by point: { [j]: { x?: { plus, minus }, y? } }.
 * `keepHidden` keeps a hidden cell's place (as a series of its own references does) rather than leaving
 * it out (as a series read from the chart's range does), so the amounts line up with the points.
 */
export function errorBarValues(wb, sheetId, chart, { keepHidden = false, includeHidden = false } = {}) {
  if (!chart?.errorBars?.length) return null;
  const read = ref => {
    const resolved = ref && wb.rangeFromText(sheetId, ref);
    if (!resolved) return [];
    const { range, sheetId: id } = resolved, sheet = wb.sheet(id);
    if (!sheet || range.r1 !== range.r2 && range.c1 !== range.c2) return [];
    const horizontal = range.r1 === range.r2 && range.c1 !== range.c2, start = horizontal ? range.c1 : range.r1;
    const end = Math.min(horizontal ? range.c2 : range.r2, start + MAX_POINTS - 1), out = [];
    for (let k = start; k <= end; k++) {
      const r = horizontal ? range.r1 : k, c = horizontal ? k : range.c1;
      const hidden = !includeHidden && (sheet.hiddenCols.has(c) || wb.isRowHidden(id, r));
      if (hidden && !keepHidden) continue;
      const v = hidden ? null : wb.getValue(id, r, c);
      out.push(typeof v === 'number' && Number.isFinite(v) && !isError(v) ? v : null);
    }
    return out;
  };
  const out = {};
  chart.errorBars.forEach((bars, j) => {
    if (!bars) return;
    for (const axis of ['x', 'y']) {
      const bar = bars[axis];
      if (bar?.type !== 'cust') continue;
      (out[j] ||= {})[axis] = { plus: bar.plus ? read(bar.plus) : bar.plusValues || [], minus: bar.minus ? read(bar.minus) : bar.minusValues || [] };
    }
  });
  return Object.keys(out).length ? out : null;
}

/**
 * Where each point's bar on `axis` runs: [{ i, x, y, low, high }] for points [{ i, x, y }] (i the point's
 * index in its series). `custom` holds the custom amounts ({ plus, minus }, by point index; a single
 * amount stands for every point). A point whose bar has no length on either side has none.
 */
export function errorBarExtents(points, bar, axis, custom = null) {
  if (!bar || !points.length) return [];
  const values = points.map(p => p[axis]).filter(Number.isFinite);
  let mean = 0, sumSquares = 0, count = 0;
  for (const v of values) { const delta = v - mean; mean += delta / ++count; sumSquares += delta * (v - mean); }
  const deviation = count > 1 ? Math.sqrt(Math.max(0, sumSquares / (count - 1))) : 0;
  const at = (list, i) => {
    if (!list?.length) return 0;
    const v = list.length === 1 ? list[0] : list[i];
    return Number.isFinite(v) ? v : 0;
  };
  const plusSide = bar.direction !== 'minus', minusSide = bar.direction !== 'plus';
  return points.flatMap(p => {
    const v = p[axis];
    if (!Number.isFinite(v)) return [];
    let centre = v, up = 0, down = 0;
    if (bar.type === 'stdDev') { centre = mean; up = down = deviation * bar.value; }
    else if (bar.type === 'stdErr') up = down = deviation / Math.sqrt(count || 1);
    else if (bar.type === 'percentage') up = down = Math.abs(v) * bar.value / 100;
    else if (bar.type === 'fixedVal') up = down = bar.value;
    else if (bar.type === 'cust') { up = at(custom?.plus, p.i); down = at(custom?.minus, p.i); }
    const low = centre - (minusSide ? down : 0), high = centre + (plusSide ? up : 0);
    if (!Number.isFinite(low) || !Number.isFinite(high) || (low === v && high === v)) return [];
    return [{ i: p.i, x: p.x, y: p.y, low, high }];
  });
}

/**
 * The SVG of one series' bars: `extents` per axis ({ x?, y? } from errorBarExtents), placed by `sx` and
 * `sy`; `every` thins a dense cloud as its points are thinned.
 */
export function errorBarsSvg(extents, bars, { j, sx, sy, color, every = 1, fmt = n => String(Math.round(n * 100) / 100), dashes = {} }) {
  let svg = '';
  for (const axis of ['x', 'y']) {
    const bar = bars?.[axis];
    if (!bar) continue;
    const half = (bar.capWidth ?? ERROR_BAR_CAP_WIDTH) / 2, stroke = bar.color || color, width = bar.width ?? 1;
    const dash = bar.dash ? (dashes[bar.dash] || []).map(v => fmt(v * (width || 1))).join(' ') : '';
    for (const e of extents[axis] || []) {
      if (e.i % every) continue;
      const x1 = sx(axis === 'x' ? e.low : e.x), x2 = sx(axis === 'x' ? e.high : e.x);
      const y1 = sy(axis === 'y' ? e.low : e.y), y2 = sy(axis === 'y' ? e.high : e.y);
      if (![x1, x2, y1, y2].every(Number.isFinite)) continue;
      // A cap at each end the bar runs to (the low end first), not across the point itself.
      const capAt = ([cx, cy]) => (axis === 'x' ? ` M ${fmt(cx)} ${fmt(cy - half)} V ${fmt(cy + half)}` : ` M ${fmt(cx - half)} ${fmt(cy)} H ${fmt(cx + half)}`);
      const caps = !bar.caps || !half ? '' : [bar.direction !== 'plus' && [x1, y1], bar.direction !== 'minus' && [x2, y2]].filter(Boolean).map(capAt).join('');
      svg += `<path class="chart-error-bar" data-el="errorBars" data-series="${j}" data-axis="${axis}" d="M ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)}${caps}" fill="none" stroke="${stroke}" stroke-width="${fmt(width)}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;
    }
  }
  return svg;
}
