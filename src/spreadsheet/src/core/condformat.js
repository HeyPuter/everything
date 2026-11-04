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
import { t, tSource } from '../i18n/index.js';

/** Give each entry a `label` read in the interface language when it is read; `labelKey` stays for English (tSource). */
const labelled = (entries) => entries.map(([key, entry]) => Object.defineProperty({ labelKey: key, ...entry }, 'label', { get: () => t(key), enumerable: true }));

export const RULE_TYPES = labelled([
  ['coreCondformat.type.gt', { value: 'gt', args: 1, numeric: true }],
  ['coreCondformat.type.gte', { value: 'gte', args: 1, numeric: true }],
  ['coreCondformat.type.lt', { value: 'lt', args: 1, numeric: true }],
  ['coreCondformat.type.lte', { value: 'lte', args: 1, numeric: true }],
  ['coreCondformat.type.between', { value: 'between', args: 2, numeric: true }],
  ['coreCondformat.type.eq', { value: 'eq', args: 1 }],
  ['coreCondformat.type.neq', { value: 'neq', args: 1 }],
  ['coreCondformat.type.contains', { value: 'contains', args: 1 }],
  ['coreCondformat.type.notContains', { value: 'notContains', args: 1 }],
  ['coreCondformat.type.beginsWith', { value: 'beginsWith', args: 1 }],
  ['coreCondformat.type.endsWith', { value: 'endsWith', args: 1 }],
  ['coreCondformat.type.empty', { value: 'empty', args: 0 }],
  ['coreCondformat.type.notEmpty', { value: 'notEmpty', args: 0 }],
  ['coreCondformat.type.dup', { value: 'dup', args: 0, rangeWide: true }],
  ['coreCondformat.type.unique', { value: 'unique', args: 0, rangeWide: true }],
  ['coreCondformat.type.top', { value: 'top', args: 1, numeric: true, rangeWide: true }],
  ['coreCondformat.type.bottom', { value: 'bottom', args: 1, numeric: true, rangeWide: true }],
  ['coreCondformat.type.date', { value: 'date', args: 1, date: true }],
  ['coreCondformat.type.formula', { value: 'formula', args: 1, formula: true }],
  ['coreCondformat.type.scale', { value: 'scale', args: 0, scale: true }],
  ['coreCondformat.type.databar', { value: 'databar', args: 0, databar: true }],
  ['coreCondformat.type.bands', { value: 'bands', args: 0, bands: true }],
  ['coreCondformat.type.icons', { value: 'icons', args: 0, icons: true }],
]);

/** Periods a "Date is" rule can name; each test gets the day serial and today's serial. */
const DAY = 86400000;
const EPOCH = 25569; // serial of 1970-01-01
const ymd = (serial) => { const d = new Date(Math.round((serial - EPOCH) * DAY)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 }; };
// Weeks run Sunday to Saturday, as Excel's This week and Last week count them (serial 1 is a Sunday).
const sundayOf = (serial) => serial - (serial + 6) % 7;
export const DATE_PERIODS = labelled([
  ['coreCondformat.period.today', { value: 'today', test: (d, today) => d === today }],
  ['coreCondformat.period.yesterday', { value: 'yesterday', test: (d, today) => d === today - 1 }],
  ['coreCondformat.period.tomorrow', { value: 'tomorrow', test: (d, today) => d === today + 1 }],
  ['coreCondformat.period.last7', { value: 'last7', test: (d, today) => d <= today && d > today - 7 }],
  ['coreCondformat.period.next7', { value: 'next7', test: (d, today) => d >= today && d < today + 7 }],
  ['coreCondformat.period.thisWeek', { value: 'thisWeek', test: (d, today) => d >= sundayOf(today) && d < sundayOf(today) + 7 }],
  ['coreCondformat.period.lastWeek', { value: 'lastWeek', test: (d, today) => d >= sundayOf(today) - 7 && d < sundayOf(today) }],
  ['coreCondformat.period.thisMonth', { value: 'thisMonth', test: (d, today) => { const a = ymd(d); const b = ymd(today); return a.y === b.y && a.m === b.m; } }],
  ['coreCondformat.period.lastMonth', { value: 'lastMonth', test: (d, today) => { const a = ymd(d); const b = ymd(today); return b.m === 1 ? a.y === b.y - 1 && a.m === 12 : a.y === b.y && a.m === b.m - 1; } }],
  ['coreCondformat.period.thisYear', { value: 'thisYear', test: (d, today) => ymd(d).y === ymd(today).y }],
  ['coreCondformat.period.past', { value: 'past', test: (d, today) => d < today }],
  ['coreCondformat.period.future', { value: 'future', test: (d, today) => d > today }],
]);

