import { NATIVE_ICON_SETS } from './native-icons.js';
import { MIN_NORMAL } from './numeric.js';
/**
 * Conditional formatting rules, evaluated per cell at render time.
 *
 * rule = { id, range: {r1,c1,r2,c2}, type, value, value2, style: { bg, color, bold },
 *          from, mid?, to }                         (from/mid/to: colors for 'scale')
 * type: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'between' | 'contains' |
 *       'notContains' | 'beginsWith' | 'endsWith' | 'empty' | 'notEmpty' |
 *       'dup' | 'unique' | 'top' | 'bottom' | 'formula' | 'scale' | 'databar' | 'bands'
 *
 * Rules that look at the whole range (dup, unique, top, bottom) and custom
 * formulas need context the workbook supplies: see matchesRule's `ctx`.
 */

import { formatNumberText, parseInput, dateTimeKind } from './format.js';
import { extendedDataBar, nativeDataBarFraction } from './data-bar.js';

export const RULE_TYPES = [
  { value: 'gt', label: 'Greater than', args: 1, numeric: true },
  { value: 'gte', label: 'Greater than or equal to', args: 1, numeric: true },
  { value: 'lt', label: 'Less than', args: 1, numeric: true },
  { value: 'lte', label: 'Less than or equal to', args: 1, numeric: true },
  { value: 'between', label: 'Between', args: 2, numeric: true },
  { value: 'eq', label: 'Equal to', args: 1 },
  { value: 'neq', label: 'Not equal to', args: 1 },
  { value: 'contains', label: 'Text contains', args: 1 },
  { value: 'notContains', label: 'Text does not contain', args: 1 },
  { value: 'beginsWith', label: 'Text begins with', args: 1 },
  { value: 'endsWith', label: 'Text ends with', args: 1 },
  { value: 'empty', label: 'Is empty', args: 0 },
  { value: 'notEmpty', label: 'Is not empty', args: 0 },
  { value: 'dup', label: 'Is a duplicate', args: 0, rangeWide: true },
  { value: 'unique', label: 'Is unique', args: 0, rangeWide: true },
  { value: 'top', label: 'Top N values', args: 1, numeric: true, rangeWide: true },
  { value: 'bottom', label: 'Bottom N values', args: 1, numeric: true, rangeWide: true },
  { value: 'date', label: 'Date is', args: 1, date: true },
  { value: 'formula', label: 'Custom formula is true', args: 1, formula: true },
  { value: 'scale', label: 'Color scale', args: 0, scale: true },
  { value: 'databar', label: 'Data bar', args: 0, databar: true },
  { value: 'bands', label: 'Alternating colors', args: 0, bands: true },
  { value: 'icons', label: 'Icon set', args: 0, icons: true },
];

/** Periods a "Date is" rule can name; each test gets the day serial and today's serial. */
const DAY = 86400000;
const EPOCH = 25569; // serial of 1970-01-01
const ymd = (serial) => { const d = new Date(Math.round((serial - EPOCH) * DAY)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; };
const mondayOf = (serial) => serial - ((serial % 7) + 5) % 7;
export const DATE_PERIODS = [
  { value: 'today', label: 'Today', test: (d, t) => d === t },
  { value: 'yesterday', label: 'Yesterday', test: (d, t) => d === t - 1 },
  { value: 'tomorrow', label: 'Tomorrow', test: (d, t) => d === t + 1 },
  { value: 'last7', label: 'In the last 7 days', test: (d, t) => d <= t && d > t - 7 },
  { value: 'next7', label: 'In the next 7 days', test: (d, t) => d >= t && d < t + 7 },
  { value: 'thisWeek', label: 'This week', test: (d, t) => d >= mondayOf(t) && d < mondayOf(t) + 7 },
  { value: 'lastWeek', label: 'Last week', test: (d, t) => d >= mondayOf(t) - 7 && d < mondayOf(t) },
  { value: 'thisMonth', label: 'This month', test: (d, t) => { const a = ymd(d); const b = ymd(t); return a.y === b.y && a.m === b.m; } },
  { value: 'lastMonth', label: 'Last month', test: (d, t) => { const a = ymd(d); const b = ymd(t); return b.m === 1 ? a.y === b.y - 1 && a.m === 12 : a.y === b.y && a.m === b.m - 1; } },
  { value: 'thisYear', label: 'This year', test: (d, t) => ymd(d).y === ymd(t).y },
  { value: 'past', label: 'In the past', test: (d, t) => d < t },
  { value: 'future', label: 'In the future', test: (d, t) => d > t },
];

/** Today's date as a serial (the local calendar day, like TODAY()). */
export function todaySerialUTC(now = new Date()) {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY) + EPOCH;
}