/** Today's date as a serial (the local calendar day, like TODAY()). */
export function todaySerialUTC(now = new Date()) {
  return Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / DAY) + EPOCH;
}

/** Icon sets: three glyphs for the high, middle, and low thirds of a range. */
export const ICON_SETS = Object.assign(Object.create(null), Object.fromEntries(Object.entries({
  arrows: { labelKey: 'coreCondformat.icons.arrows', glyphs: ['▲', '▶', '▼'], colors: ['#1baf7a', '#eda100', '#c22a2a'] },
  traffic: { labelKey: 'coreCondformat.icons.traffic', glyphs: ['●', '●', '●'], colors: ['#1baf7a', '#eda100', '#c22a2a'] },
  flags: { labelKey: 'coreCondformat.icons.flags', glyphs: ['⚑', '⚑', '⚑'], colors: ['#1baf7a', '#eda100', '#c22a2a'] },
  stars: { labelKey: 'coreCondformat.icons.stars', glyphs: ['★★★', '★★☆', '★☆☆'], colors: ['#eda100', '#eda100', '#eda100'] },
  checks: { labelKey: 'coreCondformat.icons.checks', glyphs: ['✔', '!', '✖'], colors: ['#1baf7a', '#eda100', '#c22a2a'] },
}).map(([name, set]) => [name, Object.defineProperty(set, 'label', { get: () => t(set.labelKey), enumerable: true })])));

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
  const tk = rule.type;
  if ((tk === 'dup' || tk === 'unique') && rule.duplicateRange != null) {
    return value != null && (tk === 'dup' ? ctx.nativeCount > 1 : ctx.nativeCount === 1);
  }
  // A formula rule may deliberately handle the cell error with ISERROR/IFERROR.
  if (isErr(value) && !ERROR_RULES.has(tk)) return false;
  if (tk === 'empty') return value == null || value === '';
  if (tk === 'notEmpty') return !(value == null || value === '');
  if (tk === 'formula') {
    const r = ctx.formulaResult;
    return r === true || (typeof r === 'number' && r !== 0) || (typeof r === 'string' && r.trim().toUpperCase() === 'TRUE');
  }
  if (tk === 'date') {
    const v = num(value);
    if (v === null) return false;
    const period = DATE_PERIODS.find((p) => p.value === rule.value);
    return !!period && period.test(Math.floor(v), ctx.today ?? todaySerialUTC());
  }
  if (tk === 'dup' || tk === 'unique') {
    const id = valueIdentity(value);
    if (id == null) return false;
    const n = ctx.counts?.get(id) || 0;
    return tk === 'dup' ? n > 1 : n === 1;
  }
  if (tk === 'top' || tk === 'bottom') {
    const n = Math.trunc(num(rule.value) ?? 0);
    // Only a number ranks, as in Excel: the ranking counts numbers alone, and a number stored as text is text.
    const v = typeof value === 'number' ? value : null;
    const sorted = ctx.numbers || [];
    if (v === null || n < 1 || !sorted.length) return false;
    // Top 10% ranks a share of the numbers: rounded down, but never fewer than one, as Excel counts it.
    const count = rule.percent ? Math.max(1, Math.floor(sorted.length * n / 100)) : n;
    if (tk === 'top') return v >= sorted[Math.min(count, sorted.length) - 1];
    return v <= sorted[Math.max(0, sorted.length - Math.min(count, sorted.length))];
  }
  if (tk === 'contains' || tk === 'notContains' || tk === 'beginsWith' || tk === 'endsWith') {
    const hay = shownText(value).toLowerCase();
    const needle = String(rule.value ?? '').toLowerCase();
    if (!needle) return false;
    if (tk === 'beginsWith') return hay.startsWith(needle);
    if (tk === 'endsWith') return hay.endsWith(needle);
    const has = hay.includes(needle);
    return tk === 'contains' ? has : !has;
  }
  if (tk === 'eq' || tk === 'neq') {
    const a = num(value);
    const b = num(rule.value);
    let same;
    if (a !== null && b !== null) same = a === b;
    else same = shownText(value).toLowerCase() === String(rule.value ?? '').toLowerCase() && value != null;
    if (!same && typeof value === 'number' && b === null) same = typedMoment(rule.value) === value;
    return tk === 'eq' ? same : !same;
  }
  const v = num(value);
  if (v === null) return false;
  const a = num(rule.value);
  if (tk === 'between') {
    const b = num(rule.value2);
    if (a === null || b === null) return false;
    return v >= Math.min(a, b) && v <= Math.max(a, b);
  }
  if (a === null) return false;
  switch (tk) {
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
export function mixColors(from, to, tk) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  const k = Math.max(0, Math.min(1, tk));
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
  const mix = (a, b, tk) => {
    const x = hexToRgb(a), y = hexToRgb(b);
    // The channel delta truncates toward zero, including negative deltas.
    return `#${x.map((v, i) => (v + Math.trunc((y[i] - v) * Math.max(0, Math.min(1, tk)))).toString(16).padStart(2, '0')).join('')}`;
  };
  if (!rule.mid) return mix(from, to, (value - lo) / (hi - lo));
  return value < mid ? mix(from, middle, (value - lo) / (mid - lo)) : mix(middle, to, (value - mid) / (hi - mid));
}