/** Icon sets: three glyphs for the high, middle, and low thirds of a range. */
export const ICON_SETS = Object.assign(Object.create(null), {
  arrows: { label: 'Arrows', glyphs: ['▲', '▶', '▼'], colors: ['#1baf7a', '#eda100', '#c22a2a'] },
  traffic: { label: 'Traffic lights', glyphs: ['●', '●', '●'], colors: ['#1baf7a', '#eda100', '#c22a2a'] },
  flags: { label: 'Flags', glyphs: ['⚑', '⚑', '⚑'], colors: ['#1baf7a', '#eda100', '#c22a2a'] },
  stars: { label: 'Stars', glyphs: ['★★★', '★★☆', '★☆☆'], colors: ['#eda100', '#eda100', '#eda100'] },
  checks: { label: 'Checks', glyphs: ['✔', '!', '✖'], colors: ['#1baf7a', '#eda100', '#c22a2a'] },
});

/**
 * Which icon a value gets: the top glyph at or above `hi` percent of the
 * range's span (default 67), the bottom one below `lo` (default 33), the
 * middle otherwise. Returns { icon, iconColor, iconOnly } or null.
 */
export function iconFor(rule, value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const set = ICON_SETS[rule.set] || ICON_SETS.arrows;
  const lo = rule.lo ?? 33;
  const hi = rule.hi ?? 67;
  const span = max - min, scale = Math.max(Math.abs(min), Math.abs(max));
  // App icons classify the fraction of the span. Opposite finite bounds can
  // overflow their difference; normalize before subtracting in that case.
  // Keep ordinary arithmetic unchanged, including equality at custom cutoffs.
  const fraction = Number.isFinite(span) ? (value - min) / span
    : (value / scale - min / scale) / (max / scale - min / scale);
  // A subnormal intermediate fraction loses precision before multiplying by
  // 100 (or becomes zero in Excel formulas). Form the percentage directly in
  // that case. Its numerator cannot overflow: a finite span and such a small
  // fraction imply an absolute distance below four, even at binary64's limit.
  const pct = max === min ? 100 : Number.isFinite(span) && Math.abs(fraction) < MIN_NORMAL
    ? (value - min) * 100 / span : fraction * 100;
  const i = pct >= hi ? 0 : pct >= lo ? 1 : 2;
  return { icon: set.glyphs[i], iconColor: set.colors[i], iconOnly: !!rule.iconOnly };
}

export const DEFAULT_BAR_COLOR = '#8fb8ff';

/** A data bar's color as a plain hex color; anything else (including text from a file) falls back to the default. */
export function barColorOf(rule) {
  return /^#[0-9a-f]{6}$/i.test(rule?.barColor || '') ? rule.barColor : DEFAULT_BAR_COLOR;
}

/**
 * Data bars: a bar whose length shows the value against the range. Bars
 * start at zero when every value is positive (so 0 is empty and the max is
 * full); with negatives in the range they run from the minimum.
 * Returns { bar: 0..1, barColor } or null.
 */
export function dataBar(rule, value, min, max, rightToLeft = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (rule.barMode === 'extended') return extendedDataBar(rule, value, min, max, barColorOf(rule), rightToLeft);
  if (rule.barMode === 'legacy') {
    if (![min, max].every(n => typeof n === 'number' && Number.isFinite(n))) return null;
    // SpreadsheetML data bars interpolate between configured lengths, not zero
    // and a full cell. Coinciding endpoints use their midpoint.
    // Reversed thresholds reverse the lengths. Equal bounds use a midpoint
    // only at the bound itself; values outside still saturate at the ends.
    const fraction = nativeDataBarFraction(value, min, max);
    const start = (rule.barMinLength ?? 10) / 100, end = (rule.barMaxLength ?? 90) / 100;
    return { bar: start + fraction * (end - start), barColor: barColorOf(rule), barGradient: true,
      barFullHeight: true, ...(rule.barOnly ? { barOnly: true } : {}) };
  }
  const lo = Number.isFinite(rule.barMin) ? rule.barMin : min >= 0 ? 0 : min;
  const hi = Math.max(Number.isFinite(rule.barMax) ? rule.barMax : max, lo);
  const span = hi - lo;
  // Opposite-sign finite endpoints can have an infinite difference. Scale
  // before subtracting in that case; Infinity /
  // Infinity would otherwise remove the bar and finite / Infinity collapse it.
  const scale = Math.max(Math.abs(lo), Math.abs(hi));
  const frac = span > 0 ? Number.isFinite(span) ? (value - lo) / span
    : (value / scale - lo / scale) / (hi / scale - lo / scale) : 1;
  return { bar: Math.max(0, Math.min(1, frac)), barColor: barColorOf(rule), ...(rule.barFullHeight ? { barFullHeight: true } : {}), ...(rule.barOnly ? { barOnly: true } : {}) };
}

/**
 * Fill for a cell under an alternating-colors rule: the header row (when the
 * rule has one) in headerColor, then color1 and color2 turn by turn.
 */
export function bandColor(rule, r, ordinal = null) {
  // `ordinal` is the row's place among the rule's visible rows when a filter or hidden rows take some away.
  const i = ordinal ?? r - rule.range.r1;
  if (i < 0) return null;
  const header = rule.header !== false;
  if (header && i === 0) return { bg: rule.headerColor || rule.color1 || '#e0ecff', bold: true };
  const k = i - (header ? 1 : 0);
  const bg = k % 2 === 0 ? rule.color1 : rule.color2;
  return bg ? { bg } : null;
}

/** Identity of a value for duplicate detection: case-insensitive text, exact numbers. */
export function valueIdentity(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object') return null;
  return typeof v === 'string' ? `s:${v.trim().toLowerCase()}` : `${typeof v}:${v}`;
}

// A plain decimal numeral: a sign, digits with a point, an exponent, spaces around. Number() would also take
// "0x10", "0b11" and "Infinity", which the formula engine and the filter's value list read as words.
// Explicit ECMAScript whitespace also works in the REGEX functions' PCRE2 expressions.
export const NUMBER_TEXT_SPACE = '[\\x09-\\x0d \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]';
export const NUMBER_TEXT_PATTERN = `^${NUMBER_TEXT_SPACE}*[-+]?(?:[0-9]+\\.?[0-9]*|\\.[0-9]+)(?:[eE][-+]?[0-9]+)?${NUMBER_TEXT_SPACE}*$`;
const NUMERAL = new RegExp(NUMBER_TEXT_PATTERN);