/**
 * A rule in words, for the Rules Manager: "Greater than 3", "Top 10%". `source` gives it in English, for text not
 * meant for the person (what the AI model reads).
 */
export function describeRule(rule, { source = false } = {}) {
  const tr = source ? tSource : t;
  const type = RULE_TYPES.find((x) => x.value === rule.type);
  if (!type) return rule.type;
  if (rule.type === 'between') return tr('coreCondformat.describe.between', { value: rule.value, value2: rule.value2 });
  if (rule.type === 'formula') return tr('coreCondformat.describe.formula', { value: rule.value });
  if (rule.type === 'bands') return rule.header === false ? tr('coreCondformat.type.bands') : tr('coreCondformat.describe.bandsHeader');
  if (rule.type === 'databar') return tr('coreCondformat.type.databar');
  if (rule.type === 'scale') return rule.mid ? tr('coreCondformat.describe.threeColorScale') : tr('coreCondformat.type.scale');
  if (rule.type === 'icons') {
    const native = NATIVE_ICON_SETS[rule.iconSet];
    const set = ICON_SETS[rule.set] || ICON_SETS.arrows;
    return tr('coreCondformat.describe.icons', { name: native ? native.label : tr(set.labelKey) });
  }
  if (rule.type === 'date') return tr('coreCondformat.describe.date', { period: String(rule.value), raw: String(rule.value).toLowerCase() });
  if (rule.type === 'top' || rule.type === 'bottom') {
    return tr(rule.type === 'top' ? (rule.percent ? 'coreCondformat.describe.topPercent' : 'coreCondformat.describe.top')
      : rule.percent ? 'coreCondformat.describe.bottomPercent' : 'coreCondformat.describe.bottom', { value: rule.value });
  }
  if (type.args === 1) return tr('coreCondformat.describe.compare', { type: rule.type, value: rule.value });
  return tr(type.labelKey);
}