/** The finite number a text spells as a plain numeral, or null. */
export function numberOfText(text) {
  if (typeof text !== 'string' || !NUMERAL.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function num(v) {
  if (typeof v === 'number') return v;
  return numberOfText(v);
}

const momentCache = new Map();
/**
 * The serial a condition's text names when it reads as a date or a time ("3/15/2024", "Jan 2024", "25:30"), as
 * the grid reads it typed into a cell; null for any other text. An Equal to rule keeps such an entry as typed, so
 * it still matches the same text in a cell, and through this it matches the date or time a cell holds too.
 */
export function typedMoment(text) {
  if (typeof text !== 'string' || !/\d/.test(text)) return null;
  if (!momentCache.has(text)) {
    if (momentCache.size > 500) momentCache.clear();
    const { v, f, fmt, code } = parseInput(text.trim());
    momentCache.set(text, f == null && typeof v === 'number' && dateTimeKind({ fmt, code }, v) ? v : null);
  }
  return momentCache.get(text);
}

const isErr = (v) => v != null && typeof v === 'object';

/**
 * The text a value shows, for the rules that match text: an error is the code it shows, as the column
 * filter matches one by passing the display text, a boolean TRUE or FALSE, and a number the text a formula
 * makes of it — fifteen significant digits, so 0.1+0.2 is "0.3", not "0.30000000000000004".
 */
function shownText(v) {
  if (isErr(v)) return String(v.error ?? '');
  if (v == null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return typeof v === 'number' ? formatNumberText(v) : String(v);
}

/**
 * The rules an error cell answers like any other: it holds something, so it is not blank (ISBLANK
 * reads FALSE on it and the No Blanks rule paints it), and the text rules read the code it shows. Every
 * other rule reads a number, a date or an identity out of the value, which an error has none of.
 */
const ERROR_RULES = new Set(['empty', 'notEmpty', 'contains', 'notContains', 'beginsWith', 'endsWith', 'eq', 'neq', 'formula']);

/**
 * Does a computed cell value satisfy the rule's condition? (Not for 'scale'.)
 * ctx: { counts: Map(identity → count), numbers: number[] sorted descending,
 *        formulaResult } — supplied by the workbook for the rules that need it.
 */
export function matchesRule(rule, value, ctx = {}) {
  const t = rule.type;
  if ((t === 'dup' || t === 'unique') && rule.duplicateRange != null) {
    return value != null && (t === 'dup' ? ctx.nativeCount > 1 : ctx.nativeCount === 1);
  }
  // A formula rule may deliberately handle the cell error with ISERROR/IFERROR.
  if (isErr(value) && !ERROR_RULES.has(t)) return false;
  if (t === 'empty') return value == null || value === '';
  if (t === 'notEmpty') return !(value == null || value === '');
  if (t === 'formula') {
    const r = ctx.formulaResult;
    return r === true || (typeof r === 'number' && r !== 0) || (typeof r === 'string' && r.trim().toUpperCase() === 'TRUE');
  }
  if (t === 'date') {
    const v = num(value);
    if (v === null) return false;
    const period = DATE_PERIODS.find((p) => p.value === rule.value);
    return !!period && period.test(Math.floor(v), ctx.today ?? todaySerialUTC());
  }
  if (t === 'dup' || t === 'unique') {
    const id = valueIdentity(value);
    if (id == null) return false;
    const n = ctx.counts?.get(id) || 0;
    return t === 'dup' ? n > 1 : n === 1;
  }
  if (t === 'top' || t === 'bottom') {
    const n = Math.trunc(num(rule.value) ?? 0);
    // Only a number ranks, as in Excel: the ranking counts numbers alone, and a number stored as text is text.
    const v = typeof value === 'number' ? value : null;
    const sorted = ctx.numbers || [];
    if (v === null || n < 1 || !sorted.length) return false;
    if (t === 'top') return v >= sorted[Math.min(n, sorted.length) - 1];
    return v <= sorted[Math.max(0, sorted.length - Math.min(n, sorted.length))];
  }
  if (t === 'contains' || t === 'notContains' || t === 'beginsWith' || t === 'endsWith') {
    const hay = shownText(value).toLowerCase();
    const needle = String(rule.value ?? '').toLowerCase();
    if (!needle) return false;
    if (t === 'beginsWith') return hay.startsWith(needle);
    if (t === 'endsWith') return hay.endsWith(needle);
    const has = hay.includes(needle);
    return t === 'contains' ? has : !has;
  }
  if (t === 'eq' || t === 'neq') {
    const a = num(value);
    const b = num(rule.value);
    let same;
    if (a !== null && b !== null) same = a === b;
    else same = shownText(value).toLowerCase() === String(rule.value ?? '').toLowerCase() && value != null;
    if (!same && typeof value === 'number' && b === null) same = typedMoment(rule.value) === value;
    return t === 'eq' ? same : !same;
  }
  const v = num(value);
  if (v === null) return false;
  const a = num(rule.value);
  if (t === 'between') {
    const b = num(rule.value2);
    if (a === null || b === null) return false;
    return v >= Math.min(a, b) && v <= Math.max(a, b);
  }
  if (a === null) return false;
  switch (t) {
    case 'gt': return v > a;
    case 'gte': return v >= a;
    case 'lt': return v < a;
    case 'lte': return v <= a;
    default: return false;
  }
}

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '');
  const full = h.length === 3 ? h.split('').map((ch) => ch + ch).join('') : h.padEnd(6, '0').slice(0, 6);
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Interpolate between two hex colors; t in [0, 1]. */
export function mixColors(from, to, t) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const k = Math.max(0, Math.min(1, t));
  const ch = (i) => Math.round(a[i] + (b[i] - a[i]) * k).toString(16).padStart(2, '0');
  return `#${ch(0)}${ch(1)}${ch(2)}`;
}

/** Canonical hex colors shared by the renderer and native XLSX writer. */
export function scaleColors(rule) {
  const normalize = (value, fallback) => /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value || '')
    ? `#${hexToRgb(value).map(v => v.toString(16).padStart(2, '0')).join('')}` : fallback;
  return [normalize(rule.from, '#ffffff'), ...(rule.mid ? [normalize(rule.mid, '#fef3c7')] : []), normalize(rule.to, '#4a8dff')];
}

/** Halfway between finite bounds, preserving ordinary subtraction rounding. */
export function scaleMidpoint(low, high) {
  const span = high - low;
  return Number.isFinite(span) ? low + span / 2 : low / 2 + high / 2;
}

/** Paint a numeric value using resolved thresholds or automatic range limits. */
export function scaleColor(rule, value, min, max, limits = null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const colors = scaleColors(rule), from = colors[0], to = colors.at(-1), middle = colors.length === 3 ? colors[1] : null;
  let [lo, mid, hi] = limits || [min, scaleMidpoint(min, max), max];
  if (![lo, hi, ...(rule.mid ? [mid] : [])].every(Number.isFinite)) return null;
  // All threshold values are put in order, keeping the low/mid/high colors.
  if (rule.mid) [lo, mid, hi] = [lo, mid, hi].sort((a, b) => a - b);
  else if (hi < lo) [lo, hi] = [hi, lo];
  if (value >= hi) return to;
  if (value <= lo) return from;
  const mix = (a, b, t) => {
    const x = hexToRgb(a), y = hexToRgb(b);
    // The channel delta truncates toward zero, including negative deltas.
    return `#${x.map((v, i) => (v + Math.trunc((y[i] - v) * Math.max(0, Math.min(1, t)))).toString(16).padStart(2, '0')).join('')}`;
  };
  if (!rule.mid) return mix(from, to, (value - lo) / (hi - lo));
  return value < mid ? mix(from, middle, (value - lo) / (mid - lo)) : mix(middle, to, (value - mid) / (hi - mid));
}

export function describeRule(rule) {
  const t = RULE_TYPES.find((x) => x.value === rule.type);
  if (!t) return rule.type;
  if (rule.type === 'between') return `${t.label} ${rule.value} and ${rule.value2}`;
  if (rule.type === 'formula') return `Formula ${rule.value}`;
  if (rule.type === 'bands') return rule.header === false ? 'Alternating colors' : 'Alternating colors with a header';
  if (rule.type === 'databar') return 'Data bar';
  if (rule.type === 'scale') return rule.mid ? 'Three-color scale' : 'Color scale';
  if (rule.type === 'icons') return `Icon set: ${(NATIVE_ICON_SETS[rule.iconSet] || ICON_SETS[rule.set] || ICON_SETS.arrows).label}`;
  if (rule.type === 'date') return `Date is ${(DATE_PERIODS.find((p) => p.value === rule.value)?.label || rule.value).toLowerCase()}`;
  if (rule.type === 'top' || rule.type === 'bottom') return `${rule.type === 'top' ? 'Top' : 'Bottom'} ${rule.value}`;
  if (t.args === 1) return `${t.label} ${rule.value}`;
  return t.label;
}
