import { wildcardMatcher } from './wildcard.js';
import { compareSpreadsheetText, foldComparisonText, foldPrefixText, compareFoldedText } from './text-comparison.js';
/**
 * The function library, plus the value helpers every function shares.
 *
 * Values: number | string | boolean | null | { error } | range.
 * A range is { range: true, values: any[][], ref } as produced by the
 * evaluator for A1:B2 references.
 *
 * callerContext declares caller-frame reads for saved-result provenance.
 * Built-ins conservatively depend on locale because shared numeric/text coercion
 * reads regional settings. localeContext: false certifies an implementation that
 * does not use those conversions; its argument expressions are still inspected.
 * Each entry is { fn(args, ctx), lazy?, minArgs?, maxArgs? }. Non-lazy
 * functions receive evaluated arguments; an error among their *scalar*
 * arguments has already been propagated by the evaluator. Errors inside
 * ranges are the function's own business (SUM propagates, COUNT ignores).
 * Lazy functions receive thunks and decide what to evaluate.
 */

import { formatGeneral, todaySerial, nowSerial, ymdToSerial, serialToYMD, serialClock, parseInput, parseTime, parseFormulaNumber, formulaCurrencyAffixes, formatNumberText, getLocale, localeInfo } from '../format.js';
import { MAX_NUMBER_TEXT, parseDecimalText } from './number-text.js';
import { nestedRepeat, subjectLimit } from './regex-safety.js';
import { hasNumberDigits, normalizeNumberDigits } from '../number-shape.js';
import { codeDateKind, formatWithCode, MAX_FORMAT_CODE_LENGTH } from '../numfmt.js';
import { colName, MAX_TEXT } from '../cell.js';
import { tokenize } from './tokenizer.js';
import { parseRefText, parseR1C1Ref, refToText, quoteSheet, MAX_ROW, MAX_COL } from '../refs.js';
import { invoke, isLambda, runtime } from './lambda.js';
import { runQuery } from './query.js';
import { rowsFromXml } from '../importrange.js';
import { cachedModel, forecastAt, confidenceAt, statistic } from '../forecast-ets.js';
import { midpoint, mean as numericMean, sum, product, MIN_NORMAL, flushUnderflow, hasZeroHighWord, squaredDeviations, variance as numericVariance } from '../numeric.js';

/* ---------- Value helpers ---------- */

const ERROR_CODES = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#GETTING_DATA', '#SPILL!', '#CONNECT!', '#BLOCKED!', '#UNKNOWN!', '#FIELD!', '#CALC!'];

export const err = (code) => ({ error: code });
export const isError = (v) => v != null && typeof v === 'object' && !v.range && 'error' in v;
export const isRange = (v) => v != null && typeof v === 'object' && v.range === true;

function randomValue(ctx) {
  // Scalar random calls inside a legacy array are evaluated for each output,
  // even when nested in SUM or a named formula. Track actual execution so
  // formulas which only reference a random cell still share that cell's value.
  if (ctx?.fixedArray) ctx.fixedArray.randomized = true;
  return Math.random();
}

/**
 * An argument left empty between commas, as in LEFT(A1,) or VLOOKUP(x,r,2,).
 * It reads as a value, 0, FALSE or "" by context, so a function sees it
 * as given rather than falling back to its default: the lookup is exact, the
 * text is cut to nothing, COUNT(1,) is 2. A truly absent argument is undefined.
 */
export const EMPTY = Object.freeze({ empty: true });

/** Resolve named addresses without reading their cells, including across scopes. */
function namedReferenceContext(ctx, depth) {
  return {
    ...ctx, referenceMode: true, locals: undefined, omitted: undefined, nameDepth: depth,
    nameContext: (name) => {
      const scope = ctx.nameContext?.(name);
      return scope ? namedReferenceContext(scope, depth) : null;
    },
  };
}

/** Collapse a 1x1 range to its value; anything larger is #VALUE!. */
export function scalar(v) {
  if (v === EMPTY) return null; // an empty argument coerces like a blank: 0, "" or FALSE
  if (!isRange(v)) return v;
  if (v.values.length === 1 && v.values[0].length === 1) return v.values[0][0];
  return err('#VALUE!');
}

/** Information predicates inspect each value, including errors inside arrays. */
function information(predicate) {
  return {
    localeContext: false,
    fn: ([value]) => isRange(value)
      ? { range: true, values: value.values.map((row) => row.map((v) => predicate(v))) }
      : predicate(value),
    tolerant: true,
    elementwise: true,
  };
}

/** The UTF-16 offset of the `count`-th character of `text`, or null when the text is shorter. */
function charUnits(text, count, legacy = false) {
  if (legacy) return count <= text.length ? count : null;
  let i = 0;
  for (let seen = 0; seen < count; seen++) {
    if (i >= text.length) return null;
    i += text.codePointAt(i) > 0xffff ? 2 : 1;
  }
  return i;
}

/** How many characters `text` holds before UTF-16 offset `units`. */
function charCount(text, units, legacy = false) {
  if (legacy) return units;
  let n = 0;
  for (let i = 0; i < units; n++) i += text.codePointAt(i) > 0xffff ? 2 : 1;
  return n;
}

const PLAIN_NUMBER_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
/**
 * The number that text of digits alone spells (a sign, a point and an exponent allowed), or null for
 * anything else. Under a regional format whose decimal mark is a comma, a point before exactly three
 * digits, "1.234", is the thousands separator a typed cell reads it as: such text is left to the regional
 * reader, which makes it 1234 as the cell does, while "1.5" and "1.2345" keep their point.
 */
function plainNumber(text, decimalShift) {
  if (!PLAIN_NUMBER_RE.test(text)) return null;
  if (/\d\.\d{3}$/.test(text) && localeInfo().decimal === ',') return null;
  return parseDecimalText(text, decimalShift) ?? err('#VALUE!');
}

export function toNumber(v) {
  v = scalar(v);
  if (isError(v)) return v;
  if (v == null) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    if (v.length > MAX_NUMBER_TEXT) return err('#VALUE!');
    // Formula coercion accepts ordinary spaces at the edges, not tabs,
    // line breaks or Unicode whitespace. The cell-entry parser is more
    // forgiving, so reject those boundaries before handing it the text.
    const trimmed = v.trim();
    if (trimmed !== v && v.replace(/^ +| +$/g, '') !== trimmed) return err('#VALUE!');
    const t = normalizeNumberDigits(trimmed);
    // Empty text is text, not 0: =""+1 and VALUE("") are #VALUE!, while a blank cell is 0 above.
    if (t === '') return err('#VALUE!');
    const body = t.endsWith('%') ? t.slice(0, -1) : t;
    // Plain digits here; text with thousands separators goes through the regional reader below, which
    // wants them grouped by three, so "1,234" is a number and "1,2,3" is not.
    const n = plainNumber(body, t.endsWith('%') ? -2 : 0);
    if (n != null) return n;
    const numeric = parseFormulaNumber(t, undefined, parseDecimalText);
    if (numeric != null) return numeric;
    // Dates and times still use the regional calendar reader. Do not let its
    // permissive cell-entry currency/sign cleanup rescue invalid numeric text.
    const parsed = parseInput(t);
    const kind = parsed.fmt === 'custom' ? codeDateKind(parsed.v, parsed.code) : parsed.fmt;
    return ['date', 'time', 'datetime'].includes(kind) && typeof parsed.v === 'number' && Number.isFinite(parsed.v)
      ? parsed.v : err('#VALUE!');
  }
  return err('#VALUE!');
}

export function toText(v) {
  v = scalar(v);
  if (isError(v)) return v;
  if (v == null) return '';
  if (typeof v === 'object') return err('#VALUE!'); // a sparkline or other drawable, not text
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return formatNumberText(v);
}

export function toBool(v) {
  v = scalar(v);
  if (isError(v)) return v;
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  // Only the words TRUE and FALSE read as a logical value; other text, "1" included, is #VALUE!.
  const u = v.trim().toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return err('#VALUE!');
}

const typeRank = (v) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 0);

/**
 * Case-insensitive comparisons equate Unicode space separators (Zs),
 * including NBSP, figure space and ideographic space. They do not trim/collapse
 * spaces or turn tabs and line/paragraph separators into spaces. One-for-one
 * substitution preserves character offsets for wildcard matching and SEARCH;
 * FIND, EXACT and the text-transforming functions still read the original text.
 */
const comparisonSpaces = (text) => /[^\x00-\x7f]/.test(text) ? text.replace(/\p{Zs}/gu, ' ') : text;
const comparisonText = (text) => comparisonSpaces(text).toLowerCase();

/**
 * Spreadsheet ordering: numbers < text < booleans; text is case-insensitive, in dictionary order
 * with accented letters beside their base letters (é between e and f), as comparisons read it and
 * the Sort dialog orders it, rather than by code unit, which put every é after z.
 */
export function compareValues(a, b) {
  a = scalar(a);
  b = scalar(b);
  if (a == null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b == null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (typeof a === 'string') return compareSpreadsheetText(a, b);
  const x = Number(a);
  const y = Number(b);
  // An infinity would pass the relative test below against any number at all.
  if (!Number.isFinite(x) || !Number.isFinite(y)) return x === y ? 0 : x < y ? -1 : 1;
  // Operators and criteria compare the rounded 15-digit decimal values. A
  // relative epsilon both misses equal values and merges values across a
  // rounding boundary. Skip decimal conversion when they cannot round alike.
  // Comparison falls back to stored precision when the right operand is
  // in binary64's highest exponent bin. At that boundary this comparison is
  // asymmetric; sorting and lookups use compareStoredValues instead.
  if (x === y || (Math.abs(y) < 2 ** 1023
    && Math.abs(x - y) <= 1e-14 * Math.max(Math.abs(x), Math.abs(y))
    && x.toPrecision(15) === y.toPrecision(15))) return 0;
  return x < y ? -1 : 1;
}

/** Lookups, ranking and sorting distinguish the stored binary numbers, even
 * when the worksheet's = operator considers their 15-digit views equal.
 */
export function compareStoredValues(a, b) {
  return typeof a === 'number' && typeof b === 'number'
    ? a === b ? 0 : a < b ? -1 : 1 : compareValues(a, b);
}

/** Iterate every scalar in the argument list, ranges flattened. */
function* eachValue(args) {
  for (const a of args) {
    if (isRange(a)) {
      for (const row of a.values) for (const v of row) yield { v, inRange: true };
    } else {
      yield { v: a, inRange: false };
    }
  }
}

/**
 * Numbers for aggregate functions: direct arguments are coerced (a text
 * "3" counts), values inside ranges are taken only when they are numbers.
 * Errors anywhere propagate.
 *
 * The ranges are walked with plain nested loops rather than through eachValue: the most common
 * aggregates (SUM, AVERAGE, MIN, MAX, COUNT) read whole columns, and a generator yielding an object
 * per value made them fifteen times the cost of the loop itself.
 */
function numbers(args) {
  const out = [];
  for (const a of args) {
    if (isRange(a)) {
      const rows = a.values;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (typeof v === 'number') out.push(v);
          else if (isError(v)) return v;
        }
      }
    } else if (isError(a)) return a;
    else if (a != null) {
      const n = toNumber(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

// Worksheet sums retain intermediate overflow, including before AVERAGE's
// division. Keep the exact-recovery helpers for non-worksheet calculations.
const worksheetSum = (values) => values.reduce((total, value) => total + value, 0);
const worksheetMean = (values) => worksheetSum(values) / values.length;

const num = (f) => (args) => {
  const list = numbers(args);
  return isError(list) ? list : f(list);
};

/**
 * The numbers of a range in ascending order, or an error: what LARGE, RANK, PERCENTILE and their
 * kin read. The list is kept by the values array it came from, which every formula reading the
 * range within one calculation shares, so a column ranked against itself, RANK(A1:A5000,A1:A5000),
 * sorts once rather than once per cell. It is shared too: callers copy it before changing it.
 */
const sortedLists = new WeakMap();
function sortedNumbers(range) {
  const key = isRange(range) ? range.values : null;
  const known = key && sortedLists.get(key);
  if (known) return known;
  const list = numbers([range]); if (isError(list)) return list;
  list.sort((a, b) => a - b);
  if (key) sortedLists.set(key, list);
  return list;
}

/** Where x falls in the ascending list s: how many numbers lie below it, equal it exactly, and lie above it. */
function rankCounts(s, x) {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (compareStoredValues(s[mid], x) < 0) lo = mid + 1; else hi = mid; }
  const below = lo;
  hi = s.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (compareStoredValues(s[mid], x) <= 0) lo = mid + 1; else hi = mid; }
  return [below, lo - below, s.length - lo];
}

/** The first position of the ascending list s holding v or more: where PERCENTRANK finds its value. */
function lowerBound(s, v) {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

function checkNum(n) {
  return Number.isFinite(n) ? n : err('#NUM!');
}

/** Worksheet POWER and ^ share integer repeated squaring and a reciprocal
 * for negative exponents. The integer path excludes the unsigned 32-bit
 * sentinel; the general real-power path rejects negative bases. ^ alone
 * uses a raw square when the evaluated exponent is two, preserving subnormals.
 */
export function realPower(base, exponent, operator = false) {
  if (exponent === 0) return hasZeroHighWord(base) ? err('#NUM!') : 1;
  if (operator && exponent === 2) return checkNum(base * base);
  const magnitude = Math.abs(exponent);
  let result;
  if (Number.isInteger(magnitude) && magnitude < 0xffffffff) {
    result = 1;
    let factor = base, remaining = magnitude;
    while (remaining) {
      if (remaining % 2) result = flushUnderflow(result * factor);
      remaining = Math.floor(remaining / 2);
      if (remaining) factor *= factor;
    }
  } else if (magnitude === 0.5) result = Math.sqrt(base);
  else {
    if (base < 0) return err('#NUM!');
    result = hasZeroHighWord(base) ? base : base ** magnitude;
  }
  if (exponent < 0) {
    if (Math.abs(result) < MIN_NORMAL) return err('#DIV/0!');
    result = flushUnderflow(1 / result);
  }
  return checkNum(result);
}

/**
 * The longest depreciation schedule DDB, DB and VDB will walk period by period. A life of a
 * million periods is a thousand years of months; past that the walk is a mistyped argument,
 * and answering #NUM! at once keeps a single cell from locking the tab up for ever.
 */
const MAX_PERIODS = 1e6;

/** A cell whose formula reads as another SUBTOTAL or AGGREGATE, which those two leave out. */
const NESTED_TOTAL = /^\s*(?:_xlfn\.)?(?:SUBTOTAL|AGGREGATE)\s*\(/i;

/**
 * The context to read a range's own sheet through, and the sheet name still to pass with each
 * cell. `getFormula` and `isRowHidden` look their sheet up by name, so a range on another sheet
 * is resolved once per range here rather than once per cell; a context without `nameContext`
 * (a stub in a test) keeps the name and the per-cell lookup.
 */
function sheetScope(ctx, ref) {
  const name = ref?.sheet || null;
  if (!name) return { scope: ctx, sheet: null };
  const scope = ctx?.nameContext?.(name);
  return scope ? { scope, sheet: null } : { scope: ctx, sheet: name };
}

/**
 * The rows of `rg` that SUBTOTAL and AGGREGATE add up: hidden rows dropped when `manual` is a
 * boolean, cells holding a nested total blanked when `skipNested`. A row is copied only when one
 * of its cells is a nested total, so the usual range of plain numbers is read, not rebuilt.
 */
function totalRows(rg, ctx, { skipNested, manual }) {
  const { scope, sheet } = sheetScope(ctx, rg.ref);
  const getFormula = skipNested && rg.ref ? scope?.getFormula : null;
  const isRowHidden = manual !== null && rg.ref ? scope?.isRowHidden : null;
  const rows = [];
  for (let i = 0; i < rg.values.length; i++) {
    if (isRowHidden && isRowHidden(sheet, rg.ref.r1 + i, manual)) continue;
    const row = rg.values[i];
    let kept = row;
    if (getFormula) {
      for (let j = 0; j < row.length; j++) {
        const f = getFormula(sheet, rg.ref.r1 + i, rg.ref.c1 + j);
        if (f && NESTED_TOTAL.test(f)) {
          if (kept === row) kept = row.slice();
          kept[j] = null;
        }
      }
    }
    rows.push(kept);
  }
  return rows;
}

/* ---------- Criteria (SUMIF, COUNTIF, ...) ---------- */

/**
 * The number a cell holds for a numeric criterion: a number itself, or text that reads as one,
 * since SUMIF, COUNTIF and their kin count a "5" stored as text as 5, where MATCH
 * and the = operator keep text and numbers apart. Anything else is null.
 */
const textNumbers = new Map();
let textNumbersLocale = null;
function criteriaNumber(v) {
  if (typeof v === 'number') return v;
  // Text without a digit holds no number ("apple", "TRUE"), so it is not read at all.
  if (typeof v !== 'string' || !hasNumberDigits(v)) return null;
  // The same column of text meets every SUMIF and COUNTIF over it on every calculation, and reading a date
  // or an amount out of text costs far more than the comparison: what each text holds is kept, up to a
  // bound, for the regional format that decided it.
  const locale = getLocale();
  if (locale !== textNumbersLocale) { textNumbers.clear(); textNumbersLocale = locale; }
  let n = textNumbers.get(v);
  if (n === undefined) {
    const read = toNumber(v);
    n = typeof read === 'number' ? read : null;
    if (textNumbers.size >= 100000) textNumbers.clear();
    textNumbers.set(v, n);
  }
  return n;
}

/** Build a predicate from a criteria value like ">10", "<>x", "a*", 5. */
export function criteriaMatcher(criteria) {
  criteria = scalar(criteria);
  if (isError(criteria)) return () => false;
  if (typeof criteria !== 'string') {
    // A reference to an empty cell as the criterion is the value 0.
    const target = criteria == null ? 0 : criteria;
    // Numbers are equal at 15 significant digits, as they are to the = operator: 1.1*3 is 3.3.
    if (typeof target === 'number') return (v) => { const n = criteriaNumber(v); return n != null && compareValues(n, target) === 0; };
    return (v) => typeof v === typeof target && v === target;
  }
  const m = /^(<>|<=|>=|<|>|=)?(.*)$/s.exec(criteria);
  const op = m[1] || '=';
  const rhsText = m[2];
  // Both sides use formula numeric conversion, including its whitespace and
  // numeral rules; cell-entry cleanup must not turn a text criterion numeric.
  const rhsNum = /[*?~]/.test(rhsText) ? null : criteriaNumber(rhsText);
  const rhsIsNum = rhsNum != null;
  const rhsUpper = rhsText.toUpperCase();
  const rhsBool = rhsUpper === 'TRUE' ? true : rhsUpper === 'FALSE' ? false : null;

  // Error tokens are typed criteria, even when supplied as text. Recognize
  // their compatible Unicode spellings before interpreting #NAME?'s '?' as
  // a wildcard. Text containing the token is a different cell value type.
  const rhsError = foldComparisonText(rhsText).includes('#')
    ? ERROR_CODES.findIndex(code => compareSpreadsheetText(rhsText, code) === 0) : -1;
  if (rhsError >= 0) {
    const test = v => {
      if (!isError(v)) return false;
      // Native criteria recognize modern error tokens but do not compare
      // against them. Legacy criteria still order all errors by ERROR.TYPE.
      if (rhsError >= 8) return false;
      const type = ERROR_CODES.indexOf(v.error);
      if (type < 0) return false;
      return op === '<' ? type < rhsError : op === '>' ? type > rhsError
        : op === '<=' ? type <= rhsError : op === '>=' ? type >= rhsError : type === rhsError;
    };
    if (op === '=') test.key = foldPrefixText(rhsText);
    return op === '<>' ? v => !test(v) : test;
  }

  if (op === '=' || op === '<>') {
    // Numeric text is coerced for equality only. Numeric inequality
    // counts text (including "1" against <>1), blanks, booleans and errors.
    if (op === '<>' && rhsIsNum) return v => typeof v !== 'number' || compareValues(v, rhsNum) !== 0;
    // A criterion is reused for every cell in its range. Compile its pattern
    // once, rather than rebuilding the same RegExp during each comparison.
    const wildcard = /[*?]/.test(rhsText) ? wildcardMatcher(rhsText) : null;
    const rhsLower = foldPrefixText(rhsText);
    const eq = (v) => {
      if (rhsText === '') return v == null || v === '';
      if (rhsIsNum) { const n = criteriaNumber(v); return n != null && compareValues(n, rhsNum) === 0; }
      if (rhsBool != null) return typeof v === 'boolean' && v === rhsBool;
      if (typeof v !== 'string') return false;
      return wildcard ? wildcard(v) : compareSpreadsheetText(v, rhsText) === 0;
    };
    // A plain text key can be looked up in an index of the range (criteriaIndex) instead of tested cell by cell.
    if (op === '=' && !wildcard && !rhsIsNum && rhsBool == null && rhsText !== '') eq.key = rhsLower;
    return op === '=' ? eq : (v) => !eq(v);
  }
  return (v) => {
    if (rhsIsNum) {
      if (typeof v !== 'number') return false;
      const c = compareValues(v, rhsNum); // equal at 15 significant digits is neither above nor below
      return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    if (typeof v !== 'string') return false;
    const c = compareValues(v, rhsText);
    return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
  };
}

function asRange(v) {
  return isRange(v) ? v : { range: true, values: [[v]] };
}

/**
 * Where each text or error value of a range sits. Plain ASCII labels keep a
 * direct index; other text is searched by broad linguistic collation and
 * filtered by the actual pairwise predicate, including prefix distinctions.
 * A values array is indexed the second time a text criterion meets it (a single use is
 * cheaper to scan). The arrays are shared within one calculation and replaced by any
 * change, so an index never outlives the values it describes.
 */
const criteriaIndexes = new WeakMap();
function criteriaIndex(values) {
  const known = criteriaIndexes.get(values);
  if (known) return known;
  if (known === undefined) { criteriaIndexes.set(values, false); return null; }
  let cols = 0;
  for (const row of values) cols = Math.max(cols, row.length);
  const groups = new Map();
  let plain = true;
  for (let r = 0; r < values.length; r++) {
    const row = values[r];
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      const text = typeof v === 'string' ? v : isError(v) ? v.error : null;
      if (text === null) continue;
      plain &&= typeof v === 'string' && /^[ 0-9A-Za-z]*$/.test(text);
      const key = `${typeof v}:${foldPrefixText(text)}`;
      let group = groups.get(key);
      if (!group) {
        group = { text: foldComparisonText(text), value: v, positions: [] };
        groups.set(key, group);
      }
      group.positions.push(r * cols + c);
    }
  }
  const entries = [...groups.values()];
  const index = { cols, entries, direct: plain ? new Map(entries.map(g => [g.text, g.positions])) : null,
    sorted: null, queries: new Map(), queryPositions: 0 };
  criteriaIndexes.set(values, index);
  return index;
}

/** Points a text criterion at the index of its range, when there is one: match.positions lists the cells that can match, as r*match.cols+c. */
function indexCriterion(match, range) {
  if (match.key === undefined) return;
  const index = criteriaIndex(range.values);
  if (!index) return;
  match.cols = index.cols;
  if (index.direct && /^[ 0-9A-Za-z]*$/.test(match.key)) {
    match.positions = index.direct.get(match.key) || [];
    return;
  }
  let positions = index.queries.get(match.key);
  if (!positions) {
    const text = foldComparisonText(match.key);
    const sorted = index.sorted ??= index.entries.slice().sort((a, b) => compareFoldedText(a.text, b.text));
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (compareFoldedText(sorted[mid].text, text) < 0) lo = mid + 1; else hi = mid;
    }
    const lists = [];
    for (let i = lo; i < sorted.length && compareFoldedText(sorted[i].text, text) === 0; i++) {
      if (match(sorted[i].value)) lists.push(sorted[i].positions);
    }
    // SUMIF/SUMIFS must retain source order for floating-point accumulation.
    positions = lists.length === 1 ? lists[0] : lists.flat().sort((a, b) => a - b);
    // Bound retained query results independently of the indexed source size.
    if (positions.length <= 100000) {
      if (index.queries.size >= 256 || index.queryPositions + positions.length > 100000) {
        index.queries.clear(); index.queryPositions = 0;
      }
      index.queries.set(match.key, positions); index.queryPositions += positions.length;
    }
  }
  match.positions = positions;
}

/** The rows and columns of a range that were read: the values it holds, which may stop short of the cells it names. */
function readWindow(range) {
  return [range.values.length, range.values[0]?.length || 0];
}

/** `values` as a grid of exactly rows × cols, blank where it was read short; the grid itself when it already is. */
function padGrid(values, rows, cols) {
  if (values.length === rows && (values[0]?.length || 0) === cols) return values;
  const out = new Array(rows);
  for (let r = 0; r < rows; r++) {
    const row = values[r];
    if (row && row.length === cols) { out[r] = row; continue; }
    const full = new Array(cols);
    for (let c = 0; c < cols; c++) full[c] = row?.[c] ?? null;
    out[r] = full;
  }
  return out;
}

/**
 * The value grids of arrays that are to pair cell by cell, read to one window: references naming the
 * same extent on an axis (two whole columns, each read to its own sheet's used area) are padded with
 * blanks to the furthest any of them was read on it, so they pair by position as two whole
 * columns do. An array without an address, or a reference of another extent, keeps the values it was read
 * with; the caller compares the shapes. `sameExtent` says whether the references among them name one
 * extent at all: two references of different extents never pair, whatever was read of them.
 */
function sameExtent(ranges) {
  const refs = ranges.filter(hasExtent);
  if (refs.length < 2) return true;
  const [rows, cols] = rangeShape(refs[0]);
  return refs.every((r) => { const [h, w] = rangeShape(r); return h === rows && w === cols; });
}

function readAlike(ranges) {
  const refs = ranges.filter(hasExtent);
  if (refs.length < 2) return ranges.map((r) => r.values);
  const shapes = refs.map(rangeShape);
  const windows = refs.map(readWindow);
  const rows = shapes.every((s) => s[0] === shapes[0][0]) ? Math.max(...windows.map((w) => w[0])) : null;
  const cols = shapes.every((s) => s[1] === shapes[0][1]) ? Math.max(...windows.map((w) => w[1])) : null;
  return ranges.map((r) => (hasExtent(r) ? padGrid(r.values, rows ?? r.values.length, cols ?? (r.values[0]?.length || 0)) : r.values));
}

/**
 * The pairs of numbers two arrays hold at the same positions (a pair with a blank or text on either side
 * left out), or an error: a cell in error, or #N/A when the arrays hold different numbers of cells.
 */
function pairedNumbers(a, b) {
  const ranges = [asRange(a), asRange(b)];
  if (!sameExtent(ranges)) return err('#N/A');
  const [X, Y] = readAlike(ranges);
  const xs = X.flat();
  const ys = Y.flat();
  if (xs.length !== ys.length) return err('#N/A');
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (isError(xs[i])) return xs[i];
    if (isError(ys[i])) return ys[i];
    if (typeof xs[i] === 'number' && typeof ys[i] === 'number') pairs.push([xs[i], ys[i]]);
  }
  return pairs;
}

/**
 * The cells a criteria predicate may match: its indexed candidates as positions, or (cells null)
 * every one of `count` cells in `window`, the rows and columns read of `range` unless given.
 */
function candidates(pred, range, [rows, cols] = readWindow(range)) {
  if (pred.positions) return { cells: pred.positions, cols: pred.cols, count: pred.positions.length };
  return { cells: null, cols, count: rows * cols };
}

/**
 * SUMIF's sum_range (and AVERAGEIF's) is taken from its top-left cell in the
 * shape of the criteria range: =SUMIF(A1:A3,">0",B1) sums B1:B3.
 */
function shapedLike(target, criteria, ctx) {
  const rows = criteria.values.length;
  const cols = criteria.values[0]?.length ?? 0;
  if (!target.ref || !ctx?.getRangeValues || (target.values.length === rows && (target.values[0]?.length ?? 0) === cols)) return target;
  const ref = { ...target.ref, kind: 'range', r2: target.ref.r1 + rows - 1, c2: target.ref.c1 + cols - 1 };
  return { range: true, values: ctx.getRangeValues(ref), ref };
}

/**
 * Blank cells a reference covers beyond the values that were read: ranges
 * are read only up to the sheet's used area, so a count of blanks adds
 * these back (COUNTBLANK(A1:A1000) on a sheet with 20 rows of data is 980).
 * `read` is the window that was read, the range's own values unless given.
 */
function unreadBlanks(range, [readRows, readCols] = readWindow(range)) {
  if (!range.ref) return 0;
  const [rows, cols] = rangeShape(range);
  return Math.max(0, rows * cols - readRows * readCols);
}

/** One row or one column: what the lookup functions accept as a lookup array. */
function isVector(range) {
  const [rows, cols] = rangeShape(range);
  return rows === 1 || cols === 1;
}

function rangeShape(range) {
  // Values for whole rows/columns and off-grid cells may be trimmed. Compare
  // the addresses so equal references on differently sized sheets still match.
  // An array computed from a reference — --(A:A>0), N(A:A), A:A*2 — has no address but carries the
  // extent it stands for, so it pairs with the references it was built beside.
  if (range.ref) return [range.ref.r2 - range.ref.r1 + 1, range.ref.c2 - range.ref.c1 + 1];
  return range.extent || [range.values.length, range.values[0]?.length || 0];
}

/** An array whose shape is a reference's extent rather than the cells it holds: see rangeShape. */
const hasExtent = (range) => !!(range.ref || range.extent);

/**
 * `answer(sheet, row, col)` for each cell of a reference, as a range in the reference's shape, or the
 * one answer for a single cell. A whole column or row, or a reference of more than 100,000 cells, is
 * answered for the cells read (the rows in use), as ISBLANK spills them.
 */
function overCells(range, answer) {
  const { ref } = range;
  if (ref.r1 === ref.r2 && ref.c1 === ref.c2) return answer(ref.sheet, ref.r1, ref.c1);
  let [rows, cols] = rangeShape(range);
  if (ref.kind !== 'range' || rows * cols > 100000) [rows, cols] = readWindow(range);
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(answer(ref.sheet, ref.r1 + r, ref.c1 + c));
    out.push(row);
  }
  return { range: true, values: out };
}

/** Pairs (criteriaRange, criteria) → predicate, or an error for unequal shapes. */
function multiCriteria(pairs, baseRange) {
  // Criteria come as (criteria_range, criteria) pairs, at least one: a range without its criterion is #VALUE!.
  if (pairs.length < 2 || pairs.length % 2) return err('#VALUE!');
  const [rows, cols] = rangeShape(baseRange);
  const tests = [];
  for (let i = 0; i + 1 < pairs.length; i += 2) {
    const range = asRange(pairs[i]);
    const [height, width] = rangeShape(range);
    if (height !== rows || width !== cols) return err('#VALUE!');
    tests.push({ range, match: criteriaMatcher(pairs[i + 1]) });
  }
  const ok = (r, c) => tests.every((t) => t.match(t.range.values[r]?.[c]));
  // Each range is read only as far as its own sheet holds values, so a whole column on another
  // sheet may have been read past the rows of the first: ok.read is the window every range was read
  // within, for a count that visits each cell any of them holds. A range read short of it is blank there.
  ok.read = tests.reduce(([rows, cols], t) => {
    const [h, w] = readWindow(t.range);
    return [Math.max(rows, h), Math.max(cols, w)];
  }, [0, 0]);
  // An indexed text criterion names the only cells that can match; the other tests are applied to those.
  for (const t of tests) {
    indexCriterion(t.match, t.range);
    if (t.match.positions) { ok.positions = t.match.positions; ok.cols = t.match.cols; break; }
  }
  return ok;
}

/**
 * The *IF family lifts over its criteria: an array or multi-cell range as a
 * criterion answers element by element, in the criterion's shape, so
 * SUM(COUNTIF(A1:A9,{"x","y"})) counts both values and SUMIFS(B1:B9,A1:A9,{"x","y"})
 * gives one sum per value. The criterion sits at argument `first` (and, for the
 * *IFS pairs, every second argument after it); several arrays broadcast the way
 * lifted arguments do, with #N/A where a shorter one runs out. The lifted function
 * carries the criterion positions as `criteriaArgs`, so the workbook knows a call
 * with a range criterion for an array formula that may spill.
 */
function overCriteria(fn, first, repeating = false, { errorCriteria = false } = {}) {
  const lifted = (args, ctx) => {
    let grids = null;
    let rows = 1;
    let cols = 1;
    for (let k = first; k < args.length; k += 2) {
      const a = args[k];
      if (isRange(a)) {
        const h = a.values.length;
        const w = a.values[0]?.length || 0;
        if (h !== 1 || w !== 1) {
          (grids ??= []).push({ k, h, w, values: a.values });
          if (h !== 1) rows = rows === 1 ? h : Math.max(rows, h);
          if (w !== 1) cols = cols === 1 ? w : Math.max(cols, w);
        // SUMIF and AVERAGEIF keep a one-cell reference whole, so that a one-cell sum range still
        // carries its address; an error read from the criterion cell is reported here as it would
        // have been had the reference collapsed, rather than matching nothing and summing to 0.
        } else if (!errorCriteria && isError(a.values[0][0])) return a.values[0][0];
      }
      if (!repeating) break;
    }
    if (!grids) return fn(args, ctx);
    if (rows * cols > 100000) return err('#NUM!');
    const out = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        const cell = args.slice();
        let result;
        for (const g of grids) {
          if ((g.h !== 1 && r >= g.h) || (g.w !== 1 && c >= g.w)) { result = err('#N/A'); break; }
          const v = g.values[g.h === 1 ? 0 : r]?.[g.w === 1 ? 0 : c] ?? null;
          if (!errorCriteria && isError(v)) { result = v; break; }
          cell[g.k] = v;
        }
        row.push(result === undefined ? scalar(fn(cell, ctx)) : result);
      }
      out.push(row);
    }
    return { range: true, values: out };
  };
  lifted.criteriaArgs = { first, repeating };
  return lifted;
}

/* ---------- Text helpers ---------- */

function textArg(v) {
  const t = toText(v);
  return t;
}

/**
 * TEXT's answer for a value in a format code. An unrepresentable date or fraction
 * shows as ##### in a cell, but TEXT returns #VALUE!, not five hash signs of text.
 */
function formattedText(value, code) {
  // An empty code shows nothing of a number: TEXT(1234.5,"") is "", not the number as General writes it.
  if (code === '' && typeof value === 'number') return '';
  // A code longer than the file format's 255 characters is refused, as one is in a file, a paste or the dialog,
  // rather than scanned on every recalculation or answered as a 300-character string.
  if (code.length > MAX_FORMAT_CODE_LENGTH) return err('#VALUE!');
  const out = formatWithCode(value, code, { overflow: null, textFunction: true });
  return out === null ? err('#VALUE!') : out;
}

/** Minimal TEXT() formatter for the codes people actually type. */
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function applyTextFormat(value, code) {
  const stripped = code.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '');
  const dateLike = /[dmy]/i.test(stripped) && !/[#0?]/.test(stripped);
  if (dateLike) {
    const { y, m, d, weekday } = serialToYMD(value);
    return code.replace(/yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|"[^"]*"/gi, (tok) => {
      switch (tok.toLowerCase()) {
        case 'yyyy': return String(y);
        case 'yy': return String(y).slice(-2);
        case 'mmmm': return MONTHS[m - 1];
        case 'mmm': return MONTHS[m - 1].slice(0, 3);
        case 'mm': return String(m).padStart(2, '0');
        case 'm': return String(m);
        case 'dddd': return DAYS[weekday];
        case 'ddd': return DAYS[weekday].slice(0, 3);
        case 'dd': return String(d).padStart(2, '0');
        case 'd': return String(d);
        default: return tok.startsWith('"') ? tok.slice(1, -1) : tok;
      }
    });
  }
  const percent = stripped.includes('%');
  const grouping = /#,##|0,0/.test(stripped);
  const decMatch = /[0#]\.([0#]+)/.exec(stripped);
  const dec = decMatch ? decMatch[1].length : 0;
  const intMatch = /(0+)(?:\.|$|%)/.exec(stripped.replace(/,/g, ''));
  const minInt = intMatch ? intMatch[1].length : 1;
  const n = percent ? value * 100 : value;
  const body = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: dec, maximumFractionDigits: dec, useGrouping: grouping, minimumIntegerDigits: Math.max(1, minInt),
  }).format(n);
  const prefix = /^([^#0.,%]*)/.exec(stripped)?.[1] || '';
  const suffix = /([^#0.,%]*)$/.exec(stripped)?.[1] || '';
  return `${prefix.replace(/"/g, '')}${body}${percent ? '%' : ''}${suffix.replace(/[%"]/g, '')}`;
}

/* ---------- Lookup helpers ---------- */

/**
 * The i-th value of a lookup vector, read in place: column `col` of a two-dimensional values
 * array, or the i-th entry of a one-dimensional one (col -1: a row of a range, or a list). The
 * lookups read a range's column this way rather than copying it out for every call.
 */
const vectorAt = (values, col, i) => (col < 0 ? values[i] : values[i][col]);

/** A one-row or one-column range as [values, col] for vectorAt: its row when it has only one, else its column. */
function lookupVector(range) {
  const rows = range.values;
  return rows.length === 1 ? [rows[0], -1] : [rows, 0];
}

/**
 * Ranges a function pairs row for row or column for column (XLOOKUP's lookup and return arrays,
 * FILTER's array and includes, SORTBY's keys, the parts of a stack, MAP's arrays), read to one
 * window. A whole column (row) is read only to its own sheet's used area, so two from different
 * sheets, or one beside an array computed from another, arrive with different lengths although
 * they name the same rows: each reference read short of its extent is padded with blank rows
 * (columns, or both, by `axis`) to the longest window among them, as the operators pair them and
 * COUNTIFS counts them. A bounded range arrives whole and an array keeps its shape, so a genuine
 * mismatch is still the caller's to judge. The padded array is kept per source array and window,
 * so a lookup index built on it serves every call of one calculation.
 */
const alignedWindows = new WeakMap(); // values array → Map("rows,cols" → the values padded to that window)
function alignWindows(ranges, axis) {
  let rows = 0;
  let cols = 0;
  for (const r of ranges) { rows = Math.max(rows, r.values.length); cols = Math.max(cols, r.values[0]?.length || 0); }
  return ranges.map((r) => {
    if (!hasExtent(r)) return r;
    const [extentRows, extentCols] = rangeShape(r);
    const h = r.values.length;
    const w = r.values[0]?.length || 0;
    const toRows = axis !== 'cols' && h < rows && h < extentRows ? Math.min(rows, extentRows) : h;
    const toCols = axis !== 'rows' && w < cols && w < extentCols ? Math.min(cols, extentCols) : w;
    if (toRows === h && toCols === w) return r;
    let byWindow = alignedWindows.get(r.values);
    if (!byWindow) alignedWindows.set(r.values, byWindow = new Map());
    const key = `${toRows},${toCols}`;
    let values = byWindow.get(key);
    if (!values) {
      const blank = Object.freeze(new Array(toCols).fill(null));
      values = new Array(toRows);
      for (let i = 0; i < toRows; i++) {
        const row = r.values[i];
        if (!row) values[i] = blank;
        else if (row.length === toCols) values[i] = row;
        else { const full = new Array(toCols); for (let c = 0; c < toCols; c++) full[c] = row[c] ?? null; values[i] = full; }
      }
      byWindow.set(key, values);
    }
    return { ...r, values };
  });
}

/**
 * Where each value of a lookup vector first and last sits. Text groups preserve
 * canonical spelling and UTF-16 width; broad collation supplies candidates for
 * either fixed-width legacy matching or whole-text modern exact matching.
 * Numbers and booleans retain their direct keys. As with criteriaIndex, a vector is
 * indexed the second time an exact lookup meets it (one lookup is cheaper as a scan); the arrays are
 * shared within one calculation and replaced by any change, so an index never outlives its values.
 */
const exactIndexes = new WeakMap(); // values array → Map(col → index, or false after a first use)
function exactIndex(values, col) {
  let byCol = exactIndexes.get(values);
  if (!byCol) exactIndexes.set(values, byCol = new Map());
  const known = byCol.get(col);
  if (known) return known;
  if (known === undefined) { byCol.set(col, false); return null; }
  const text = new Map();
  const exact = new Map();
  let plainText = true;
  for (let i = 0; i < values.length; i++) {
    const v = vectorAt(values, col, i);
    const isText = typeof v === 'string';
    if (!isText && typeof v !== 'number' && typeof v !== 'boolean') continue;
    if (v !== v) continue; // NaN equals nothing, in a scan too
    if (isText) {
      const plain = /^[ 0-9A-Za-z]*$/.test(v), prefix = foldPrefixText(v);
      plainText &&= plain;
      const key = `${v.length}:${prefix}`;
      const group = text.get(key);
      if (group) group.span[1] = i;
      else text.set(key, { value: v, broad: plain ? prefix : foldComparisonText(v), span: [i, i] });
    } else {
      const span = exact.get(v);
      if (span) span[1] = i;
      else exact.set(v, [i, i]);
    }
  }
  const index = { text, plainText, textSorted: null, exact };
  byCol.set(col, index);
  return index;
}

/**
 * The index a vector holds the needle at, first or last, as matchIndex's scan finds it, or -1:
 * text whatever its case, numbers and booleans by their stored values.
 */
function exactLookup(index, needle, last, fixedWidth) {
  const end = last ? 1 : 0;
  if (typeof needle === 'string') {
    if (index.plainText && /^[ 0-9A-Za-z]*$/.test(needle)) {
      const group = index.text.get(`${needle.length}:${foldPrefixText(needle)}`);
      return group ? group.span[end] : -1;
    }
    const broad = foldComparisonText(needle);
    const sorted = index.textSorted ??= [...index.text.values()].sort((a, b) => compareFoldedText(a.broad, b.broad));
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = lo + Math.floor((hi - lo) / 2);
      if (compareFoldedText(sorted[mid].broad, broad) < 0) lo = mid + 1; else hi = mid;
    }
    let best = -1;
    for (let i = lo; i < sorted.length && compareFoldedText(sorted[i].broad, broad) === 0; i++) {
      const group = sorted[i];
      if (fixedWidth && group.value.length !== needle.length) continue;
      if (compareSpreadsheetText(group.value, needle) !== 0) continue;
      const position = group.span[end];
      if (best < 0 || (last ? position > best : position < best)) best = position;
    }
    return best;
  }
  const span = index.exact.get(needle);
  return span ? span[end] : -1;
}

/** Whether an exact needle can be looked up in an index: text without wildcards, a number, or a boolean. */
const indexable = (needle, wildcard) => !wildcard && (typeof needle === 'string' || typeof needle === 'number' || typeof needle === 'boolean');

/**
 * Where a vector's values of each type lie, in order, and whether each of those runs climbs or falls:
 * what the approximate search needs to halve a sorted column instead of walking it. Blanks, errors and
 * values of another type than the needle are passed over by the scan, so each type keeps its own list
 * of positions. A run that contradicts its order is left to the scan, which then answers as it always
 * did. As with exactIndex, a vector is indexed the second time a search meets it: one search is
 * cheaper as a scan, which may stop at the first rows.
 */
const sortedRuns = new WeakMap(); // values array → Map(col → runs by type rank, or false after a first use)
function sortedRunIndex(values, col) {
  let byCol = sortedRuns.get(values);
  if (!byCol) sortedRuns.set(values, byCol = new Map());
  const known = byCol.get(col);
  if (known) return known;
  if (known === undefined) { byCol.set(col, false); return null; }
  const runs = [[], [], []]; // by typeRank: numbers, text, booleans
  const climbs = [true, true, true];
  const falls = [true, true, true];
  let last = [null, null, null];
  for (let i = 0; i < values.length; i++) {
    const v = vectorAt(values, col, i);
    if (v == null || isError(v)) continue;
    const rank = typeRank(v);
    const before = last[rank];
    if (before !== null) {
      const c = compareStoredValues(before, v);
      if (c > 0) climbs[rank] = false;
      if (c < 0) falls[rank] = false;
    }
    last[rank] = v;
    runs[rank].push(i);
  }
  const index = { runs, climbs, falls };
  byCol.set(col, index);
  return index;
}

/** The last position of a sorted run not past the needle (mode 1) or not below it (mode -1), by halving. */
function sortedRunMatch(run, values, col, needle, mode) {
  let lo = 0;
  let hi = run.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = compareStoredValues(vectorAt(values, col, run[mid]), needle);
    if (mode === 1 ? c <= 0 : c >= 0) { best = run[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

function matchIndex(needle, values, mode, col = -1) {
  needle = scalar(needle);
  if (mode === 0) {
    const wildcard = typeof needle === 'string' && /[*?~]/.test(needle) ? wildcardMatcher(needle) : null;
    if (indexable(needle, wildcard)) {
      const index = exactIndex(values, col);
      if (index) return exactLookup(index, needle, false, true);
    }
    for (let i = 0; i < values.length; i++) {
      const v = vectorAt(values, col, i);
      if (typeof needle === 'string' && typeof v === 'string') {
        if (wildcard ? wildcard(v) : v.length === needle.length && compareSpreadsheetText(v, needle) === 0) return i;
      } else if (v != null && typeof v === typeof needle && v === needle) return i;
    }
    return -1;
  }
  // Sorted search: largest value <= needle (mode 1) or smallest >= needle (mode -1).
  // An empty lookup value matches nothing here (it is not a zero).
  if (needle == null) return -1;
  // The approximate forms say the data is sorted, which is what halving needs: a column whose values
  // of the needle's type do run that way is searched in a handful of comparisons rather than scanned
  // to the answer, as XLOOKUP's search_mode 2 already was. One that does not falls through to the scan.
  const index = sortedRunIndex(values, col);
  if (index) {
    const rank = typeRank(needle);
    if (mode === 1 ? index.climbs[rank] : index.falls[rank]) return sortedRunMatch(index.runs[rank], values, col, needle, mode);
  }
  let best = -1;
  for (let i = 0; i < values.length; i++) {
    const v = vectorAt(values, col, i);
    // An error cell is passed over like text or a boolean beside a numeric needle, as the search
    // does, so MATCH(2,1/(A:A<>"")) reaches the last filled row past the #DIV/0! of the blank ones;
    // ranked as a number it compared above everything, ending the ascending search and standing as
    // the descending one's answer.
    if (v == null || isError(v) || typeRank(v) !== typeRank(needle)) continue;
    const c = compareStoredValues(v, needle);
    if (mode === 1) { if (c <= 0) best = i; else break; }
    else if (c >= 0) best = i; else break; // descending data: the last value still >= the needle
  }
  return best;
}

/**
 * XLOOKUP / XMATCH matching. match_mode: 0 exact, -1 exact or next smaller,
 * 1 exact or next larger, 2 wildcard. search_mode: 1 first to last, -1 last
 * to first, 2 binary search over ascending values, -2 over descending ones.
 */
function xmatchIndex(needle, values, matchMode, searchMode, col = -1) {
  needle = scalar(needle);
  if (isError(needle)) return needle;
  const mm = Math.trunc(matchMode);
  const sm = Math.trunc(searchMode);
  if (mm !== 0 && mm !== 1 && mm !== -1 && mm !== 2) return err('#VALUE!'); // judged before any search takes the call, a binary one included
  // A sorted range is searched by halving, so a lookup into a long table takes a handful
  // of comparisons instead of a scan of every row.
  if ((sm === 2 || sm === -2) && mm !== 2 && needle != null) return sortedMatchIndex(needle, values, mm, sm > 0, col);
  const reverse = searchMode < 0;
  const n = values.length;
  if (mm === 0 || mm === 2) {
    const wild = mm === 2 && typeof needle === 'string' && /[*?~]/.test(needle);
    const match = wild ? wildcardMatcher(needle) : null;
    if (indexable(needle, match)) {
      const index = exactIndex(values, col);
      if (index) return exactLookup(index, needle, reverse, mm === 2);
    }
    for (let k = 0; k < n; k++) {
      const i = reverse ? n - 1 - k : k;
      const v = vectorAt(values, col, i);
      if (typeof needle === 'string' && typeof v === 'string') {
        if (match ? match(v) : (mm !== 2 || v.length === needle.length) && compareSpreadsheetText(v, needle) === 0) return i;
      } else if (v != null && typeof v === typeof needle && v === needle) return i;
    }
    return -1;
  }
  if (needle == null) return -1; // an empty lookup value is not a zero
  let best = -1;
  for (let k = 0; k < n; k++) {
    const i = reverse ? n - 1 - k : k;
    const v = vectorAt(values, col, i);
    // An error cell is never the next larger or smaller item: passed over, as the search does,
    // rather than ranked as a number (NaN compares as greater than everything and nothing displaces it).
    if (v == null || isError(v) || typeRank(v) !== typeRank(needle)) continue;
    const c = compareStoredValues(v, needle);
    if (c === 0) return i;
    if (mm === -1 && c < 0 && (best < 0 || compareStoredValues(v, vectorAt(values, col, best)) > 0)) best = i;
    if (mm === 1 && c > 0 && (best < 0 || compareStoredValues(v, vectorAt(values, col, best)) < 0)) best = i;
  }
  return best;
}

/**
 * A lookup lifts over an array where it expects one value: a column of lookup values
 * answers with a column of results, VLOOKUP with {1,2} as its column index with a row of
 * two, INDEX with {1;2} as its row with two rows. The function runs once per element of the
 * arrays at the argument `positions`, which broadcast the way lifted arguments do, with #N/A
 * where a shorter one runs out; a one-cell range there is its value. The definition carries
 * the same positions as `liftArgs`, so the workbook can tell the formula may spill.
 */
function overArguments(fn, positions, keepReferences = false) {
  return (args, ctx) => {
    let grids = null;
    let rows = 1;
    let cols = 1;
    for (const k of positions) {
      const a = args[k];
      if (!isRange(a)) continue;
      const h = a.values.length;
      const w = a.values[0]?.length || 0;
      if (h === 1 && w === 1) continue;
      (grids ??= []).push({ k, h, w, values: a.values });
      if (h !== 1) rows = rows === 1 ? h : Math.max(rows, h);
      if (w !== 1) cols = cols === 1 ? w : Math.max(cols, w);
    }
    if (!grids) return fn(args, ctx);
    if (rows * cols > 100000) return err('#NUM!');
    const out = [], referenceGrid = keepReferences ? [] : null;
    for (let r = 0; r < rows; r++) {
      const row = [], references = [];
      for (let c = 0; c < cols; c++) {
        const cell = args.slice();
        let result;
        for (const g of grids) {
          if ((g.h !== 1 && r >= g.h) || (g.w !== 1 && c >= g.w)) { result = err('#N/A'); break; }
          const v = g.values[g.h === 1 ? 0 : r]?.[g.w === 1 ? 0 : c] ?? null;
          if (isError(v)) { result = v; break; }
          cell[g.k] = v;
        }
        if (result === undefined) result = fn(cell, ctx);
        row.push(scalar(result));
        if (referenceGrid) references.push(result);
      }
      out.push(row);
      if (referenceGrid) referenceGrid.push(references);
    }
    return { range: true, values: out, ...(referenceGrid ? { referenceGrid } : {}) };
  };
}

/** The last serial of the spreadsheet calendar, 31 December 9999. */
const MAX_DATE_SERIAL = 2958465;

/** A date argument as a serial inside the calendar (day 0 to 31 December 9999), or #NUM!. */
function dateSerial(a) {
  const n = toNumber(a);
  if (isError(n)) return n;
  return n < 0 || n >= MAX_DATE_SERIAL + 1 ? err('#NUM!') : n;
}

/** A computed serial, or #NUM! when it falls outside the calendar. */
function inCalendar(serial) {
  return serial < 0 || serial > MAX_DATE_SERIAL ? err('#NUM!') : serial;
}

/** Binary search for XLOOKUP and XMATCH over values sorted ascending or descending; blanks sort last. */
function sortedMatchIndex(needle, values, mm, ascending, col = -1) {
  const rank = typeRank(needle);
  let lo = 0;
  let hi = values.length - 1;
  let best = -1;
  while (lo <= hi) {
    let mid = (lo + hi) >> 1;
    let v = vectorAt(values, col, mid);
    if (isError(v)) {
      // An error cell has no place in the order: the nearest cell of the window that is not one
      // stands in for it, as the linear search passes over errors, and a window of errors alone
      // holds no answer. Ranked as a number it compared above everything and was never displaced.
      let probe = -1;
      for (let d = 1; probe < 0 && (mid - d >= lo || mid + d <= hi); d++) {
        if (mid - d >= lo && !isError(vectorAt(values, col, mid - d))) probe = mid - d;
        else if (mid + d <= hi && !isError(vectorAt(values, col, mid + d))) probe = mid + d;
      }
      if (probe < 0) break;
      mid = probe;
      v = vectorAt(values, col, mid);
    }
    let c; // where v sits relative to the needle, in the range's own order
    if (v == null) c = 1;
    else {
      const rv = typeRank(v);
      c = rv !== rank ? (rv < rank ? -1 : 1) : compareStoredValues(v, needle);
      if (!ascending) c = -c;
    }
    if (c === 0) return mid;
    if (c < 0) {
      // v comes before the needle: it is the smaller neighbour in an ascending range, the larger in a descending one.
      if (v != null && mm === (ascending ? -1 : 1)) best = mid;
      lo = mid + 1;
    } else {
      if (v != null && mm === (ascending ? 1 : -1)) best = mid;
      hi = mid - 1;
    }
  }
  return best;
}

/** Calendar/clock extractors round to a second; date arithmetic keeps
 * using dateSerial so hidden time cannot advance EDATE or EOMONTH. */
function dateClock(a) {
  const n = dateSerial(a);
  if (isError(n)) return n;
  const { day, seconds } = serialClock(n);
  return day > MAX_DATE_SERIAL ? err('#NUM!') : { day, seconds };
}

/* ---------- Business days ---------- */

/** The weekday of a whole serial, 0 Sunday to 6 Saturday: day 0 of the calendar is a Saturday. */
function weekdayOf(serial) {
  return (((serial + 6) % 7) + 7) % 7;
}

/**
 * The working days from `a` to `b` inclusive, whole serials with a <= b: the days on no `weekend`
 * weekday and in no holiday of `off`. Any seven days in a row hold each weekday once, so whole
 * weeks are counted at once and only the days of a part week one by one; each holiday on a working
 * day of the span is then taken off, so a span across the calendar is not walked day by day.
 */
function workingDays(a, b, weekend, off) {
  const weeks = Math.floor((b - a + 1) / 7);
  let n = weeks * (7 - weekend.size);
  for (let d = a + weeks * 7; d <= b; d++) if (!weekend.has(weekdayOf(d))) n++;
  for (const h of off) if (h >= a && h <= b && !weekend.has(weekdayOf(h))) n--;
  return n;
}

/**
 * The serial `count` working days on from `start` (`step` 1, or -1 to count back), skipping the
 * `weekend` weekdays (fewer than seven) and the holidays `off`. Whole weeks are stepped at once,
 * leaving the last working day to be found one by one; then each holiday the span took in, in date
 * order, adds one working day, which may take in the next holiday, so every holiday is passed once.
 * The day is not checked against the calendar's bounds here.
 */
function workingDaysFrom(start, count, step, weekend, off) {
  let d = start;
  if (count > 0) {
    const perWeek = 7 - weekend.size;
    const weeks = Math.floor((count - 1) / perWeek);
    d += weeks * 7 * step;
    for (let left = count - weeks * perWeek; left > 0;) { d += step; if (!weekend.has(weekdayOf(d))) left--; }
  }
  const taken = [...off].filter((h) => (step > 0 ? h > start : h < start) && !weekend.has(weekdayOf(h))).sort((x, y) => (x - y) * step);
  for (const h of taken) {
    if (step > 0 ? h > d : h < d) break; // past the span, as every later holiday is
    do d += step; while (weekend.has(weekdayOf(d)));
  }
  return d;
}

/* ---------- The library ---------- */

// Range values must not become function arguments: large inputs exceed the engine's call limit.
const minimum = (list) => list.reduce((a, b) => Math.min(a, b), Infinity);
const maximum = (list) => list.reduce((a, b) => Math.max(a, b), -Infinity);

/**
 * A number on its 15 significant decimal digits, as a spreadsheet sees it: 0.3 / 0.1 is
 * 2.9999999999999996 in binary but 3 to a spreadsheet, so stepping functions
 * must not floor it to 2. A value of 1E+15 or more needs every one of its 16 or
 * 17 digits, so it is kept as it is: snapping 1234567890123456 to ...460 made
 * FLOOR exceed its argument and ROUND move 2^53 to another integer.
 */
function sig15(x) {
  return Number.isFinite(x) && Math.abs(x) < 1e15 ? Number(x.toPrecision(15)) : x;
}

/**
 * C(n, k) for whole n >= k >= 0 by a running product: exact while it fits a
 * double and correctly rounded to about fifteen digits beyond, where
 * exp(lnΓ) carried only fourteen.
 */
function choose(n, k) {
  let out = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) {
    out = (out * (n - i + 1)) / i;
    if (!Number.isFinite(out)) break;
  }
  return Math.round(out);
}

/** `n` moved to a multiple of `step` with `pick` (Math.floor, Math.ceil, or Math.round) applied to the exact quotient. */
function toStep(n, step, pick) {
  return sig15(pick(sig15(n / step)) * step);
}

/** SWITCH's test of its expression against a case: equal and of one type, an empty cell standing for 0, "" or FALSE as it does to the = operator. */
function switchMatches(a, b) {
  if (a == null || b == null) {
    const blankFor = (other) => (typeof other === 'string' ? '' : typeof other === 'boolean' ? false : 0);
    return (a ?? blankFor(b)) === (b ?? blankFor(a));
  }
  return compareValues(a, b) === 0 && typeof a === typeof b;
}

export const FUNCTIONS = {
  /* Math */
  /* The operators as functions, as Google Sheets names them. */
  ADD: { fn: arith((x, y) => x + y) },
  MINUS: { fn: arith((x, y) => x - y) },
  MULTIPLY: { fn: arith((x, y) => x * y) },
  DIVIDE: { fn: arith((x, y) => (y === 0 ? err('#DIV/0!') : x / y)) },
  POW: { alias: 'POWER' }, // the ^ operator as a function: 0^0 is #NUM! and a negative power of zero #DIV/0!, as for POWER
  UMINUS: { fn: unaryMath((x) => -x) },
  UPLUS: { fn: unaryMath((x) => x) },
  UNARY_PERCENT: { fn: unaryMath((x) => x / 100) },
  EQ: { localeContext: false, fn: relation((c) => c === 0) },
  NE: { localeContext: false, fn: relation((c) => c !== 0) },
  GT: { localeContext: false, fn: relation((c) => c > 0) },
  GTE: { localeContext: false, fn: relation((c) => c >= 0) },
  LT: { localeContext: false, fn: relation((c) => c < 0) },
  LTE: { localeContext: false, fn: relation((c) => c <= 0) },
  SUM: { refArgs: true, fn: num(worksheetSum) },
  AVERAGE: { refArgs: true, fn: num((l) => (l.length ? worksheetMean(l) : err('#DIV/0!'))) },
  MIN: { refArgs: true, fn: num((l) => (l.length ? minimum(l) : 0)) },
  MAX: { refArgs: true, fn: num((l) => (l.length ? maximum(l) : 0)) },
  PRODUCT: { refArgs: true, fn: num(product) }, // nothing to multiply is 0
  MEDIAN: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => {
      if (!l.length) return err('#NUM!');
      const s = [...l].sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid] : midpoint(s[mid - 1], s[mid]);
    }),
  },
  STDEV: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num(sampleStdev),
  },
  'STDEV.S': { alias: 'STDEV' },
  'STDEV.P': {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num(populationStdev),
  },
  VAR: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => descriptiveVariance(l, 1)),
  },
  'VAR.S': { alias: 'VAR' },
  COUNT: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    tolerant: true, // an error given directly is a value that is not a number, as one in a range is, not the answer
    fn: (args) => {
      let n = 0;
      for (const v of args) {
        if (isRange(v)) {
          // Plain loops, as numbers() walks its ranges: a generator per value made COUNT of a column slow.
          const rows = v.values;
          for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            for (let c = 0; c < row.length; c++) if (typeof row[c] === 'number' || row[c] === EMPTY) n++;
          }
        } else if (typeof v === 'number' || v === EMPTY) n++; // COUNT(1,) is 2: the empty argument is the number 0
        else if (typeof v === 'string' && !isError(toNumber(v)) && v.trim() !== '') n++;
        else if (typeof v === 'boolean') n++;
      }
      return n;
    },
  },
  // COUNTA counts every non-empty cell, including a formula's "" result.
  COUNTA: {
    tolerant: true, // an error given directly is counted as a value, as one in a range is, rather than answered
    fn: (args) => {
      let n = 0;
      for (const v of args) {
        if (isRange(v)) {
          const rows = v.values;
          for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            for (let c = 0; c < row.length; c++) if (row[c] != null) n++;
          }
        } else if (v != null) n++;
      }
      return n;
    },
  },
  COUNTBLANK: {
    fn: (args) => {
      let n = 0;
      for (const v of args) {
        if (isRange(v)) {
          const rows = v.values;
          for (let r = 0; r < rows.length; r++) {
            const row = rows[r];
            for (let c = 0; c < row.length; c++) if (row[c] == null || row[c] === '') n++;
          }
          n += unreadBlanks(v);
        } else if (v == null || v === '') n++;
      }
      return n;
    },
  },
  ABS: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : Math.abs(n); } },
  SIGN: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : Math.sign(n); } },
  // The number at 15 significant digits, as TRUNC and FLOOR take it: INT(0.3/0.1) is 3, as TRUNC(0.3/0.1) is.
  INT: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : Math.floor(sig15(n)); } },
  TRUNC: {
    fn: ([a, d]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const p = d === undefined ? 0 : toNumber(d); if (isError(p)) return p;
      const f = 10 ** Math.trunc(p);
      if (f >= 1 && Number.isInteger(n)) return n; // a whole number keeps its decimals, where scaling 1E+308 by 10^places would overflow
      // Cut on the value's 15 significant decimal digits, as ROUNDDOWN does: 4.35 keeps its 5.
      return Math.trunc(sig15(n * f)) / f;
    },
  },
  ROUND: {
    fn: ([a, d]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const p = d === undefined ? 0 : toNumber(d); if (isError(p)) return p;
      const places = Math.trunc(p);
      const f = 10 ** Math.abs(places);
      if (places >= 0 && Number.isInteger(n)) return n; // a whole number keeps its decimals, where scaling 1E+308 by 10^places would overflow
      // Round half away from zero on the value's 15 significant decimal
      // digits, so binary error never tips a half (1.005 →
      // 1.01) and large values are not nudged past the next integer.
      const x = sig15(places >= 0 ? Math.abs(n) * f : Math.abs(n) / f);
      const r = Math.round(x);
      return Math.sign(n) * (places >= 0 ? r / f : r * f);
    },
  },
  ROUNDUP: {
    fn: ([a, d]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const p = d === undefined ? 0 : toNumber(d); if (isError(p)) return p;
      const f = 10 ** Math.trunc(p);
      if (f >= 1 && Number.isInteger(n)) return n; // a whole number keeps its decimals, where scaling 1E+308 by 10^places would overflow
      return Math.sign(n) * Math.ceil(sig15(Math.abs(n) * f)) / f;
    },
  },
  ROUNDDOWN: {
    fn: ([a, d]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const p = d === undefined ? 0 : toNumber(d); if (isError(p)) return p;
      const f = 10 ** Math.trunc(p);
      if (f >= 1 && Number.isInteger(n)) return n; // a whole number keeps its decimals, where scaling 1E+308 by 10^places would overflow
      return Math.sign(n) * Math.floor(sig15(Math.abs(n) * f)) / f;
    },
  },
  // A positive number cannot round to a negative multiple: the answer is #NUM!.
  FLOOR: {
    fn: ([a, s]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const step = s === undefined ? 1 : toNumber(s); if (isError(step)) return step;
      if (step === 0) return err('#DIV/0!');
      if (n > 0 && step < 0) return err('#NUM!');
      return toStep(n, step, Math.floor);
    },
  },
  CEILING: {
    fn: ([a, s]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const step = s === undefined ? 1 : toNumber(s); if (isError(step)) return step;
      if (step === 0) return 0;
      if (n > 0 && step < 0) return err('#NUM!');
      return toStep(n, step, Math.ceil);
    },
  },
  MOD: {
    fn: ([a, b]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const d = toNumber(b); if (isError(d)) return d;
      if (d === 0) return err('#DIV/0!');
      // The remainder operator is exact where n - d * floor(n / d) is not: a quotient past 2^53 made MOD(1E+17,7) zero.
      const r = n % d;
      if (r === 0) return 0;
      return (r < 0) !== (d < 0) ? r + d : r;
    },
  },
  POWER: {
    fn: ([a, b]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const p = toNumber(b); if (isError(p)) return p;
      return realPower(n, p);
    },
  },
  SQRT: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : n < 0 ? err('#NUM!') : Math.sqrt(n); } },
  EXP: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : checkNum(Math.exp(n)); } },
  LN: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : n <= 0 ? err('#NUM!') : Math.log(n); } },
  LOG10: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : n <= 0 ? err('#NUM!') : Math.log10(n); } },
  LOG: {
    fn: ([a, b]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const base = b === undefined ? 10 : toNumber(b); if (isError(base)) return base;
      if (n <= 0 || base <= 0 || base === 1) return err('#NUM!');
      const v = base === 10 ? Math.log10(n) : base === 2 ? Math.log2(n) : Math.log(n) / Math.log(base);
      // An exact power reads as a whole number, so INT(LOG(1000)) is 3.
      const k = Math.round(v);
      return Math.abs(v - k) < 1e-12 && base ** k === n ? k : v;
    },
  },
  PI: { localeContext: false, fn: () => Math.PI },
  RAND: { fn: (_, ctx) => randomValue(ctx), volatile: true },
  RANDBETWEEN: {
    fn: ([a, b], ctx) => {
      const lo = toNumber(a); if (isError(lo)) return lo;
      const hi = toNumber(b); if (isError(hi)) return hi;
      // Only the integers between the bounds can be drawn: from the ceiling of the low one up.
      const first = Math.ceil(lo);
      const last = Math.floor(hi);
      if (last < first) return err('#NUM!');
      return first + Math.floor(randomValue(ctx) * (last - first + 1));
    },
    volatile: true,
  },
  SUMPRODUCT: {
    fn: (args) => {
      // Whole columns on two sheets, each read to its own sheet's used area, pair by row, the shorter read on with blanks.
      const ranges = args.map(asRange);
      if (!sameExtent(ranges)) return err('#VALUE!');
      const grids = readAlike(ranges);
      const rows = grids[0].length;
      const cols = grids[0][0]?.length || 0;
      if (grids.some((g) => g.length !== rows || (g[0]?.length || 0) !== cols)) return err('#VALUE!');
      // An entry that is not a number counts as zero, text and TRUE alike, which is why
      // SUMPRODUCT(--(A1:A6>3)) is written with the double unary: without it the comparisons
      // are TRUE and FALSE, and the sum is 0, as it is for SUM over the same array.
      let total = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          let p = 0;
          for (let i = 0; i < grids.length; i++) {
            const v = grids[i][r][c];
            if (isError(v)) return v;
            const n = typeof v === 'number' ? v : 0;
            p = i === 0 ? n : flushUnderflow(p * n);
          }
          total += p;
        }
      }
      return total;
    },
  },
  SUMIF: {
    refArgs: true, // a one-cell sum range arrives with its address, to be taken in the criteria range's shape
    fn: overCriteria(([range, criteria, sumRange], ctx) => {
      const rg = asRange(range);
      const sr = sumRange === undefined ? rg : shapedLike(asRange(sumRange), rg, ctx);
      const match = criteriaMatcher(criteria);
      indexCriterion(match, rg);
      let total = 0;
      const { cells, cols, count } = candidates(match, rg);
      for (let k = 0; k < count; k++) {
        const p = cells ? cells[k] : k;
        const r = Math.floor(p / cols);
        const c = p - r * cols;
        if (!match(rg.values[r][c])) continue;
        const s = sr.values[r]?.[c];
        if (typeof s === 'number') total += s;
        else if (isError(s)) return s;
      }
      return total;
    }, 1),
  },
  SUMIFS: {
    refArgs: true, // an error inside a one-cell range is data, not a failed argument
    fn: overCriteria(([sumRange, ...pairs]) => {
      const sr = asRange(sumRange);
      const ok = multiCriteria(pairs, sr);
      if (isError(ok)) return ok;
      let total = 0;
      const { cells, cols, count } = candidates(ok, sr);
      for (let k = 0; k < count; k++) {
        const p = cells ? cells[k] : k;
        const r = Math.floor(p / cols);
        const c = p - r * cols;
        const v = sr.values[r]?.[c];
        if (typeof v === 'number') { if (ok(r, c)) total += v; }
        else if (isError(v) && ok(r, c)) return v;
      }
      return total;
    }, 2, true),
  },
  COUNTIF: {
    fn: overCriteria(([range, criteria]) => {
      if (isError(range)) return range;
      // COUNTIF accepts an error value as a criterion, including NA() and
      // references to error cells. A broken range still reports its error.
      criteria = scalar(criteria);
      const match = criteriaMatcher(isError(criteria) ? criteria.error : criteria);
      const rg = asRange(range);
      indexCriterion(match, rg);
      let n = 0;
      if (match.positions) n = match.positions.length;
      else for (const row of rg.values) for (const v of row) if (match(v)) n++;
      if (match(null)) n += unreadBlanks(rg);
      return n;
    }, 1, false, { errorCriteria: true }),
    refArgs: true,
    tolerant: true,
  },
  COUNTIFS: {
    refArgs: true, // an error inside a one-cell range is data, not a failed argument
    fn: overCriteria((pairs) => {
      const first = asRange(pairs[0]);
      const ok = multiCriteria(pairs, first);
      if (isError(ok)) return ok;
      let n = 0;
      // Every cell any of the ranges was read to is visited, not only those of the first range.
      const { cells, cols, count } = candidates(ok, first, ok.read);
      for (let k = 0; k < count; k++) {
        const p = cells ? cells[k] : k;
        const r = Math.floor(p / cols);
        if (ok(r, p - r * cols)) n++;
      }
      // Blank cells beyond the values read of every range are blank in each range of the pair list.
      if (ok(-1, -1)) n += unreadBlanks(first, ok.read);
      return n;
    }, 1, true),
  },
  AVERAGEIF: {
    refArgs: true,
    fn: overCriteria(([range, criteria, avgRange], ctx) => {
      const rg = asRange(range);
      const ar = avgRange === undefined ? rg : shapedLike(asRange(avgRange), rg, ctx);
      const match = criteriaMatcher(criteria);
      indexCriterion(match, rg);
      let total = 0;
      let n = 0;
      const { cells, cols, count } = candidates(match, rg);
      for (let k = 0; k < count; k++) {
        const p = cells ? cells[k] : k;
        const r = Math.floor(p / cols);
        const c = p - r * cols;
        if (!match(rg.values[r][c])) continue;
        const s = ar.values[r]?.[c];
        if (typeof s === 'number') { total += s; n++; }
        else if (isError(s)) return s;
      }
      return n ? total / n : err('#DIV/0!');
    }, 1),
  },
  MAXIFS: {
    refArgs: true, // an error inside a one-cell range is data, not a failed argument
    fn: overCriteria(([range, ...pairs]) => {
      const rg = asRange(range);
      const ok = multiCriteria(pairs, rg);
      if (isError(ok)) return ok;
      let best = null;
      const { cells, cols, count } = candidates(ok, rg);
      for (let k = 0; k < count; k++) {
        const p = cells ? cells[k] : k;
        const r = Math.floor(p / cols);
        const c = p - r * cols;
        const v = rg.values[r]?.[c];
        if (typeof v === 'number') { if (ok(r, c) && (best === null || v > best)) best = v; }
        else if (isError(v) && ok(r, c)) return v; // a cell in error is reported, as SUMIFS and MAX report it
      }
      return best ?? 0;
    }, 2, true),
  },
  MINIFS: {
    refArgs: true, // an error inside a one-cell range is data, not a failed argument
    fn: overCriteria(([range, ...pairs]) => {
      const rg = asRange(range);
      const ok = multiCriteria(pairs, rg);
      if (isError(ok)) return ok;
      let best = null;
      const { cells, cols, count } = candidates(ok, rg);
      for (let k = 0; k < count; k++) {
        const p = cells ? cells[k] : k;
        const r = Math.floor(p / cols);
        const c = p - r * cols;
        const v = rg.values[r]?.[c];
        if (typeof v === 'number') { if (ok(r, c) && (best === null || v < best)) best = v; }
        else if (isError(v) && ok(r, c)) return v; // a cell in error is reported, as SUMIFS and MIN report it
      }
      return best ?? 0;
    }, 2, true),
  },

  /* Logical */
  TRUE: { localeContext: false, fn: () => true },
  FALSE: { localeContext: false, fn: () => false },
  NOT: { localeContext: false, fn: ([a]) => { const b = toBool(a); return isError(b) ? b : !b; } },
  AND: {
    localeContext: false,
    refArgs: true, // a referenced text cell is skipped, whether the reference is one cell or a range
    fn: (args) => {
      let seen = false;
      let all = true;
      for (const { v, inRange } of eachValue(args)) {
        if (isError(v)) return v;
        if (inRange && typeof v !== 'boolean' && typeof v !== 'number') continue;
        if (v == null) continue;
        const b = toBool(v); if (isError(b)) return b;
        seen = true;
        if (!b) all = false; // every argument is read: text or an error after a FALSE still decides the answer
      }
      return seen ? all : err('#VALUE!');
    },
  },
  OR: {
    localeContext: false,
    refArgs: true, // a referenced text cell is skipped, whether the reference is one cell or a range
    fn: (args) => {
      let seen = false;
      let any = false;
      // Every argument is read: text or an error after a TRUE still decides the answer.
      for (const { v, inRange } of eachValue(args)) {
        if (isError(v)) return v;
        if (inRange && typeof v !== 'boolean' && typeof v !== 'number') continue;
        if (v == null) continue;
        const b = toBool(v); if (isError(b)) return b;
        seen = true;
        if (b) any = true;
      }
      return seen ? any : err('#VALUE!');
    },
  },
  XOR: {
    localeContext: false,
    refArgs: true, // a referenced text cell is skipped, whether the reference is one cell or a range
    fn: (args) => {
      let seen = false;
      let count = 0;
      for (const { v, inRange } of eachValue(args)) {
        if (isError(v)) return v;
        if (inRange && typeof v !== 'boolean' && typeof v !== 'number') continue;
        if (v == null) continue;
        const b = toBool(v); if (isError(b)) return b;
        seen = true;
        if (b) count++;
      }
      // Nothing logical to read is no answer, as for AND and OR, not the FALSE of zero TRUEs.
      return seen ? count % 2 === 1 : err('#VALUE!');
    },
  },
  IF: {
    localeContext: false,
    lazy: true,
    refArgs: true,
    fn: ([cond, yes, no]) => {
      const c = toBool(cond ? cond() : null);
      if (isError(c)) return c;
      if (c) return yes ? (yes.omitted ? 0 : yes()) : true;
      return no ? (no.omitted ? 0 : no()) : false;
    },
  },
  IFS: {
    localeContext: false,
    lazy: true,
    fn: (args) => {
      for (let i = 0; i + 1 < args.length; i += 2) {
        const c = toBool(args[i]());
        if (isError(c)) return c;
        if (c) return args[i + 1].omitted ? 0 : args[i + 1]();
      }
      return err('#N/A');
    },
  },
  IFERROR: {
    localeContext: false,
    lazy: true,
    fn: ([value, fallback]) => {
      const v = scalar(value ? value() : null);
      return isError(v) ? (fallback ? (fallback.omitted ? 0 : fallback()) : '') : v; // IFERROR(x,): a fallback left empty is 0, as for IF
    },
  },
  IFNA: {
    localeContext: false,
    lazy: true,
    fn: ([value, fallback]) => {
      const v = scalar(value ? value() : null);
      return isError(v) && v.error === '#N/A' ? (fallback ? (fallback.omitted ? 0 : fallback()) : '') : v;
    },
  },
  SWITCH: {
    localeContext: false,
    lazy: true,
    matches: switchMatches, // the evaluator lifts SWITCH over an array expression with the same test
    fn: (args) => {
      const target = scalar(args[0]());
      if (isError(target)) return target;
      let i = 1;
      for (; i + 1 < args.length; i += 2) {
        const candidate = scalar(args[i]());
        if (isError(candidate)) return candidate;
        if (switchMatches(target, candidate)) return args[i + 1].omitted ? 0 : args[i + 1](); // a result left empty is 0, as for IF
      }
      return i < args.length ? (args[i].omitted ? 0 : args[i]()) : err('#N/A');
    },
  },
  CHOOSE: {
    lazy: true,
    refArgs: true,
    fn: (args) => {
      const index = args[0] ? args[0]() : null;
      if (isRange(index) && (!index.ref || index.values.length > 1 || index.values[0]?.length > 1)) {
        // Array indices evaluate every choice once. Broadcast singleton axes,
        // then select only the corresponding element of each chosen value.
        const choices = args.slice(1).map((read) => asRange(read.omitted ? 0 : read()).values);
        const indices = index.values.map((row) => row.map((value) => {
          const n = toNumber(value);
          if (isError(n)) return n;
          const k = Math.trunc(n);
          return k >= 1 && k <= choices.length ? k - 1 : err('#VALUE!');
        }));
        let rows = indices.length, cols = indices[0]?.length || 0;
        for (const choice of choices) {
          rows = Math.max(rows, choice.length);
          cols = Math.max(cols, choice[0]?.length || 0);
        }
        if (rows * cols > 100000) return err('#NUM!');
        const at = (values, r, c) => {
          const row = values[values.length === 1 ? 0 : r];
          const col = values[0]?.length === 1 ? 0 : c;
          return !row || col >= row.length ? err('#N/A') : row[col] ?? null;
        };
        const values = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
          const k = at(indices, r, c);
          return isError(k) ? k : at(choices[k], r, c);
        }));
        return { range: true, values };
      }
      const i = toNumber(index);
      if (isError(i)) return i;
      const k = Math.trunc(i);
      if (k < 1 || k >= args.length) return err('#VALUE!');
      return args[k].omitted ? 0 : args[k](); // a choice left empty is 0, as for IF
    },
  },

  /* Information */
  ISBLANK: information((v) => v == null),
  ISNUMBER: information((v) => typeof v === 'number'),
  ISTEXT: information((v) => typeof v === 'string'),
  ISLOGICAL: information((v) => typeof v === 'boolean'),
  ISERROR: information(isError),
  ISERR: information((v) => isError(v) && v.error !== '#N/A'),
  ISNA: information((v) => isError(v) && v.error === '#N/A'),
  // The whole part of the number at 15 significant digits, as EVEN and ODD take it: ISODD(0.3/0.1) is TRUE.
  ISEVEN: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : Math.trunc(sig15(n)) % 2 === 0; } },
  ISODD: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : Math.abs(Math.trunc(sig15(n))) % 2 === 1; } },
  NA: { localeContext: false, fn: () => err('#N/A') },
  N: { localeContext: false, fn: ([a]) => { const v = scalar(a); return typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : isError(v) ? v : 0; }, tolerant: true },
  TYPE: {
    localeContext: false,
    fn: ([a]) => {
      if (isRange(a) && (a.values.length > 1 || a.values[0].length > 1)) return 64;
      const v = scalar(a);
      // A picture in a cell (placed there or from IMAGE) is a compound value, neither text nor an error.
      if (v && typeof v === 'object' && (typeof v.image === 'string' || v.sparkline)) return 128;
      return typeof v === 'number' || v == null ? 1 : typeof v === 'string' ? 2 : typeof v === 'boolean' ? 4 : 16;
    },
    tolerant: true,
  },

  /* Text */
  CONCAT: { fn: (args) => { let s = ''; for (const { v } of eachValue(args)) { if (isError(v)) return v; const t = toText(v); if (isError(t)) return t; s += t; if (s.length > MAX_TEXT) return err('#VALUE!'); } return s; } },
  CONCATENATE: { alias: 'CONCAT' },
  TEXTJOIN: {
    fn: ([delim, ignoreEmpty, ...rest]) => {
      // An array of delimiters is used in turn between the texts, starting over when it runs out.
      const delims = [];
      for (const { v } of eachValue([delim])) {
        if (isError(v)) return v;
        const d = toText(v); if (isError(d)) return d;
        delims.push(d);
      }
      if (!delims.length) return err('#VALUE!');
      const skip = toBool(ignoreEmpty); if (isError(skip)) return skip;
      const parts = [];
      for (const { v } of eachValue(rest)) {
        if (isError(v)) return v;
        const t = toText(v); if (isError(t)) return t;
        if (skip && t === '') continue;
        parts.push(t);
      }
      let joined = '';
      for (let i = 0; i < parts.length; i++) {
        joined += (i ? delims[(i - 1) % delims.length] : '') + parts[i];
        if (joined.length > MAX_TEXT) return err('#VALUE!');
      }
      return joined;
    },
  },
  LEN: { callerContext: ['compatibility'], fn: ([a], ctx) => { const t = textArg(a); return isError(t) ? t : ctx?.compatibilityVersion === 1 ? t.length : [...t].length; } },
  // A letter can grow when its case changes ("ß" to "SS"), so the result is held to what a cell holds, as in REPT.
  UPPER: { fn: ([a]) => { const t = textArg(a); if (isError(t)) return t; const u = t.toUpperCase(); return u.length > MAX_TEXT ? err('#VALUE!') : u; } },
  LOWER: { fn: ([a]) => { const t = textArg(a); if (isError(t)) return t; const l = t.toLowerCase(); return l.length > MAX_TEXT ? err('#VALUE!') : l; } },
  PROPER: {
    fn: ([a]) => {
      const t = textArg(a);
      return isError(t) ? t : t.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (m, p, ch) => p + ch.toUpperCase());
    },
  },
  // Only spaces: newlines stay for the CLEAN idiom, and CHAR(160) stays for SUBSTITUTE.
  TRIM: { fn: ([a]) => { const t = textArg(a); return isError(t) ? t : t.replace(/^ +| +$/g, '').replace(/ {2,}/g, ' '); } },
  CLEAN: { fn: ([a]) => { const t = textArg(a); return isError(t) ? t : t.replace(/[\x00-\x1f]/g, ''); } },
  LEFT: {
    fn: ([a, n]) => {
      const t = textArg(a); if (isError(t)) return t;
      const k = n === undefined ? 1 : toNumber(n); if (isError(k)) return k;
      if (k < 0) return err('#VALUE!');
      return [...t].slice(0, Math.trunc(k)).join('');
    },
  },
  RIGHT: {
    fn: ([a, n]) => {
      const t = textArg(a); if (isError(t)) return t;
      const k = n === undefined ? 1 : toNumber(n); if (isError(k)) return k;
      if (k < 0) return err('#VALUE!');
      const chars = [...t];
      const count = Math.trunc(k); // slice(-0) would be the whole text
      return count === 0 ? '' : chars.slice(-count).join('');
    },
  },
  MID: {
    callerContext: ['compatibility'],
    fn: ([a, start, n], ctx) => {
      const t = textArg(a); if (isError(t)) return t;
      const s = toNumber(start); if (isError(s)) return s;
      const k = toNumber(n); if (isError(k)) return k;
      if (s < 1 || k < 0) return err('#VALUE!');
      const from = Math.trunc(s) - 1, to = from + Math.trunc(k);
      return ctx?.compatibilityVersion === 1 ? t.slice(from, to) : [...t].slice(from, to).join('');
    },
  },
  FIND: {
    callerContext: ['compatibility'],
    fn: ([needle, hay, start], ctx) => {
      const n = textArg(needle); if (isError(n)) return n;
      const h = textArg(hay); if (isError(h)) return h;
      const s = start === undefined ? 1 : toNumber(start); if (isError(s)) return s;
      if (s < 1) return err('#VALUE!');
      // Version 1 uses UTF-16 positions; Version 2 counts surrogate pairs once.
      const legacy = ctx?.compatibilityVersion === 1;
      const from = charUnits(h, Math.trunc(s) - 1, legacy);
      if (from == null) return err('#VALUE!');
      const i = h.indexOf(n, from);
      return i < 0 ? err('#VALUE!') : charCount(h, i, legacy) + 1;
    },
  },
  SEARCH: {
    callerContext: ['compatibility'],
    fn: ([needle, hay, start], ctx) => {
      const n = textArg(needle); if (isError(n)) return n;
      const h = textArg(hay); if (isError(h)) return h;
      const s = start === undefined ? 1 : toNumber(start); if (isError(s)) return s;
      if (s < 1) return err('#VALUE!');
      const legacy = ctx?.compatibilityVersion === 1;
      const from = charUnits(h, Math.trunc(s) - 1, legacy);
      if (from == null || from >= h.length) return err('#VALUE!');
      // Match fixed UTF-16 spans, but report/start at character boundaries in
      // Compatibility Version 2. Plain literals use the same linguistic rules.
      const at = wildcardMatcher(n).searchFrom(h, from, !legacy);
      return at < 0 ? err('#VALUE!') : charCount(h, at, legacy) + 1;
    },
  },
  SUBSTITUTE: {
    fn: ([text, from, to, nth]) => {
      const t = textArg(text); if (isError(t)) return t;
      const f = textArg(from); if (isError(f)) return f;
      const r = textArg(to); if (isError(r)) return r;
      if (f === '') return t;
      if (nth === undefined) {
        // Text longer than a cell holds is #VALUE!, as in REPT; the instances are counted first so a
        // huge replacement is refused rather than built.
        let count = 0;
        for (let i = t.indexOf(f); i >= 0; i = t.indexOf(f, i + f.length)) count++;
        if (t.length + count * (r.length - f.length) > MAX_TEXT) return err('#VALUE!');
        return t.split(f).join(r);
      }
      const k = toNumber(nth); if (isError(k)) return k;
      if (k < 1) return err('#VALUE!');
      // Instances never overlap, as in the all-instances form: "aa" occurs once in "aaa".
      let idx = -1;
      for (let i = 0; i < Math.trunc(k); i++) {
        idx = t.indexOf(f, idx < 0 ? 0 : idx + f.length);
        if (idx < 0) return t;
      }
      if (t.length + r.length - f.length > MAX_TEXT) return err('#VALUE!');
      return t.slice(0, idx) + r + t.slice(idx + f.length);
    },
  },
  REPLACE: {
    callerContext: ['compatibility'],
    fn: ([text, start, n, to], ctx) => {
      const t = textArg(text); if (isError(t)) return t;
      const s = toNumber(start); if (isError(s)) return s;
      const k = toNumber(n); if (isError(k)) return k;
      const r = textArg(to); if (isError(r)) return r;
      if (s < 1 || k < 0) return err('#VALUE!');
      const chars = ctx?.compatibilityVersion === 1 ? t.split('') : [...t];
      const out = chars.slice(0, Math.trunc(s) - 1).join('') + r + chars.slice(Math.trunc(s) - 1 + Math.trunc(k)).join('');
      return out.length > MAX_TEXT ? err('#VALUE!') : out; // longer than a cell holds, as in REPT
    },
  },
  REPT: {
    fn: ([a, n]) => {
      const t = textArg(a); if (isError(t)) return t;
      const k = toNumber(n); if (isError(k)) return k;
      const times = Math.trunc(k); // the fraction is dropped before the length is judged
      if (times < 0 || t.length * times > MAX_TEXT) return err('#VALUE!');
      return t.repeat(times);
    },
  },
  EXACT: {
    fn: ([a, b]) => {
      const x = textArg(a); if (isError(x)) return x;
      const y = textArg(b); if (isError(y)) return y;
      return x === y;
    },
  },
  VALUE: { fn: ([a]) => { const v = scalar(a); return typeof v === 'number' ? v : toNumber(v); } },
  CHAR: { fn: ([a]) => { const n = toNumber(a); if (isError(n)) return n; const k = Math.trunc(n); return k < 1 || k > 255 ? err('#VALUE!') : String.fromCharCode(k); } }, // truncated before the range check, as UNICHAR is
  // The code point of the first character, as UNICODE gives it and as LEN and MID count characters (Google Sheets; Excel answers 63 outside its code page), not the first UTF-16 half of an emoji.
  CODE: { fn: ([a]) => { const t = textArg(a); return isError(t) ? t : t === '' ? err('#VALUE!') : t.codePointAt(0); } },
  TEXT: {
    fn: ([a, code]) => {
      const v = scalar(a);
      if (isError(v)) return v;
      const c = textArg(code); if (isError(c)) return c;
      // Text that reads as a number (or a date) is formatted as one.
      if (typeof v === 'string') {
        // Other text, and the empty text, goes through the format's text section (@ and its literals).
        const parsed = v === '' ? err('#VALUE!') : toNumber(v);
        try { return formattedText(isError(parsed) ? v : parsed, c); } catch { return v; }
      }
      // Keep Boolean spelling, but still validate the format code.
      const n = typeof v === 'boolean' ? v : toNumber(v); if (isError(n)) return n;
      try { return formattedText(n, c); } catch { return err('#VALUE!'); }
    },
  },

  /* Lookup & reference */
  VLOOKUP: {
    liftArgs: [0, 2], // an array of lookup values, or of column indexes, answers with an array
    fn: overArguments(([needle, table, colIdx, approx]) => {
      const t = asRange(table);
      const ci = toNumber(colIdx); if (isError(ci)) return ci;
      const k = Math.trunc(ci);
      // An index below 1 is #VALUE!; one past the reference's own width (not how far past the data it was read) is #REF!.
      if (k < 1) return err('#VALUE!');
      if (k > rangeShape(t)[1]) return err('#REF!');
      const sorted = approx === undefined ? true : toBool(approx); if (isError(sorted)) return sorted;
      const i = matchIndex(needle, t.values, sorted ? 1 : 0, 0); // the first column, read in place
      if (i < 0) return err('#N/A');
      return t.values[i][k - 1] ?? 0;
    }, [0, 2]),
  },
  HLOOKUP: {
    liftArgs: [0, 2],
    fn: overArguments(([needle, table, rowIdx, approx]) => {
      const t = asRange(table);
      const ri = toNumber(rowIdx); if (isError(ri)) return ri;
      const k = Math.trunc(ri);
      if (k < 1) return err('#VALUE!');
      if (k > rangeShape(t)[0]) return err('#REF!');
      const sorted = approx === undefined ? true : toBool(approx); if (isError(sorted)) return sorted;
      const i = matchIndex(needle, t.values[0] || [], sorted ? 1 : 0);
      if (i < 0) return err('#N/A');
      return t.values[k - 1]?.[i] ?? 0;
    }, [0, 2]),
  },
  XLOOKUP: {
    liftArgs: [0],
    fn: overArguments(([needle, lookup, ret, notFound, matchMode, searchMode]) => {
      const [l, r] = alignWindows([asRange(lookup), asRange(ret)]);
      const mm = matchMode === undefined ? 0 : toNumber(matchMode); if (isError(mm)) return mm;
      const sm = searchMode === undefined ? 1 : toNumber(searchMode); if (isError(sm)) return sm;
      if (![1, -1, 2, -2].includes(Math.trunc(sm))) return err('#VALUE!'); // first to last, last to first, or a binary search either way
      if (!isVector(l)) return err('#VALUE!'); // a lookup array is one row or one column
      const [lookupRows, lookupCols] = rangeShape(l);
      const [returnRows, returnCols] = rangeShape(r);
      // The return array runs alongside the lookup array; a different length there is #VALUE!.
      if (lookupRows >= lookupCols ? returnRows !== lookupRows : returnCols !== lookupCols) return err('#VALUE!');
      const [vector, vectorCol] = lookupVector(l);
      const i = xmatchIndex(needle, vector, mm, sm, vectorCol);
      if (isError(i)) return i;
      if (i < 0) return notFound === undefined ? err('#N/A') : notFound;
      const vertical = l.values.length >= (l.values[0]?.length || 0);
      // A two-dimensional return range answers with the whole row (or column).
      if (vertical) {
        const row = r.values[i];
        if (!row) return err('#N/A');
        return row.length === 1 ? row[0] ?? null : { range: true, values: [row.map((v) => v ?? null)] };
      }
      const col = r.values.map((row) => row[i]);
      if (col.length === 1) return col[0] ?? null;
      return { range: true, values: col.map((v) => [v ?? null]) };
    }, [0]),
    array: true,
  },
  XMATCH: {
    liftArgs: [0],
    fn: overArguments(([needle, lookup, matchMode, searchMode]) => {
      const l = asRange(lookup);
      const mm = matchMode === undefined ? 0 : toNumber(matchMode); if (isError(mm)) return mm;
      const sm = searchMode === undefined ? 1 : toNumber(searchMode); if (isError(sm)) return sm;
      if (![1, -1, 2, -2].includes(Math.trunc(sm))) return err('#VALUE!'); // first to last, last to first, or a binary search either way
      if (!isVector(l)) return err('#VALUE!');
      const [vector, col] = lookupVector(l);
      const i = xmatchIndex(needle, vector, mm, sm, col);
      if (isError(i)) return i;
      return i < 0 ? err('#N/A') : i + 1;
    }, [0]),
  },
  MATCH: {
    liftArgs: [0],
    fn: overArguments(([needle, lookup, mode]) => {
      const l = asRange(lookup);
      const m = mode === undefined ? 1 : toNumber(mode); if (isError(m)) return m;
      if (!isVector(l)) return err('#N/A');
      const [vector, col] = lookupVector(l);
      const i = matchIndex(needle, vector, Math.sign(m), col);
      return i < 0 ? err('#N/A') : i + 1;
    }, [0]),
  },
  INDEX: {
    array: true,
    refArgs: true,
    liftArgs: [1, 2], // an array of row or column numbers picks one cell per element
    fn: overArguments(([table, rowIdx, colIdx, areaNum], ctx) => {
      // INDEX((A1:B3, D1:E3), 2, 1, 2): area_num picks one area of a union.
      let t = asRange(table);
      if (t.areas) {
        const a = areaNum === undefined ? 1 : toNumber(areaNum); if (isError(a)) return a;
        if (Math.trunc(a) < 1 || Math.trunc(a) > t.areas.length) return err('#REF!');
        t = t.areas[Math.trunc(a) - 1];
      } else if (areaNum !== undefined) {
        // A plain reference has only area 1.
        const a = toNumber(areaNum); if (isError(a)) return a;
        if (Math.trunc(a) !== 1) return err('#REF!');
      }
      const r = rowIdx === undefined ? 0 : toNumber(rowIdx); if (isError(r)) return r;
      const c = colIdx === undefined ? 0 : toNumber(colIdx); if (isError(c)) return c;
      const referenceOnly = ctx.referenceMode && t.ref;
      const rows = referenceOnly ? t.ref.r2 - t.ref.r1 + 1 : t.values.length;
      const cols = referenceOnly ? t.ref.c2 - t.ref.c1 + 1 : t.values[0]?.length || 0;
      // The reference may extend past the values read (they stop at the used area); those cells are blank.
      const [refRows, refCols] = t.ref ? rangeShape(t) : [rows, cols];
      let rr = Math.trunc(r);
      let cc = Math.trunc(c);
      // A single row or column lets one index address it.
      if (colIdx === undefined && refRows === 1 && refCols > 1) { cc = rr; rr = 1; }
      if (rr === 0 && refRows === 1) rr = 1;
      if (cc === 0 && refCols === 1) cc = 1;
      if (rr < 0 || cc < 0 || rr > refRows || cc > refCols) return err('#REF!');
      if (referenceOnly) {
        const ref = { ...t.ref, sheet: t.ref.sheet || ctx.currentSheet,
          r1: rr === 0 ? t.ref.r1 : t.ref.r1 + rr - 1,
          r2: rr === 0 ? t.ref.r2 : t.ref.r1 + rr - 1,
          c1: cc === 0 ? t.ref.c1 : t.ref.c1 + cc - 1,
          c2: cc === 0 ? t.ref.c2 : t.ref.c1 + cc - 1,
          kind: rr && cc ? 'cell' : rr === 0 && t.ref.kind === 'cols' ? 'cols' : cc === 0 && t.ref.kind === 'rows' ? 'rows' : 'range',
        };
        let values;
        return { range: true, ref, get values() { return values ??= ref.kind === 'cell'
          ? [[ctx.getValue(ref.sheet, ref.r1, ref.c1)]] : ctx.getRangeValues(ref); } };
      }
      if (rr === 0 || cc === 0) {
        const r1 = rr === 0 ? 0 : rr - 1;
        const r2 = rr === 0 ? rows : rr;
        const c1 = cc === 0 ? 0 : cc - 1;
        const c2 = cc === 0 ? cols : cc;
        const values = t.values.slice(r1, r2).map((row) => row.slice(c1, c2));
        if (!t.ref) return { range: true, values };
        // Keep the selected source address for ROW/COLUMN and @ intersection. An axis left at 0 keeps the
        // reference's own extent, a whole column staying one, so ROWS(INDEX(A:A,0,1)) is the column's rows
        // and ROWS(INDEX(A1:B5000,0,1)) is 5000, not how far past the data the values were read.
        const ref = {
          ...t.ref,
          kind: rr === 0 && t.ref.kind === 'cols' ? 'cols' : cc === 0 && t.ref.kind === 'rows' ? 'rows' : 'range',
          r1: rr === 0 ? t.ref.r1 : t.ref.r1 + rr - 1,
          r2: rr === 0 ? t.ref.r2 : t.ref.r1 + rr - 1,
          c1: cc === 0 ? t.ref.c1 : t.ref.c1 + cc - 1,
          c2: cc === 0 ? t.ref.c2 : t.ref.c1 + cc - 1,
        };
        return { range: true, values, ref };
      }
      const value = t.values[rr - 1]?.[cc - 1] ?? null;
      if (!t.ref) return value;
      const r1 = t.ref.r1 + rr - 1, c1 = t.ref.c1 + cc - 1;
      return { range: true, values: [[value]], ref: { ...t.ref, kind: 'cell', r1, r2: r1, c1, c2: c1 } };
    }, [1, 2]),
  },
  // ROW(A1:A4) is the array {1;2;3;4}, the classic input to SUMPRODUCT and MOD tricks.
  // Its cap is SEQUENCE's, so the two functions answer the same span the same way.
  ROW: {
    localeContext: false,
    callerContext: args => args.length ? [] : ['row'],
    fn: ([a], ctx) => {
      if (a === undefined) {
        const array = ctx.fixedArray;
        if (!array || array.rows === 1) return ctx.cell.r + 1;
        if (array.rows > 100000) return err('#NUM!');
        return { range: true, values: Array.from({ length: array.rows }, (_, i) => [array.r + i + 1]) };
      }
      if (!isRange(a) || !a.ref) return err('#VALUE!');
      const { r1, r2 } = a.ref;
      // A whole column keeps answering with its first row, since an address check must never
      // allocate a million-row array; a written-out span past the cap is #NUM!, as SEQUENCE
      // answers past its own, rather than the first row again, which reads as a real answer.
      if (r2 === r1 || a.ref.kind === 'cols') return r1 + 1;
      if (r2 - r1 + 1 > 100000) return err('#NUM!'); // SEQUENCE's cap, so both refuse the same span
      return { range: true, values: Array.from({ length: r2 - r1 + 1 }, (_, i) => [r1 + i + 1]) };
    },
    refArgs: true,
    array: true,
  },
  COLUMN: {
    localeContext: false,
    callerContext: args => args.length ? [] : ['col'],
    fn: ([a], ctx) => {
      if (a === undefined) {
        const array = ctx.fixedArray;
        if (!array || array.cols === 1) return ctx.cell.c + 1;
        return { range: true, values: [Array.from({ length: array.cols }, (_, i) => array.c + i + 1)] };
      }
      if (!isRange(a) || !a.ref) return err('#VALUE!');
      const { c1, c2 } = a.ref;
      if (c2 === c1 || a.ref.kind === 'rows') return c1 + 1; // a whole row, as ROW answers for a whole column
      if (c2 - c1 + 1 > 100000) return err('#NUM!');
      return { range: true, values: [Array.from({ length: c2 - c1 + 1 }, (_, i) => c1 + i + 1)] };
    },
    refArgs: true,
    array: true,
  },
  // SINGLE(range) is how workbook files save the @ operator: implicit intersection,
  // the one value of a row or column range on the formula's own row or column.
  SINGLE: {
    localeContext: false,
    callerContext: ['row', 'col'],
    fn: ([a], ctx) => {
      if (!isRange(a)) return a ?? null;
      const rows = a.values.length, cols = a.values[0]?.length || 0;
      if (rows === 1 && cols === 1) return a.values[0][0];
      // An array with no address ({1,2,3}) yields its first value.
      if (!a.ref) return a.values[0]?.[0] ?? null;
      if (!ctx.cell) return err('#VALUE!');
      if (cols === 1) {
        const i = ctx.cell.r - a.ref.r1;
        return i >= 0 && i < rows ? a.values[i][0] : err('#VALUE!');
      }
      if (rows === 1) {
        const j = ctx.cell.c - a.ref.c1;
        return j >= 0 && j < cols ? a.values[0][j] : err('#VALUE!');
      }
      return err('#VALUE!');
    },
    refArgs: true,
    minArgs: 1,
    maxArgs: 1,
  },
  // A union counts its first area, as INDEX reads one without area_num, rather than the areas stacked into one column.
  ROWS: {
    localeContext: false,
    fn: ([a]) => { const r = asRange(a); const area = r.areas ? r.areas[0] : r; return area.ref ? area.ref.r2 - area.ref.r1 + 1 : area.values.length; },
    refArgs: true,
  },
  COLUMNS: {
    localeContext: false,
    fn: ([a]) => { const r = asRange(a); const area = r.areas ? r.areas[0] : r; return area.ref ? area.ref.c2 - area.ref.c1 + 1 : area.values[0]?.length || 0; },
    refArgs: true,
  },
  ADDRESS: {
    callerContext: args => !args[3] || args[3].type === 'bool' && args[3].value || !args[2] || args[2].type === 'num' && args[2].value === 1 ? [] : ['row', 'col'],
    fn: ([r, c, absNum, a1, sheetText], ctx) => {
      const rr = toNumber(r); if (isError(rr)) return rr;
      const cc = toNumber(c); if (isError(cc)) return cc;
      const mode = absNum === undefined ? 1 : toNumber(absNum); if (isError(mode)) return mode;
      const abs = Math.trunc(mode);
      if (abs < 1 || abs > 4) return err('#VALUE!');
      const useA1 = a1 === undefined ? true : toBool(a1); if (isError(useA1)) return useA1;
      const sheet = sheetText === undefined ? '' : toText(sheetText); if (isError(sheet)) return sheet;
      const row = Math.trunc(rr), col = Math.trunc(cc);
      const absR = abs === 1 || abs === 2, absC = abs === 1 || abs === 3;
      // Relative R1C1 coordinates are offsets from the formula's cell.
      const targetR = !useA1 && !absR ? ctx.cell.r + row : row - 1;
      const targetC = !useA1 && !absC ? ctx.cell.c + col : col - 1;
      if (targetR < 0 || targetR > MAX_ROW || targetC < 0 || targetC > MAX_COL) return err('#VALUE!');
      const address = useA1
        ? `${absC ? '$' : ''}${colName(col - 1)}${absR ? '$' : ''}${row}`
        : `R${absR ? row : row ? `[${row}]` : ''}C${absC ? col : col ? `[${col}]` : ''}`;
      // A name that would read as a cell reference (A1, R1C1, RC) is quoted, and an empty name keeps its separator.
      const readsAsRef = /^(?:[A-Za-z]{1,3}\d+|R(?:\d+|\[-?\d+\])?(?:C(?:\d+|\[-?\d+\])?)?|C(?:\d+|\[-?\d+\])?)$/i.test(sheet);
      const name = readsAsRef ? `'${sheet.replace(/'/g, "''")}'` : quoteSheet(sheet);
      return sheetText === undefined ? address : `${sheet ? name : ''}!${address}`;
    },
  },

  /* Date & time */
  TODAY: { fn: () => todaySerial(), volatile: true },
  NOW: { fn: () => nowSerial(), volatile: true },
  DATE: {
    fn: ([y, m, d]) => {
      const yy = toNumber(y); if (isError(yy)) return yy;
      const mm = toNumber(m); if (isError(mm)) return mm;
      const dd = toNumber(d); if (isError(dd)) return dd;
      if (yy < 0) return err('#NUM!'); // a year below 0 is #NUM!, before 1900 is added to one under it
      const year = yy < 1900 ? yy + 1900 : yy;
      // A month normalized before January 1900 is rejected even if a
      // positive day overflow would bring the final serial back into range.
      if (ymdToSerial(Math.trunc(year), Math.trunc(mm), 1) < 1) return err('#NUM!');
      return inCalendar(ymdToSerial(Math.trunc(year), Math.trunc(mm), Math.trunc(dd)));
    },
  },
  YEAR: { fn: ([a]) => { const p = dateClock(a); return isError(p) ? p : serialToYMD(p.day).y; } },
  MONTH: { fn: ([a]) => { const p = dateClock(a); return isError(p) ? p : serialToYMD(p.day).m; } },
  DAY: { fn: ([a]) => { const p = dateClock(a); return isError(p) ? p : serialToYMD(p.day).d; } },
  WEEKDAY: {
    fn: ([a, type]) => {
      const p = dateClock(a); if (isError(p)) return p;
      const raw = type === undefined ? 1 : toNumber(type); if (isError(raw)) return raw;
      const t = Math.trunc(raw);
      const wd = serialToYMD(p.day).weekday; // 0 = Sunday
      if (t === 1) return wd + 1;
      if (t === 2) return ((wd + 6) % 7) + 1;
      if (t === 3) return (wd + 6) % 7;
      // 11 to 17: the week starts on Monday through Sunday and days count from 1.
      if (t >= 11 && t <= 17) { const first = t === 17 ? 0 : t - 10; return ((wd - first + 7) % 7) + 1; }
      return err('#NUM!');
    },
  },
  DAYS: {
    fn: ([end, start]) => {
      const e = dateSerial(end); if (isError(e)) return e;
      const s = dateSerial(start); if (isError(s)) return s;
      return Math.trunc(e) - Math.trunc(s);
    },
  },
  EDATE: {
    fn: ([a, months]) => {
      const n = dateSerial(a); if (isError(n)) return n;
      const k = toNumber(months); if (isError(k)) return k;
      const { y, m, d } = serialToYMD(n);
      const target = new Date(Date.UTC(y, m - 1 + Math.trunc(k), 1));
      if (target.getUTCFullYear() < 1900) return err('#NUM!');
      const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
      return inCalendar(ymdToSerial(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(d, last)));
    },
  },
  EOMONTH: {
    fn: ([a, months]) => {
      const n = dateSerial(a); if (isError(n)) return n;
      const k = toNumber(months); if (isError(k)) return k;
      const { y, m } = serialToYMD(n);
      // EOMONTH (like EDATE) uses Gregorian month lengths, including 28
      // days in February 1900, although DATE permits the fictitious 29th.
      const target = new Date(Date.UTC(y, m + Math.trunc(k), 0));
      if (target.getUTCFullYear() < 1900) return err('#NUM!');
      return inCalendar(ymdToSerial(target.getUTCFullYear(), target.getUTCMonth() + 1, target.getUTCDate()));
    },
  },
  // The time of day of a serial inside the calendar; a negative serial or one past 9999 is #NUM!.
  HOUR: { fn: ([a]) => { const p = dateClock(a); return isError(p) ? p : Math.floor(p.seconds / 3600); } },
  MINUTE: { fn: ([a]) => { const p = dateClock(a); return isError(p) ? p : Math.floor(p.seconds / 60) % 60; } },
  SECOND: { fn: ([a]) => { const p = dateClock(a); return isError(p) ? p : p.seconds % 60; } },
  TIME: {
    fn: ([h, m, s]) => {
      const hh = toNumber(h); if (isError(hh)) return hh;
      const mm = toNumber(m); if (isError(mm)) return mm;
      const ss = toNumber(s); if (isError(ss)) return ss;
      // Parts are whole numbers (1.5 hours is 1 hour) and none may pass 32767; a negative total is no time of day.
      if (hh > 32767 || mm > 32767 || ss > 32767) return err('#NUM!');
      const total = Math.trunc(hh) * 3600 + Math.trunc(mm) * 60 + Math.trunc(ss);
      if (total < 0) return err('#NUM!');
      return (total % 86400) / 86400;
    },
  },

  /* More statistics */
  AVERAGEIFS: {
    refArgs: true, // an error inside a one-cell range is data, not a failed argument
    fn: overCriteria(([avgRange, ...pairs]) => {
      const ar = asRange(avgRange);
      const ok = multiCriteria(pairs, ar);
      if (isError(ok)) return ok;
      let total = 0;
      let n = 0;
      const { cells, cols, count } = candidates(ok, ar);
      for (let k = 0; k < count; k++) {
        const p = cells ? cells[k] : k;
        const r = Math.floor(p / cols);
        const c = p - r * cols;
        const v = ar.values[r]?.[c];
        if (typeof v === 'number') { if (ok(r, c)) { total += v; n++; } }
        else if (isError(v) && ok(r, c)) return v;
      }
      return n ? total / n : err('#DIV/0!');
    }, 2, true),
  },
  // An array where one value is expected, k or x, answers one value per element:
  // SUM(LARGE(A1:A9,{1,2,3})) adds the top three, RANK(A1:A9,A1:A9) ranks the whole column and
  // PERCENTILE(A1:A9,{0.25,0.5,0.75}) spills the quartiles; the range is sorted once for all of them.
  LARGE: {
    liftArgs: [1],
    fn: overArguments(([range, k]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const n = toNumber(k); if (isError(n)) return n;
      const i = Math.trunc(n);
      if (i < 1 || i > s.length) return err('#NUM!');
      return s[s.length - i];
    }, [1]),
  },
  SMALL: {
    liftArgs: [1],
    fn: overArguments(([range, k]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const n = toNumber(k); if (isError(n)) return n;
      const i = Math.trunc(n);
      if (i < 1 || i > s.length) return err('#NUM!');
      return s[i - 1];
    }, [1]),
  },
  RANK: {
    liftArgs: [0],
    fn: overArguments(([value, range, order]) => {
      const x = toNumber(value); if (isError(x)) return x;
      const s = sortedNumbers(range); if (isError(s)) return s;
      // order is a number: any non-zero value, including the text "1", ranks ascending.
      const ord = order === undefined ? 0 : toNumber(order); if (isError(ord)) return ord; const ascending = ord !== 0;
      // Numbers equal at 15 significant digits share a rank, as they are equal to the = operator.
      const [below, ties, above] = rankCounts(s, x);
      if (!ties) return err('#N/A');
      return 1 + (ascending ? below : above);
    }, [0]),
  },
  'RANK.EQ': { alias: 'RANK' },
  'RANK.AVG': {
    liftArgs: [0],
    fn: overArguments(([value, range, order]) => {
      const x = toNumber(value); if (isError(x)) return x;
      const s = sortedNumbers(range); if (isError(s)) return s;
      // order is a number: any non-zero value, including the text "1", ranks ascending.
      const ord = order === undefined ? 0 : toNumber(order); if (isError(ord)) return ord; const ascending = ord !== 0;
      const [below, ties, above] = rankCounts(s, x); // equal at 15 significant digits, as to the = operator
      if (!ties) return err('#N/A');
      return (ascending ? below : above) + (ties + 1) / 2;
    }, [0]),
  },
  PERCENTILE: {
    liftArgs: [1],
    fn: overArguments(([range, k]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const p = toNumber(k); if (isError(p)) return p;
      return percentile(s, p);
    }, [1]),
  },
  'PERCENTILE.INC': { alias: 'PERCENTILE' },
  QUARTILE: {
    liftArgs: [1],
    fn: overArguments(([range, q]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const k = toNumber(q); if (isError(k)) return k;
      const i = Math.trunc(k);
      // Below zero is refused before the fraction is dropped, so -0.5 is #NUM! rather than quart 0.
      if (k < 0 || i > 4) return err('#NUM!');
      return percentile(s, i / 4);
    }, [1]),
  },
  'QUARTILE.INC': { alias: 'QUARTILE' },
  PERCENTRANK: {
    liftArgs: [1],
    fn: overArguments(([range, x, sig]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const v = toNumber(x); if (isError(v)) return v;
      const digits = sig === undefined ? 3 : toNumber(sig); if (isError(digits)) return digits;
      if (!s.length || Math.trunc(digits) < 1) return err('#NUM!'); // fewer than one digit means nothing
      if (v < s[0] || v > s[s.length - 1]) return err('#N/A');
      if (s.length === 1) return 1;
      // Ties take the first position; values between two entries interpolate.
      const i = lowerBound(s, v);
      let rank = i / (s.length - 1);
      if (s[i] !== v) rank = ((i - 1) + (v - s[i - 1]) / (s[i] - s[i - 1])) / (s.length - 1);
      const f = 10 ** Math.trunc(digits);
      return Math.floor(rank * f + 1e-9) / f;
    }, [1]),
  },
  'PERCENTRANK.INC': { alias: 'PERCENTRANK' },
  MODE: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => {
      if (!l.length) return err('#N/A');
      // Of the values sharing the top count, the one that appears first, as MODE.MULT lists them: MODE(1,2,2,1) is 1.
      const counts = new Map();
      const order = [];
      let best = 1;
      for (const v of l) {
        if (!counts.has(v)) order.push(v);
        const n = (counts.get(v) || 0) + 1;
        counts.set(v, n);
        if (n > best) best = n;
      }
      if (best < 2) return err('#N/A');
      return order.find((v) => counts.get(v) === best);
    }),
  },
  'MODE.SNGL': { alias: 'MODE' },
  SUMSQ: { refArgs: true, fn: num((l) => l.reduce((a, x) => a + flushUnderflow(x * x), 0)) },
  COUNTUNIQUE: {
    fn: (args) => {
      const seen = new Set();
      for (const { v } of eachValue(args)) {
        if (v == null || v === '') continue;
        seen.add(isError(v) ? `e:${v.error}` : typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${v}`);
      }
      return seen.size;
    },
    tolerant: true,
  },
  GEOMEAN: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => {
      if (!l.length || l.some((x) => x <= 0)) return err('#NUM!');
      return Math.exp(l.reduce((a, x) => a + Math.log(x), 0) / l.length);
    }),
  },
  HARMEAN: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => {
      if (!l.length || l.some((x) => x <= 0)) return err('#NUM!');
      return l.length / l.reduce((a, x) => a + 1 / x, 0);
    }),
  },
  AVEDEV: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => {
      if (!l.length) return err('#NUM!');
      // Deviation functions retain overflow in the mean's ordinary sum.
      const m = l.reduce((a, x) => a + x, 0) / l.length;
      return l.reduce((a, x) => a + Math.abs(x - m), 0) / l.length;
    }),
  },
  'VAR.P': {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => descriptiveVariance(l, 0)),
  },
  VARP: { alias: 'VAR.P' },
  STDEVP: { alias: 'STDEV.P' },
  CORREL: { fn: ([a, b]) => pairStats(a, b, correlation) },
  PEARSON: { alias: 'CORREL' },
  RSQ: {
    fn: ([a, b]) => pairStats(a, b, (s) => {
      const r = correlation(s, 1);
      return isError(r) ? r : flushUnderflow(r * r);
    }),
  },
  SLOPE: { fn: ([ys, xs]) => pairStats(xs, ys, (s) => (s.sxx ? flushUnderflow(s.sxy / s.sxx) : err('#DIV/0!'))) },
  INTERCEPT: {
    fn: ([ys, xs]) => pairStats(xs, ys, (s) => {
      if (!s.sxx) return err('#DIV/0!');
      const slope = flushUnderflow(s.sxy / s.sxx);
      return s.my - flushUnderflow(slope * s.mx);
    }),
  },
  FORECAST: {
    fn: ([x, ys, xs]) => {
      const at = toNumber(x); if (isError(at)) return at;
      return pairStats(xs, ys, (s) => {
        if (!s.sxx) return err('#DIV/0!');
        const slope = flushUnderflow(s.sxy / s.sxx);
        return s.my + flushUnderflow(slope * (at - s.mx));
      });
    },
  },
  'FORECAST.LINEAR': { alias: 'FORECAST' },
  'FORECAST.ETS': { fn: ([target, values, timeline, seasonality, completion, aggregation]) => etsEach(target, etsModel(values, timeline, seasonality, completion, aggregation), forecastAt) },
  'FORECAST.ETS.CONFINT': {
    fn: ([target, values, timeline, level, seasonality, completion, aggregation]) => {
      const p = etsOption(level, 0.95); if (isError(p)) return p;
      return etsEach(target, etsModel(values, timeline, seasonality, completion, aggregation), (model, t) => confidenceAt(model, t, p, normInv));
    },
  },
  'FORECAST.ETS.SEASONALITY': {
    fn: ([values, timeline, completion, aggregation]) => {
      const model = etsModel(values, timeline, 1, completion, aggregation);
      return isError(model) ? model : model.m;
    },
  },
  'FORECAST.ETS.STAT': {
    fn: ([values, timeline, type, seasonality, completion, aggregation]) => {
      const t = etsOption(type, undefined); if (isError(t)) return t;
      if (!Number.isInteger(t) || t < 1 || t > 8) return err('#NUM!');
      const model = etsModel(values, timeline, seasonality, completion, aggregation);
      return isError(model) ? model : statistic(model, t);
    },
  },
  'COVARIANCE.P': { fn: ([a, b]) => pairStats(a, b, (s) => flushUnderflow(s.sxy / s.n)) },
  'COVARIANCE.S': { fn: ([a, b]) => pairStats(a, b, (s) => (s.n > 1 ? flushUnderflow(s.sxy / (s.n - 1)) : err('#DIV/0!'))) },
  COVAR: { alias: 'COVARIANCE.P' },

  /* More math */
  MROUND: {
    fn: ([a, m]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const step = toNumber(m); if (isError(step)) return step;
      if (step === 0) return 0;
      if (n * step < 0) return err('#NUM!'); // opposite signs; zero rounds to any multiple
      if (n === 0) return 0;
      // Signs agree, so the quotient is positive and Math.round is half away from zero.
      return toStep(n, step, Math.round);
    },
  },
  QUOTIENT: {
    fn: ([a, b]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const d = toNumber(b); if (isError(d)) return d;
      if (d === 0) return err('#DIV/0!');
      return Math.trunc(sig15(n / d)); // the integer part of the division as TRUNC(n/d) gives it: QUOTIENT(0.3,0.1) is 3
    },
  },
  // An integer of 2^53 or more is no longer exact in a double, so GCD refuses such an argument and
  // LCM such a result with #NUM!, rather than answering a rounded neighbour.
  GCD: {
    fn: num((l) => {
      if (l.some((x) => x < 0 || !Number.isFinite(x))) return err('#NUM!');
      const ints = l.map((x) => Math.trunc(x));
      if (ints.some((x) => x >= 2 ** 53)) return err('#NUM!');
      return ints.reduce((a, b) => gcd(a, b), 0);
    }),
  },
  LCM: {
    fn: num((l) => {
      if (l.some((x) => x < 0 || !Number.isFinite(x))) return err('#NUM!');
      const ints = l.map((x) => Math.trunc(x));
      if (ints.includes(0)) return 0;
      let out = 1;
      for (const b of ints) {
        // out / gcd is a whole number, so exact; the product is exact below 2^53 and, rounded or not, no less than 2^53 above it.
        out = (out / gcd(out, b)) * b;
        if (out >= 2 ** 53) return err('#NUM!');
      }
      return out;
    }),
  },
  FACT: {
    fn: ([a]) => {
      const n = toNumber(a); if (isError(n)) return n;
      if (n < 0) return err('#NUM!'); // before truncation: -0.5 is not the factorial of 0
      const k = Math.trunc(n);
      if (k > 170) return err('#NUM!');
      let out = 1;
      for (let i = 2; i <= k; i++) out *= i;
      return out;
    },
  },
  COMBIN: {
    fn: ([a, b]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const k = toNumber(b); if (isError(k)) return k;
      const N = Math.trunc(n);
      const K = Math.trunc(k);
      if (N < 0 || K < 0 || K > N) return err('#NUM!');
      return choose(N, K);
    },
  },
  PERMUT: {
    fn: ([a, b]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const k = toNumber(b); if (isError(k)) return k;
      const N = Math.trunc(n);
      const K = Math.trunc(k);
      if (N < 0 || K < 0 || K > N) return err('#NUM!');
      let out = 1;
      // The product overflows after at most 170 steps and stays overflowed, so it stops
      // there rather than counting out a quadrillion permutations to the same #NUM!.
      for (let i = 0; i < K && Number.isFinite(out); i++) out *= N - i;
      return out;
    },
  },
  // Away from zero to the next even (odd) whole number, the number taken at 15 significant
  // digits as the other stepping functions take it: EVEN(2.000000000001) is 4, EVEN(0.3/0.1*20) is 60.
  EVEN: {
    fn: ([a]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const k = Math.ceil(sig15(Math.abs(n)));
      return Math.sign(n || 1) * (k % 2 ? k + 1 : k);
    },
  },
  ODD: {
    fn: ([a]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const k = Math.ceil(sig15(Math.abs(n)));
      return Math.sign(n || 1) * (k % 2 ? k : k + 1);
    },
  },
  SIN: { fn: unaryMath(Math.sin) },
  COS: { fn: unaryMath(Math.cos) },
  TAN: { fn: unaryMath(Math.tan) },
  ASIN: { fn: unaryMath((x) => (x < -1 || x > 1 ? NaN : Math.asin(x))) },
  ACOS: { fn: unaryMath((x) => (x < -1 || x > 1 ? NaN : Math.acos(x))) },
  ATAN: { fn: unaryMath(Math.atan) },
  ATAN2: {
    fn: ([x, y]) => {
      const a = toNumber(x); if (isError(a)) return a;
      const b = toNumber(y); if (isError(b)) return b;
      if (a === 0 && b === 0) return err('#DIV/0!');
      return Math.atan2(b, a);
    },
  },
  SINH: { fn: unaryMath(Math.sinh) },
  COSH: { fn: unaryMath(Math.cosh) },
  TANH: { fn: unaryMath(Math.tanh) },
  DEGREES: { fn: unaryMath((x) => (x * 180) / Math.PI) },
  RADIANS: { fn: unaryMath((x) => (x * Math.PI) / 180) },
  SUBTOTAL: {
    fn: ([code, ...refs], ctx) => {
      // OFFSET with an array of offsets denotes one reference per element.
      // SUBTOTAL must aggregate each reference, retaining its hidden-row and
      // nested-subtotal rules, rather than counting the collapsed array.
      const positions = refs.flatMap((ref, i) => ref?.referenceGrid ? [i + 1] : []);
      if (positions.length) return overArguments(FUNCTIONS.SUBTOTAL.fn, positions)([code,
        ...refs.map(ref => ref?.referenceGrid ? { range: true, values: ref.referenceGrid } : ref)], ctx);
      const k = toNumber(code); if (isError(k)) return k;
      const n = Math.trunc(k);
      const op = n > 100 ? n - 100 : n;
      if (op < 1 || op > 11) return err('#VALUE!');
      // Rows hidden by a filter are always skipped; 101-111 also skip rows hidden by hand.
      // Cells holding another SUBTOTAL (or AGGREGATE) are ignored too, so a grand total over
      // a range with subtotal rows inside does not double count.
      const clean = (rg) => {
        if (!isRange(rg) || !rg.ref) return rg;
        // Nested cells are found by their own row, so dropping rows above them does not shift the check.
        return { range: true, values: totalRows(rg, ctx, { skipNested: true, manual: n > 100 }), ref: rg.ref };
      };
      // A union lists its cells as one column: each area is cleaned by its own rows and the column rebuilt.
      const visible = refs.map((rg) => (isRange(rg) && rg.areas
        ? { range: true, values: rg.areas.flatMap((area) => clean(area).values.flatMap((row) => row.map((v) => [v ?? null]))) }
        : clean(rg)));
      const name = ['AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV', 'STDEV.P', 'SUM', 'VAR', 'VAR.P'][op - 1];
      return FUNCTIONS[name].fn(visible, ctx);
    },
    refArgs: true,
  },

  /* Engineering: error function and complex numbers */
  ERF: {
    fn: ([lower, upper]) => {
      const a = toNumber(lower); if (isError(a)) return a;
      if (upper === undefined) return checkNum(1 - erfcOf(a));
      const b = toNumber(upper); if (isError(b)) return b;
      return checkNum((1 - erfcOf(b)) - (1 - erfcOf(a)));
    },
  },
  'ERF.PRECISE': { fn: unaryMath((x) => 1 - erfcOf(x)) },
  ERFC: { fn: unaryMath((x) => erfcOf(x)) },
  'ERFC.PRECISE': { alias: 'ERFC' },
  COMPLEX: {
    fn: ([re, im, suffix]) => {
      const a = toNumber(re); if (isError(a)) return a;
      const b = toNumber(im); if (isError(b)) return b;
      const sfx = suffix === undefined ? 'i' : toText(suffix);
      if (isError(sfx)) return sfx;
      if (sfx !== 'i' && sfx !== 'j') return err('#VALUE!');
      return formatComplex(a, b, sfx, true);
    },
  },
  IMREAL: { fn: ([a]) => { const z = parseComplex(a); return isError(z) ? z : z.re; } },
  IMAGINARY: { fn: ([a]) => { const z = parseComplex(a); return isError(z) ? z : z.im; } },
  IMABS: { fn: ([a]) => { const z = parseComplex(a); return isError(z) ? z : Math.hypot(z.re, z.im); } },
  IMARGUMENT: { fn: ([a]) => { const z = parseComplex(a); return isError(z) ? z : z.re === 0 && z.im === 0 ? err('#DIV/0!') : Math.atan2(z.im, z.re); } },
  IMCONJUGATE: { fn: complexUnary((z) => ({ re: z.re, im: -z.im })) },
  IMSUM: {
    fn: (args) => {
      let acc = { re: 0, im: 0 };
      let suffix;
      for (const { v } of eachValue(args)) {
        if (v == null || v === '') continue;
        const z = parseComplex(v); if (isError(z)) return z;
        // The arguments must agree on i or j; a real number has neither and takes the other's.
        if (suffix && z.suffix && z.suffix !== suffix) return err('#VALUE!');
        suffix ??= z.suffix;
        acc = { re: acc.re + z.re, im: acc.im + z.im };
      }
      return formatComplex(acc.re, acc.im, suffix, true);
    },
  },
  IMSUB: {
    fn: ([a, b]) => {
      const x = parseComplex(a); if (isError(x)) return x;
      const y = parseComplex(b); if (isError(y)) return y;
      if (x.suffix && y.suffix && x.suffix !== y.suffix) return err('#VALUE!'); // i and j must agree, as for IMSUM
      return formatComplex(x.re - y.re, x.im - y.im, x.suffix ?? y.suffix, true);
    },
  },
  IMPRODUCT: {
    fn: (args) => {
      let acc = { re: 1, im: 0 };
      let suffix;
      for (const { v } of eachValue(args)) {
        if (v == null || v === '') continue;
        const z = parseComplex(v); if (isError(z)) return z;
        if (suffix && z.suffix && z.suffix !== suffix) return err('#VALUE!'); // i and j must agree, as for IMSUM
        suffix ??= z.suffix;
        acc = cMul(acc, z);
      }
      return formatComplex(acc.re, acc.im, suffix);
    },
  },
  IMDIV: {
    fn: ([a, b]) => {
      const x = parseComplex(a); if (isError(x)) return x;
      const y = parseComplex(b); if (isError(y)) return y;
      if (x.suffix && y.suffix && x.suffix !== y.suffix) return err('#VALUE!'); // i and j must agree, as for IMSUM
      const q = cDiv(x, y);
      return isError(q) ? q : formatComplex(q.re, q.im, x.suffix ?? y.suffix);
    },
  },
  IMPOWER: {
    fn: ([a, n]) => {
      const z = parseComplex(a); if (isError(z)) return z;
      const p = toNumber(n); if (isError(p)) return p;
      const out = cPow(z, p);
      return isError(out) ? out : formatComplex(out.re, out.im, z.suffix);
    },
  },
  IMSQRT: { fn: complexUnary((z) => cPow(z, 0.5)) },
  IMEXP: { fn: complexUnary(cExp) },
  IMLN: { fn: complexUnary(cLn) },
  IMLOG10: { fn: complexUnary((z) => { const l = cLn(z); return isError(l) ? l : { re: l.re / Math.LN10, im: l.im / Math.LN10 }; }) },
  IMLOG2: { fn: complexUnary((z) => { const l = cLn(z); return isError(l) ? l : { re: l.re / Math.LN2, im: l.im / Math.LN2 }; }) },
  IMSIN: { fn: complexUnary((z) => ({ re: Math.sin(z.re) * Math.cosh(z.im), im: Math.cos(z.re) * Math.sinh(z.im) })) },
  IMCOSH: { fn: complexUnary((z) => ({ re: Math.cosh(z.re) * Math.cos(z.im), im: Math.sinh(z.re) * Math.sin(z.im) })) },
  IMSINH: { fn: complexUnary((z) => ({ re: Math.sinh(z.re) * Math.cos(z.im), im: Math.cosh(z.re) * Math.sin(z.im) })) },
  IMSEC: { fn: complexUnary((z) => cDiv({ re: 1, im: 0 }, { re: Math.cos(z.re) * Math.cosh(z.im), im: -Math.sin(z.re) * Math.sinh(z.im) })) },
  IMCSC: { fn: complexUnary((z) => cDiv({ re: 1, im: 0 }, { re: Math.sin(z.re) * Math.cosh(z.im), im: Math.cos(z.re) * Math.sinh(z.im) })) },
  IMCOT: {
    fn: complexUnary((z) => {
      const sin = { re: Math.sin(z.re) * Math.cosh(z.im), im: Math.cos(z.re) * Math.sinh(z.im) };
      const cos = { re: Math.cos(z.re) * Math.cosh(z.im), im: -Math.sin(z.re) * Math.sinh(z.im) };
      return cDiv(cos, sin);
    }),
  },
  IMSECH: { fn: complexUnary((z) => cDiv({ re: 1, im: 0 }, { re: Math.cosh(z.re) * Math.cos(z.im), im: Math.sinh(z.re) * Math.sin(z.im) })) },
  IMCSCH: { fn: complexUnary((z) => cDiv({ re: 1, im: 0 }, { re: Math.sinh(z.re) * Math.cos(z.im), im: Math.cosh(z.re) * Math.sin(z.im) })) },
  BESSELJ: { fn: ([x, n]) => { const a = besselArgs(x, n, false); return isError(a) ? a : checkNum(besselJ(a.n, a.x)); } },
  BESSELY: { fn: ([x, n]) => { const a = besselArgs(x, n, true); return isError(a) ? a : checkNum(besselY(a.n, a.x)); } },
  BESSELI: { fn: ([x, n]) => { const a = besselArgs(x, n, false); return isError(a) ? a : checkNum(besselI(a.n, a.x)); } },
  BESSELK: { fn: ([x, n]) => { const a = besselArgs(x, n, true); return isError(a) ? a : checkNum(besselK(a.n, a.x)); } },
  IMCOS: { fn: complexUnary((z) => ({ re: Math.cos(z.re) * Math.cosh(z.im), im: -Math.sin(z.re) * Math.sinh(z.im) })) },
  IMTAN: {
    fn: complexUnary((z) => {
      const sin = { re: Math.sin(z.re) * Math.cosh(z.im), im: Math.cos(z.re) * Math.sinh(z.im) };
      const cos = { re: Math.cos(z.re) * Math.cosh(z.im), im: -Math.sin(z.re) * Math.sinh(z.im) };
      return cDiv(sin, cos);
    }),
  },

  /* More statistics */
  PROB: {
    fn: ([xs, probs, lower, upper]) => {
      const x = numbers([xs]); if (isError(x)) return x;
      const p = numbers([probs]); if (isError(p)) return p;
      if (x.length !== p.length || !x.length) return err('#N/A');
      if (p.some((v) => v < 0 || v > 1) || Math.abs(sum(p) - 1) > 1e-9) return err('#NUM!');
      const lo = toNumber(lower); if (isError(lo)) return lo;
      const hi = upper === undefined ? lo : toNumber(upper); if (isError(hi)) return hi;
      let total = 0;
      x.forEach((v, i) => { if (v >= lo && v <= hi) total += p[i]; });
      return total;
    },
  },
  'PERCENTRANK.EXC': {
    liftArgs: [1], // an array of x answers one rank per element, as PERCENTRANK does
    fn: overArguments(([range, x, sig]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const v = toNumber(x); if (isError(v)) return v;
      const digits = sig === undefined ? 3 : toNumber(sig); if (isError(digits)) return digits;
      if (!s.length || digits < 1) return err('#NUM!');
      const n = s.length;
      if (v < s[0] || v > s[n - 1]) return err('#N/A');
      const i = lowerBound(s, v);
      let rank = (i + 1) / (n + 1);
      if (s[i] !== v) rank = (i + (v - s[i - 1]) / (s[i] - s[i - 1])) / (n + 1);
      const f = 10 ** Math.trunc(digits);
      return Math.floor(rank * f + 1e-9) / f;
    }, [1]),
  },
  LOGINV: { alias: 'LOGNORM.INV' },
  MARGINOFERROR: {
    fn: ([range, confidence]) => {
      const list = numbers([range]); if (isError(list)) return list;
      const c = toNumber(confidence); if (isError(c)) return c;
      if (list.length < 2 || c <= 0 || c >= 1) return err('#NUM!');
      const z = normInv(1 - (1 - c) / 2);
      return z * sampleStdev(list) / Math.sqrt(list.length);
    },
  },
  COUNTUNIQUEIFS: {
    fn: ([range, ...pairs]) => {
      const rg = asRange(range);
      if (pairs.length < 2) return err('#VALUE!');
      const ok = multiCriteria(pairs, rg);
      if (isError(ok)) return ok;
      const seen = new Set();
      rg.values.forEach((row, r) => row.forEach((v, c) => {
        if (v == null || v === '' || !ok(r, c)) return;
        seen.add(isError(v) ? `e:${v.error}` : typeof v === 'string' ? `s:${v.toLowerCase()}` : `${typeof v}:${v}`);
      }));
      return seen.size;
    },
  },
  AREAS: { localeContext: false, fn: ([a]) => (isRange(a) ? (a.areas ? a.areas.length : 1) : err('#VALUE!')), refArgs: true },
  // Handled by the evaluator (it needs the parameter's name); listed here so it is a known function.
  ISOMITTED: { fn: () => err('#VALUE!'), lazy: true },

  /* Discount securities and Treasury bills */
  DISC: {
    fn: ([settlement, maturity, pr, redemption, basis]) => {
      const d = discountArgs(settlement, maturity, basis); if (isError(d)) return d;
      const price = toNumber(pr); if (isError(price)) return price;
      const red = toNumber(redemption); if (isError(red)) return red;
      if (price <= 0 || red <= 0) return err('#NUM!');
      return (red - price) / red / d.yf;
    },
  },
  INTRATE: {
    fn: ([settlement, maturity, investment, redemption, basis]) => {
      const d = discountArgs(settlement, maturity, basis); if (isError(d)) return d;
      const inv = toNumber(investment); if (isError(inv)) return inv;
      const red = toNumber(redemption); if (isError(red)) return red;
      if (inv <= 0 || red <= 0) return err('#NUM!');
      return (red - inv) / inv / d.yf;
    },
  },
  RECEIVED: {
    fn: ([settlement, maturity, investment, discount, basis]) => {
      const d = discountArgs(settlement, maturity, basis); if (isError(d)) return d;
      const inv = toNumber(investment); if (isError(inv)) return inv;
      const rate = toNumber(discount); if (isError(rate)) return rate;
      if (inv <= 0 || rate <= 0 || rate * d.yf >= 1) return err('#NUM!');
      return inv / (1 - rate * d.yf);
    },
  },
  PRICEDISC: {
    fn: ([settlement, maturity, discount, redemption, basis]) => {
      const d = discountArgs(settlement, maturity, basis); if (isError(d)) return d;
      const rate = toNumber(discount); if (isError(rate)) return rate;
      const red = toNumber(redemption); if (isError(red)) return red;
      if (rate <= 0 || red <= 0) return err('#NUM!');
      return red - rate * red * d.yf;
    },
  },
  YIELDDISC: {
    fn: ([settlement, maturity, pr, redemption, basis]) => {
      const d = discountArgs(settlement, maturity, basis); if (isError(d)) return d;
      const price = toNumber(pr); if (isError(price)) return price;
      const red = toNumber(redemption); if (isError(red)) return red;
      if (price <= 0 || red <= 0) return err('#NUM!');
      return (red - price) / price / d.yf;
    },
  },
  /* Bonds with periodic coupons, and coupon dates (the Analysis ToolPak functions). */
  COUPPCD: { fn: ([s, m, f, b]) => { const cp = couponArgs(s, m, f, b); return isError(cp) ? cp : cp.pcd; } },
  COUPNCD: { fn: ([s, m, f, b]) => { const cp = couponArgs(s, m, f, b); return isError(cp) ? cp : cp.ncd; } },
  COUPNUM: { fn: ([s, m, f, b]) => { const cp = couponArgs(s, m, f, b); return isError(cp) ? cp : cp.num; } },
  COUPDAYBS: { fn: ([s, m, f, b]) => { const cp = couponArgs(s, m, f, b); return isError(cp) ? cp : couponDays(cp).A; } },
  COUPDAYS: { fn: ([s, m, f, b]) => { const cp = couponArgs(s, m, f, b); return isError(cp) ? cp : couponDays(cp).E; } },
  COUPDAYSNC: { fn: ([s, m, f, b]) => { const cp = couponArgs(s, m, f, b); return isError(cp) ? cp : couponDays(cp).DSC; } },
  PRICE: {
    fn: ([settlement, maturity, rate, yld, redemption, frequency, basis]) => {
      const cp = couponArgs(settlement, maturity, frequency, basis); if (isError(cp)) return cp;
      const nums = bondNumbers([[rate, false], [yld, false], [redemption, true]]); if (isError(nums)) return nums;
      return checkNum(bondPrice(cp, nums[0], nums[1], nums[2]));
    },
  },
  YIELD: {
    fn: ([settlement, maturity, rate, pr, redemption, frequency, basis]) => {
      const cp = couponArgs(settlement, maturity, frequency, basis); if (isError(cp)) return cp;
      const nums = bondNumbers([[rate, false], [pr, true], [redemption, true]]); if (isError(nums)) return nums;
      return checkNum(bondYield(cp, nums[0], nums[1], nums[2]));
    },
  },
  DURATION: {
    fn: ([settlement, maturity, coupon, yld, frequency, basis]) => {
      const cp = couponArgs(settlement, maturity, frequency, basis); if (isError(cp)) return cp;
      const nums = bondNumbers([[coupon, false], [yld, false]]); if (isError(nums)) return nums;
      return checkNum(bondDuration(cp, nums[0], nums[1]));
    },
  },
  MDURATION: {
    fn: ([settlement, maturity, coupon, yld, frequency, basis]) => {
      const cp = couponArgs(settlement, maturity, frequency, basis); if (isError(cp)) return cp;
      const nums = bondNumbers([[coupon, false], [yld, false]]); if (isError(nums)) return nums;
      const d = bondDuration(cp, nums[0], nums[1]); if (isError(d)) return d;
      return checkNum(d / (1 + nums[1] / cp.freq));
    },
  },
  ACCRINT: {
    fn: ([issue, firstInterest, settlement, rate, par, frequency, basis, calcMethod]) => {
      const i = toNumber(issue); if (isError(i)) return i;
      const fi = toNumber(firstInterest); if (isError(fi)) return fi;
      const s = toNumber(settlement); if (isError(s)) return s;
      const f = toNumber(frequency); if (isError(f)) return f;
      const nums = bondNumbers([[rate, true], [par === undefined ? 1000 : par, true]]); if (isError(nums)) return nums;
      const b = basis === undefined ? 0 : toNumber(basis); if (isError(b)) return b;
      const fromIssue = calcMethod === undefined ? true : toBool(calcMethod); if (isError(fromIssue)) return fromIssue;
      const freq = Math.trunc(f);
      if (![1, 2, 4].includes(freq) || Math.trunc(b) < 0 || Math.trunc(b) > 4 || i < 0 || fi < 0 || !(i < s)) return err('#NUM!');
      // calc_method FALSE counts from the first interest date once the settlement is past it; TRUE, the default, from the issue.
      const from = Math.trunc(!fromIssue && s > fi ? fi : i);
      const to = Math.trunc(s);
      if (Math.trunc(b) !== 1) {
        const yf = FUNCTIONS.YEARFRAC.fn([from, to, b]); if (isError(yf)) return yf;
        return checkNum(nums[1] * nums[0] * yf);
      }
      // Actual/actual: the sum, over the quasi-coupon periods laid out every 12/frequency months
      // from first_interest, the accrued days of each as a fraction of its own length, times
      // rate/frequency — the accrued term PRICE uses — rather than taking a fraction of a calendar
      // year, which disagreed with PRICE by the difference between the year and the period's length.
      const at = couponSchedule(Math.trunc(fi), freq);
      let k = 0;
      while (at(k) > from) k--;
      while (at(k + 1) <= from) k++;
      let periods = 0;
      for (; at(k) < to; k++) periods += (Math.min(to, at(k + 1)) - Math.max(from, at(k))) / (at(k + 1) - at(k));
      return checkNum(nums[1] * nums[0] / freq * periods);
    },
  },
  ACCRINTM: {
    fn: ([issue, settlement, rate, par, basis]) => {
      const i = toNumber(issue); if (isError(i)) return i;
      const s = toNumber(settlement); if (isError(s)) return s;
      const nums = bondNumbers([[rate, true], [par === undefined ? 1000 : par, true]]); if (isError(nums)) return nums;
      if (!(i < s)) return err('#NUM!');
      const yf = FUNCTIONS.YEARFRAC.fn([i, s, basis === undefined ? 0 : basis]); if (isError(yf)) return yf;
      return checkNum(nums[1] * nums[0] * yf);
    },
  },
  PRICEMAT: {
    fn: ([settlement, maturity, issue, rate, yld, basis]) => {
      const s = toNumber(settlement); if (isError(s)) return s;
      const m = toNumber(maturity); if (isError(m)) return m;
      const i = toNumber(issue); if (isError(i)) return i;
      const nums = bondNumbers([[rate, false], [yld, false]]); if (isError(nums)) return nums;
      if (!(s < m) || !(i < s)) return err('#NUM!');
      const b = basis === undefined ? 0 : basis;
      const im = FUNCTIONS.YEARFRAC.fn([i, m, b]); if (isError(im)) return im;
      const sm = FUNCTIONS.YEARFRAC.fn([s, m, b]); if (isError(sm)) return sm;
      const is = FUNCTIONS.YEARFRAC.fn([i, s, b]); if (isError(is)) return is;
      return checkNum((100 + im * nums[0] * 100) / (1 + sm * nums[1]) - is * nums[0] * 100);
    },
  },
  YIELDMAT: {
    fn: ([settlement, maturity, issue, rate, pr, basis]) => {
      const s = toNumber(settlement); if (isError(s)) return s;
      const m = toNumber(maturity); if (isError(m)) return m;
      const i = toNumber(issue); if (isError(i)) return i;
      const nums = bondNumbers([[rate, false], [pr, true]]); if (isError(nums)) return nums;
      if (!(s < m) || !(i < s)) return err('#NUM!');
      const b = basis === undefined ? 0 : basis;
      const im = FUNCTIONS.YEARFRAC.fn([i, m, b]); if (isError(im)) return im;
      const sm = FUNCTIONS.YEARFRAC.fn([s, m, b]); if (isError(sm)) return sm;
      const is = FUNCTIONS.YEARFRAC.fn([i, s, b]); if (isError(is)) return is;
      const base = nums[1] / 100 + is * nums[0];
      return checkNum(((1 + im * nums[0]) - base) / base / sm);
    },
  },
  TBILLEQ: {
    fn: ([settlement, maturity, discount]) => {
      const d = discountArgs(settlement, maturity, 2); if (isError(d)) return d;
      const rate = toNumber(discount); if (isError(rate)) return rate;
      if (rate <= 0 || d.days > 366) return err('#NUM!');
      return (365 * rate) / (360 - rate * d.days);
    },
  },
  TBILLPRICE: {
    fn: ([settlement, maturity, discount]) => {
      const d = discountArgs(settlement, maturity, 2); if (isError(d)) return d;
      const rate = toNumber(discount); if (isError(rate)) return rate;
      if (rate <= 0 || d.days > 366) return err('#NUM!');
      const price = 100 * (1 - (rate * d.days) / 360);
      return price <= 0 ? err('#NUM!') : price;
    },
  },
  TBILLYIELD: {
    fn: ([settlement, maturity, pr]) => {
      const d = discountArgs(settlement, maturity, 2); if (isError(d)) return d;
      const price = toNumber(pr); if (isError(price)) return price;
      if (price <= 0 || d.days > 366) return err('#NUM!');
      return ((100 - price) / price) * (360 / d.days);
    },
  },

  /* Conversions (as in Sheets) and byte-string aliases (as in Excel) */
  TO_TEXT: { fn: ([a]) => toText(a) },
  TO_PURE_NUMBER: { fn: ([a]) => { const v = scalar(a); return typeof v === 'number' || isError(v) ? v : toNumber(v); } },
  TO_DATE: { fn: ([a]) => toNumber(a) },
  TO_PERCENT: { fn: ([a]) => toNumber(a) },
  TO_DOLLARS: { fn: ([a]) => toNumber(a) },
  LEFTB: { alias: 'LEFT' },
  RIGHTB: { alias: 'RIGHT' },
  MIDB: { alias: 'MID' },
  LENB: { alias: 'LEN' },
  FINDB: { alias: 'FIND' },
  SEARCHB: { alias: 'SEARCH' },
  REPLACEB: { alias: 'REPLACE' },

  /* In-cell charts */
  SPARKLINE: {
    // SPARKLINE(data, [type], [color]) or, as in Sheets, SPARKLINE(data, options)
    // where options is a two-column range of names and values ("charttype", "line").
    fn: ([data, typeOrOptions, color]) => {
      const values = [];
      for (const { v } of eachValue([data])) values.push(typeof v === 'number' && Number.isFinite(v) ? v : null);
      let type = 'line';
      let hue = null;
      let negative = null;
      const setOption = (name, val) => {
        const key = String(name ?? '').toLowerCase().trim();
        if (key === 'charttype' || key === 'type') type = String(val ?? '').toLowerCase();
        else if (key === 'color' || key === 'color1') hue = String(val ?? '');
        else if (key === 'negcolor' || key === 'color2') negative = String(val ?? '');
      };
      if (isRange(typeOrOptions)) {
        for (const row of typeOrOptions.values) if (row.length >= 2) setOption(row[0], row[1]);
      } else if (typeOrOptions !== undefined) type = String(scalar(typeOrOptions) ?? '').toLowerCase();
      if (color !== undefined) hue = String(scalar(color) ?? '');
      if (!['line', 'column', 'bar', 'winloss'].includes(type)) return err('#VALUE!');
      if (!values.some((v) => v !== null)) return err('#N/A');
      return { sparkline: true, type, values: values.slice(0, 500), color: hue || null, negColor: negative || null };
    },
    tolerant: true,
  },

  /* Arrays: these return ranges, which spill into neighbouring cells. */
  ARRAYFORMULA: { fn: ([a]) => (a === undefined ? err('#N/A') : a), array: true },
  TRANSPOSE: {
    fn: ([a]) => {
      const v = asRange(a).values;
      const rows = v.length;
      const cols = v[0]?.length || 0;
      const out = [];
      for (let c = 0; c < cols; c++) { const row = []; for (let r = 0; r < rows; r++) row.push(v[r][c] ?? null); out.push(row); }
      return { range: true, values: out };
    },
    array: true,
  },
  SEQUENCE: {
    fn: ([rows, cols, start, step]) => {
      const r = toNumber(rows); if (isError(r)) return r;
      const c = cols === undefined ? 1 : toNumber(cols); if (isError(c)) return c;
      const s = start === undefined ? 1 : toNumber(start); if (isError(s)) return s;
      const d = step === undefined ? 1 : toNumber(step); if (isError(d)) return d;
      const R = Math.trunc(r);
      const C = Math.trunc(c);
      if (R < 1 || C < 1) return err('#CALC!'); // no rows or no columns is the empty array
      if (R * C > 100000) return err('#NUM!');
      const out = [];
      // Each value is start + k*step rather than a running sum, which drifts off the 15-digit value after hundreds of fractional steps.
      for (let i = 0; i < R; i++) { const row = []; for (let j = 0; j < C; j++) row.push(s + (i * C + j) * d); out.push(row); }
      return { range: true, values: out };
    },
    array: true,
  },
  /* Grouping and pivoting: a function passed by name or as a LAMBDA summarizes each group. */
  GROUPBY: {
    fn: ([rowFields, values, fn, fieldHeaders, totalDepth, sortOrder, filterArray]) => {
      if (!isLambda(fn)) return err('#VALUE!');
      const g = groupInputs(rowFields, values, fieldHeaders, filterArray); if (isError(g)) return g;
      const depth = totalDepth === undefined ? 1 : toNumber(totalDepth); if (isError(depth)) return depth;
      const order = sortOrder === undefined ? null : toNumber(sortOrder); if (isError(order)) return order;
      if (![0, 1, 2, -1, -2].includes(Math.trunc(depth))) return err('#VALUE!');
      const { keys, vals, nKeys, nVals, keyHeaders, valHeaders, showHeaders } = g;
      if (!keys.length) return err('#CALC!');
      const groups = groupRows(keys);
      const sorted = sortGroups(groups, order, nKeys, (grp, j) => summarize(fn, vals, grp.idx, j), nKeys + nVals); if (isError(sorted)) return sorted;
      const aggs = (idx) => { const row = []; for (let j = 0; j < nVals; j++) row.push(summarize(fn, vals, idx, j)); return row; };
      // These are intentionally empty labels, not references to empty cells.
      const blanks = (n) => Array.from({ length: n }, () => '');
      const labels = keys => keys.map(v => v ?? '');
      const out = [];
      const d = Math.trunc(depth);
      const subtotals = Math.abs(d) === 2 && nKeys > 1;
      const top = d < 0;
      const grandLabel = subtotals ? 'Grand Total' : 'Total';
      if (showHeaders) out.push([...keyHeaders, ...valHeaders]);
      if (top && d !== 0) out.push([grandLabel, ...blanks(nKeys - 1), ...aggs(keys.map((_, i) => i))]);
      let run = [];
      const flushRun = () => {
        if (!run.length) return;
        const idx = run.flatMap((grp) => grp.idx);
        // The key's text and Total; a blank key's subtotal reads Total, not a space and Total.
        const sub = [`${toText(run[0].keys[0])} Total`.trim(), ...blanks(nKeys - 1), ...aggs(idx)];
        const body = run.map((grp) => [...labels(grp.keys), ...aggs(grp.idx)]);
        if (top) out.push(sub, ...body); else out.push(...body, sub);
        run = [];
      };
      for (const grp of groups) {
        if (!subtotals) { out.push([...labels(grp.keys), ...aggs(grp.idx)]); continue; }
        if (run.length && valueKey(run[0].keys[0]) !== valueKey(grp.keys[0])) flushRun();
        run.push(grp);
      }
      flushRun();
      if (!top && d !== 0) out.push([grandLabel, ...blanks(nKeys - 1), ...aggs(keys.map((_, i) => i))]);
      return { range: true, values: out };
    },
    array: true,
  },
  PIVOTBY: {
    fn: ([rowFields, colFields, values, fn, fieldHeaders, rowTotalDepth, rowSortOrder, colTotalDepth, colSortOrder, filterArray]) => {
      if (!isLambda(fn)) return err('#VALUE!');
      const g = groupInputs(rowFields, values, fieldHeaders, filterArray, colFields); if (isError(g)) return g;
      const rowDepth = rowTotalDepth === undefined ? 1 : toNumber(rowTotalDepth); if (isError(rowDepth)) return rowDepth;
      const colDepth = colTotalDepth === undefined ? 1 : toNumber(colTotalDepth); if (isError(colDepth)) return colDepth;
      const rowOrder = rowSortOrder === undefined ? null : toNumber(rowSortOrder); if (isError(rowOrder)) return rowOrder;
      const colOrder = colSortOrder === undefined ? null : toNumber(colSortOrder); if (isError(colOrder)) return colOrder;
      // A depth names no totals, grand totals, or grand totals and subtotals, at the end or at the
      // top: any other number is #VALUE!, as GROUPBY answers for its own, rather than being read as
      // "some totals" whatever it says.
      if ([rowDepth, colDepth].some((d) => ![0, 1, 2, -1, -2].includes(Math.trunc(d)))) return err('#VALUE!');
      const { keys, cols, vals, nKeys, keyHeaders, showHeaders } = g;
      if (!keys.length) return err('#CALC!');
      const rowGroups = groupRows(keys);
      const colGroups = groupRows(cols);
      // Each row group's rows are put in a bucket per column group once, so a cell of the pivot,
      // and every comparison when sorting by one, reads its rows from the bucket rather than
      // filtering the row group through a set of the column's rows: that took 2.3 s for a pivot
      // of a thousand rows by twenty columns over 20000 source rows, and minutes for a wide one.
      const colAt = new Array(keys.length);
      colGroups.forEach((grp, j) => { grp.at = j; for (const i of grp.idx) colAt[i] = j; });
      for (const grp of rowGroups) {
        grp.cells = new Array(colGroups.length).fill(null);
        for (const i of grp.idx) (grp.cells[colAt[i]] ??= []).push(i);
      }
      const cell = (rowGrp, colGrp) => { const idx = rowGrp.cells[colGrp.at]; return idx ? summarize(fn, vals, idx, 0) : null; };
      const all = keys.map((_, i) => i);
      const rowTotals = Math.trunc(rowDepth) !== 0;
      const colTotals = Math.trunc(colDepth) !== 0;
      // The rows sort by one of the output's columns (the keys, a column group, the total when shown)
      // and the columns by one of its rows (the key, a row group, the total when shown).
      const rowSort = sortGroups(rowGroups, rowOrder, nKeys, (grp, j) => (j < colGroups.length ? cell(grp, colGroups[j]) : summarize(fn, vals, grp.idx, 0)), nKeys + colGroups.length + (colTotals ? 1 : 0));
      if (isError(rowSort)) return rowSort;
      const colSort = sortGroups(colGroups, colOrder, cols[0].length, (grp, j) => (j < rowGroups.length ? cell(rowGroups[j], grp) : summarize(fn, vals, grp.idx, 0)), 1 + rowGroups.length + (rowTotals ? 1 : 0));
      if (isError(colSort)) return colSort;
      const out = [];
      const header = [...(showHeaders ? keyHeaders.map(v => v ?? '') : Array.from({ length: nKeys }, () => '')), ...colGroups.map((grp) => grp.keys[0] ?? '')];
      if (colTotals) header.push('Total');
      out.push(header);
      // A line of the pivot: one row group's cells, or, for no group, the totals of every column.
      const line = (label, rowGrp) => {
        const row = [...label.map(v => v ?? ''), ...colGroups.map((grp) => (rowGrp ? cell(rowGrp, grp) ?? '' : summarize(fn, vals, grp.idx, 0)))];
        if (colTotals) row.push(summarize(fn, vals, rowGrp ? rowGrp.idx : all, 0));
        return row;
      };
      const totalRow = () => line(['Total', ...Array.from({ length: nKeys - 1 }, () => '')], null);
      if (rowTotals && Math.trunc(rowDepth) < 0) out.push(totalRow());
      for (const grp of rowGroups) out.push(line(grp.keys, grp));
      if (rowTotals && Math.trunc(rowDepth) > 0) out.push(totalRow());
      return { range: true, values: out };
    },
    array: true,
  },
  PERCENTOF: {
    fn: ([subset, all]) => {
      const part = numbers([subset]); if (isError(part)) return part;
      const whole = numbers([all]); if (isError(whole)) return whole;
      const total = sum(whole);
      return total === 0 ? err('#DIV/0!') : sum(part) / total;
    },
  },
  TRIMRANGE: {
    fn: ([array, trimRows, trimCols]) => {
      const v = asRange(array).values;
      const tr = trimRows === undefined ? 3 : toNumber(trimRows); if (isError(tr)) return tr;
      const tc = trimCols === undefined ? 3 : toNumber(trimCols); if (isError(tc)) return tc;
      if (![0, 1, 2, 3].includes(Math.trunc(tr)) || ![0, 1, 2, 3].includes(Math.trunc(tc))) return err('#VALUE!');
      // Empty text is a value, including a formula returning "". Only truly
      // blank cells trim away; downstream COUNTA and wildcard counts need it.
      const blank = (x) => x == null;
      let r1 = 0;
      let r2 = v.length - 1;
      let c1 = 0;
      let c2 = (v[0]?.length || 0) - 1;
      const rowBlank = (r) => v[r].every(blank);
      const colBlank = (c) => v.every((row) => blank(row[c]));
      if (tr & 1) while (r1 <= r2 && rowBlank(r1)) r1++;
      if (tr & 2) while (r2 >= r1 && rowBlank(r2)) r2--;
      if (r1 > r2) return err('#CALC!');
      if (tc & 1) while (c1 <= c2 && colBlank(c1)) c1++;
      if (tc & 2) while (c2 >= c1 && colBlank(c2)) c2--;
      if (c1 > c2) return err('#CALC!');
      return { range: true, values: v.slice(r1, r2 + 1).map((row) => row.slice(c1, c2 + 1).map((x) => x ?? null)) };
    },
    array: true,
  },
  UNIQUE: {
    fn: ([a, byCol, once]) => {
      const cols = byCol === undefined ? false : toBool(byCol); if (isError(cols)) return cols;
      const exactlyOnce = once === undefined ? false : toBool(once); if (isError(exactlyOnce)) return exactlyOnce;
      let lines = asRange(a).values;
      if (cols) lines = FUNCTIONS.TRANSPOSE.fn([a]).values;
      const counts = new Map();
      const order = [];
      for (const line of lines) {
        const key = line.map(valueKey).join('');
        if (!counts.has(key)) { counts.set(key, 0); order.push({ key, line }); }
        counts.set(key, counts.get(key) + 1);
      }
      let kept = order.filter(({ key }) => !exactlyOnce || counts.get(key) === 1).map(({ line }) => line);
      // UNIQUE cannot return a zero-sized array, including exactly-once mode
      // when every row/column repeats. The answer is the empty-array error.
      if (!kept.length) return err('#CALC!');
      if (cols) kept = FUNCTIONS.TRANSPOSE.fn([{ range: true, values: kept }]).values;
      return { range: true, values: kept };
    },
    array: true,
  },
  FILTER: {
    fn: ([a, ...rest]) => {
      const aligned = alignWindows([asRange(a), ...rest.filter(isRange)]);
      const rg = aligned[0];
      let next = 1;
      rest = rest.map((arg) => (isRange(arg) ? aligned[next++] : arg));
      const rows = rg.values.length;
      const cols = rg.values[0]?.length || 0;
      const conds = [];
      let ifEmpty;
      const shape = (c) => ({ rows: c.values.length, cols: c.values[0]?.length || 0 });
      const tall = (s) => s.rows === rows && s.cols === 1 && rows > 1;
      const wide = (s) => s.rows === 1 && s.cols === cols && cols > 1;
      rest.forEach((arg, i) => {
        if (i < rest.length - 1 || !conds.length) { conds.push(isRange(arg) ? arg : { range: true, values: [[arg]] }); return; }
        // The last argument is another condition (Sheets) when it is shaped like the ones before it, a
        // column as tall as the data or a row as wide; anything else, an array constant included, is if_empty (Excel).
        if (isRange(arg)) {
          const s = shape(arg);
          const orientation = conds.some((c) => tall(shape(c))) ? 'rows' : conds.some((c) => wide(shape(c))) ? 'cols' : null;
          if (orientation === 'rows' ? tall(s) : orientation === 'cols' ? wide(s) : tall(s) || wide(s)) { conds.push(arg); return; }
        }
        ifEmpty = arg;
      });
      if (!conds.length) return err('#VALUE!');
      const byRows = conds.every((c) => { const s = shape(c); return (s.rows === rows && s.cols === 1) || (s.rows === 1 && s.cols === 1); });
      const byCols = !byRows && conds.every((c) => { const s = shape(c); return (s.rows === 1 && s.cols === cols) || (s.rows === 1 && s.cols === 1); });
      if (!byRows && !byCols) return err('#VALUE!');
      const pick = (c, i) => { const s = shape(c); const v = byRows ? c.values[s.rows === 1 ? 0 : i][0] : c.values[0][s.cols === 1 ? 0 : i]; return toBool(v); };
      const out = [];
      if (byRows) {
        for (let r = 0; r < rows; r++) {
          let keep = true;
          for (const c of conds) { const t = pick(c, r); if (isError(t)) return t; if (!t) { keep = false; break; } }
          if (keep) out.push(rg.values[r]);
        }
      } else {
        const keepCols = [];
        for (let c = 0; c < cols; c++) {
          let keep = true;
          for (const cond of conds) { const t = pick(cond, c); if (isError(t)) return t; if (!t) { keep = false; break; } }
          if (keep) keepCols.push(c);
        }
        if (keepCols.length) for (const row of rg.values) out.push(keepCols.map((c) => row[c]));
      }
      if (!out.length) return ifEmpty === undefined ? err('#CALC!') : ifEmpty;
      return { range: true, values: out };
    },
    array: true,
  },
  SORT: {
    fn: ([a, ...rest]) => {
      let rg = asRange(a);
      let lines = rg.values;
      // Excel's fourth argument (by_col) is a logical, as often written 1 or 0 as TRUE or FALSE; Sheets' fourth is
      // another sort column, which comes with its own order, so a call of exactly four arguments is Excel's form.
      let byCol = false;
      if (rest.length === 3) { byCol = toBool(scalar(rest[2])); if (isError(byCol)) return byCol; rest = rest.slice(0, 2); }
      if (byCol) lines = FUNCTIONS.TRANSPOSE.fn([a]).values;
      else {
        // Sheets' separate key column is read to its own sheet's used area, so one from another sheet
        // than the data arrives shorter although both name every row: they are padded to one window
        // first, as SORTBY pairs its keys, rather than the column being taken for a list of indices.
        const at = rest.map((arg, i) => (i % 2 === 0 && isRange(arg) ? i : -1)).filter((i) => i >= 0);
        const aligned = alignWindows([rg, ...at.map((i) => rest[i])], 'rows');
        [rg] = aligned;
        at.forEach((i, k) => { rest[i] = aligned[k + 1]; });
        lines = rg.values;
      }
      const width = lines[0]?.length || 0;
      const keys = [];
      // TRUE or 1 is ascending and FALSE or -1 descending; any other number is #VALUE!.
      const direction = (orderArg) => {
        if (orderArg === undefined) return true;
        const o = scalar(orderArg);
        if (typeof o === 'boolean') return o;
        const n = toNumber(o); if (isError(n)) return n;
        return n === 1 || n === -1 ? n === 1 : err('#VALUE!');
      };
      const byIndex = (idx, asc) => {
        const n = toNumber(idx); if (isError(n)) return n;
        const k = Math.trunc(n);
        if (k < 1 || k > width) return err('#VALUE!');
        keys.push({ get: (line) => line[k - 1], asc });
        return null;
      };
      if (!rest.length) keys.push({ get: (line) => line[0], asc: true });
      for (let i = 0; i < rest.length; i += 2) {
        const idxArg = rest[i];
        const orderArg = rest[i + 1];
        const idxList = isRange(idxArg) ? idxArg.values.flat() : null;
        const orderList = isRange(orderArg) ? orderArg.values.flat() : null;
        const keyColumn = isRange(idxArg) && idxArg.values.length === lines.length && !byCol;
        if (idxList && idxList.length > 1 && (orderList ? orderList.length === idxList.length : !keyColumn)) {
          // The array form: {1,2} with {1,-1} sorts by the first column, then by the second descending.
          for (let j = 0; j < idxList.length; j++) {
            const asc = direction(orderList ? orderList[j] : orderArg); if (isError(asc)) return asc;
            const bad = byIndex(idxList[j], asc); if (bad) return bad;
          }
          continue;
        }
        if (orderList && orderList.length > 1) return err('#VALUE!');
        const asc = direction(orderArg); if (isError(asc)) return asc;
        if (keyColumn) {
          // A separate column of keys, as Sheets allows.
          const col = idxArg.values.map((row) => row[0]);
          keys.push({ get: (line, li) => col[li], asc });
        } else {
          const bad = byIndex(idxArg === undefined ? 1 : idxArg, asc); if (bad) return bad;
        }
      }
      const empty = (v) => v == null || v === '';
      const indexed = lines.map((line, li) => ({ line, li }));
      indexed.sort((x, y) => {
        for (const key of keys) {
          const p = key.get(x.line, x.li);
          const q = key.get(y.line, y.li);
          if (empty(p) && empty(q)) continue;
          if (empty(p)) return 1;
          if (empty(q)) return -1;
          if (isError(p) && isError(q)) continue;
          if (isError(p)) return 1;
          if (isError(q)) return -1;
          const cmp = compareStoredValues(p, q);
          if (cmp) return key.asc ? cmp : -cmp;
        }
        return x.li - y.li;
      });
      let out = indexed.map((x) => x.line);
      if (byCol) out = FUNCTIONS.TRANSPOSE.fn([{ range: true, values: out }]).values;
      return { range: true, values: out };
    },
    array: true,
  },
  FLATTEN: {
    fn: (args) => {
      const out = [];
      for (const { v } of eachValue(args)) out.push([v ?? null]);
      return out.length ? { range: true, values: out } : err('#N/A');
    },
    array: true,
    tolerant: true,
  },
  CHOOSECOLS: {
    fn: ([a, ...idx]) => {
      const v = asRange(a).values;
      const width = v[0]?.length || 0;
      const picks = [];
      for (const i of idx) for (const { v: n } of eachValue([i])) {
        const k = toNumber(n); if (isError(k)) return k;
        const j = Math.trunc(k);
        const at = j < 0 ? width + j : j - 1;
        if (at < 0 || at >= width) return err('#VALUE!');
        picks.push(at);
      }
      return { range: true, values: v.map((row) => picks.map((c) => row[c] ?? null)) };
    },
    array: true,
  },
  CHOOSEROWS: {
    fn: ([a, ...idx]) => {
      const v = asRange(a).values;
      const out = [];
      for (const i of idx) for (const { v: n } of eachValue([i])) {
        const k = toNumber(n); if (isError(k)) return k;
        const j = Math.trunc(k);
        const at = j < 0 ? v.length + j : j - 1;
        if (at < 0 || at >= v.length) return err('#VALUE!');
        out.push(v[at]);
      }
      return { range: true, values: out };
    },
    array: true,
  },
  SPLIT: {
    fn: ([text, delim, byEach, removeEmpty]) => {
      const t = textArg(text); if (isError(t)) return t;
      const d = textArg(delim); if (isError(d)) return d;
      const each = byEach === undefined ? true : toBool(byEach); if (isError(each)) return each;
      const skip = removeEmpty === undefined ? true : toBool(removeEmpty); if (isError(skip)) return skip;
      let parts;
      if (d === '') parts = [t];
      // Match by character, so an emoji delimiter is one delimiter and not two surrogate halves.
      else if (each) { const re = new RegExp(`[${d.replace(/[\]\\^-]/g, '\\$&')}]`, 'u'); parts = t.split(re); }
      else parts = t.split(d);
      if (skip) parts = parts.filter((p) => p !== '');
      if (!parts.length) return err('#N/A');
      return { range: true, values: [parts.map(splitValue)] };
    },
    array: true,
  },
  TEXTSPLIT: {
    fn: ([text, colDelim, rowDelim, ignoreEmpty, matchMode, padWith]) => {
      const t = textArg(text); if (isError(t)) return t;
      const cd = delimiterList(colDelim); if (isError(cd)) return cd;
      const rd = delimiterList(rowDelim); if (isError(rd)) return rd;
      const skip = ignoreEmpty === undefined ? false : toBool(ignoreEmpty); if (isError(skip)) return skip;
      const mode = matchMode === undefined ? 0 : toNumber(matchMode); if (isError(mode)) return mode;
      if (mode !== 0 && mode !== 1) return err('#VALUE!');
      const pad = padWith === undefined ? err('#N/A') : scalar(padWith);
      // Any delimiter of an array constant cuts the text; an empty delimiter cuts nothing.
      const cut = (s, delims) => {
        const list = delims.filter((d) => d !== '');
        const pieces = !list.length ? [s] : list.length === 1 && mode === 0 ? s.split(list[0]) : s.split(delimiterPattern(list, mode === 1));
        return skip ? pieces.filter((p) => p !== '') : pieces;
      };
      // Every piece stays the text it was: "007" keeps its zeros and SUM(TEXTSPLIT(...)) is 0 until VALUE converts the pieces.
      const values = cut(t, rd).map((row) => cut(row, cd)).filter((row) => row.length);
      if (!values.length) return err('#CALC!');
      const width = values.reduce((max, row) => Math.max(max, row.length), 0);
      for (const row of values) while (row.length < width) row.push(pad);
      return { range: true, values };
    },
    array: true,
  },

  /* More lookup & reference */
  LOOKUP: {
    liftArgs: [0],
    fn: overArguments(([needle, lookup, result]) => {
      const l = asRange(lookup);
      const rows = l.values.length;
      const cols = l.values[0]?.length || 0;
      // A tall or square range searches its first column and answers from its last. The column is
      // read in place, as MATCH and VLOOKUP read theirs: copying it out cost more per call than the
      // search itself over a long table.
      const vertical = rows >= cols;
      const [vector, col] = vertical ? [l.values, 0] : [l.values[0] || [], -1];
      // The last value of the key's type not above it, passing over blanks, errors and values of
      // another type as the search does, so LOOKUP(2,1/(A1:A9<>""),A1:A9) reaches the last
      // filled cell past the #DIV/0! of the blank ones; a value above the key ends the search, as
      // in a sorted vector. An empty key matches nothing (it is not a zero).
      const key = scalar(needle);
      if (isError(key)) return key;
      const i = matchIndex(key, vector, 1, col);
      if (i < 0) return err('#N/A');
      if (result === undefined) return (vertical ? l.values[i][cols - 1] : l.values[rows - 1][i]) ?? null;
      const r = asRange(result);
      return (r.values.length >= (r.values[0]?.length || 0) ? r.values[i]?.[0] : r.values[0]?.[i]) ?? null;
    }, [0]),
  },
  INDIRECT: {
    callerContext: ['row', 'col', 'sheet'],
    fn: ([text, a1], ctx) => {
      const t = textArg(text); if (isError(t)) return t;
      const useA1 = a1 === undefined ? true : toBool(a1); if (isError(useA1)) return useA1;
      let ref = useA1 ? null : parseR1C1Ref(t, ctx.cell);
      try {
        if (!ref) {
          const tokens = tokenize(t.trim());
          if (useA1 && tokens.length === 1 && tokens[0].type === 'ref') {
            const token = tokens[0];
            ref = parseRefText(token.text, token.sheet, token.sheetEnd);
            if (ref && token.spill) ref = ref.kind === 'cell' ? { ...ref, spill: true } : null;
          } else if (tokens.length === 1 && tokens[0].type === 'name') {
            const token = tokens[0];
            if (token.sheet && ctx.indirectSheetExists && !ctx.indirectSheetExists(token.sheet)) return err('#REF!');
            const scope = token.sheet ? ctx.nameContext?.(token.sheet) : ctx;
            ref = scope?.getNamedRef?.(token.value);
            if (!ref) {
              const named = scope?.getNamedFormula?.(token.value);
              if (named) {
                const depth = (ctx.nameDepth || 0) + 1;
                if (depth > 64) return err('#REF!');
                const value = runtime.evaluate(named, namedReferenceContext(scope, depth));
                ref = isRange(value) ? value.ref : null;
              } else ref = (!token.sheet && ctx.resolveTableRef?.(token.value, '')) || null;
            }
          } else if (tokens.length === 1 && tokens[0].type === 'tref') {
            ref = ctx.resolveTableRef?.(tokens[0].table, tokens[0].spec) || null;
          }
        }
      } catch { ref = null; }
      if (!ref || isError(ref) || ref.sheetEnd) return err('#REF!');
      // A supporting-cell cache is not an open source workbook.
      // INDIRECT requires the latter, including through named references.
      // https://support.microsoft.com/en-us/excel/functions/indirect-function
      if (ref.sheet && !(ctx.indirectSheetExists || ctx.sheetExists)(ref.sheet)
        || !ref.sheet && ctx.currentSheet && ctx.indirectSheetExists && !ctx.indirectSheetExists(ctx.currentSheet)) return err('#REF!');
      if (ref.spill) {
        const range = ctx.getSpillRange?.(ref);
        if (!range) return err('#REF!');
        const single = range.r1 === range.r2 && range.c1 === range.c2;
        ref = { ...ref, ...range, spill: false, kind: single ? 'cell' : 'range' };
      }
      if (ctx.referenceMode) {
        ref = { ...ref, sheet: ref.sheet || ctx.currentSheet };
        let values;
        return { range: true, get values() {
          return values ??= ref.kind === 'cell'
            ? [[ctx.getValue(ref.sheet, ref.r1, ref.c1)]] : ctx.getRangeValues(ref);
        }, ref };
      }
      if (ref.kind === 'cell') return { range: true, values: [[ctx.getValue(ref.sheet, ref.r1, ref.c1)]], ref };
      return { range: true, values: ctx.getRangeValues(ref), ref };
    },
    array: true,
  },
  OFFSET: {
    liftArgs: [1, 2], // an array of row or column offsets answers with an array, OFFSET(A1,{1;2},0) being {A2;A3}
    fn: overArguments(([base, rows, cols, height, width], ctx) => {
      if (!isRange(base) || !base.ref) return err('#VALUE!');
      const dr = toNumber(rows); if (isError(dr)) return dr;
      const dc = toNumber(cols); if (isError(dc)) return dc;
      const h = height === undefined ? base.ref.r2 - base.ref.r1 + 1 : toNumber(height); if (isError(h)) return h;
      const w = width === undefined ? base.ref.c2 - base.ref.c1 + 1 : toNumber(width); if (isError(w)) return w;
      if (Math.trunc(h) < 1 || Math.trunc(w) < 1) return err('#REF!');
      const r1 = base.ref.r1 + Math.trunc(dr);
      const c1 = base.ref.c1 + Math.trunc(dc);
      if (r1 < 0 || c1 < 0) return err('#REF!');
      const ref = { sheet: base.ref.sheet, kind: 'range', r1, c1, r2: r1 + Math.trunc(h) - 1, c2: c1 + Math.trunc(w) - 1, absR1: false, absC1: false, absR2: false, absC2: false };
      if (ref.r2 > MAX_ROW || ref.c2 > MAX_COL) return err('#REF!');
      // Consumers such as ROW only need the resulting address. Defer reads
      // so finding a boundary cannot calculate a dependent source cell.
      let values;
      return { range: true, get values() {
        return values ??= ref.r1 === ref.r2 && ref.c1 === ref.c2
          ? [[ctx.getValue(ref.sheet, ref.r1, ref.c1)]] : ctx.getRangeValues(ref);
      }, ref };
    }, [1, 2], true),
    refArgs: true,
    array: true,
  },
  HYPERLINK: {
    fn: ([url, label]) => {
      const u = textArg(url); if (isError(u)) return u;
      if (label === undefined) return u;
      const v = scalar(label);
      return v == null ? u : v;
    },
  },
  SHEET: {
    callerContext: args => args.length ? ['order'] : ['index'],
    fn: ([name], ctx) => {
      if (name === undefined) return ctx.sheetIndex ? ctx.sheetIndex(ctx.currentSheet) : 1;
      if (isRange(name) && name.ref) {
        const i = ctx.sheetIndex ? ctx.sheetIndex(name.ref.sheet || ctx.currentSheet) : 1;
        return i > 0 ? i : err('#REF!');
      }
      const t = textArg(name); if (isError(t)) return t;
      const i = ctx.sheetIndex?.(t) ?? 0;
      return i > 0 ? i : err('#N/A');
    },
    refArgs: true,
  },
  SHEETS: {
    localeContext: false,
    callerContext: args => args.length ? [] : ['count'],
    fn: ([reference], ctx) => {
      if (reference === undefined) return ctx.sheetCount?.() ?? 1;
      if (!isRange(reference)) return err('#REF!');
      // Chartsheets have no cells in a 3D calculation, but SHEETS includes
      // every sheet type in the span (the documented SHEETS behavior).
      if (reference.sheetSpan) return reference.sheetSpan.length;
      const areas = reference.areas || [reference];
      if (!areas.length || areas.some((area) => !area.ref)) return err('#REF!');
      return new Set(areas.map((area) => (area.ref.sheet || ctx.currentSheet || '').toLowerCase())).size;
    },
    refArgs: true,
  },
  // Over a reference of several cells, one answer per cell, as the other IS functions give.
  ISFORMULA: {
    localeContext: false,
    fn: ([a], ctx) => (isRange(a) && a.ref ? overCells(a, (sheet, r, c) => ctx.getFormula?.(sheet, r, c) != null) : false),
    refArgs: true,
    tolerant: true,
    elementwise: true, // the answer takes the reference's shape, so a range argument may spill
  },
  FORMULATEXT: {
    localeContext: false,
    fn: ([a], ctx) => {
      if (!isRange(a) || !a.ref) return err('#N/A');
      return overCells(a, (sheet, r, c) => {
        const f = ctx.getFormula?.(sheet, r, c);
        return f == null ? err('#N/A') : ctx.isFixedArray?.(sheet, r, c) ? `{=${f}}` : `=${f}`;
      });
    },
    refArgs: true,
    tolerant: true,
    elementwise: true,
  },
  'ERROR.TYPE': {
    localeContext: false,
    fn: ([a]) => {
      const v = scalar(a);
      if (!isError(v)) return err('#N/A');
      const i = ERROR_CODES.indexOf(v.error);
      return i < 0 ? 8 : i + 1;
    },
    tolerant: true,
  },

  /* More text */
  REGEXMATCH: {
    fn: ([text, pattern]) => {
      const t = textArg(text); if (isError(t)) return t;
      const re = regex(pattern, '', t); if (isError(re)) return re;
      return re.test(t);
    },
  },
  REGEXTEST: {
    fn: ([text, pattern, caseSensitivity]) => {
      const t = textArg(text); if (isError(t)) return t;
      const mode = caseSensitivity === undefined ? 0 : toNumber(caseSensitivity); if (isError(mode)) return mode;
      if (mode !== 0 && mode !== 1) return err('#VALUE!');
      const re = regex(pattern, mode === 1 ? 'i' : '', t); if (isError(re)) return re;
      return re.test(t);
    },
  },
  REGEXEXTRACT: {
    fn: ([text, pattern]) => {
      const t = textArg(text); if (isError(t)) return t;
      const re = regex(pattern, '', t); if (isError(re)) return re;
      const m = re.exec(t);
      if (!m) return err('#N/A');
      // Several capture groups come back as a row, one as its text and none as the whole match, as in Sheets.
      if (m.length > 2) return { range: true, values: [m.slice(1).map((g) => g ?? '')] };
      return m.length > 1 ? (m[1] ?? '') : m[0];
    },
    array: true,
  },
  REGEXREPLACE: {
    fn: ([text, pattern, replacement]) => {
      const t = textArg(text); if (isError(t)) return t;
      const re = regex(pattern, 'g', t); if (isError(re)) return re;
      const r = textArg(replacement); if (isError(r)) return r;
      // Sheets' replacement syntax: $1 is a group and $0 the whole match; nothing else is special.
      const js = r.replace(/\$(\d+|&|`|'|<|\$)/g, (m, what) => (what === '0' ? '$&' : /^\d+$/.test(what) ? m : `$$${what}`));
      // Text longer than a cell holds is #VALUE!, as in REPT. The result is measured over the
      // matches first, so a huge one is refused rather than built: the group references count for
      // the text they stand in for, not for nothing, as a replacement of nothing but references
      // once let two ordinary cells build half a billion characters.
      const refs = [];
      const literal = js.replace(/\$(\$|&|\d+)/g, (m, what) => {
        if (what === '$') return '$';
        refs.push(what);
        return '';
      }).length;
      let length = t.length;
      for (const m of t.matchAll(re)) {
        length += literal - m[0].length;
        for (const ref of refs) {
          const group = ref === '&' ? m[0] : m[Number(ref)];
          // A reference to a group the pattern has not got stays as written, or reads as its first
          // digit's group with the rest of the digits literal; the longer of the two is counted.
          length += group !== undefined ? group.length : (m[Number(ref[0])]?.length ?? 1) + ref.length;
        }
        if (length > MAX_TEXT) return err('#VALUE!');
      }
      const out = t.replace(re, js);
      return out.length > MAX_TEXT ? err('#VALUE!') : out;
    },
  },
  JOIN: {
    fn: ([delim, ...rest]) => {
      const d = textArg(delim); if (isError(d)) return d;
      const parts = [];
      let length = -d.length;
      for (const { v } of eachValue(rest)) {
        if (isError(v)) return v;
        const t = toText(v); if (isError(t)) return t;
        length += d.length + t.length;
        if (length > MAX_TEXT) return err('#VALUE!'); // more than a cell holds, as for CONCAT and TEXTJOIN
        parts.push(t);
      }
      return parts.join(d);
    },
  },
  // A column of text answers with a column of pieces; the delimiter is lifted over by neither, an array there
  // naming alternatives.
  TEXTBEFORE: {
    liftArgs: [0],
    fn: overArguments((args) => textAround(args, true), [0]),
  },
  TEXTAFTER: {
    liftArgs: [0],
    fn: overArguments((args) => textAround(args, false), [0]),
  },
  NUMBERVALUE: {
    fn: ([text, dec, group]) => {
      const t = textArg(text); if (isError(t)) return t;
      if (t.length > MAX_NUMBER_TEXT) return err('#VALUE!');
      // With both separators left out, the text is read with the regional format's own:
      // "1,5" is one and a half under German, as it is to VALUE and a typed cell, and fifteen under English.
      const info = localeInfo();
      const decSep = dec === undefined ? info.decimal : textArg(dec); if (isError(decSep)) return decSep;
      // Only the first character of each separator counts, and the two must differ; a group
      // separator left out beside a given decimal separator is whichever of "," and "." that one is not.
      const dc = decSep[0];
      if (dc === undefined) return err('#VALUE!');
      const groupSep = group === undefined ? (dec === undefined ? info.group : dc === ',' ? '.' : ',') : textArg(group); if (isError(groupSep)) return groupSep;
      const gc = groupSep[0];
      if (gc !== undefined && gc === dc) return err('#VALUE!');
      let body = t.replace(/\s+/g, '');
      if (body === '') return 0;
      // A group separator after the decimal separator makes no number.
      const decAt = body.indexOf(dc);
      if (gc !== undefined && decAt >= 0 && body.indexOf(gc, decAt) >= 0) return err('#VALUE!');
      if (gc !== undefined) body = body.split(gc).join('');
      if (dc !== '.') body = body.split(dc).join('.');
      body = normalizeNumberDigits(body);
      const pct = /%+$/.exec(body);
      if (pct) body = body.slice(0, -pct[0].length);
      if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(body)) return err('#VALUE!');
      return parseDecimalText(body, -2 * (pct ? pct[0].length : 0), true) ?? err('#VALUE!');
    },
  },
  DOLLAR: {
    fn: ([a, d]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const k = d === undefined ? 2 : toNumber(d); if (isError(k)) return k;
      if (Math.abs(k) > 127) return err('#VALUE!'); // the documented limit
      const dec = Math.max(0, Math.trunc(k));
      const v = roundToDigits(n, Math.trunc(k));
      const text = fixedDecimals(Math.abs(v), dec, true);
      const { prefix, suffix } = formulaCurrencyAffixes();
      return `${v < 0 ? '(' : ''}${prefix}${text}${suffix}${v < 0 ? ')' : ''}`;
    },
  },
  FIXED: {
    fn: ([a, d, noCommas]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const k = d === undefined ? 2 : toNumber(d); if (isError(k)) return k;
      const plain = noCommas === undefined ? false : toBool(noCommas); if (isError(plain)) return plain;
      if (Math.abs(k) > 127) return err('#VALUE!');
      const dec = Math.max(0, Math.trunc(k));
      return fixedDecimals(roundToDigits(n, Math.trunc(k)), dec, !plain);
    },
  },
  UNICHAR: {
    fn: ([a]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const k = Math.trunc(n);
      if (k < 1 || k > 0x10ffff) return err('#VALUE!');
      if (k >= 0xd800 && k <= 0xdfff) return err('#N/A'); // a partial surrogate is no character: #N/A
      return String.fromCodePoint(k);
    },
  },
  UNICODE: { fn: ([a]) => {
    const t = textArg(a); if (isError(t)) return t;
    const point = t.codePointAt(0);
    // A high surrogate without its low half is rejected. A lone low half
    // returns its code unit (including when Version 1 MID produces it).
    return point === undefined || point >= 0xd800 && point <= 0xdbff ? err('#VALUE!') : point;
  } },
  T: { localeContext: false, fn: ([a]) => { const v = scalar(a); return typeof v === 'string' ? v : isError(v) ? v : ''; }, tolerant: true },

  /* More dates */
  DATEDIF: {
    fn: ([start, end, unit]) => {
      const s = dateSerial(start); if (isError(s)) return s;
      const e = dateSerial(end); if (isError(e)) return e;
      const u = textArg(unit); if (isError(u)) return u;
      if (Math.trunc(e) < Math.trunc(s)) return err('#NUM!'); // dates, not times: a later hour on the same day is not a later date
      const a = serialToYMD(s);
      const b = serialToYMD(e);
      let months = (b.y - a.y) * 12 + (b.m - a.m);
      if (b.d < a.d) months--;
      switch (u.toUpperCase()) {
        case 'D': return Math.trunc(e) - Math.trunc(s);
        case 'M': return months;
        case 'Y': return Math.floor(months / 12);
        case 'YM': return months % 12;
        case 'MD': {
          // Days past the most recent monthly anniversary of the start date.
          let y = b.y;
          let m = b.d < a.d ? b.m - 1 : b.m;
          if (m < 1) { m = 12; y--; }
          const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
          return Math.trunc(e) - ymdToSerial(y, m, Math.min(a.d, last));
        }
        case 'YD': {
          const years = Math.floor(months / 12);
          return Math.trunc(e) - ymdToSerial(a.y + years, a.m, a.d);
        }
        default: return err('#NUM!');
      }
    },
  },
  DATEVALUE: {
    fn: ([a]) => {
      const v = scalar(a);
      if (typeof v === 'number') return err('#VALUE!'); // text only: a serial is already a date
      const parsed = parseInput(toText(v));
      if (parsed.fmt === 'date' || parsed.fmt === 'datetime') return Math.floor(parsed.v);
      // A month and a year ("Feb 2024") is the first of the month, as VALUE and a typed cell read it: a custom
      // date code, where a fraction's or an elapsed time's code is none.
      if (parsed.fmt === 'custom' && codeDateKind(parsed.v, parsed.code) === 'date') return Math.floor(parsed.v);
      return err('#VALUE!');
    },
  },
  TIMEVALUE: {
    fn: ([a]) => {
      const v = scalar(a);
      if (typeof v === 'number') return err('#VALUE!'); // text only, as in DATEVALUE: a serial is already a time
      const t = normalizeNumberDigits(toText(v));
      // The time parser reads an hour with AM or PM and no minutes ("3 pm") too, so VALUE and a typed cell agree with TIMEVALUE.
      const time = parseTime(t);
      if (time != null) return time;
      // An elapsed time's hours wrap around the day ("25:00" is 1:00), reading up to 9999 hours.
      const elapsed = parseTime(t, { elapsed: true });
      if (elapsed != null) return elapsed % 1;
      const parsed = parseInput(t);
      if (parsed.fmt === 'datetime') {
        // The time of day is read from its own text: the fraction of the combined serial has lost digits to the date.
        const tail = /(\d{1,2}:\d{2}(?::\d{2})?\s*(?:[AaPp][Mm])?)$/.exec(t.trim());
        return (tail && parseTime(tail[1])) ?? parsed.v - Math.floor(parsed.v);
      }
      return err('#VALUE!');
    },
  },
  WEEKNUM: {
    fn: ([a, type]) => {
      const n = dateSerial(a); if (isError(n)) return n;
      const raw = type === undefined ? 1 : toNumber(type); if (isError(raw)) return raw;
      const t = Math.trunc(raw); // 1.5 is system 1
      if (t === 21) return isoWeek(n);
      // System 1: the week holding January 1 is week 1; weeks start on Sunday (1) or Monday (2).
      const startDow = t === 2 || t === 11 ? 1 : t === 1 || t === 17 ? 0 : t >= 12 && t <= 16 ? t - 10 : -1;
      if (startDow < 0) return err('#NUM!');
      const { y } = serialToYMD(n);
      const jan1 = ymdToSerial(y, 1, 1);
      const jan1Dow = serialToYMD(jan1).weekday;
      const offset = ((jan1Dow - startDow) + 7) % 7;
      return Math.floor((Math.trunc(n) - jan1 + offset) / 7) + 1;
    },
  },
  ISOWEEKNUM: { fn: ([a]) => { const n = dateSerial(a); return isError(n) ? n : isoWeek(n); } },
  // A column of start dates, or of end dates or day counts, answers one value per row; the
  // holidays stay the range they are.
  NETWORKDAYS: {
    refArgs: true, // the holidays come as the cells they are, one or many, so text in a cell is passed over
    liftArgs: [0, 1],
    fn: overArguments(([start, end, holidays]) => {
      const s = toNumber(start); if (isError(s)) return s;
      const e = toNumber(end); if (isError(e)) return e;
      const off = holidaySet(holidays); if (isError(off)) return off;
      if (!validCalendarDay(s) || !validCalendarDay(e)) return err('#NUM!');
      const n = workingDays(Math.trunc(Math.min(s, e)), Math.trunc(Math.max(s, e)), weekendDays(), off);
      return e < s ? -n : n;
    }, [0, 1]),
  },
  WORKDAY: {
    refArgs: true,
    liftArgs: [0, 1],
    fn: overArguments(([start, days, holidays]) => {
      const s = toNumber(start); if (isError(s)) return s;
      const k = toNumber(days); if (isError(k)) return k;
      const off = holidaySet(holidays); if (isError(off)) return off;
      // Even with no weekends, k workdays require at least k calendar days.
      if (!validCalendarDay(s) || !validCalendarDay(Math.trunc(s) + Math.trunc(k))) return err('#NUM!');
      const d = workingDaysFrom(Math.trunc(s), Math.abs(Math.trunc(k)), k < 0 ? -1 : 1, weekendDays(), off);
      return validCalendarDay(d) ? d : err('#NUM!'); // weekends and holidays may carry the day past the calendar
    }, [0, 1]),
  },
  DAYS360: {
    fn: ([start, end, method]) => {
      // A serial the calendar has no day for is #NUM!, as it is to YEAR and the other date functions.
      const s = dateSerial(start); if (isError(s)) return s;
      const e = dateSerial(end); if (isError(e)) return e;
      const eu = method === undefined ? false : toBool(method); if (isError(eu)) return eu;
      return days360(s, e, eu);
    },
  },
  YEARFRAC: {
    fn: ([start, end, basis]) => {
      const s = dateSerial(start); if (isError(s)) return s;
      const e = dateSerial(end); if (isError(e)) return e;
      const b = basis === undefined ? 0 : toNumber(basis); if (isError(b)) return b;
      // Whole days on every basis, the dates truncated: a time of day on NOW() counts for nothing.
      const lo = Math.trunc(Math.min(s, e));
      const hi = Math.trunc(Math.max(s, e));
      switch (Math.trunc(b)) {
        case 0: return days360(lo, hi, false, true) / 360;
        case 1: {
          const a = serialToYMD(lo);
          const z = serialToYMD(hi);
          const leap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
          let yearLen;
          const withinYear = z.y === a.y || (z.y === a.y + 1 && (z.m < a.m || (z.m === a.m && z.d <= a.d)));
          if (withinYear) {
            // A span inside one calendar year takes that year's length; a span into the
            // next year uses 366 only when it includes a February 29.
            const hasLeapDay = a.y === z.y ? leap(a.y)
              : (leap(a.y) && lo <= ymdToSerial(a.y, 2, 29) && hi >= ymdToSerial(a.y, 2, 29))
              || (leap(z.y) && lo <= ymdToSerial(z.y, 2, 29) && hi >= ymdToSerial(z.y, 2, 29));
            yearLen = hasLeapDay ? 366 : 365;
          } else {
            let total = 0;
            for (let y = a.y; y <= z.y; y++) total += leap(y) ? 366 : 365;
            yearLen = total / (z.y - a.y + 1);
          }
          return (hi - lo) / yearLen;
        }
        case 2: return (hi - lo) / 360;
        case 3: return (hi - lo) / 365;
        case 4: return days360(lo, hi, true) / 360;
        default: return err('#NUM!');
      }
    },
  },

  /* Financial */
  PMT: {
    fn: ([rate, nper, pv, fv, type]) => {
      const args = finArgs([rate, nper, pv, fv ?? 0, type ?? 0]); if (isError(args)) return args;
      const [r, n, p, f, t] = args;
      if (n === 0) return err('#NUM!');
      if (r === 0) return -(p + f) / n;
      const q = (1 + r) ** n;
      return checkNum(-(r * (p * q + f)) / ((q - 1) * (1 + r * (t ? 1 : 0))));
    },
  },
  IPMT: {
    fn: ([rate, per, nper, pv, fv, type]) => {
      const args = finArgs([rate, per, nper, pv, fv ?? 0, type ?? 0]); if (isError(args)) return args;
      const [r, k, n, p, f, t] = args;
      if (k < 1 || k > n) return err('#NUM!');
      const pmt = FUNCTIONS.PMT.fn([r, n, p, f, t]);
      if (isError(pmt)) return pmt;
      // Interest for period k is charged on the balance after k-1 payments
      // (the future value of the loan at that point). With payments at the
      // start of each period the first carries no interest, and each later one
      // is paid a period early, so it is discounted by one period.
      if (t && k === 1) return 0;
      const periods = k - 1;
      const q = (1 + r) ** periods;
      const balance = r === 0 ? -(p + pmt * periods) : -(p * q + pmt * (t ? 1 + r : 1) * ((q - 1) / r));
      return checkNum(t ? (balance * r) / (1 + r) : balance * r);
    },
  },
  PPMT: {
    fn: ([rate, per, nper, pv, fv, type]) => {
      const args = finArgs([rate, per, nper, pv, fv ?? 0, type ?? 0]); if (isError(args)) return args;
      const [r, k, n, p, f, t] = args;
      const pmt = FUNCTIONS.PMT.fn([r, n, p, f, t]); if (isError(pmt)) return pmt;
      const ipmt = FUNCTIONS.IPMT.fn([r, k, n, p, f, t]); if (isError(ipmt)) return ipmt;
      return pmt - ipmt;
    },
  },
  FV: {
    fn: ([rate, nper, pmt, pv, type]) => {
      const args = finArgs([rate, nper, pmt, pv ?? 0, type ?? 0]); if (isError(args)) return args;
      const [r, n, m, p, t] = args;
      if (r === 0) return -(p + m * n);
      const q = (1 + r) ** n;
      return checkNum(-(p * q + (m * (1 + r * (t ? 1 : 0)) * (q - 1)) / r));
    },
  },
  PV: {
    fn: ([rate, nper, pmt, fv, type]) => {
      const args = finArgs([rate, nper, pmt, fv ?? 0, type ?? 0]); if (isError(args)) return args;
      const [r, n, m, f, t] = args;
      if (r === 0) return -(f + m * n);
      const q = (1 + r) ** n;
      return checkNum(-(f + (m * (1 + r * (t ? 1 : 0)) * (q - 1)) / r) / q);
    },
  },
  NPER: {
    fn: ([rate, pmt, pv, fv, type]) => {
      const args = finArgs([rate, pmt, pv, fv ?? 0, type ?? 0]); if (isError(args)) return args;
      const [r, m, p, f, t] = args;
      if (r <= -1) return err('#NUM!'); // no growth factor is left to count periods by, as for NPV
      if (r === 0) return m === 0 ? err('#NUM!') : -(p + f) / m;
      const adj = m * (1 + r * (t ? 1 : 0));
      const top = adj - f * r;
      const bottom = p * r + adj;
      if (top / bottom <= 0) return err('#NUM!');
      return checkNum(Math.log(top / bottom) / Math.log(1 + r));
    },
  },
  RATE: {
    fn: ([nper, pmt, pv, fv, type, guess]) => {
      const args = finArgs([nper, pmt, pv, fv ?? 0, type ?? 0, guess ?? 0.1]); if (isError(args)) return args;
      const [n, m, p, f, t, g] = args;
      if (n <= 0) return err('#NUM!'); // the number of payment periods of an annuity is positive, as for PDURATION
      // ((1+r)^n - 1) / r through expm1 and log1p: the plain form cancels to
      // noise near r = 0, where a loan repaid exactly at cost has its root.
      const annuity = (r) => (r === 0 ? n : Math.expm1(n * Math.log1p(r)) / r);
      const balance = (r) => {
        const a = annuity(r);
        return p * (1 + r * a) + m * (1 + r * (t ? 1 : 0)) * a + f;
      };
      // Tolerances follow the size of the flows, so billions and millionths converge alike.
      const scale = Math.max(Math.abs(p), Math.abs(f), Math.abs(m) * Math.abs(n));
      if (scale === 0) return err('#NUM!');
      let r = g;
      for (let i = 0; i < 100; i++) {
        const y = balance(r);
        if (Math.abs(y) < 1e-12 * scale) return r;
        const h = 1e-6;
        const dy = (balance(r + h) - y) / h;
        if (!Number.isFinite(dy) || dy === 0) break;
        const next = r - y / dy;
        if (!Number.isFinite(next)) break;
        if (Math.abs(next - r) < 1e-12) return next;
        r = next;
      }
      return Math.abs(balance(r)) < 1e-6 * scale ? r : err('#NUM!');
    },
  },
  NPV: {
    fn: ([rate, ...values]) => {
      const r = toNumber(rate); if (isError(r)) return r;
      const list = numbers(values); if (isError(list)) return list;
      if (r <= -1) return err('#NUM!');
      return checkNum(list.reduce((acc, v, i) => acc + v / (1 + r) ** (i + 1), 0));
    },
  },
  IRR: {
    fn: ([values, guess]) => {
      const list = numbers([values]); if (isError(list)) return list;
      const g = guess === undefined ? 0.1 : toNumber(guess); if (isError(g)) return g;
      if (!list.some((v) => v > 0) || !list.some((v) => v < 0)) return err('#NUM!');
      const npv = (r) => list.reduce((acc, v, i) => acc + v / (1 + r) ** i, 0);
      return solveRate(npv, g, list.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
    },
  },
  XNPV: {
    fn: ([rate, values, dates]) => {
      const r = toNumber(rate); if (isError(r)) return r;
      if (r <= -1) return err('#NUM!'); // no growth factor is left to discount by, as for NPV
      const vs = asRange(values).values.flat();
      const ds = asRange(dates).values.flat();
      if (vs.length !== ds.length) return err('#NUM!');
      const d0 = Math.trunc(ds[0]); // the dates are whole days, truncated: a time of day in a stamp does not shift the value
      let total = 0;
      for (let i = 0; i < vs.length; i++) {
        if (typeof vs[i] !== 'number' || typeof ds[i] !== 'number') return err('#VALUE!');
        const d = Math.trunc(ds[i]);
        if (d < d0) return err('#NUM!'); // every flow is discounted from the first date
        total += vs[i] / (1 + r) ** ((d - d0) / 365);
      }
      return checkNum(total);
    },
  },
  XIRR: {
    fn: ([values, dates, guess]) => {
      const vs = asRange(values).values.flat();
      const ds = asRange(dates).values.flat();
      const g = guess === undefined ? 0.1 : toNumber(guess); if (isError(g)) return g;
      if (vs.length !== ds.length || vs.some((v) => typeof v !== 'number') || ds.some((d) => typeof d !== 'number')) return err('#VALUE!');
      if (!vs.some((v) => v > 0) || !vs.some((v) => v < 0)) return err('#NUM!');
      const days = ds.map(Math.trunc); // whole days, the dates truncated as XNPV does here
      const d0 = days[0];
      if (days.some((d) => d < d0)) return err('#NUM!'); // every flow is discounted from the first date, as in XNPV
      return solveRate((r) => vs.reduce((acc, v, i) => acc + v / (1 + r) ** ((days[i] - d0) / 365), 0), g, vs.reduce((m, v) => Math.max(m, Math.abs(v)), 0));
    },
  },
  SLN: {
    fn: ([cost, salvage, life]) => {
      const args = finArgs([cost, salvage, life]); if (isError(args)) return args;
      const [c, s, l] = args;
      return l === 0 ? err('#DIV/0!') : (c - s) / l;
    },
  },
  SYD: {
    fn: ([cost, salvage, life, per]) => {
      const args = finArgs([cost, salvage, life, per]); if (isError(args)) return args;
      const [c, s, l, k] = args;
      if (l <= 0 || k < 1 || k > l) return err('#NUM!');
      return ((c - s) * (l - k + 1) * 2) / (l * (l + 1));
    },
  },
  DDB: {
    fn: ([cost, salvage, life, per, factor]) => {
      const args = finArgs([cost, salvage, life, per, factor ?? 2]); if (isError(args)) return args;
      const [c, s, l, k, f] = args;
      if (l <= 0 || k < 1 || k > l || c < 0 || s < 0 || f <= 0) return err('#NUM!');
      if (Math.ceil(k) > MAX_PERIODS) return err('#NUM!');
      let book = c;
      let dep = 0;
      for (let i = 1; i <= Math.ceil(k); i++) {
        dep = Math.min(book * (f / l), Math.max(0, book - s));
        book -= dep;
        if (dep === 0) break; // the book value is down to the salvage floor, so every later period is 0 too
      }
      return dep;
    },
  },
  EFFECT: {
    fn: ([nominal, npery]) => {
      const args = finArgs([nominal, npery]); if (isError(args)) return args;
      const [r, n] = args;
      const k = Math.trunc(n);
      if (r <= 0 || k < 1) return err('#NUM!');
      return (1 + r / k) ** k - 1;
    },
  },
  NOMINAL: {
    fn: ([effect, npery]) => {
      const args = finArgs([effect, npery]); if (isError(args)) return args;
      const [r, n] = args;
      const k = Math.trunc(n);
      if (r <= 0 || k < 1) return err('#NUM!');
      return k * ((1 + r) ** (1 / k) - 1);
    },
  },

  /* Lambdas: LET and LAMBDA are evaluated by the evaluator itself (they need
     the unevaluated names); these entries make them known to autocomplete
     and to the array detector, which judges a LET by what its result names. */
  LET: { lazy: true, fn: () => err('#VALUE!') },
  LAMBDA: { lazy: true, fn: () => err('#VALUE!') },
  MAP: {
    fn: (args) => {
      if (args.length < 2) return err('#VALUE!');
      const fn = args[args.length - 1];
      if (!isLambda(fn)) return err('#VALUE!');
      const arrays = alignWindows(args.slice(0, -1).map(asRange));
      const rows = Math.max(...arrays.map((a) => a.values.length));
      const cols = Math.max(...arrays.map((a) => a.values[0]?.length || 0));
      const out = [];
      for (let r = 0; r < rows; r++) {
        const row = [];
        for (let c = 0; c < cols; c++) {
          const xs = arrays.map((a) => {
            const rr = a.values.length === 1 ? 0 : r;
            const cc = (a.values[0]?.length || 0) === 1 ? 0 : c;
            return rr < a.values.length && cc < (a.values[rr]?.length || 0) ? a.values[rr][cc] ?? null : err('#N/A');
          });
          row.push(lambdaScalar(fn, xs));
        }
        out.push(row);
      }
      return { range: true, values: out };
    },
    array: true,
  },
  REDUCE: {
    fn: ([initial, array, fn]) => {
      if (!isLambda(fn)) return err('#VALUE!');
      let acc = initial === undefined ? null : initial;
      for (const { v } of eachValue([array])) {
        acc = lambdaValue(fn, [acc, v ?? null]);
        if (isError(acc)) return acc;
      }
      return acc;
    },
  },
  SCAN: {
    fn: ([initial, array, fn]) => {
      if (!isLambda(fn)) return err('#VALUE!');
      let acc = initial === undefined ? null : initial;
      const src = asRange(array).values;
      const out = src.map((row) => row.map((v) => {
        if (isError(acc)) return acc;
        acc = lambdaScalar(fn, [acc, v ?? null]);
        return acc;
      }));
      return { range: true, values: out };
    },
    array: true,
  },
  BYROW: {
    fn: ([array, fn]) => {
      if (!isLambda(fn)) return err('#VALUE!');
      const src = asRange(array).values;
      return { range: true, values: src.map((row) => [lambdaScalar(fn, [{ range: true, values: [row] }])]) };
    },
    array: true,
  },
  BYCOL: {
    fn: ([array, fn]) => {
      if (!isLambda(fn)) return err('#VALUE!');
      const src = asRange(array).values;
      const cols = src[0]?.length || 0;
      const row = [];
      for (let c = 0; c < cols; c++) row.push(lambdaScalar(fn, [{ range: true, values: src.map((r) => [r[c] ?? null]) }]));
      return { range: true, values: [row] };
    },
    array: true,
  },
  MAKEARRAY: {
    fn: ([rows, cols, fn]) => {
      const R = toNumber(rows); if (isError(R)) return R;
      const C = toNumber(cols); if (isError(C)) return C;
      if (!isLambda(fn)) return err('#VALUE!');
      const nr = Math.trunc(R);
      const nc = Math.trunc(C);
      if (nr < 1 || nc < 1) return err('#VALUE!');
      if (nr * nc > 100000) return err('#NUM!');
      const out = [];
      for (let r = 1; r <= nr; r++) { const row = []; for (let c = 1; c <= nc; c++) row.push(lambdaScalar(fn, [r, c])); out.push(row); }
      return { range: true, values: out };
    },
    array: true,
  },

  /* Array shaping */
  VSTACK: {
    fn: (args) => {
      if (!args.length) return err('#VALUE!');
      const parts = alignWindows(args.map(asRange), 'cols');
      const width = Math.max(...parts.map((p) => p.values[0]?.length || 0));
      // The same cap as SEQUENCE and MAKEARRAY: a stack cannot assemble what they may not.
      if (parts.reduce((n, p) => n + p.values.length, 0) * width > 100000) return err('#NUM!');
      const out = [];
      for (const p of parts) for (const row of p.values) out.push(padRow(row, width));
      return { range: true, values: out };
    },
    array: true,
    tolerant: true,
  },
  HSTACK: {
    fn: (args) => {
      if (!args.length) return err('#VALUE!');
      const parts = alignWindows(args.map(asRange), 'rows');
      const height = Math.max(...parts.map((p) => p.values.length));
      if (parts.reduce((n, p) => n + (p.values[0]?.length || 0), 0) * height > 100000) return err('#NUM!');
      const out = [];
      for (let r = 0; r < height; r++) {
        const row = [];
        for (const p of parts) {
          const w = p.values[0]?.length || 0;
          const src = p.values[r];
          for (let c = 0; c < w; c++) row.push(src ? src[c] ?? null : err('#N/A'));
        }
        out.push(row);
      }
      return { range: true, values: out };
    },
    array: true,
    tolerant: true,
  },
  TAKE: {
    fn: ([array, rows, cols]) => {
      const v = asRange(array).values;
      const h = v.length;
      const w = v[0]?.length || 0;
      const nr = rows === undefined || rows === null ? h : toNumber(rows); if (isError(nr)) return nr;
      const nc = cols === undefined || cols === null ? w : toNumber(cols); if (isError(nc)) return nc;
      const R = Math.trunc(nr);
      const C = Math.trunc(nc);
      if (R === 0 || C === 0) return err('#CALC!');
      const rowIdx = R > 0 ? range0(Math.min(R, h)) : range0(Math.min(-R, h)).map((i) => h - Math.min(-R, h) + i);
      const colIdx = C > 0 ? range0(Math.min(C, w)) : range0(Math.min(-C, w)).map((i) => w - Math.min(-C, w) + i);
      return { range: true, values: rowIdx.map((r) => colIdx.map((c) => v[r][c] ?? null)) };
    },
    array: true,
    tolerant: true,
  },
  DROP: {
    fn: ([array, rows, cols]) => {
      const v = asRange(array).values;
      const h = v.length;
      const w = v[0]?.length || 0;
      const nr = rows === undefined || rows === null ? 0 : toNumber(rows); if (isError(nr)) return nr;
      const nc = cols === undefined || cols === null ? 0 : toNumber(cols); if (isError(nc)) return nc;
      const R = Math.trunc(nr);
      const C = Math.trunc(nc);
      const rowIdx = range0(h).filter((r) => (R >= 0 ? r >= R : r < h + R));
      const colIdx = range0(w).filter((c) => (C >= 0 ? c >= C : c < w + C));
      if (!rowIdx.length || !colIdx.length) return err('#CALC!');
      return { range: true, values: rowIdx.map((r) => colIdx.map((c) => v[r][c] ?? null)) };
    },
    array: true,
    tolerant: true,
  },
  EXPAND: {
    fn: ([array, rows, cols, pad]) => {
      const v = asRange(array).values;
      const h = v.length;
      const w = v[0]?.length || 0;
      const nr = rows === undefined || rows === null ? h : toNumber(rows); if (isError(nr)) return nr;
      const nc = cols === undefined || cols === null ? w : toNumber(cols); if (isError(nc)) return nc;
      const R = Math.trunc(nr);
      const C = Math.trunc(nc);
      if (R < h || C < w) return err('#VALUE!');
      if (R * C > 100000) return err('#NUM!');
      const fill = pad === undefined ? err('#N/A') : scalar(pad);
      const out = [];
      for (let r = 0; r < R; r++) { const row = []; for (let c = 0; c < C; c++) row.push(r < h && c < w ? v[r][c] ?? null : fill); out.push(row); }
      return { range: true, values: out };
    },
    array: true,
    tolerant: true,
  },
  WRAPROWS: {
    fn: ([vector, count, pad]) => {
      const flat = vectorOf(vector); if (isError(flat)) return flat;
      const n = toNumber(count); if (isError(n)) return n;
      const k = Math.trunc(n);
      if (k < 1) return err('#NUM!');
      if (k * Math.ceil(flat.length / k) > 100000) return err('#NUM!'); // padded out to more cells than SEQUENCE allows
      const fill = pad === undefined ? err('#N/A') : scalar(pad);
      const out = [];
      for (let i = 0; i < flat.length; i += k) { const row = flat.slice(i, i + k); while (row.length < k) row.push(fill); out.push(row); }
      return { range: true, values: out };
    },
    array: true,
    tolerant: true,
  },
  WRAPCOLS: {
    fn: ([vector, count, pad]) => {
      const flat = vectorOf(vector); if (isError(flat)) return flat;
      const n = toNumber(count); if (isError(n)) return n;
      const k = Math.trunc(n);
      if (k < 1) return err('#NUM!');
      if (k * Math.ceil(flat.length / k) > 100000) return err('#NUM!'); // padded out to more cells than SEQUENCE allows
      const fill = pad === undefined ? err('#N/A') : scalar(pad);
      const cols = [];
      for (let i = 0; i < flat.length; i += k) { const col = flat.slice(i, i + k); while (col.length < k) col.push(fill); cols.push(col); }
      const out = [];
      for (let r = 0; r < k; r++) out.push(cols.map((col) => col[r]));
      return { range: true, values: out };
    },
    array: true,
    tolerant: true,
  },
  TOCOL: {
    fn: ([array, ignore, byCol]) => {
      const flat = flattenArray(array, ignore, byCol); if (isError(flat)) return flat;
      return { range: true, values: flat.map((v) => [v]) };
    },
    array: true,
    tolerant: true,
  },
  TOROW: {
    fn: ([array, ignore, byCol]) => {
      const flat = flattenArray(array, ignore, byCol); if (isError(flat)) return flat;
      return { range: true, values: [flat] };
    },
    array: true,
    tolerant: true,
  },
  RANDARRAY: {
    fn: ([rows, cols, min, max, integer]) => {
      const R = rows === undefined ? 1 : toNumber(rows); if (isError(R)) return R;
      const C = cols === undefined ? 1 : toNumber(cols); if (isError(C)) return C;
      const lo = min === undefined ? 0 : toNumber(min); if (isError(lo)) return lo;
      const hi = max === undefined ? 1 : toNumber(max); if (isError(hi)) return hi;
      const whole = integer === undefined ? false : toBool(integer); if (isError(whole)) return whole;
      const nr = Math.trunc(R);
      const nc = Math.trunc(C);
      if (nr < 1 || nc < 1) return err('#CALC!'); // no rows or no columns is the empty array
      if (hi < lo) return err('#VALUE!');
      if (nr * nc > 100000) return err('#NUM!');
      // Whole numbers come from the integers between the bounds, as in RANDBETWEEN; there is none between 0.2 and 0.8.
      const first = Math.ceil(lo);
      const last = Math.floor(hi);
      if (whole && last < first) return err('#VALUE!');
      const out = [];
      for (let r = 0; r < nr; r++) {
        const row = [];
        for (let c = 0; c < nc; c++) row.push(whole ? first + Math.floor(Math.random() * (last - first + 1)) : lo + Math.random() * (hi - lo));
        out.push(row);
      }
      return { range: true, values: out };
    },
    array: true,
    volatile: true,
  },

  /* Statistics: A-variants, spread, and distributions */
  AVERAGEA: { refArgs: true, fn: (args) => { const l = numbersA(args, true); return isError(l) ? l : l.length ? worksheetMean(l) : err('#DIV/0!'); } },
  MAXA: { refArgs: true, fn: (args) => { const l = numbersA(args); return isError(l) ? l : l.length ? maximum(l) : 0; } },
  MINA: { refArgs: true, fn: (args) => { const l = numbersA(args); return isError(l) ? l : l.length ? minimum(l) : 0; } },
  DEVSQ: { refArgs: true, fn: num((l) => l.length ? squaredDeviations(l, l.reduce((a, x) => a + x, 0) / l.length) : err('#NUM!')) },
  SKEW: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => {
      const n = l.length;
      if (n < 3) return err('#DIV/0!');
      const m = numericMean(l);
      const sd = Math.sqrt(numericVariance(l, 1, m));
      if (!sd) return err('#DIV/0!');
      return (n / ((n - 1) * (n - 2))) * l.reduce((a, x) => a + ((x - m) / sd) ** 3, 0);
    }),
  },
  'SKEW.P': {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => {
      const n = l.length;
      if (n < 3) return err('#DIV/0!'); // two points are symmetric about their own mean, so their skew is 0 whatever they are
      const m = numericMean(l);
      const sd = Math.sqrt(numericVariance(l, 0, m));
      if (!sd) return err('#DIV/0!');
      return l.reduce((a, x) => a + ((x - m) / sd) ** 3, 0) / n;
    }),
  },
  KURT: {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range
    fn: num((l) => {
      const n = l.length;
      if (n < 4) return err('#DIV/0!');
      const m = numericMean(l);
      const sd = Math.sqrt(numericVariance(l, 1, m));
      if (!sd) return err('#DIV/0!');
      const s4 = l.reduce((a, x) => a + ((x - m) / sd) ** 4, 0);
      return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * s4 - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3));
    }),
  },
  TRIMMEAN: {
    refArgs: true, // even a single referenced text/boolean observation is ignored
    liftArgs: [1], // an array of percentages answers one mean per element, as LARGE does for k
    fn: overArguments(([range, pct]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const p = toNumber(pct); if (isError(p)) return p;
      if (p < 0 || p >= 1) return err('#NUM!');
      if (!s.length) return err('#NUM!');
      const drop = Math.floor((s.length * p) / 2);
      const lower = s[drop], upper = s[s.length - drop - 1];
      let total = 0, lowExtra = drop, highExtra = drop;
      // Sum within inclusive rank boundaries in input order, then
      // subtract excess boundary duplicates individually. Sorting the sum or
      // multiplying a duplicate count changes cancellation and overflow.
      for (const x of numbers([range])) {
        if (x < lower) lowExtra--;
        else if (x > upper) highExtra--;
        else total += x;
      }
      while (lowExtra-- > 0) total -= lower;
      while (highExtra-- > 0) total -= upper;
      return total / (s.length - 2 * drop);
    }, [1]),
  },
  STANDARDIZE: {
    fn: ([x, mean, sd]) => {
      const a = finArgs([x, mean, sd]); if (isError(a)) return a;
      if (a[2] <= 0) return err('#NUM!');
      return (a[0] - a[1]) / a[2];
    },
  },
  'PERCENTILE.EXC': {
    liftArgs: [1],
    fn: overArguments(([range, k]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const p = toNumber(k); if (isError(p)) return p;
      return percentileExc(s, p);
    }, [1]),
  },
  'QUARTILE.EXC': {
    liftArgs: [1],
    fn: overArguments(([range, q]) => {
      const s = sortedNumbers(range); if (isError(s)) return s;
      const k = toNumber(q); if (isError(k)) return k;
      const i = Math.trunc(k);
      if (i < 1 || i > 3) return err('#NUM!');
      return percentileExc(s, i / 4);
    }, [1]),
  },
  FREQUENCY: {
    fn: ([data, bins]) => {
      const values = numbers([data]); if (isError(values)) return values;
      const edges = numbers([bins]); if (isError(edges)) return edges;
      // The bins are counted in ascending order, but each count answers the bin in its own
      // position; the first of equal bins takes their count (the sort is stable).
      const order = edges.map((_, i) => i).sort((i, j) => edges[i] - edges[j]);
      const sorted = order.map((i) => edges[i]);
      const counts = new Array(sorted.length + 1).fill(0);
      for (const v of values) {
        // The first bin edge not below v, found by halving: a long list against many bins stays quick.
        let lo = 0;
        let hi = sorted.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (v > sorted[mid]) lo = mid + 1; else hi = mid;
        }
        counts[lo < sorted.length ? order[lo] : lo]++;
      }
      return { range: true, values: counts.map((n) => [n]) };
    },
    array: true,
  },
  SUMX2MY2: { fn: ([a, b]) => pairSum(a, b, (x, y) => x * x - y * y) },
  SUMX2PY2: { fn: ([a, b]) => pairSum(a, b, (x, y) => x * x + y * y) },
  SUMXMY2: { fn: ([a, b]) => pairSum(a, b, (x, y) => (x - y) ** 2) },
  STEYX: {
    fn: ([ys, xs]) => pairStats(xs, ys, (s) => {
      if (s.n < 3 || !s.sxx) return err('#DIV/0!');
      const explained = flushUnderflow(flushUnderflow(s.sxy * s.sxy) / s.sxx);
      return Math.sqrt(flushUnderflow((s.syy - explained) / (s.n - 2)));
    }),
  },
  // LINEST(known_y, [known_x], [const], [stats]) and LOGEST likewise: the coefficients, last variable
  // first, then the intercept (0, or 1 for LOGEST, when const is FALSE); with stats, the five rows of
  // statistics. An empty const reads as FALSE.
  LINEST: {
    fn: ([ys, xs, constant, stats]) => {
      const c = constant === undefined ? true : toBool(constant); if (isError(c)) return c;
      const s = stats === undefined ? false : toBool(stats); if (isError(s)) return s;
      const fit = regression(ys, xs, c); if (isError(fit)) return fit;
      return { range: true, values: s ? regressionStats(fit, (v) => v) : [[...fit.coef.slice().reverse(), fit.b]] };
    },
    array: true,
  },
  LOGEST: {
    fn: ([ys, xs, constant, stats]) => {
      const c = constant === undefined ? true : toBool(constant); if (isError(c)) return c;
      const s = stats === undefined ? false : toBool(stats); if (isError(s)) return s;
      const fit = logRegression(ys, xs, c); if (isError(fit)) return fit;
      return { range: true, values: s ? regressionStats(fit, Math.exp) : [[...fit.coef.map(Math.exp).reverse(), Math.exp(fit.b)]] };
    },
    array: true,
  },
  // TREND(known_y, [known_x], [new_x], [const]) and GROWTH likewise.
  TREND: {
    fn: ([ys, xs, newXs, constant]) => {
      const c = constant === undefined ? true : toBool(constant); if (isError(c)) return c;
      const fit = regression(ys, xs, c); if (isError(fit)) return fit;
      return fittedValues(fit, ys, newXs, (v) => v);
    },
    array: true,
  },
  GROWTH: {
    fn: ([ys, xs, newXs, constant]) => {
      const c = constant === undefined ? true : toBool(constant); if (isError(c)) return c;
      const fit = logRegression(ys, xs, c); if (isError(fit)) return fit;
      return fittedValues(fit, ys, newXs, Math.exp);
    },
    array: true,
  },
  FISHER: { fn: unaryMath((x) => (x <= -1 || x >= 1 ? NaN : 0.5 * Math.log((1 + x) / (1 - x)))) },
  FISHERINV: { fn: unaryMath(Math.tanh) }, // (e^2y - 1) / (e^2y + 1), without the overflow past y = 355
  GAMMA: { fn: unaryMath((x) => (x <= 0 && Number.isInteger(x) ? NaN : gammaFn(x))) },
  GAMMALN: { fn: unaryMath((x) => (x <= 0 ? NaN : gammaLn(x))) },
  'GAMMALN.PRECISE': { alias: 'GAMMALN' },
  'NORM.DIST': {
    fn: ([x, mean, sd, cumulative]) => {
      const a = finArgs([x, mean, sd]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      if (a[2] <= 0) return err('#NUM!');
      const z = (a[0] - a[1]) / a[2];
      return cum ? normCdf(z) : Math.exp(-0.5 * z * z) / (a[2] * Math.sqrt(2 * Math.PI));
    },
  },
  NORMDIST: { alias: 'NORM.DIST' },
  'NORM.S.DIST': {
    fn: ([z, cumulative]) => {
      const x = toNumber(z); if (isError(x)) return x;
      const cum = cumulative === undefined ? true : toBool(cumulative); if (isError(cum)) return cum;
      return cum ? normCdf(x) : Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    },
  },
  NORMSDIST: { alias: 'NORM.S.DIST' },
  'NORM.INV': {
    fn: ([p, mean, sd]) => {
      const a = finArgs([p, mean, sd]); if (isError(a)) return a;
      if (a[0] <= 0 || a[0] >= 1 || a[2] <= 0) return err('#NUM!');
      return a[1] + a[2] * normInv(a[0]);
    },
  },
  NORMINV: { alias: 'NORM.INV' },
  'NORM.S.INV': { fn: unaryMath((p) => (p <= 0 || p >= 1 ? NaN : normInv(p))) },
  NORMSINV: { alias: 'NORM.S.INV' },
  'LOGNORM.DIST': {
    fn: ([x, mean, sd, cumulative]) => {
      const a = finArgs([x, mean, sd]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      if (a[0] <= 0 || a[2] <= 0) return err('#NUM!');
      const z = (Math.log(a[0]) - a[1]) / a[2];
      return cum ? normCdf(z) : Math.exp(-0.5 * z * z) / (a[0] * a[2] * Math.sqrt(2 * Math.PI));
    },
  },
  LOGNORMDIST: { alias: 'LOGNORM.DIST' },
  'LOGNORM.INV': {
    fn: ([p, mean, sd]) => {
      const a = finArgs([p, mean, sd]); if (isError(a)) return a;
      if (a[0] <= 0 || a[0] >= 1 || a[2] <= 0) return err('#NUM!');
      return Math.exp(a[1] + a[2] * normInv(a[0]));
    },
  },
  'EXPON.DIST': {
    fn: ([x, lambda, cumulative]) => {
      const a = finArgs([x, lambda]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      if (a[0] < 0 || a[1] <= 0) return err('#NUM!');
      return cum ? 1 - Math.exp(-a[1] * a[0]) : a[1] * Math.exp(-a[1] * a[0]);
    },
  },
  EXPONDIST: { alias: 'EXPON.DIST' },
  'POISSON.DIST': {
    fn: ([x, mean, cumulative]) => {
      const a = finArgs([x, mean]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      const k = Math.floor(a[0]);
      if (k < 0 || a[1] < 0) return err('#NUM!');
      if (a[1] === 0) return cum || k === 0 ? 1 : 0;
      // The mass e^-λ λ^k / k! is x^a e^-x / Γ(a) at a = k + 1 over λ; the CDF is the upper incomplete gamma Q(k + 1, λ).
      if (!cum) return Math.exp(lnGammaFront(k + 1, a[1])) / a[1];
      return incompleteGamma(k + 1, a[1]).q;
    },
  },
  POISSON: { alias: 'POISSON.DIST' },
  'BINOM.DIST.RANGE': {
    fn: ([trials, p, k1, k2]) => {
      const a = finArgs([trials, p, k1, k2 === undefined ? k1 : k2]); if (isError(a)) return a;
      const n = Math.floor(a[0]);
      const prob = a[1];
      const lo = Math.floor(a[2]);
      const hi = Math.floor(a[3]);
      if (n < 0 || prob < 0 || prob > 1 || lo < 0 || lo > n || hi < lo || hi > n) return err('#NUM!');
      // A narrow range sums its masses; a wide one is the difference of two same-side tails, so nothing cancels.
      if (hi - lo <= 1000) {
        let total = 0;
        for (let i = lo; i <= hi; i++) total += binomialPmf(n, i, prob);
        return checkNum(Math.min(1, total));
      }
      const below = binomialCdf(n, lo - 1, prob);
      const upTo = binomialCdf(n, hi, prob);
      return Math.max(0, Math.min(1, lo > n * prob ? below.q - upTo.q : upTo.p - below.p));
    },
  },
  'BINOM.DIST': {
    fn: ([k, n, p, cumulative]) => {
      const a = finArgs([k, n, p]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      const successes = Math.floor(a[0]);
      const trials = Math.floor(a[1]);
      const prob = a[2];
      if (successes < 0 || successes > trials || prob < 0 || prob > 1) return err('#NUM!');
      if (!cum) return binomialPmf(trials, successes, prob);
      return binomialCdf(trials, successes, prob).p;
    },
  },
  BINOMDIST: { alias: 'BINOM.DIST' },
  'WEIBULL.DIST': {
    fn: ([x, alpha, beta, cumulative]) => {
      const a = finArgs([x, alpha, beta]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      if (a[0] < 0 || a[1] <= 0 || a[2] <= 0) return err('#NUM!');
      const t = (a[0] / a[2]) ** a[1];
      return cum ? 1 - Math.exp(-t) : (a[1] / a[2]) * (a[0] / a[2]) ** (a[1] - 1) * Math.exp(-t);
    },
  },
  WEIBULL: { alias: 'WEIBULL.DIST' },
  'GAMMA.DIST': {
    fn: ([x, alpha, beta, cumulative]) => {
      const a = finArgs([x, alpha, beta]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      if (a[0] < 0 || a[1] <= 0 || a[2] <= 0) return err('#NUM!');
      if (cum) return incompleteGamma(a[1], a[0] / a[2]).p;
      // At zero the density is 1/beta for shape 1, zero above it, and unbounded (#NUM!) below it.
      if (a[0] === 0) return a[1] < 1 ? err('#NUM!') : a[1] === 1 ? 1 / a[2] : 0;
      return Math.exp((a[1] - 1) * Math.log(a[0]) - a[0] / a[2] - gammaLn(a[1]) - a[1] * Math.log(a[2]));
    },
  },
  GAMMADIST: { alias: 'GAMMA.DIST' },
  'CHISQ.DIST': {
    fn: ([x, df, cumulative]) => {
      const a = finArgs([x, df]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      const k = Math.trunc(a[1]);
      if (a[0] < 0 || k < 1) return err('#NUM!');
      if (cum) return incompleteGamma(k / 2, a[0] / 2).p;
      if (a[0] === 0) return k < 2 ? err('#NUM!') : k === 2 ? 0.5 : 0;
      return Math.exp((k / 2 - 1) * Math.log(a[0]) - a[0] / 2 - gammaLn(k / 2) - (k / 2) * Math.LN2);
    },
  },
  'CHISQ.DIST.RT': {
    fn: ([x, df]) => {
      const a = finArgs([x, df]); if (isError(a)) return a;
      const k = Math.trunc(a[1]);
      if (a[0] < 0 || k < 1) return err('#NUM!');
      return incompleteGamma(k / 2, a[0] / 2).q;
    },
  },
  CHIDIST: { alias: 'CHISQ.DIST.RT' },
  'CHISQ.INV': {
    fn: ([p, df]) => {
      const a = finArgs([p, df]); if (isError(a)) return a;
      const k = Math.trunc(a[1]);
      if (a[0] < 0 || a[0] >= 1 || k < 1) return err('#NUM!');
      if (a[0] === 0) return 0;
      return gammaQuantile(a[0], k / 2, 2);
    },
  },
  'CHISQ.INV.RT': {
    fn: ([p, df]) => {
      const a = finArgs([p, df]); if (isError(a)) return a;
      const k = Math.trunc(a[1]);
      if (a[0] <= 0 || a[0] > 1 || k < 1) return err('#NUM!');
      if (a[0] === 1) return 0;
      return gammaQuantile(a[0], k / 2, 2, true);
    },
  },
  CHIINV: { alias: 'CHISQ.INV.RT' },
  'CHISQ.TEST': {
    fn: ([actual, expected]) => {
      const ranges = [asRange(actual), asRange(expected)];
      if (!sameExtent(ranges)) return err('#N/A');
      const [A, B] = readAlike(ranges); // whole columns on two sheets read to one depth
      const rows = A.length;
      const cols = A[0]?.length || 0;
      if (B.length !== rows || (B[0]?.length || 0) !== cols) return err('#N/A');
      let stat = 0;
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const o = A[r][c];
        const e = B[r][c];
        if (typeof o !== 'number' || typeof e !== 'number') continue;
        if (e === 0) return err('#DIV/0!');
        stat += ((o - e) ** 2) / e;
      }
      const df = rows > 1 && cols > 1 ? (rows - 1) * (cols - 1) : rows * cols - 1;
      if (df < 1) return err('#N/A'); // a single cell leaves no degree of freedom
      return incompleteGamma(df / 2, stat / 2).q;
    },
  },
  CHITEST: { alias: 'CHISQ.TEST' },
  'T.DIST': {
    fn: ([x, df, cumulative]) => {
      const a = finArgs([x, df]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      const k = Math.trunc(a[1]);
      if (k < 1) return err('#NUM!');
      return cum ? tCdf(a[0], k) : tPdf(a[0], k);
    },
  },
  'T.DIST.RT': {
    fn: ([x, df]) => {
      const a = finArgs([x, df]); if (isError(a)) return a;
      const k = Math.trunc(a[1]);
      if (k < 1) return err('#NUM!');
      const p = tProbability(a[0], k);
      return isError(p) ? p : a[0] >= 0 ? p : 1 - p;
    },
  },
  'T.DIST.2T': {
    fn: ([x, df]) => {
      const a = finArgs([x, df]); if (isError(a)) return a;
      const k = Math.trunc(a[1]);
      if (k < 1 || a[0] < 0) return err('#NUM!');
      return tProbability(a[0], k, 2);
    },
  },
  TDIST: {
    fn: ([x, df, tails]) => {
      const a = finArgs([x, df, tails]); if (isError(a)) return a;
      const k = Math.trunc(a[1]);
      const t = Math.trunc(a[2]);
      if (k < 1 || a[0] < 0 || (t !== 1 && t !== 2)) return err('#NUM!');
      return tProbability(a[0], k, t);
    },
  },
  'T.INV': {
    fn: ([p, df]) => {
      const a = finArgs([p, df]); if (isError(a)) return a;
      const k = Math.trunc(a[1]);
      if (a[0] < 0 || a[0] >= 1 || k < 1) return err('#NUM!');
      if (a[0] === 0.5) return 0;
      // 1 - p is exact from 0.5 up. Preserve the Cauchy endpoint error before
      // applying the sign; negating an error object would lose its identity.
      const q = tQuantile(a[0] < 0.5 ? a[0] : 1 - a[0], k);
      return isError(q) ? q : a[0] < 0.5 ? -q : q;
    },
  },
  'T.INV.2T': {
    fn: ([p, df]) => {
      const a = finArgs([p, df]); if (isError(a)) return a;
      const k = Math.trunc(a[1]);
      if (a[0] < 0 || a[0] > 1 || k < 1) return err('#NUM!');
      return tQuantile(flushUnderflow(a[0] / 2), k);
    },
  },
  TINV: { alias: 'T.INV.2T' },
  'T.TEST': {
    fn: ([a, b, tails, type]) => {
      const xs = numbers([a]); if (isError(xs)) return xs;
      const ys = numbers([b]); if (isError(ys)) return ys;
      const t = toNumber(tails); if (isError(t)) return t;
      const kind = toNumber(type); if (isError(kind)) return kind;
      const tl = Math.trunc(t);
      const ty = Math.trunc(kind);
      if ((tl !== 1 && tl !== 2) || ty < 1 || ty > 3) return err('#NUM!');
      if (ty === 1) {
        return pairStats(a, b, (s) => {
          if (s.n < 2) return err('#DIV/0!');
          if (!Number.isFinite(s.sxx) || !Number.isFinite(s.syy)) return err('#NUM!');
          const vx = flushUnderflow(s.sxx / (s.n - 1));
          const vy = flushUnderflow(s.syy / (s.n - 1));
          const covariance = flushUnderflow(s.sxy / (s.n - 1));
          // Use the two variances and covariance, not variance of the
          // differences. Subtract covariance from each before summing: adding
          // the variances first loses a bit that matters for near-equal pairs.
          const se2 = flushUnderflow(((vx - covariance) + (vy - covariance)) / s.n);
          if (se2 <= 0 || !Number.isFinite(se2)) return err('#DIV/0!');
          return tTestProbability((s.mx - s.my) / Math.sqrt(se2), s.n - 1, tl);
        });
      }
      if (!xs.length || !ys.length) return err('#DIV/0!');
      // T.TEST's sample means use ordinary sums; AVERAGE's separate overflow
      // recovery would turn invalid native test inputs into finite statistics.
      const mx = xs.reduce((total, x) => total + x, 0) / xs.length;
      const my = ys.reduce((total, y) => total + y, 0) / ys.length;
      if (!Number.isFinite(mx) || !Number.isFinite(my)) return err('#NUM!');
      const sxx = squaredDeviations(xs, mx);
      const syy = squaredDeviations(ys, my);
      if (!Number.isFinite(sxx) || !Number.isFinite(syy)) return err('#NUM!');
      // Empty samples fail first; singleton samples do not mask overflow in
      // the other sample's sum or squared deviations.
      if (xs.length < 2 || ys.length < 2) return err('#DIV/0!');
      const vx = flushUnderflow(sxx / (xs.length - 1));
      const vy = flushUnderflow(syy / (ys.length - 1));
      if (ty === 2) {
        const df = xs.length + ys.length - 2;
        const pooled = flushUnderflow(((xs.length - 1) * vx + (ys.length - 1) * vy) / df);
        const se2 = flushUnderflow(pooled * (1 / xs.length + 1 / ys.length));
        // An overflowing individual variance is #NUM!, but zero or overflowing
        // pooled standard error is #DIV/0!, just as for paired samples.
        if (!se2 || !Number.isFinite(se2)) return err('#DIV/0!');
        return tTestProbability((mx - my) / Math.sqrt(se2), df, tl);
      }
      const se2 = vx / xs.length + vy / ys.length;
      if (!se2) return err('#DIV/0!');
      const stat = (mx - my) / Math.sqrt(se2);
      // The Welch degrees calculation converts an overflowing square to
      // zero before division. Apply that at each square, not to the completed
      // denominator: the other sample can still contribute a finite term.
      const square = n => {
        const value = n * n;
        return Number.isFinite(value) ? value : 0;
      };
      // Native Welch arithmetic rounds each squared-variance contribution
      // after division, before adding them in the Satterthwaite denominator.
      const denominator = flushUnderflow(square(vx / xs.length) / (xs.length - 1))
        + flushUnderflow(square(vy / ys.length) / (ys.length - 1));
      if (denominator === 0 || !Number.isFinite(denominator)) return err('#DIV/0!');
      const df = square(se2) / denominator;
      return tTestProbability(stat, df, tl);
    },
  },
  TTEST: { alias: 'T.TEST' },
  'F.DIST': {
    fn: ([x, df1, df2, cumulative]) => {
      const a = finArgs([x, df1, df2]); if (isError(a)) return a;
      const cum = toBool(cumulative); if (isError(cum)) return cum;
      const d1 = Math.trunc(a[1]);
      const d2 = Math.trunc(a[2]);
      if (a[0] < 0 || d1 < 1 || d2 < 1) return err('#NUM!');
      if (cum) { const f = fDistribution(a[0], d1, d2); return isError(f) ? f : f.p; }
      const lnB = gammaLn(d1 / 2) + gammaLn(d2 / 2) - gammaLn((d1 + d2) / 2);
      if (a[0] === 0) return d1 < 2 ? err('#NUM!') : d1 === 2 ? 1 : 0;
      return Math.exp(0.5 * (d1 * Math.log(d1 * a[0]) + d2 * Math.log(d2) - (d1 + d2) * Math.log(d1 * a[0] + d2)) - lnB) / a[0];
    },
  },
  'F.DIST.RT': {
    fn: ([x, df1, df2]) => {
      const a = finArgs([x, df1, df2]); if (isError(a)) return a;
      const d1 = Math.trunc(a[1]);
      const d2 = Math.trunc(a[2]);
      if (a[0] < 0 || d1 < 1 || d2 < 1) return err('#NUM!');
      const f = fDistribution(a[0], d1, d2);
      return isError(f) ? f : f.q;
    },
  },
  FDIST: { alias: 'F.DIST.RT' },
  'CONFIDENCE.NORM': {
    fn: ([alpha, sd, size]) => {
      const a = finArgs([alpha, sd, size]); if (isError(a)) return a;
      const n = Math.trunc(a[2]);
      if (a[0] <= 0 || a[0] >= 1 || a[1] <= 0 || n < 1) return err('#NUM!');
      return normInv(1 - a[0] / 2) * (a[1] / Math.sqrt(n));
    },
  },
  CONFIDENCE: { alias: 'CONFIDENCE.NORM' },
  'CONFIDENCE.T': {
    fn: ([alpha, sd, size]) => {
      const a = finArgs([alpha, sd, size]); if (isError(a)) return a;
      const n = Math.trunc(a[2]);
      if (a[0] <= 0 || a[0] >= 1 || a[1] <= 0 || n < 2) return err('#NUM!');
      const tail = flushUnderflow(a[0] / 2);
      if (tail === 0) return err('#NUM!');
      return tQuantile(tail, n - 1) * (a[1] / Math.sqrt(n));
    },
  },
  'Z.TEST': {
    fn: ([range, x, sigma]) => {
      const list = numbers([range]); if (isError(list)) return list;
      const mu = toNumber(x); if (isError(mu)) return mu;
      const n = list.length;
      if (!n) return err('#N/A');
      const m = numericMean(list);
      let sd;
      if (sigma === undefined) {
        if (n < 2) return err('#DIV/0!'); // the sample standard deviation needs two observations; a given sigma needs one
        sd = Math.sqrt(list.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1));
      } else { sd = toNumber(sigma); if (isError(sd)) return sd; }
      if (!sd) return err('#DIV/0!');
      return normCdf(-(m - mu) / (sd / Math.sqrt(n))); // the upper tail itself, where 1 - Φ(z) rounds to zero past 8 sigma
    },
  },
  ZTEST: { alias: 'Z.TEST' },

  /* More math */
  'CEILING.MATH': {
    fn: ([a, sig, mode]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const sigN = sig === undefined ? 1 : toNumber(sig); if (isError(sigN)) return sigN;
      const step = Math.abs(sigN);
      const m = mode === undefined ? 0 : toNumber(mode); if (isError(m)) return m;
      if (step === 0) return 0;
      if (n < 0 && m) return -toStep(-n, step, Math.ceil); // away from zero
      return toStep(n, step, Math.ceil);
    },
  },
  'FLOOR.MATH': {
    fn: ([a, sig, mode]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const sigN = sig === undefined ? 1 : toNumber(sig); if (isError(sigN)) return sigN;
      const step = Math.abs(sigN);
      const m = mode === undefined ? 0 : toNumber(mode); if (isError(m)) return m;
      if (step === 0) return 0;
      if (n < 0 && m) return -toStep(-n, step, Math.floor); // toward zero
      return toStep(n, step, Math.floor);
    },
  },
  'CEILING.PRECISE': { fn: ([a, sig]) => FUNCTIONS['CEILING.MATH'].fn([a, sig]) },
  'ISO.CEILING': { alias: 'CEILING.PRECISE' },
  'FLOOR.PRECISE': { fn: ([a, sig]) => FUNCTIONS['FLOOR.MATH'].fn([a, sig]) },
  ACOSH: { fn: unaryMath((x) => (x < 1 ? NaN : Math.acosh(x))) },
  ASINH: { fn: unaryMath((x) => Math.asinh(x)) },
  ATANH: { fn: unaryMath((x) => (x <= -1 || x >= 1 ? NaN : Math.atanh(x))) },
  // The reciprocal of a zero is #DIV/0!, as 1/0 is; checkNum would call the infinity #NUM!.
  COT: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : n === 0 ? err('#DIV/0!') : checkNum(1 / Math.tan(n)); } },
  ACOT: { fn: unaryMath((x) => Math.PI / 2 - Math.atan(x)) },
  SEC: { fn: unaryMath((x) => 1 / Math.cos(x)) },
  CSC: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : n === 0 ? err('#DIV/0!') : checkNum(1 / Math.sin(n)); } },
  COTH: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : n === 0 ? err('#DIV/0!') : checkNum(1 / Math.tanh(n)); } },
  SECH: { fn: unaryMath((x) => 1 / Math.cosh(x)) },
  CSCH: { fn: ([a]) => { const n = toNumber(a); return isError(n) ? n : n === 0 ? err('#DIV/0!') : checkNum(1 / Math.sinh(n)); } },
  ACOTH: { fn: unaryMath((x) => (Math.abs(x) <= 1 ? NaN : Math.atanh(1 / x))) },
  SQRTPI: { fn: unaryMath((x) => (x < 0 ? NaN : Math.sqrt(x * Math.PI))) },
  FACTDOUBLE: {
    fn: unaryMath((x) => {
      if (x < 0) return NaN; // before truncation: -1 and -0.5 are #NUM!
      const n = Math.trunc(x);
      if (n > 300) return NaN;
      let out = 1;
      for (let i = n; i > 1; i -= 2) out *= i;
      return out;
    }),
  },
  MULTINOMIAL: {
    fn: num((l) => {
      if (l.some((x) => x < 0)) return err('#NUM!');
      // (k1 + ... + km)! / (k1! ... km!) = C(k1, k1) C(k1 + k2, k2) ... C(k1 + ... + km, km)
      let total = 0;
      let out = 1;
      for (const x of l) { total += Math.trunc(x); out *= choose(total, Math.trunc(x)); }
      return checkNum(out);
    }),
  },
  COMBINA: {
    fn: ([n, k]) => {
      const a = finArgs([n, k]); if (isError(a)) return a;
      const N = Math.trunc(a[0]);
      const K = Math.trunc(a[1]);
      if (N < 0 || K < 0 || (N === 0 && K > 0)) return err('#NUM!');
      if (K === 0) return 1;
      return checkNum(choose(N + K - 1, K)); // combinations with repetition
    },
  },
  PERMUTATIONA: {
    fn: ([n, k]) => {
      const a = finArgs([n, k]); if (isError(a)) return a;
      const N = Math.trunc(a[0]);
      const K = Math.trunc(a[1]);
      if (N < 0 || K < 0) return err('#NUM!');
      return checkNum(N ** K);
    },
  },
  SERIESSUM: {
    fn: ([x, n, m, coeffs]) => {
      const a = finArgs([x, n, m]); if (isError(a)) return a;
      // Every coefficient is a term of the series, so one that is not a number (text, a boolean or an
      // empty cell among them) is #VALUE!, not a term left out; one given directly reads as a number.
      let cs;
      if (isRange(coeffs)) { cs = matrixOf(coeffs); if (isError(cs)) return cs; cs = cs.flat(); }
      else { const c = toNumber(coeffs); if (isError(c)) return c; cs = [c]; }
      let total = 0;
      cs.forEach((c, i) => { total += c * a[0] ** (a[1] + i * a[2]); });
      return checkNum(total);
    },
  },
  MMULT: {
    fn: ([a, b]) => {
      const A = matrixOf(a); if (isError(A)) return A;
      const B = matrixOf(b); if (isError(B)) return B;
      if (A[0].length !== B.length) return err('#VALUE!');
      const out = A.map((row) => B[0].map((_, j) => row.reduce((acc, v, k) => acc + v * B[k][j], 0)));
      return { range: true, values: out };
    },
    array: true,
  },
  MINVERSE: {
    fn: ([a]) => {
      const A = matrixOf(a); if (isError(A)) return A;
      // Shape errors are #VALUE!; only a square matrix can be singular (#NUM!).
      if (A.length !== A[0].length) return err('#VALUE!');
      const inv = invertMatrix(A);
      return inv ? { range: true, values: inv } : err('#NUM!');
    },
    array: true,
  },
  MDETERM: {
    fn: ([a]) => {
      const A = matrixOf(a); if (isError(A)) return A;
      if (A.length !== A[0].length) return err('#VALUE!');
      return determinant(A);
    },
  },
  MUNIT: {
    fn: ([n]) => {
      const k = toNumber(n); if (isError(k)) return k;
      const size = Math.trunc(k);
      if (size < 1 || size > 300) return err('#VALUE!');
      return { range: true, values: range0(size).map((r) => range0(size).map((c) => (r === c ? 1 : 0))) };
    },
    array: true,
  },
  /* Engineering */
  BASE: {
    fn: ([n, radix, minLength]) => {
      const a = finArgs([n, radix, minLength ?? 0]); if (isError(a)) return a;
      const v = Math.trunc(a[0]);
      const b = Math.trunc(a[1]);
      // The number runs from 0 to below 2^53, where a double still holds every integer, and min_length from 0 to 255.
      if (v < 0 || v >= 2 ** 53 || b < 2 || b > 36 || a[2] < 0 || a[2] >= 256) return err('#NUM!');
      return v.toString(b).toUpperCase().padStart(Math.trunc(a[2]), '0');
    },
  },
  DECIMAL: {
    fn: ([text, radix]) => {
      const t = textArg(text); if (isError(t)) return t;
      const b = toNumber(radix); if (isError(b)) return b;
      const base = Math.trunc(b);
      if (base < 2 || base > 36) return err('#NUM!');
      const digits = t.trim().toUpperCase();
      if (!digits) return 0;
      let out = 0;
      for (const ch of digits) {
        const d = parseInt(ch, 36);
        if (Number.isNaN(d) || d >= base) return err('#NUM!');
        out = out * base + d;
      }
      return out;
    },
  },
  BIN2DEC: { fn: ([t]) => fromBaseTwosComplement(t, 2, 10) },
  BIN2OCT: { fn: ([t, places]) => convertBase(t, 2, 8, places) },
  BIN2HEX: { fn: ([t, places]) => convertBase(t, 2, 16, places) },
  OCT2DEC: { fn: ([t]) => fromBaseTwosComplement(t, 8, 30) },
  OCT2BIN: { fn: ([t, places]) => convertBase(t, 8, 2, places) },
  OCT2HEX: { fn: ([t, places]) => convertBase(t, 8, 16, places) },
  HEX2DEC: { fn: ([t]) => fromBaseTwosComplement(t, 16, 40) },
  HEX2BIN: { fn: ([t, places]) => convertBase(t, 16, 2, places) },
  HEX2OCT: { fn: ([t, places]) => convertBase(t, 16, 8, places) },
  DEC2BIN: { fn: ([n, places]) => toBaseTwosComplement(n, 2, 10, places) },
  DEC2OCT: { fn: ([n, places]) => toBaseTwosComplement(n, 8, 30, places) },
  DEC2HEX: { fn: ([n, places]) => toBaseTwosComplement(n, 16, 40, places) },
  BITAND: { fn: ([a, b]) => bitOp(a, b, (x, y) => Number(BigInt(x) & BigInt(y))) },
  BITOR: { fn: ([a, b]) => bitOp(a, b, (x, y) => Number(BigInt(x) | BigInt(y))) },
  BITXOR: { fn: ([a, b]) => bitOp(a, b, (x, y) => Number(BigInt(x) ^ BigInt(y))) },
  BITLSHIFT: {
    fn: ([a, shift]) => {
      const n = toNumber(a); if (isError(n)) return n;
      const sh = toNumber(shift); if (isError(sh)) return sh;
      // Whole numbers only, as in the rest of the BIT family: 1.5 is refused rather than truncating it.
      if (!Number.isInteger(n) || !Number.isInteger(sh) || n < 0 || n >= 2 ** 48 || Math.abs(sh) > 53) return err('#NUM!');
      const out = sh >= 0 ? n * 2 ** sh : Math.floor(n / 2 ** -sh);
      return out >= 2 ** 48 ? err('#NUM!') : out;
    },
  },
  BITRSHIFT: { fn: ([a, shift]) => { const k = toNumber(shift); return isError(k) ? k : FUNCTIONS.BITLSHIFT.fn([a, -k]); } },
  DELTA: {
    fn: ([a, b]) => {
      const x = finArgs([a, b ?? 0]); if (isError(x)) return x;
      return x[0] === x[1] ? 1 : 0;
    },
  },
  GESTEP: {
    fn: ([a, step]) => {
      const x = finArgs([a, step ?? 0]); if (isError(x)) return x;
      return x[0] >= x[1] ? 1 : 0;
    },
  },
  ROMAN: {
    fn: ([n, form]) => {
      const x = toNumber(n); if (isError(x)) return x;
      // The form: 0 or TRUE is the classic spelling; 1 to 3 let a subtracted numeral
      // stand that many steps further from the one it is taken from (450 as LD, 490
      // as XD, 495 as VD); 4 or FALSE is the shortest spelling (499 as ID).
      let mode = 0;
      if (typeof form === 'boolean') mode = form ? 0 : 4;
      else if (form !== undefined) { const f = toNumber(form); if (isError(f)) return f; mode = Math.trunc(f); }
      let v = Math.trunc(x);
      if (v < 0 || v > 3999 || mode < 0 || mode > 4) return err('#VALUE!');
      const chars = 'MDCLXVI';
      const values = [1000, 500, 100, 50, 10, 5, 1];
      let out = '';
      for (let place = 0; place < 4; place++) {
        let index = 2 * place; // M, C, X, I
        const digit = Math.floor(v / values[index]);
        if (digit % 5 === 4) {
          const from = digit === 4 ? index - 1 : index - 2; // the numeral subtracted from: D, L, V for a 4; M, C, X for a 9
          for (let steps = 0; steps < mode && index < 6; steps++) {
            if (values[from] - values[index + 1] > v) break; // the shorter pair would exceed what is left
            index++;
          }
          out += chars[index] + chars[from];
          v += values[index] - values[from];
        } else {
          if (digit > 4) out += chars[index - 1];
          out += chars[index].repeat(digit % 5);
          v %= values[index];
        }
      }
      return out;
    },
  },
  ARABIC: {
    fn: ([text]) => {
      const t = textArg(text); if (isError(t)) return t;
      const roman = t.trim().toUpperCase();
      if (!roman) return 0;
      const neg = roman.startsWith('-');
      const body = neg ? roman.slice(1) : roman;
      if (!/^[MDCLXVI]+$/.test(body)) return err('#VALUE!');
      const val = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
      let total = 0;
      for (let i = 0; i < body.length; i++) {
        const cur = val[body[i]];
        const next = val[body[i + 1]] || 0;
        total += cur < next ? -cur : cur;
      }
      return neg ? -total : total;
    },
  },
  CONVERT: {
    fn: ([value, from, to]) => {
      const x = toNumber(value); if (isError(x)) return x;
      const f = textArg(from); if (isError(f)) return f;
      const t = textArg(to); if (isError(t)) return t;
      return convertUnits(x, f.trim(), t.trim());
    },
  },

  /* More finance */
  DB: {
    fn: ([cost, salvage, life, per, month]) => {
      const a = finArgs([cost, salvage, life, per, month ?? 12]); if (isError(a)) return a;
      const [c, sv, l, k, m] = a;
      if (c < 0 || sv < 0 || l <= 0 || k < 1 || m < 1 || m > 12 || k > Math.ceil(l) + (m < 12 ? 1 : 0)) return err('#NUM!');
      if (k > MAX_PERIODS) return err('#NUM!');
      const rate = Math.round((1 - (sv / c) ** (1 / l)) * 1000) / 1000;
      let book = c;
      let dep = 0;
      for (let i = 1; i <= k; i++) {
        if (i === 1) dep = (c * rate * m) / 12;
        else if (i === Math.trunc(l) + 1 && m < 12) dep = (book * rate * (12 - m)) / 12;
        else dep = book * rate;
        book -= dep;
        if (dep === 0) break; // a rate that rounds to zero leaves the book value where it is for every later period
      }
      return dep;
    },
  },
  VDB: {
    fn: ([cost, salvage, life, start, end, factor, noSwitch]) => {
      const a = finArgs([cost, salvage, life, start, end, factor ?? 2]); if (isError(a)) return a;
      const [c, sv, l, s0, e0, f] = a;
      const sw = noSwitch === undefined ? false : toBool(noSwitch); if (isError(sw)) return sw;
      if (c < 0 || sv < 0 || l <= 0 || s0 < 0 || e0 > l || s0 > e0 || f <= 0) return err('#NUM!');
      if (Math.ceil(e0) > MAX_PERIODS) return err('#NUM!');
      // Depreciation per whole period, declining balance switching to straight line unless told
      // not to, taken while the periods asked for last instead of over the whole life and kept.
      let total = 0;
      let book = c;
      for (let i = 1; i <= Math.ceil(e0); i++) {
        const ddb = Math.min(book * (f / l), Math.max(0, book - sv));
        const sln = Math.max(0, (book - sv) / (l - i + 1));
        const dep = sw ? ddb : Math.max(ddb, sln);
        book -= dep;
        const from = Math.max(s0, i - 1);
        const to = Math.min(e0, i);
        if (to > from) total += dep * (to - from);
      }
      return total;
    },
  },
  CUMIPMT: {
    fn: ([rate, nper, pv, start, end, type]) => cumulative([rate, nper, pv, start, end, type], 'IPMT'),
  },
  CUMPRINC: {
    fn: ([rate, nper, pv, start, end, type]) => cumulative([rate, nper, pv, start, end, type], 'PPMT'),
  },
  ISPMT: {
    fn: ([rate, per, nper, pv]) => {
      const a = finArgs([rate, per, nper, pv]); if (isError(a)) return a;
      const [r, k, n, p] = a;
      if (n === 0) return err('#DIV/0!');
      return -p * r * (1 - k / n);
    },
  },
  MIRR: {
    fn: ([values, finance, reinvest]) => {
      const flows = numbers([values]); if (isError(flows)) return flows;
      const a = finArgs([finance, reinvest]); if (isError(a)) return a;
      const [fr, rr] = a;
      const n = flows.length;
      const neg = flows.map((v) => (v < 0 ? v : 0));
      const pos = flows.map((v) => (v > 0 ? v : 0));
      if (!neg.some((v) => v) || !pos.some((v) => v)) return err('#DIV/0!');
      const npvNeg = neg.reduce((acc, v, i) => acc + v / (1 + fr) ** i, 0);
      const fvPos = pos.reduce((acc, v, i) => acc + v * (1 + rr) ** (n - 1 - i), 0);
      return checkNum((fvPos / -npvNeg) ** (1 / (n - 1)) - 1);
    },
  },
  PDURATION: {
    fn: ([rate, pv, fv]) => {
      const a = finArgs([rate, pv, fv]); if (isError(a)) return a;
      if (a[0] <= 0 || a[1] <= 0 || a[2] <= 0) return err('#NUM!');
      return (Math.log(a[2]) - Math.log(a[1])) / Math.log(1 + a[0]);
    },
  },
  RRI: {
    fn: ([nper, pv, fv]) => {
      const a = finArgs([nper, pv, fv]); if (isError(a)) return a;
      if (a[0] <= 0 || a[1] === 0) return err('#NUM!');
      return checkNum((a[2] / a[1]) ** (1 / a[0]) - 1);
    },
  },
  FVSCHEDULE: {
    fn: ([principal, schedule]) => {
      const p = toNumber(principal); if (isError(p)) return p;
      let out = p;
      for (const { v, inRange } of eachValue([schedule])) {
        if (isError(v)) return v;
        if (v == null) continue; // a blank cell is passed over
        // A value in the schedule is a number or a blank cell; text or a logical there is #VALUE!, as
        // documented and as NPV declines to read a rate from text, rather than a number to compound by.
        if (inRange && typeof v !== 'number') return err('#VALUE!');
        const r = toNumber(v); if (isError(r)) return r;
        out *= 1 + r;
      }
      return out;
    },
  },
  DOLLARDE: {
    fn: ([fractional, fraction]) => {
      const a = finArgs([fractional, fraction]); if (isError(a)) return a;
      const f = Math.trunc(a[1]);
      if (f < 0) return err('#NUM!');
      if (f === 0) return err('#DIV/0!');
      const whole = Math.trunc(a[0]);
      const frac = a[0] - whole;
      const digits = 10 ** Math.ceil(Math.log10(f));
      return whole + (frac * digits) / f;
    },
  },
  DOLLARFR: {
    fn: ([decimal, fraction]) => {
      const a = finArgs([decimal, fraction]); if (isError(a)) return a;
      const f = Math.trunc(a[1]);
      if (f < 0) return err('#NUM!');
      if (f === 0) return err('#DIV/0!');
      const whole = Math.trunc(a[0]);
      const frac = a[0] - whole;
      const digits = 10 ** Math.ceil(Math.log10(f));
      return whole + (frac * f) / digits;
    },
  },

  /* More information, text, and dates */
  ISNONTEXT: information((v) => typeof v !== 'string'),
  // A union or a Sheet1:Sheet3!A1 span has no single address but is a reference when each of its areas is.
  ISREF: { fn: ([a]) => isRange(a) && (!!a.ref || (!!a.areas?.length && a.areas.every((area) => !!area.ref))), refArgs: true, tolerant: true },
  // The domain is labels of letters, digits and inner hyphens joined by dots, so "a@b.com," or "a@-b.com" is no address.
  // Each cell of a range is judged on its own, as the other IS functions do, rather than the range as a whole being no text.
  ISEMAIL: information((v) => typeof v === 'string' && /^[^\s@"]+@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u.test(v.trim())),
  ISURL: information((v) => typeof v === 'string' && isWebAddress(v.trim())),
  ISBETWEEN: {
    fn: ([value, lo, hi, loInc, hiInc]) => {
      const v = scalar(value);
      const a = scalar(lo);
      const b = scalar(hi);
      const li = loInc === undefined ? true : toBool(loInc); if (isError(li)) return li;
      const hi2 = hiInc === undefined ? true : toBool(hiInc); if (isError(hi2)) return hi2;
      if (v == null || a == null || b == null) return err('#VALUE!');
      const c1 = compareValues(v, a);
      const c2 = compareValues(v, b);
      return (li ? c1 >= 0 : c1 > 0) && (hi2 ? c2 <= 0 : c2 < 0);
    },
  },
  ENCODEURL: {
    fn: ([a]) => {
      const t = textArg(a); if (isError(t)) return t;
      // Half a surrogate pair, which pasted or imported text can hold, is no character to encode: it
      // goes in as the replacement character, as a URL parser writes it, rather than being thrown over.
      const wellFormed = t.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
      const encoded = encodeURIComponent(wellFormed).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
      return encoded.length > MAX_TEXT ? err('#VALUE!') : encoded; // escaping can triple the text past what a cell holds
    },
  },
  ARRAYTOTEXT: {
    fn: ([a, format]) => {
      const f = format === undefined ? 0 : toNumber(format); if (isError(f)) return f;
      const mode = Math.trunc(f);
      if (mode !== 0 && mode !== 1) return err('#VALUE!');
      const rows = asRange(a).values;
      const [between, betweenRows, open, close] = mode === 1 ? [',', ';', '{', '}'] : [', ', ', ', '', ''];
      // The pieces are measured as they are listed, so a range too long to fit a cell is refused
      // rather than joined first: more than a cell holds is #VALUE!, as for CONCAT and TEXTJOIN.
      const parts = [open];
      let length = open.length + close.length;
      for (let r = 0; r < rows.length; r++) {
        if (r) { parts.push(betweenRows); length += betweenRows.length; }
        for (let c = 0; c < rows[r].length; c++) {
          if (c) { parts.push(between); length += between.length; }
          const piece = valueAsText(rows[r][c], mode === 1);
          parts.push(piece);
          length += piece.length;
          if (length > MAX_TEXT) return err('#VALUE!');
        }
      }
      parts.push(close);
      return parts.join('');
    },
    tolerant: true,
  },
  VALUETOTEXT: {
    fn: ([a, format]) => {
      const f = format === undefined ? 0 : toNumber(format); if (isError(f)) return f;
      const mode = Math.trunc(f);
      if (mode !== 0 && mode !== 1) return err('#VALUE!');
      const out = valueAsText(scalar(a), mode === 1);
      return out.length > MAX_TEXT ? err('#VALUE!') : out; // the strict form's quotes can push text past what a cell holds
    },
    tolerant: true,
  },
  INFO: {
    callerContext: args => args[0]?.type === 'str' && args[0].value.trim().toLowerCase() !== 'numfile' ? [] : ['count'],
    fn: ([type], ctx) => {
      const t = textArg(type); if (isError(t)) return t;
      switch (t.trim().toLowerCase()) {
        case 'directory': return '/';
        case 'numfile': return ctx?.sheetCount ? ctx.sheetCount() : 1;
        case 'origin': return '$A:$A$1';
        case 'osversion': return typeof navigator !== 'undefined' ? navigator.platform || 'Web' : 'Web';
        case 'recalc': return 'Automatic';
        case 'release': return '1.0';
        case 'system': return 'web';
        default: return err('#VALUE!');
      }
    },
  },
  FILTERXML: {
    fn: ([xml, xpath]) => {
      const text = textArg(xml); if (isError(text)) return text;
      const path = textArg(xpath); if (isError(path)) return path;
      const rows = rowsFromXml(text, path, parseInput);
      if (rows && rows.error) return err(rows.error);
      return { range: true, values: rows };
    },
    array: true,
  },
  CELL: {
    callerContext: args => args.length < 2 ? ['row', 'col', 'sheet'] : ['sheet'],
    fn: ([info, ref], ctx) => {
      const kind = textArg(info); if (isError(kind)) return kind;
      // The reference is a cell or a range, not a text like "B3" or an array: #VALUE!.
      if (ref !== undefined && !(isRange(ref) && ref.ref)) return isError(ref) ? ref : err('#VALUE!');
      const target = ref ? ref.ref : { r1: ctx.cell.r, c1: ctx.cell.c, sheet: null };
      const r = target.r1;
      const c = target.c1;
      switch (kind.trim().toLowerCase()) {
        case 'address': {
          // A cell of another sheet is named with its sheet, quoted as Sheets writes it: 'Data'!$B$3.
          const own = !target.sheet || target.sheet.toLowerCase() === (ctx.currentSheet || '').toLowerCase();
          return `${own ? '' : `'${target.sheet.replace(/'/g, "''")}'!`}$${colName(c)}$${r + 1}`;
        }
        case 'row': return r + 1;
        case 'col': return c + 1;
        // Without a reference the only cell to read is this one, whose value is being calculated.
        case 'contents': { if (!ref) return err('#VALUE!'); const v = ctx.getValue(target.sheet, r, c); return v == null ? 0 : v; }
        // "b" is an empty cell alone; a formula's "" is text, "l", as ISBLANK of it is FALSE.
        case 'type': { if (!ref) return err('#VALUE!'); const v = ctx.getValue(target.sheet, r, c); return v == null ? 'b' : typeof v === 'string' ? 'l' : 'v'; }
        case 'filename': return '';
        default: return err('#VALUE!');
      }
    },
    refArgs: true,
  },
  ARRAY_CONSTRAIN: {
    fn: ([a, rows, cols]) => {
      const v = asRange(a).values;
      const R = toNumber(rows); if (isError(R)) return R;
      const C = toNumber(cols); if (isError(C)) return C;
      const nr = Math.trunc(R);
      const nc = Math.trunc(C);
      if (nr < 1 || nc < 1) return err('#VALUE!');
      return { range: true, values: v.slice(0, nr).map((row) => row.slice(0, nc).map((x) => x ?? null)) };
    },
    array: true,
    tolerant: true,
  },
  // Lifted over the dates and the day count as NETWORKDAYS and WORKDAY are; the weekend and holidays stay whole.
  'NETWORKDAYS.INTL': {
    refArgs: true,
    liftArgs: [0, 1],
    fn: overArguments(([start, end, weekend, holidays]) => {
      const s = toNumber(start); if (isError(s)) return s;
      const e = toNumber(end); if (isError(e)) return e;
      const off = weekendDays(weekend); if (isError(off)) return off;
      const hol = holidaySet(holidays); if (isError(hol)) return hol;
      if (!validCalendarDay(s) || !validCalendarDay(e)) return err('#NUM!');
      const n = workingDays(Math.trunc(Math.min(s, e)), Math.trunc(Math.max(s, e)), off, hol);
      return e < s ? -n : n;
    }, [0, 1]),
  },
  'WORKDAY.INTL': {
    refArgs: true,
    liftArgs: [0, 1],
    fn: overArguments(([start, days, weekend, holidays]) => {
      const s = toNumber(start); if (isError(s)) return s;
      const k = toNumber(days); if (isError(k)) return k;
      const off = weekendDays(weekend); if (isError(off)) return off;
      if (off.size >= 7) return err('#VALUE!');
      const hol = holidaySet(holidays); if (isError(hol)) return hol;
      if (!validCalendarDay(s) || !validCalendarDay(Math.trunc(s) + Math.trunc(k))) return err('#NUM!');
      const d = workingDaysFrom(Math.trunc(s), Math.abs(Math.trunc(k)), k < 0 ? -1 : 1, off, hol);
      return validCalendarDay(d) ? d : err('#NUM!'); // weekends and holidays may carry the day past the calendar
    }, [0, 1]),
  },
  EPOCHTODATE: {
    fn: ([ts, unit]) => {
      const t = toNumber(ts); if (isError(t)) return t;
      const u = unit === undefined ? 1 : toNumber(unit); if (isError(u)) return u;
      const div = { 1: 1, 2: 1000, 3: 1000000 }[Math.trunc(u)];
      if (!div) return err('#VALUE!');
      // Unix epoch is serial 25569 (1970-01-01).
      return 25569 + t / div / 86400;
    },
  },

  /* Database functions: a table with a header row, a field, and a criteria table */
  DSUM: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, worksheetSum) },
  DAVERAGE: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, (l) => (l.length ? worksheetMean(l) : err('#DIV/0!'))) },
  DCOUNT: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, (l) => l.length, { allowAnyField: true }) },
  DCOUNTA: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, null, { countAll: true, allowAnyField: true }) },
  DMAX: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, (l) => (l.length ? maximum(l) : 0)) },
  DMIN: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, (l) => (l.length ? minimum(l) : 0)) },
  DPRODUCT: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, product) }, // nothing to multiply is 0, as PRODUCT answers
  // Database sample statistics check the selected record count before raw moments.
  DSTDEV: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, (l) => (l.length < 2 ? err('#DIV/0!') : sampleStdev(l))) },
  DSTDEVP: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, (l) => populationStdev(l)) },
  DVAR: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, (l) => { const sd = l.length < 2 ? err('#DIV/0!') : sampleStdev(l); return isError(sd) ? sd : sd * sd; }) },
  DVARP: { fn: ([db, field, crit]) => dbAggregate(db, field, crit, (l) => { const sd = populationStdev(l); return isError(sd) ? sd : sd * sd; }) },
  DGET: {
    fn: ([db, field, crit]) => {
      const picked = dbSelect(db, field, crit); if (isError(picked)) return picked;
      // The records that match are counted, whatever the field holds: none is #VALUE!, several #NUM!.
      if (!picked.length) return err('#VALUE!');
      if (picked.length > 1) return err('#NUM!');
      return picked[0] ?? null;
    },
  },

  /* A picture inside a cell */
  IMAGE: {
    // IMAGE(url, [mode]) with mode 1 fit, 2 stretch, 3 original size; or, with text second,
    // IMAGE(url, alt_text, [sizing]) with sizing 0 fit, 1 fill, 2 original size, 3 custom (fitted here).
    fn: ([url, mode, sizing], ctx) => {
      const u = textArg(url); if (isError(u)) return u;
      const t = u.trim();
      if (!/^https?:\/\/\S+$/i.test(t) && !/^data:image\/[a-z0-9.+-]+;base64,/i.test(t)) return err('#VALUE!');
      if (/^https?:/i.test(t) && ctx?.externalBlocked?.()) return err('#BLOCKED!');
      if (typeof scalar(mode) === 'string' || sizing !== undefined) {
        const alt = mode === undefined ? '' : textArg(mode); if (isError(alt)) return alt;
        const s = sizing === undefined ? 0 : toNumber(sizing); if (isError(s)) return s;
        const fit = { 0: 'contain', 1: 'stretch', 2: 'original', 3: 'contain' }[Math.trunc(s)];
        if (!fit) return err('#VALUE!');
        return { image: t, fit, ...(String(alt).trim() ? { alt: String(alt).trim().slice(0, 2000) } : {}) };
      }
      const m = mode === undefined ? 1 : toNumber(mode); if (isError(m)) return m;
      const fit = { 1: 'contain', 2: 'stretch', 3: 'original' }[Math.trunc(m)];
      if (!fit) return err('#VALUE!');
      return { image: t, fit };
    },
  },
};

/** Coerce a list of financial arguments to numbers, propagating the first error. */
function finArgs(list) {
  const out = [];
  for (const a of list) {
    const n = toNumber(a);
    if (isError(n)) return n;
    out.push(n);
  }
  return out;
}

/**
 * Newton's method on a cash-flow function, falling back to bisection. The balance counts as
 * zero relative to `scale`, the largest flow, so a schedule in billionths converges to its
 * rate as one in billions does instead of stopping at the guess.
 */
function solveRate(f, guess, scale) {
  const tolerance = 1e-12 * scale;
  let r = guess;
  for (let i = 0; i < 100; i++) {
    const y = f(r);
    if (Math.abs(y) < tolerance) return r;
    const h = 1e-7;
    const dy = (f(r + h) - y) / h;
    if (!Number.isFinite(dy) || dy === 0) break;
    const next = r - y / dy;
    if (!Number.isFinite(next) || next <= -1) break;
    if (Math.abs(next - r) < 1e-12) return next;
    r = next;
  }
  // Bisection needs a bracket with a strict sign change. Discounting hundreds of flows
  // at a rate near -1 overflows, so the low end starts at 0 and walks toward -1
  // only while f stays finite and keeps the sign it has at the high end. Signs are
  // compared rather than multiplied: a product hides an end that sits exactly on the
  // root (f = 0, so no half ever changes sign and the loop walks the answer away from
  // it) and underflows to zero for two tiny balances of the same sign.
  let hi = 10;
  const fhi = f(hi);
  if (fhi === 0) return hi;
  let lo = 0;
  let flo = f(lo);
  for (let k = 1; k <= 16 && Number.isFinite(flo) && flo !== 0 && Math.sign(flo) === Math.sign(fhi); k++) {
    const next = -1 + 2 ** -k;
    const fnext = f(next);
    if (!Number.isFinite(fnext)) break;
    lo = next;
    flo = fnext;
  }
  if (flo === 0) return lo;
  if (!Number.isFinite(flo) || !Number.isFinite(fhi) || Math.sign(flo) === Math.sign(fhi)) return err('#NUM!');
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < tolerance) return mid;
    if (!Number.isFinite(fm)) return err('#NUM!');
    if (Math.sign(fm) === Math.sign(flo)) { lo = mid; flo = fm; } else hi = mid;
  }
  // The halves keep a strict sign change around the root, so the last one is the
  // rate to the last bit even when the balance there is coarser than the tolerance.
  return (lo + hi) / 2;
}

function isoWeek(serial) {
  const { y, m, d } = serialToYMD(serial);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - dow + 3); // the Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/** Reject dates outside the calendar before a day-by-day loop. */
function validCalendarDay(serial) {
  return Number.isFinite(serial) && serial >= 0 && serial < MAX_DATE_SERIAL + 1;
}

/** Holiday argument (a range, a value, or nothing) → a Set of whole-day serials, or an error. */
function holidaySet(arg) {
  const set = new Set();
  if (arg === undefined) return set;
  // Only a reference reads cells. An array constant ({"2006/1/2","2006/1/16"})
  // is a range too, but its text was written into the formula.
  const cells = isRange(arg) && arg.ref != null;
  for (const { v } of eachValue([arg])) {
    if (isError(v)) return v;
    if (typeof v === 'number') set.add(Math.trunc(v));
    // A date written as text ("2024-01-15") counts when written into the formula;
    // text in a cell, whether the reference is one cell or many, is no holiday and is passed over.
    else if (typeof v === 'string' && !cells) { const n = toNumber(v); if (isError(n)) return n; set.add(Math.trunc(n)); }
  }
  return set;
}

function days360(start, end, european, gregorianEnds = false) {
  const a = serialToYMD(start);
  const b = serialToYMD(end);
  let d1 = a.d;
  let d2 = b.d;
  if (european) {
    if (d1 === 31) d1 = 30;
    if (d2 === 31) d2 = 30;
  } else {
    // Native DAYS360 recognizes the serial calendar's fictitious month end;
    // YEARFRAC basis 0 retains Gregorian February-end adjustments instead.
    const lastOf = (y, m) => !gregorianEnds && y === 1900 && m === 2 ? 29 : new Date(Date.UTC(y, m, 0)).getUTCDate();
    const aLast = a.d === lastOf(a.y, a.m);
    if (a.m === 2 && aLast && b.m === 2 && b.d === lastOf(b.y, b.m)) d2 = 30;
    if (d1 === 31 || (a.m === 2 && aLast)) d1 = 30;
    if (d2 === 31 && d1 === 30) d2 = 30;
  }
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1);
}

/** Call a lambda; whatever it returns. */
function lambdaValue(fn, args) {
  return invoke(fn, args);
}

/** Call a lambda for one cell of a result: a 1x1 range collapses, anything larger is #CALC!. */
/**
 * The inputs GROUPBY and PIVOTBY share: parallel row-field, value, and
 * (optional) column-field ranges, with headers taken off when field_headers
 * says the first row holds them (1 or 3; 2 and 3 show headers in the
 * result) and rows dropped where filter_array is FALSE.
 */
function groupInputs(rowFields, values, fieldHeaders, filterArray, colFields) {
  // A whole column is read only to its own sheet's used area, so fields from different sheets arrive
  // with different lengths although each names every row: they are padded to one window first, as
  // FILTER and SORTBY pair theirs, rather than being refused as fields of unequal height.
  const given = [asRange(rowFields), asRange(values)];
  if (colFields !== undefined) given.push(asRange(colFields));
  if (filterArray !== undefined) given.push(asRange(filterArray));
  const [rowRange, valRange, ...more] = alignWindows(given, 'rows');
  const filterRange = filterArray === undefined ? null : more[more.length - 1];
  const keys = rowRange.values.map((r) => r.slice());
  const vals = valRange.values.map((r) => r.slice());
  const cols = colFields === undefined ? null : more[0].values.map((r) => [r[0] ?? null]);
  if (!keys.length || keys.length !== vals.length || (cols && cols.length !== keys.length)) return err('#VALUE!');
  let mode = fieldHeaders === undefined ? 0 : toNumber(fieldHeaders); if (isError(mode)) return mode;
  mode = Math.trunc(mode); // 1.5 is checked as 1 and read as 1, not checked as 1 and read as neither
  if (![0, 1, 2, 3].includes(mode)) return err('#VALUE!');
  const hasHeaders = mode === 1 || mode === 3;
  const showHeaders = mode === 2 || mode === 3;
  const nKeys = keys[0].length;
  const nVals = vals[0].length;
  const keyHeaders = hasHeaders ? keys[0].map((h, i) => (h == null || h === '' ? `Column${i + 1}` : h)) : keys[0].map((_, i) => `Column${i + 1}`);
  const valHeaders = hasHeaders ? vals[0].map((h, i) => (h == null || h === '' ? `Column${nKeys + i + 1}` : h)) : vals[0].map((_, i) => `Column${nKeys + i + 1}`);
  const start = hasHeaders ? 1 : 0;
  const keep = keys.map((_, i) => i >= start);
  if (filterArray !== undefined) {
    const f = filterRange.values.map((r) => r[0]);
    const flags = f.length === keys.length ? f : f.length === keys.length - start ? [...Array(start).fill(true), ...f] : null;
    if (!flags) return err('#VALUE!');
    for (let i = 0; i < keep.length; i++) {
      if (!keep[i]) continue;
      const b = toBool(flags[i]); if (isError(b)) return b;
      keep[i] = b;
    }
  }
  const pick = (list) => list.filter((_, i) => keep[i]);
  return { keys: pick(keys), vals: pick(vals), cols: cols ? pick(cols) : null, nKeys, nVals, keyHeaders, valHeaders, showHeaders };
}

/** Distinct key tuples in order of first appearance, each with the indices of its rows. */
function groupRows(keys) {
  const groups = new Map();
  keys.forEach((tuple, i) => {
    const key = tuple.map(valueKey).join('');
    if (!groups.has(key)) groups.set(key, { keys: tuple.map((k) => k ?? null), idx: [] });
    groups.get(key).idx.push(i);
  });
  return [...groups.values()];
}

/**
 * Sort groups: by their key columns ascending when no order is given, or by
 * output column |order| (1-based: key columns first, then the summaries
 * `aggAt(group, j)` gives), descending for a negative order. An order past
 * the output's `width` columns names nothing to sort by and is #VALUE!.
 */
function sortGroups(groups, order, nKeys, aggAt, width) {
  const byKeys = (a, b) => { for (let k = 0; k < nKeys; k++) { const c = compareStoredValues(a.keys[k] ?? '', b.keys[k] ?? ''); if (c) return c; } return 0; };
  const col = order == null ? 0 : Math.abs(Math.trunc(order));
  if (col === 0) { groups.sort(byKeys); return null; }
  if (col > width) return err('#VALUE!');
  const dir = order < 0 ? -1 : 1;
  // Each group's sort value is worked out once, not once per comparison: a summary is a lambda call.
  const value = new Map(groups.map((grp) => [grp, (col <= nKeys ? grp.keys[col - 1] : aggAt(grp, col - nKeys - 1)) ?? null]));
  // An empty summary (a pivot cell with no rows, a lambda's "") and an error sort last whichever the
  // direction, as SORT and SORTBY place them; read as the text "" an empty one ranked above every
  // number and led a descending order.
  const empty = (v) => v == null || v === '';
  const compare = (p, q) => {
    if (empty(p) !== empty(q)) return empty(p) ? 1 : -1;
    if (empty(p)) return 0;
    if (isError(p) !== isError(q)) return isError(p) ? 1 : -1;
    if (isError(p)) return 0;
    return dir * compareStoredValues(p, q);
  };
  groups.sort((a, b) => compare(value.get(a), value.get(b)) || byKeys(a, b));
  return null;
}

/** One summary: the function over column j of the value rows at `idx`, as a scalar. */
function summarize(fn, vals, idx, j) {
  const part = { range: true, values: idx.map((i) => [vals[i][j] ?? null]) };
  if (fn.native !== FUNCTIONS.PERCENTOF) return lambdaScalar(fn, [part]);
  // PERCENTOF named as the function takes the whole value column (the rows a filter kept) as its
  // data_all, so each group's summary is its share of everything, rather than
  // PERCENTOF of a subset alone, which has nothing to divide by.
  let byColumn = wholeColumns.get(vals);
  if (!byColumn) wholeColumns.set(vals, byColumn = new Map());
  let all = byColumn.get(j);
  if (!all) byColumn.set(j, all = { range: true, values: vals.map((row) => [row[j] ?? null]) });
  return lambdaScalar(fn, [part, all]);
}
const wholeColumns = new WeakMap(); // a GROUPBY's value rows → Map(column → that column as a range), built once per call rather than per group

function lambdaScalar(fn, args) {
  const v = invoke(fn, args);
  if (isRange(v)) {
    if (v.values.length === 1 && v.values[0].length === 1) return v.values[0][0] ?? null;
    return err('#CALC!');
  }
  if (isLambda(v)) return err('#CALC!');
  return v === undefined ? null : v;
}

/** Text for ARRAYTOTEXT / VALUETOTEXT: strict mode quotes strings and spells errors. */
function valueAsText(v, strict) {
  if (v == null) return '';
  if (isError(v)) return v.error;
  if (typeof v === 'object') return '#VALUE!'; // a sparkline or other drawable has no text
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return formatNumberText(v);
  return strict ? `"${String(v).replace(/"/g, '""')}"` : String(v);
}

function isWebAddress(text) {
  if (!/^(https?:\/\/|ftp:\/\/|mailto:|www\.)/i.test(text) && !/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text)) return false;
  try { new URL(/^[a-z]+:/i.test(text) ? text : `https://${text}`); return true; } catch { return false; }
}

/**
 * The weekend argument of NETWORKDAYS.INTL / WORKDAY.INTL: 1-7 and 11-17
 * codes, or seven characters of 0/1 starting Monday. Returns a Set of
 * JavaScript weekday numbers (0 = Sunday).
 */
function weekendDays(arg) {
  if (arg === undefined || arg === null) return new Set([0, 6]);
  const v = scalar(arg);
  if (typeof v === 'string') {
    if (!/^[01]{7}$/.test(v)) return err('#VALUE!');
    const set = new Set();
    for (let i = 0; i < 7; i++) if (v[i] === '1') set.add((i + 1) % 7);
    return set;
  }
  const n = toNumber(v); if (isError(n)) return n;
  const k = Math.trunc(n);
  const pairs = { 1: [6, 0], 2: [0, 1], 3: [1, 2], 4: [2, 3], 5: [3, 4], 6: [4, 5], 7: [5, 6], 11: [0], 12: [1], 13: [2], 14: [3], 15: [4], 16: [5], 17: [6] };
  if (!pairs[k]) return err('#NUM!');
  return new Set(pairs[k]);
}

/** CUMIPMT / CUMPRINC: the interest (or principal) paid between two periods, as a negative number. */
function cumulative(argList, part) {
  const [rate, nper, pv, start, end, type] = argList;
  const a = finArgs([rate, nper, pv, start, end, type ?? 0]); if (isError(a)) return a;
  const [r, n, p, s0, e0, t] = a;
  const s = Math.trunc(s0);
  const e = Math.trunc(e0);
  if (r <= 0 || n <= 0 || p <= 0 || s < 1 || e < s || e > n || (t !== 0 && t !== 1)) return err('#NUM!');
  let total = 0;
  for (let k = s; k <= e; k++) {
    const v = FUNCTIONS[part].fn([r, k, n, p, 0, t]);
    if (isError(v)) return v;
    total += v;
  }
  return total;
}

/* ---------- Matrix and engineering helpers ---------- */

/** A range as a numeric matrix; anything that is not a number is #VALUE!. */
function matrixOf(v) {
  const rows = asRange(v).values;
  if (!rows.length || !rows[0]?.length) return err('#VALUE!');
  const out = [];
  for (const row of rows) {
    const line = [];
    for (const x of row) {
      if (isError(x)) return x;
      if (typeof x !== 'number') return err('#VALUE!');
      line.push(x);
    }
    out.push(line);
  }
  return out;
}

function determinant(A) {
  const n = A.length;
  const m = A.map((row) => [...row]);
  let det = 1;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(m[r][i]) > Math.abs(m[pivot][i])) pivot = r;
    if (Math.abs(m[pivot][i]) < 1e-300) return 0;
    if (pivot !== i) { [m[i], m[pivot]] = [m[pivot], m[i]]; det = -det; }
    det *= m[i][i];
    for (let r = i + 1; r < n; r++) {
      const f = m[r][i] / m[i][i];
      for (let c = i; c < n; c++) m[r][c] -= f * m[i][c];
    }
  }
  return det;
}

/** Gauss-Jordan inverse, or null when the matrix is singular or not square. */
function invertMatrix(A) {
  const n = A.length;
  if (A[0].length !== n) return null;
  const m = A.map((row, i) => [...row, ...range0(n).map((j) => (i === j ? 1 : 0))]);
  // Singular means a pivot negligible against the matrix's own scale, not against a fixed 1e-12:
  // a matrix of tiny (or huge) numbers is as invertible as one of ordinary ones.
  const scale = Math.max(...A.flat().map(Math.abs));
  if (!(scale > 0) || !Number.isFinite(scale)) return null;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(m[r][i]) > Math.abs(m[pivot][i])) pivot = r;
    if (Math.abs(m[pivot][i]) <= scale * 1e-14) return null;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    const p = m[i][i];
    for (let c = 0; c < 2 * n; c++) m[i][c] /= p;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const f = m[r][i];
      if (!f) continue;
      for (let c = 0; c < 2 * n; c++) m[r][c] -= f * m[i][c];
    }
  }
  return m.map((row) => row.slice(n));
}

/** BIN2DEC and friends: up to 10 (binary), 30 (octal), or 40 (hex) bits, two's complement for negatives. */
function fromBaseTwosComplement(text, base, bits) {
  const t = typeof text === 'number' ? String(text) : textArg(text);
  if (isError(t)) return t;
  const digits = t.trim().toUpperCase();
  const width = bits === 10 ? 10 : 10; // every base-conversion function takes at most 10 characters
  if (!digits) return 0;
  if (digits.length > width) return err('#NUM!');
  const valid = base === 2 ? /^[01]+$/ : base === 8 ? /^[0-7]+$/ : /^[0-9A-F]+$/;
  if (!valid.test(digits)) return err('#NUM!');
  const n = parseInt(digits, base);
  const span = base ** width; // 2^10, 8^10 = 2^30, 16^10 = 2^40
  return digits.length === width && n >= span / 2 ? n - span : n;
}

function toBaseTwosComplement(value, base, bits, places) {
  const x = toNumber(value); if (isError(x)) return x;
  const n = Math.trunc(x);
  const half = 2 ** (bits - 1);
  if (n < -half || n >= half) return err('#NUM!');
  const pl = places === undefined ? null : toNumber(places); if (isError(pl)) return pl;
  if (n < 0) return (n + 2 ** bits).toString(base).toUpperCase();
  const digits = n.toString(base).toUpperCase();
  if (pl == null) return digits;
  const width = Math.trunc(pl);
  if (width < digits.length || width > 10) return err('#NUM!');
  return digits.padStart(width, '0');
}

function convertBase(text, fromBase, toBase, places) {
  const bits = fromBase === 2 ? 10 : fromBase === 8 ? 30 : 40;
  const n = fromBaseTwosComplement(text, fromBase, bits); if (isError(n)) return n;
  const toBits = toBase === 2 ? 10 : toBase === 8 ? 30 : 40;
  return toBaseTwosComplement(n, toBase, toBits, places);
}

function bitOp(a, b, f) {
  const x = finArgs([a, b]); if (isError(x)) return x;
  if (x.some((v) => v < 0 || v >= 2 ** 48 || !Number.isInteger(v))) return err('#NUM!');
  return f(x[0], x[1]);
}

/* CONVERT: every unit is a factor to its group's base unit; temperatures are special. */
const UNIT_PREFIXES = { Y: 1e24, Z: 1e21, E: 1e18, P: 1e15, T: 1e12, G: 1e9, M: 1e6, k: 1e3, h: 1e2, da: 1e1, e: 1e1, d: 1e-1, c: 1e-2, m: 1e-3, u: 1e-6, n: 1e-9, p: 1e-12, f: 1e-15, a: 1e-18, z: 1e-21, y: 1e-24, ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6, Zi: 1024 ** 7, Yi: 1024 ** 8 };
const UNIT_GROUPS = {
  mass: { g: 1, sg: 14593.9029372064, lbm: 453.59237, u: 1.66053886282828e-24, ozm: 28.349523125, grain: 0.06479891, cwt: 45359.237, shweight: 45359.237, uk_cwt: 50802.34544, lcwt: 50802.34544, hweight: 50802.34544, stone: 6350.29318, ton: 907184.74, uk_ton: 1016046.9088, LTON: 1016046.9088, brton: 1016046.9088 },
  length: { m: 1, mi: 1609.344, Nmi: 1852, in: 0.0254, ft: 0.3048, yd: 0.9144, ang: 1e-10, ell: 1.143, ly: 9.46073047258e15, parsec: 3.08567758128155e16, pc: 3.08567758128155e16, Pica: 0.000352777777777778, Picapt: 0.000352777777777778, pica: 0.00423333333333333, survey_mi: 1609.34721869444 },
  time: { yr: 31557600, day: 86400, d: 86400, hr: 3600, mn: 60, min: 60, sec: 1, s: 1 },
  pressure: { Pa: 1, p: 1, atm: 101325, at: 101325, mmHg: 133.322, psi: 6894.75729316836, Torr: 133.322368421053 },
  force: { N: 1, dyn: 1e-5, dy: 1e-5, lbf: 4.4482216152605, pond: 0.00980665 },
  energy: { J: 1, e: 1e-7, c: 4.184, cal: 4.1868, eV: 1.602176565e-19, ev: 1.602176565e-19, HPh: 2684519.53769617, hh: 2684519.53769617, Wh: 3600, wh: 3600, flb: 1.3558179483314, BTU: 1055.05585262, btu: 1055.05585262 },
  power: { W: 1, w: 1, HP: 745.69987158227, h: 745.69987158227, PS: 735.49875 },
  magnetism: { T: 1, ga: 1e-4 },
  volume: { l: 0.001, L: 0.001, lt: 0.001, tsp: 4.92892159375e-6, tspm: 5e-6, tbs: 1.478676478125e-5, oz: 2.95735295625e-5, cup: 2.365882365e-4, pt: 4.73176473e-4, us_pt: 4.73176473e-4, uk_pt: 5.6826125e-4, qt: 9.46352946e-4, uk_qt: 0.0011365225, gal: 0.003785411784, uk_gal: 0.00454609, 'm3': 1, ang3: 1e-30, barrel: 0.158987294928, bushel: 0.03523907016688, 'ft3': 0.028316846592, 'in3': 1.6387064e-5, 'ly3': 8.46786664623715e47, 'mi3': 4168181825.44058, 'yd3': 0.764554857984, MTON: 1.13267386368, GRT: 2.8316846592, regton: 2.8316846592, 'Nmi3': 6352182208, 'Pica3': 4.39039566186557e-11, 'Picapt3': 4.39039566186557e-11 },
  area: { 'm2': 1, uk_acre: 4046.8564224, us_acre: 4046.87260987425, 'ang2': 1e-20, ar: 100, 'ft2': 0.09290304, ha: 10000, 'in2': 0.00064516, 'ly2': 8.95054210748189e31, Morgen: 2500, 'mi2': 2589988.110336, 'Nmi2': 3429904, 'Pica2': 1.24452160493827e-7, 'Picapt2': 1.24452160493827e-7, 'yd2': 0.83612736 },
  information: { bit: 1, byte: 8 },
  speed: { 'm/s': 1, 'm/sec': 1, 'm/h': 1 / 3600, 'm/hr': 1 / 3600, mph: 0.44704, kn: 0.514444444444444, admkn: 0.514773333333333 },
};
// Units that accept metric prefixes (km, mg, ms, kPa, kWh, GB, ...).
const PREFIXABLE = new Set(['g', 'u', 'm', 'ang', 'ly', 'parsec', 'pc', 'sec', 's', 'Pa', 'p', 'atm', 'at', 'mmHg', 'N', 'dyn', 'dy', 'pond', 'J', 'e', 'c', 'cal', 'eV', 'ev', 'Wh', 'wh', 'W', 'w', 'T', 'ga', 'l', 'L', 'lt', 'tspm', 'm3', 'ang3', 'ly3', 'm2', 'ang2', 'ly2', 'ar', 'bit', 'byte', 'm/s', 'm/sec', 'm/h', 'm/hr']);
const TEMPERATURES = {
  C: [(c) => c, (k) => k], cel: [(c) => c, (k) => k],
  F: [(f) => ((f - 32) * 5) / 9, (c) => (c * 9) / 5 + 32], fah: [(f) => ((f - 32) * 5) / 9, (c) => (c * 9) / 5 + 32],
  K: [(k) => k - 273.15, (c) => c + 273.15], kel: [(k) => k - 273.15, (c) => c + 273.15],
  Rank: [(r) => ((r - 491.67) * 5) / 9, (c) => ((c + 273.15) * 9) / 5], Reau: [(r) => r * 1.25, (c) => c * 0.8],
};

function unitFactor(unit) {
  // Own properties only: "constructor" is not a unit the tables inherit.
  for (const [group, table] of Object.entries(UNIT_GROUPS)) {
    if (Object.hasOwn(table, unit)) return { group, factor: table[unit] };
  }
  // A metric (or binary) prefix in front of a prefixable unit.
  for (const [prefix, mult] of Object.entries(UNIT_PREFIXES)) {
    if (!unit.startsWith(prefix) || unit.length <= prefix.length) continue;
    const base = unit.slice(prefix.length);
    if (!PREFIXABLE.has(base)) continue;
    // A binary prefix (ki, Mi, … Yi) sizes information only: "kim" names no unit.
    if (/^[kMGTPEZY]i$/.test(prefix) && base !== 'bit' && base !== 'byte') continue;
    for (const [group, table] of Object.entries(UNIT_GROUPS)) {
      if (Object.hasOwn(table, base)) {
        // Squared and cubed units take the prefix to that power.
        const power = /[23]$/.test(base) && group !== 'volume' && group !== 'area' ? 1 : base.endsWith('3') ? 3 : base.endsWith('2') ? 2 : 1;
        return { group, factor: table[base] * mult ** power };
      }
    }
  }
  return null;
}

function convertUnits(x, fromUnit, toUnit) {
  // A squared or cubed unit is spelled both ways: "m2" and "m^2".
  const from = fromUnit.replace(/\^(?=[23]$)/, '');
  const to = toUnit.replace(/\^(?=[23]$)/, '');
  const fromTemperature = Object.hasOwn(TEMPERATURES, from);
  const toTemperature = Object.hasOwn(TEMPERATURES, to);
  if (fromTemperature && toTemperature) return TEMPERATURES[to][1](TEMPERATURES[from][0](x));
  if (fromTemperature || toTemperature) return err('#N/A');
  const a = unitFactor(from);
  const b = unitFactor(to);
  if (!a || !b || a.group !== b.group) return err('#N/A');
  return (x * a.factor) / b.factor;
}

/** Public variance/stdev functions retain overflow errors from their raw
 * moments even when centered deviations would yield a finite result. Sample
 * functions evaluate sum(x²) and sum(x)²; population functions also multiply
 * sum(x²) by n. Keep these checks separate from centered variance used by
 * hypothesis tests and higher moments, which have different overflow behavior.
 */
function descriptiveVariance(l, correction) {
  let total = 0;
  let squares = 0;
  for (const x of l) { total += x; squares += x * x; }
  if (!Number.isFinite(total * total) || !Number.isFinite(squares * (correction ? 1 : l.length))) return err('#NUM!');
  if (l.length <= correction) return err('#DIV/0!');
  return numericVariance(l, correction, total / l.length);
}

function sampleStdev(l) {
  const variance = descriptiveVariance(l, 1);
  return isError(variance) ? variance : Math.sqrt(variance);
}

function populationStdev(l) {
  const variance = descriptiveVariance(l, 0);
  return isError(variance) ? variance : Math.sqrt(variance);
}

/* ---------- Database function helpers ---------- */

const headerKey = (v) => String(v ?? '').trim().toLowerCase();

/**
 * The values of `field` in the rows of `database` that satisfy `criteria`.
 * The criteria table has its own header row; each further row is one set
 * of conditions that must all hold (AND across the row), and any row may
 * match (OR down the rows). A cell like ">100", "Ap*", or "West" uses the
 * same matching as COUNTIF; an empty cell matches anything.
 */
function dbSelect(db, field, crit, { allowAnyField = false } = {}) {
  const table = asRange(db).values;
  if (table.length < 1) return err('#VALUE!');
  const headers = table[0].map(headerKey);
  let col = -1;
  if (field === undefined || field === null) {
    if (!allowAnyField) return err('#VALUE!');
  } else {
    const f = scalar(field);
    if (typeof f === 'number') col = Math.trunc(f) - 1;
    else col = headers.indexOf(headerKey(f));
    if (col < 0 || col >= headers.length) return err('#VALUE!');
  }
  const c = asRange(crit).values;
  if (c.length < 2) return err('#VALUE!');
  const tests = [];
  for (let r = 1; r < c.length; r++) {
    const row = [];
    for (let j = 0; j < c[0].length; j++) {
      const v = c[r][j];
      if (v == null || v === '') continue;
      const at = headers.indexOf(headerKey(c[0][j]));
      if (at < 0) return err('#VALUE!');
      row.push({ at, match: criteriaMatcher(v) });
    }
    tests.push(row);
  }
  const out = [];
  for (let r = 1; r < table.length; r++) {
    const rec = table[r];
    const ok = tests.some((row) => row.every((t) => t.match(rec[t.at] ?? null)));
    if (ok) out.push(col < 0 ? rec : rec[col] ?? null);
  }
  return out;
}

function dbAggregate(db, field, crit, agg, { allowAnyField = false, countAll = false } = {}) {
  const picked = dbSelect(db, field, crit, { allowAnyField }); if (isError(picked)) return picked;
  if (countAll) return picked.filter((v) => (Array.isArray(v) ? v.some((x) => x != null && x !== '') : v != null && v !== '')).length;
  if (field === undefined || field === null) return picked.length; // DCOUNT with no field counts matching rows
  for (const v of picked) if (isError(v)) return v;
  const nums = picked.filter((v) => typeof v === 'number');
  return agg(nums);
}

/* ---------- Statistics helpers ---------- */

/** A-functions count referenced text as 0 and booleans as 1/0. Value arrays
 * ignore both, except AVERAGEA also counts their text as 0. Direct arguments
 * still use ordinary numeric coercion.
 */
function numbersA(args, countArrayText = false) {
  const out = [];
  for (const a of args) {
    if (isRange(a)) {
      const rows = a.values;
      for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        for (let c = 0; c < row.length; c++) {
          const v = row[c];
          if (typeof v === 'number') out.push(v);
          else if (typeof v === 'boolean' && a.ref) out.push(v ? 1 : 0);
          else if (typeof v === 'string' && (a.ref || countArrayText)) out.push(0);
          else if (isError(v)) return v;
        }
      }
    } else if (isError(a)) return a;
    else if (a != null) {
      const n = toNumber(a);
      if (isError(n)) return n;
      out.push(n);
    }
  }
  return out;
}

/** Exclusive percentile: rank = p(n+1), interpolated; outside 1/(n+1)..n/(n+1) is #NUM!. */
function percentileExc(list, p) {
  const n = list.length;
  if (!n || p <= 0 || p >= 1) return err('#NUM!');
  const sorted = [...list].sort((a, b) => a - b);
  const rank = p * (n + 1);
  if (rank < 1 || rank > n) return err('#NUM!');
  const lo = Math.floor(rank);
  const frac = rank - lo;
  const a = sorted[lo - 1];
  const b = sorted[Math.min(lo, n - 1)];
  return a + frac * (b - a);
}

/** Sum of f(x, y) over paired numeric cells of two same-sized arrays (whole columns on two sheets read to one depth). */
function pairSum(a, b, f) {
  const pairs = pairedNumbers(a, b); if (isError(pairs)) return pairs;
  let total = 0;
  for (const [x, y] of pairs) total += f(x, y);
  return pairs.length ? total : err('#N/A');
}

/**
 * The least-squares fit LINEST, LOGEST, TREND and GROWTH share: known_y on one or more x
 * variables, with an intercept unless `constant` is FALSE. A column of y takes each column of
 * known_x as a variable and a row of y each row; a y of any other shape, or
 * an x with as many cells as y, pairs cell by cell as one variable; no known_x is 1, 2, 3, ....
 * Rows with a non-numeric y or x are left out and an error anywhere is the answer. The slopes
 * come from the normal equations on the centred data (a single variable's is sxy/sxx, as before),
 * the intercept from the means; without an intercept the sums are taken about zero.
 * Returns the coefficients, the intercept (0 when none is fitted) and the sums of squares,
 * inverse and means LINEST's statistics are built from.
 */
function regression(ys, xs, constant) {
  // Whole columns on two sheets, each read to its own sheet's used area, are read to one depth.
  const [Y, X] = xs === undefined ? [asRange(ys).values, null] : readAlike([asRange(ys), asRange(xs)]);
  const y = Y.flat();
  const n = y.length;
  const column = Y[0]?.length === 1;
  const row = !column && Y.length === 1;
  let rows; // the x values of each observation
  if (xs === undefined) rows = y.map((_, i) => [i + 1]);
  else {
    const flat = X.flat();
    if (flat.length === n && (X.length === 1 || X[0].length === 1 || !(column || row))) rows = flat.map((v) => [v]);
    else if (column && X.length === n) rows = X.map((line) => [...line]);
    else if (row && X[0].length === n) rows = X[0].map((_, i) => X.map((line) => line[i]));
    else return err('#REF!');
  }
  const k = rows[0]?.length || 1;
  const kept = [];
  for (let i = 0; i < n; i++) {
    if (isError(y[i])) return y[i];
    let numeric = typeof y[i] === 'number';
    for (const v of rows[i]) { if (isError(v)) return v; if (typeof v !== 'number') numeric = false; }
    if (numeric) kept.push([rows[i], y[i]]);
  }
  const m = kept.length;
  const p = k + (constant ? 1 : 0);
  if (m < 2 || m < p) return err('#DIV/0!');
  const mx = new Array(k).fill(0);
  let my = 0;
  if (constant) {
    for (const [xr, yv] of kept) { for (let j = 0; j < k; j++) mx[j] += xr[j]; my += yv; }
    for (let j = 0; j < k; j++) mx[j] /= m;
    my /= m;
  }
  const A = range0(k).map(() => new Array(k).fill(0)); // XᵀX of the centred x
  const r = new Array(k).fill(0); // Xᵀy
  for (const [xr, yv] of kept) {
    const dy = yv - my;
    for (let i = 0; i < k; i++) {
      const di = xr[i] - mx[i];
      r[i] += di * dy;
      for (let j = i; j < k; j++) A[i][j] += di * (xr[j] - mx[j]);
    }
  }
  for (let i = 0; i < k; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];
  const inv = invertMatrix(A);
  if (!inv) return err('#DIV/0!'); // a constant or collinear variable has no unique fit
  const coef = k === 1 ? [r[0] / A[0][0]] : inv.map((line) => line.reduce((s, v, j) => s + v * r[j], 0));
  const b = constant ? my - coef.reduce((s, c, j) => s + c * mx[j], 0) : 0;
  let ssreg = 0;
  let ssresid = 0;
  let sstotal = 0;
  for (const [xr, yv] of kept) {
    const fitted = b + coef.reduce((s, c, j) => s + c * xr[j], 0);
    ssreg += (fitted - my) ** 2;
    ssresid += (yv - fitted) ** 2;
    sstotal += (yv - my) ** 2;
  }
  return { coef, b, k, n: m, df: m - p, constant, column, row, rows, inv, mx, ssreg, ssresid, sstotal };
}

/** The fit of LOGEST and GROWTH: a line through ln(y), so y = b·m^x; a y that is not positive is #NUM!. */
function logRegression(ys, xs, constant) {
  const range = asRange(ys);
  const Y = range.values;
  for (const line of Y) for (const v of line) if (typeof v === 'number' && v <= 0) return err('#NUM!');
  // The address travels with the logged values, so two whole columns on different sheets still
  // pair by it inside the fit, as they do for LINEST and TREND.
  const logged = { range: true, values: Y.map((line) => line.map((v) => (typeof v === 'number' ? Math.log(v) : v))), ref: range.ref };
  return regression(logged, xs, constant);
}

/**
 * LINEST's five rows of statistics: the coefficients, last variable first, and the intercept; their
 * standard errors, #N/A for an intercept forced to 0; r² and the standard error of y; the F
 * statistic and the residual degrees of freedom; the regression and residual sums of squares. The
 * cells past the second of the last three rows are #N/A, and a statistic the
 * fit leaves undefined (no residual degrees of freedom, no residual at all) is #NUM!. `transform`
 * maps the coefficients, exp for LOGEST, whose errors and sums stay those of the fit on ln(y).
 */
function regressionStats(fit, transform) {
  const { coef, b, k, n, df, constant, inv, mx, ssreg, ssresid, sstotal } = fit;
  const na = () => err('#N/A');
  const finite = (v) => (Number.isFinite(v) ? v : err('#NUM!'));
  const seY = Math.sqrt(ssresid / df);
  const meanTerm = mx.reduce((s, xi, i) => s + xi * mx.reduce((t, xj, j) => t + inv[i][j] * xj, 0), 0); // x̄ᵀ (XcᵀXc)⁻¹ x̄
  const pad = (cells) => [...cells, ...range0(k - 1).map(na)];
  return [
    [...coef.map(transform).reverse(), transform(b)],
    [...coef.map((_, j) => finite(seY * Math.sqrt(inv[j][j]))).reverse(), constant ? finite(seY * Math.sqrt(1 / n + meanTerm)) : na()],
    pad([finite(ssreg / sstotal), finite(seY)]),
    pad([finite((ssreg / k) / (ssresid / df)), df]),
    pad([ssreg, ssresid]),
  ];
}

/**
 * TREND's and GROWTH's answers: the fit applied to new_x, or to known_x when none is given. For
 * one variable new_x is any shape and the answers take it (or known_y's); for several, each row of
 * new_x is an observation when known_y is a column and each column when it is a row, as for
 * known_x, and the answers run along known_y.
 */
function fittedValues(fit, ys, newXs, transform) {
  let targets;
  if (newXs === undefined) targets = fit.rows;
  else {
    const N = asRange(newXs).values;
    if (fit.k === 1) targets = N.flat().map((v) => [v]);
    else if (fit.column && N[0]?.length === fit.k) targets = N.map((line) => [...line]);
    else if (fit.row && N.length === fit.k) targets = N[0].map((_, i) => N.map((line) => line[i]));
    else return err('#REF!');
  }
  const out = targets.map((xr) => {
    let v = fit.b;
    for (let j = 0; j < fit.k; j++) { const x = toNumber(xr[j]); if (isError(x)) return x; v += fit.coef[j] * x; }
    return transform(v);
  });
  return vectorLike(fit.k === 1 && newXs !== undefined ? newXs : ys, out);
}

/** Lay a flat list out in the shape (row or column) of the argument it came from. */
function vectorLike(source, list) {
  const shape = asRange(source).values;
  const vertical = shape.length >= (shape[0]?.length || 0);
  return { range: true, values: vertical ? list.map((v) => [v]) : [list] };
}

/** Γ(n) = (n-1)! exactly for a whole n from 1 to 171, where the Lanczos series is a few units off (GAMMA(5) read 23.99999999999996); null otherwise. */
function wholeGamma(x) {
  if (!Number.isInteger(x) || x < 1 || x > 171) return null;
  let out = 1;
  for (let i = 2; i < x; i++) out *= i;
  return out;
}

/** ln Γ(x) for x > 0 (Lanczos approximation, accurate to ~1e-15; exact at whole numbers, so GAMMALN(1) is 0). */
function gammaLn(x) {
  const whole = wholeGamma(x);
  if (whole !== null) return Math.log(whole);
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - gammaLn(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

function gammaFn(x) {
  const whole = wholeGamma(x);
  if (whole !== null) return whole;
  if (x < 0.5) return Math.PI / (Math.sin(Math.PI * x) * gammaFn(1 - x));
  return Math.exp(gammaLn(x));
}

/** ln(1 + z) - z, by its series for small z where the direct difference cancels to noise. */
function log1pMinus(z) {
  if (Math.abs(z) >= 0.1) return Math.log1p(z) - z;
  if (z === 0) return 0;
  let term = (-z * z) / 2; // -z²/2 + z³/3 - z⁴/4 + ...
  let total = term;
  for (let k = 2; k < 40; k++) {
    term *= (-z * k) / (k + 1);
    total += term;
    if (Math.abs(term) < 1e-17 * Math.abs(total)) break;
  }
  return total;
}

/** lnΓ(z) minus Stirling's (z - 1/2) ln z - z + ln(2π)/2: the asymptotic series from z = 100, the difference itself below. */
function stirlingRemainder(z) {
  if (z >= 100) {
    const z2 = z * z;
    return (1 / 12 - (1 / 360 - (1 / 1260 - 1 / (1680 * z2)) / z2) / z2) / z;
  }
  return gammaLn(z) - ((z - 0.5) * Math.log(z) - z + 0.5 * Math.log(2 * Math.PI));
}

/**
 * ln(x^a e^-x / Γ(a)), the factor in front of the incomplete gamma series and
 * continued fraction. Written as a ln x - x - lnΓ(a) it subtracts numbers near
 * a ln a and keeps few digits for large a (P(1E12, 1E12) came out 0.499
 * instead of 0.5000002); in terms of μ = (x - a) / a it does not cancel.
 */
function lnGammaFront(a, x) {
  if (a < 100) return -x + a * Math.log(x) - gammaLn(a);
  return a * log1pMinus((x - a) / a) + 0.5 * Math.log(a / (2 * Math.PI)) - stirlingRemainder(a);
}

/**
 * x·total - part to the last digit (Dekker's split product), the offset of x
 * from the fraction part/total: subtracting the rounded fraction loses the
 * digits that matter when x sits within 1E-9 of it.
 */
function scaledOffset(x, total, part) {
  const product = x * total;
  const split = 134217729; // 2^27 + 1
  let t = split * x;
  const xh = t - (t - x);
  const xl = x - xh;
  t = split * total;
  const th = t - (t - total);
  const tl = total - th;
  const error = (xh * th - product + xh * tl + xl * th) + xl * tl;
  return product - part + error;
}

/**
 * ln(x^a (1-x)^b / B(a, b)), the factor in front of the incomplete beta
 * continued fraction, given x and its complement xc = 1 - x (passed in so a
 * value near 1 keeps the digits of its complement). Around the mean μ =
 * a / (a + b) the two logarithms are written as (ln(1+u) - u) terms whose
 * linear parts cancel exactly, so large a and b lose nothing.
 */
function lnBetaFront(x, xc, a, b) {
  const lnX = x > 0.5 ? Math.log1p(-xc) : Math.log(x);
  const lnXc = xc > 0.5 ? Math.log1p(-x) : Math.log(xc);
  if (a + b < 100) return a * lnX + b * lnXc - (gammaLn(a) + gammaLn(b) - gammaLn(a + b));
  // (x - μ)(a + b) = x (a+b) - a = b - (1-x)(a+b), taken exactly from whichever of x and 1 - x is the precise one;
  // then (x - μ) / μ is offset / a and ((1-x) - (1-μ)) / (1-μ) is -offset / b.
  const offset = x > 0.5 ? -scaledOffset(xc, a + b, b) : scaledOffset(x, a + b, a);
  const da = offset / a;
  const db = -offset / b;
  // Near an endpoint, reconstructing x from 1 + offset/shape loses its
  // significant digits. Use the original logarithm on that side instead.
  const la = da < -0.5 ? lnX - Math.log(a / (a + b)) - da : log1pMinus(da);
  const lb = db < -0.5 ? lnXc - Math.log(b / (a + b)) - db : log1pMinus(db);
  return a * la + b * lb
    + 0.5 * Math.log((a * b) / (2 * Math.PI * (a + b))) + stirlingRemainder(a + b) - stirlingRemainder(a) - stirlingRemainder(b);
}

/**
 * ln C(n, k) through Stirling's formula written as n H(k/n) + ln(n / (2π k (n-k))) / 2
 * plus the remainders: the entropy term is a sum of two positive parts, where
 * lnΓ(n+1) - lnΓ(k+1) - lnΓ(n-k+1) subtracts numbers near n ln n.
 */
function lnChooseStirling(n, k) {
  if (k < 1 || n - k < 1) return 0;
  const entropy = -k * Math.log1p(-(n - k) / n) - (n - k) * Math.log1p(-k / n);
  return entropy + 0.5 * Math.log(n / (2 * Math.PI * k * (n - k))) + stirlingRemainder(n) - stirlingRemainder(k) - stirlingRemainder(n - k);
}

/**
 * ln of the hypergeometric mass C(M, k) C(N-M, n-k) / C(N, n). Inside the
 * support the three entropies are combined into two divergences from the
 * sampling fraction, each a sum of positive terms, so a population of two
 * billion keeps its digits; at an edge of the support the coefficients are
 * taken one by one, where they are small.
 */
function lnHypergeometricPmf(k, n, M, N) {
  const others = N - M;
  const rest = n - k;
  if (k < 1 || M - k < 1 || rest < 1 || others - rest < 1) return lnChooseStirling(M, k) + lnChooseStirling(others, rest) - lnChooseStirling(N, n);
  const q = n / N;
  // `of` times the divergence of count/of from q: r ln(r/q) + (1-r) ln((1-r)/(1-q)) with its linear parts cancelled exactly.
  const divergence = (count, of) => {
    const r = count / of;
    const d = r - q;
    return of * (r * log1pMinus(d / q) + (1 - r) * log1pMinus(-d / (1 - q)) + (d * d) / (q * (1 - q)));
  };
  return -divergence(k, M) - divergence(rest, others)
    + 0.5 * Math.log((M * others * n * (N - n)) / (2 * Math.PI * N * k * (M - k) * rest * (others - rest)))
    + stirlingRemainder(M) - stirlingRemainder(k) - stirlingRemainder(M - k)
    + stirlingRemainder(others) - stirlingRemainder(rest) - stirlingRemainder(others - rest)
    - stirlingRemainder(N) + stirlingRemainder(n) + stirlingRemainder(N - n);
}

// 18-point Gauss–Legendre nodes and weights on [0, 1] (the roots of P₁₈, mapped from [-1, 1]).
const GL_NODES = [0.004217415789534527, 0.022088025214301123, 0.05369876675122213, 0.09814752051373844, 0.1541564784698234, 0.22011458446302623, 0.2941244192685787, 0.37405688715424723, 0.45761249347913235, 0.5423875065208676, 0.6259431128457528, 0.7058755807314213, 0.7798854155369738, 0.8458435215301766, 0.9018524794862616, 0.9463012332487779, 0.9779119747856989, 0.9957825842104655];
const GL_WEIGHTS = [0.010808006763241656, 0.0248572744474849, 0.038212865127444526, 0.050471022053143584, 0.06127760335573923, 0.07032145733532533, 0.07734233756313262, 0.08213824187291636, 0.0845711914815718, 0.0845711914815718, 0.08213824187291636, 0.07734233756313262, 0.07032145733532533, 0.06127760335573923, 0.050471022053143584, 0.038212865127444526, 0.0248572744474849, 0.010808006763241656];

/**
 * ∫ exp(logDensity(t)) dt over [from, to] for a bell-shaped density with the
 * given mean and standard deviation: Gauss–Legendre panels half a deviation
 * wide near the mean, narrowing as the density steepens away from it, so the
 * 18-point rule integrates each panel to rounding.
 */
function integrateBell(logDensity, mean, sd, from, to) {
  let total = 0;
  for (let t = from; t < to;) {
    const away = Math.abs(t - mean) / sd;
    const width = Math.min(to - t, sd * Math.min(0.5, 2 / Math.max(1, away)));
    let panel = 0;
    for (let j = 0; j < GL_NODES.length; j++) panel += GL_WEIGHTS[j] * Math.exp(logDensity(t + width * GL_NODES[j]));
    total += panel * width;
    t += width;
  }
  return total;
}

/**
 * I_x(a, b) for a and b both large by integrating the beta density over the
 * shorter side. Near the mean the continued fraction converges only as 1/m³,
 * and stopping where a factor is within rounding of one leaves an error of
 * about m·ε/2 (2E-12 at a = b = 5E8); the quadrature keeps every digit.
 */
function betaByQuadrature(x, xc, a, b, preserveSubnormal = false) {
  const mean = a / (a + b);
  const meanC = b / (a + b);
  const sd = Math.sqrt((a * b) / ((a + b) ** 2 * (a + b + 1)));
  // Everything runs in the offset d = t - mean: a position near 0.5 held as t
  // itself is only good to 1E-16, which is 1E-11 deviations when sd is 1E-5.
  const lnConstant = 0.5 * Math.log((a * b) / (2 * Math.PI * (a + b))) + stirlingRemainder(a + b) - stirlingRemainder(a) - stirlingRemainder(b);
  const logDensity = (d) => a * log1pMinus(d / mean) + b * log1pMinus(-d / meanC) + lnConstant - Math.log(mean + d) - Math.log(meanC - d);
  const d = (x > 0.5 ? -scaledOffset(xc, a + b, b) : scaledOffset(x, a + b, a)) / (a + b);
  // Forty deviations suffice for a normal density, but a skewed beta can
  // still have a representable tail there. Since a,b > 1, the log density
  // is concave: its tangent bounds omitted mass by density / |slope|, and
  // the smaller endpoint density bounds an interior interval from below.
  const tailBound = (direction) => {
    const support = direction < 0 ? -mean : meanC;
    const width = Math.min(sd, Math.abs(support - d)) / 2;
    const logMinimumMass = width > 0
      ? Math.min(logDensity(d), logDensity(d + direction * width)) + Math.log(width) : -Infinity;
    // Stop when the omitted mass cannot affect relative rounding, or is
    // below the smallest double. Ordinary tails need no wider integration.
    const logTolerance = Math.max(Math.log(Number.MIN_VALUE), logMinimumMass + Math.log(Number.EPSILON / 2));
    let distance = Math.min(Math.abs(support), 40 * sd);
    while (distance > 0 && distance < Math.abs(support)) {
      const at = direction * distance;
      const slope = (mean - meanC - (a + b - 2) * at) / ((mean + at) * (meanC - at));
      if (logDensity(at) - Math.log(Math.abs(slope)) < logTolerance) break;
      distance = Math.min(Math.abs(support), distance * 2);
    }
    return direction * distance;
  };
  if (d <= 0) {
    const lo = tailBound(-1);
    const value = d <= lo ? 0 : integrateBell(logDensity, 0, sd, lo, d);
    const p = preserveSubnormal ? value : flushUnderflow(value);
    return { p, q: 1 - p };
  }
  const hi = tailBound(1);
  const value = d >= hi ? 0 : integrateBell(logDensity, 0, sd, d, hi);
  const q = preserveSubnormal ? value : flushUnderflow(value);
  return { p: 1 - q, q };
}

// Taylor coefficients in μ of c₀(η) = 1/μ - 1/η, Temme's first coefficient, for use near μ = 0 where the two terms cancel.
const TEMME_C0 = [-1 / 3, 1 / 12, -23 / 540, 353 / 12960, -589 / 30240, 81083 / 5443200, -7783 / 653184, 514303 / 52254720];

/**
 * Temme's uniform asymptotic expansion of the incomplete gamma function for
 * large a, with its first correction term: Q(a, x) ≈ erfc(η √(a/2)) / 2 +
 * e^(-aη²/2) c₀(η) / √(2πa), where η² / 2 = μ - ln(1 + μ) and μ = (x - a) / a.
 * The next term is of order 1/a smaller, so from a = 1E8 the result carries
 * about fifteen digits in either tail while the series would need 7√a terms.
 */
function temmeGamma(a, x) {
  const mu = (x - a) / a;
  const L = log1pMinus(mu); // -η²/2
  const eta = Math.sign(mu) * Math.sqrt(-2 * L);
  let c0 = 0;
  if (Math.abs(mu) < 0.01) for (let k = TEMME_C0.length - 1; k >= 0; k--) c0 = c0 * mu + TEMME_C0[k];
  else c0 = 1 / mu - 1 / eta;
  const correction = (Math.exp(a * L) / Math.sqrt(2 * Math.PI * a)) * c0;
  if (eta >= 0) {
    const q = Math.min(1, Math.max(0, 0.5 * erfcOf(eta * Math.sqrt(a / 2)) + correction));
    return { p: 1 - q, q };
  }
  const p = Math.min(1, Math.max(0, 0.5 * erfcOf(-eta * Math.sqrt(a / 2)) - correction));
  return { p, q: 1 - p };
}

/**
 * The regularized incomplete gamma function as both tails, P(a, x) and
 * Q(a, x) = 1 - P: the series gives P and the continued fraction gives Q, and
 * each is returned as computed, so a right tail of 1E-22 is not lost as
 * 1 - 0.9999999999999999.
 */
function incompleteGamma(a, x) {
  if (x <= 0) return { p: 0, q: 1 };
  if (a >= 1e8) return temmeGamma(a, x);
  const lnFront = lnGammaFront(a, x);
  // Near x = a the series needs about 7√a terms and the continued fraction a few hundred.
  const limit = Math.max(500, Math.ceil(20 * Math.sqrt(a)) + 100);
  if (x < a + 1) {
    // Series expansion for P.
    let term = 1 / a;
    let total = term;
    for (let n = 1; n < limit; n++) {
      term *= x / (a + n);
      total += term;
      if (Math.abs(term) < Math.abs(total) * 1e-15) break;
    }
    const p = Math.min(1, total * Math.exp(lnFront));
    return { p, q: 1 - p };
  }
  // Continued fraction for Q (Lentz's method).
  let b = x + 1 - a;
  let c = 1 / 1e-300;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < limit; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < 1e-15) break;
  }
  const q = Math.min(1, Math.exp(lnFront) * h);
  return { p: 1 - q, q };
}

/** Gamma quantiles are computed at unit scale, then multiplied by the scale.
 * An underflowed unit quantile is flushed before that multiplication, as
 * well as flushing the final product. Chi-square uses shape=df/2, scale=2.
 */
function gammaQuantile(p, shape, scale, rightTail = false) {
  // Invert the smaller tail so a near-one CDF cannot round away the residual.
  const upper = rightTail ? p <= 0.5 : p > 0.5;
  const target = upper ? -(rightTail ? p : 1 - p) : rightTail ? 1 - p : p;
  const cdf = upper ? x => -incompleteGamma(shape, x).q : x => incompleteGamma(shape, x).p;
  let hi = shape + 10 * Math.sqrt(shape) + 10;
  let probability = cdf(hi);
  while (probability < target) {
    if (hi === Number.MAX_VALUE) return err('#NUM!');
    hi = Math.min(Number.MAX_VALUE, hi * 2);
    probability = cdf(hi);
  }
  if (!Number.isFinite(probability)) return err('#NUM!');
  const unit = flushUnderflow(invertCdf(cdf, target, 0, hi));
  const value = flushUnderflow(unit * scale);
  return Number.isFinite(value) ? value : err('#NUM!');
}

/**
 * The regularized incomplete beta function as both tails, I_x(a, b) and its
 * complement: the continued fraction runs on whichever side converges, and
 * that side is returned as computed so a tail of 1E-18 keeps its digits. A
 * caller that knows 1 - x more accurately than the subtraction gives it
 * (df / (df + t²) against t² / (df + t²)) passes it as `xc`.
 * Continuous inverse searches can retain subnormal tail probabilities;
 * worksheet callers keep their existing final-division underflow behavior.
 */
function incompleteBeta(x, a, b, xc = 1 - x, preserveSubnormal = false) {
  if (x <= 0) return { p: 0, q: 1 };
  if (x >= 1 || xc <= 0) return { p: 1, q: 0 };
  // I_x(a, 1) = x^a. The power path preserves subnormal values,
  // unlike the division at the end of the general beta-tail calculation.
  if (b === 1) return { p: x ** a, q: -Math.expm1(a * Math.log(x)) };
  if (a >= 1000 && b >= 1000 && a + b >= 1e6) return betaByQuadrature(x, xc, a, b, preserveSubnormal);
  const front = Math.exp(lnBetaFront(x, xc, a, b));
  // Near the mean the fraction needs about 4∛(a + b) terms.
  const limit = Math.max(500, Math.ceil(40 * Math.cbrt(a + b)) + 100);
  const cf = (xx, aa, bb) => {
    let c = 1;
    let d = 1 - ((aa + bb) * xx) / (aa + 1); if (Math.abs(d) < 1e-300) d = 1e-300;
    d = 1 / d;
    let h = d;
    for (let m = 1; m < limit; m++) {
      const m2 = 2 * m;
      let num = (m * (bb - m) * xx) / ((aa + m2 - 1) * (aa + m2));
      d = 1 + num * d; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + num / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      h *= d * c;
      num = (-(aa + m) * (aa + bb + m) * xx) / ((aa + m2) * (aa + m2 + 1));
      d = 1 + num * d; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = 1 + num / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) < 1e-15) break;
    }
    return h;
  };
  // Use the symmetry relation to keep the continued fraction converging.
  if (x < (a + 1) / (a + b + 2)) {
    const value = (front * cf(x, a, b)) / a;
    const p = Math.min(1, preserveSubnormal ? value : flushUnderflow(value));
    return { p, q: 1 - p };
  }
  const value = (front * cf(xc, b, a)) / b;
  const q = Math.min(1, preserveSubnormal ? value : flushUnderflow(value));
  return { p: 1 - q, q };
}

/** Worksheet beta tails, including the unit-shape subtraction order. */
function betaDistribution(x, a, b, xc = 1 - x) {
  if (x <= 0) return { p: 0, q: 1 };
  if (x >= 1 || xc <= 0) return { p: 1, q: 0 };
  // The identities are x^a and 1-(1-x)^b. Native unit-shape controls
  // switch to expm1 below x=0.1 (above x=0.9 for the reflected identity).
  // The other tail is then a subtraction, even when that loses precision.
  // Keep this ordering out of inverse searches and binomial calculations.
  if (b === 1) {
    if (x > 0.9) {
      const q = flushUnderflow(-Math.expm1(a * Math.log(x)));
      return { p: 1 - q, q };
    }
    const p = x ** a; // This power path preserves subnormal results.
    return { p, q: 1 - p };
  }
  if (a === 1) {
    if (x < 0.1) {
      const p = flushUnderflow(-Math.expm1(b * Math.log1p(-x)));
      return { p, q: 1 - p };
    }
    const q = xc ** b;
    return { p: 1 - q, q };
  }
  return incompleteBeta(x, a, b, xc);
}

/**
 * The F distribution with d1 and d2 degrees of freedom at x as both tails.
 * The left tail is I_y(d1/2, d2/2) at y = d1 x / (d1 x + d2) and the right
 * tail I_z(d2/2, d1/2) at z = d2 / (d2 + d1 x); each is taken from the side
 * whose argument is computed without cancellation, so F.DIST.RT(1E18,2,2) is
 * 1E-18 rather than 0.
 */
function fDist(x, d1, d2, beta = incompleteBeta, rightTail = false) {
  const total = d1 * x + d2;
  // Normalize with worksheet division semantics before evaluating beta: a
  // subnormal argument vanishes even if its beta tail would be normal.
  const leftX = flushUnderflow((d1 * x) / total);
  const rightX = flushUnderflow(d2 / total);
  if (!rightTail && d1 * x < d2) return beta(leftX, d1 / 2, d2 / 2, rightX);
  const right = beta(rightX, d2 / 2, d1 / 2, leftX);
  return { p: right.q, q: right.p };
}

// Direct F statistics report an overflowing normalization denominator as a
// division error. Inverse searches normalize separately in fQuantile.
function fDistribution(x, d1, d2, rightTail = false) {
  return Number.isFinite(d1 * x + d2) ? fDist(x, d1, d2, betaDistribution, rightTail) : err('#DIV/0!');
}

/** Inverse searches need continuous tails, not worksheet normalization's
 * underflow discontinuity. Normalize through a ratio at most one so neither
 * d1*x nor its sum with d2 can overflow, and retain both beta arguments.
 */
function fQuantile(p, d1, d2, rightTail = false) {
  const upper = rightTail ? p <= 0.5 : p > 0.5;
  const target = upper ? -(rightTail ? p : 1 - p) : rightTail ? 1 - p : p;
  const scale = d2 / d1;
  const cdf = x => {
    const left = x <= scale;
    const ratio = left ? x / scale : scale / x;
    const small = ratio / (1 + ratio), large = 1 / (1 + ratio);
    const tails = left ? incompleteBeta(small, d1 / 2, d2 / 2, large, true)
      : incompleteBeta(small, d2 / 2, d1 / 2, large, true);
    return upper ? -(left ? tails.q : tails.p) : left ? tails.p : tails.q;
  };
  let hi = 1;
  let probability = cdf(hi);
  while (probability < target) {
    if (hi === Number.MAX_VALUE) return err('#NUM!');
    hi = Math.min(Number.MAX_VALUE, hi * 2);
    probability = cdf(hi);
  }
  if (!Number.isFinite(probability)) return err('#NUM!');
  return flushUnderflow(invertCdf(cdf, target, 0, hi));
}

/** Standard normal CDF via the complementary error function. */
function normCdf(z) {
  return 0.5 * erfcOf(-z / Math.SQRT2);
}

/** Inverse standard normal (Acklam's algorithm with one Newton refinement). */
function normInv(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  let x;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - lo) {
    const q = p - 0.5;
    const r = q * q;
    x = ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

function tPdf(t, df) {
  const t2 = t * t;
  if (!Number.isFinite(df + t2)) return err('#NUM!');
  // The Cauchy density uses reciprocal arithmetic, while the two-degree
  // identity is a power and preserves its subnormal result.
  if (df === 1) {
    const denominator = Math.PI * (1 + t2);
    return Number.isFinite(denominator) ? flushUnderflow(1 / denominator) : err('#DIV/0!');
  }
  if (df === 2) return (t2 + 2) ** -1.5;
  // Combine the gamma ratio with sqrt(df*pi) before evaluation, avoiding
  // subtraction of two large log-gammas. log1p also retains t²/df near zero.
  const a = df / 2;
  const logScale = -0.5 * Math.log(2 * Math.PI) + a * Math.log1p(0.5 / a) - 0.5
    + stirlingRemainder(a + 0.5) - stirlingRemainder(a);
  return flushUnderflow(Math.exp(logScale - ((df + 1) / 2) * Math.log1p(t2 / df)));
}

// Apply one/two-sided scaling before flushing the final probability: a
// two-sided result may be normal even when its one-sided half is subnormal.
// Inverse searches keep using the unscaled, limiting tail helper below.
function tProbability(t, df, tails = 1) {
  const total = df + t * t;
  if (!Number.isFinite(total)) return err('#NUM!');
  // Native worksheet evaluation recognizes the normalized beta endpoint
  // before computing the tail, even if quadrature could retain the offset.
  if (total === df) return tails / 2;
  return flushUnderflow(tails * tTail(t, df, true));
}

// T.TEST evaluates its rounded beta argument directly. Unlike T.DIST at
// general degrees, it does not carry the separately computed complement.
function tTestProbability(t, df, tails) {
  const total = df + flushUnderflow(t * t);
  if (!Number.isFinite(total)) return err('#NUM!');
  // Welch overflow can produce zero degrees. Native division-by-zero takes
  // precedence over the beta shape-domain error, including underflowed t².
  if (total === 0) return err('#DIV/0!');
  if (df === 0) return err('#NUM!');
  const x = flushUnderflow(df / total);
  return flushUnderflow((tails / 2) * betaDistribution(x, df / 2, 0.5).p);
}

/** P(T > |t|) for Student's t with df degrees of freedom: half the incomplete beta at df / (df + t²), computed on the small side. */
function tTail(t, df, worksheetDivision = false) {
  const t2 = t * t;
  // The continued fraction's denominators are about t²/df + 1/df, which for a
  // large df and a moderate t cancel to a few digits (T.DIST(1.96, 1E6) was off
  // by 1E-12): there the tail is integrated from the density instead.
  if (df >= 100 && t2 < df / 99) return tTailByQuadrature(Math.abs(t), df);
  const x = df / (df + t2);
  // The one/two-degree closed forms use the rounded beta argument's
  // complement. Other degrees retain the direct small ratio.
  const xc = worksheetDivision && (df === 1 || df === 2) ? 1 - x : t2 / (df + t2);
  // Direct formulas round these divisions; inverse searches need the
  // continuous tail, including its limiting value beyond squared overflow.
  return 0.5 * (worksheetDivision
    ? betaDistribution(flushUnderflow(x), df / 2, 0.5, flushUnderflow(xc))
    : incompleteBeta(x, df / 2, 0.5, xc)).p;
}

/**
 * The upper tail of Student's t for large df: the unnormalised density
 * (1 + u²/df)^-(df+1)/2 is integrated from |t| to where the continued fraction
 * is well conditioned again (t² = df/99, or 45 deviations), and from 0 to fix
 * the constant against the fraction's tail there, so no ratio of gamma
 * functions at df/2 is needed. Beyond ten deviations past |t| the density is
 * below 1E-20 of what was gathered and is left out.
 */
function tTailByQuadrature(t, df) {
  const upper = Math.min(Math.sqrt(df / 99), 45);
  const logDensity = (u) => -((df + 1) / 2) * Math.log1p((u * u) / df);
  const beyond = 0.5 * incompleteBeta(df / (df + upper * upper), df / 2, 0.5, (upper * upper) / (df + upper * upper)).p;
  const body = integrateBell(logDensity, 0, 1, 0, t);
  const rest = integrateBell(logDensity, 0, 1, t, Math.min(upper, Math.max(10, t + 10)));
  // Half the mass lies above zero: scale (body + rest) + beyond = 1/2.
  const scale = (0.5 - beyond) / (body + rest);
  return scale * rest + beyond;
}

function tCdf(t, df) {
  const tail = tProbability(t, df);
  return isError(tail) ? tail : t >= 0 ? 1 - tail : tail;
}

/**
 * The t ≥ 0 whose upper tail is `tail` for df degrees of freedom. Cauchy has
 * a closed form; other degrees bisect the tail itself inside a bracket
 * doubled until it holds the quantile, rather than imposing a fixed bound.
 */
function tQuantile(tail, df) {
  if (tail >= 0.5) return 0;
  // One degree is Cauchy: cot(pi * tail) avoids overflowing t² in the tail
  // search for very large representable quantiles.
  // The angle product is flushed, not the original one-tailed probability;
  // zero probability (or an underflowed angle) reaches division by zero here.
  // https://itl.nist.gov/div898/handbook/eda/section3/eda3663.htm
  if (df === 1) {
    const angle = flushUnderflow(Math.PI * tail);
    return angle === 0 ? err('#DIV/0!') : 1 / Math.tan(angle);
  }
  // The general t tail is half a regularized beta probability. If doubling
  // the requested tail underflows, that beta target is zero and no finite
  // quantile can be resolved. Otherwise bisection would return the boundary
  // where the beta tail abruptly flushes to zero, independent of the input.
  if (flushUnderflow(2 * tail) === 0) return err('#NUM!');
  let hi = 1;
  while (tTail(hi, df) > tail && hi < 1e300) hi *= 2;
  return invertCdf((t) => -tTail(t, df), -tail, 0, hi);
}

/**
 * Bisection on an increasing CDF: the x with cdf(x) = p within [lo, hi]. The
 * bracket narrows to a relative 1E-15 of the answer, or to adjacent doubles.
 * An absolute width cutoff loses tiny representable quantiles; 2100 halvings
 * reach from 1E+300 down to the smallest doubles. These brackets are
 * nonnegative; form the midpoint by differences to avoid overflowing a+b.
 */
function invertCdf(cdf, p, lo, hi) {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 2100; i++) {
    const mid = a + (b - a) / 2;
    if (mid <= a || mid >= b) break; // no double lies strictly between the ends
    if (cdf(mid) < p) a = mid; else b = mid;
    if (b - a <= 1e-15 * Math.abs(mid)) break;
  }
  return a + (b - a) / 2;
}

/* ---------- Array shaping helpers ---------- */

const range0 = (n) => Array.from({ length: n }, (_, i) => i);

function padRow(row, width) {
  const out = row.map((v) => v ?? null);
  while (out.length < width) out.push(err('#N/A'));
  return out;
}

/** A single row or column as a flat list; anything two-dimensional is #VALUE!. */
function vectorOf(v) {
  const a = asRange(v).values;
  if (a.length > 1 && (a[0]?.length || 0) > 1) return err('#VALUE!');
  return a.flat().map((x) => x ?? null);
}

/** TOCOL / TOROW: flatten by row (or column), dropping blanks and/or errors. */
function flattenArray(array, ignore, byCol) {
  const v = asRange(array).values;
  const mode = ignore === undefined ? 0 : toNumber(ignore); if (isError(mode)) return mode;
  const columns = byCol === undefined ? false : toBool(byCol); if (isError(columns)) return columns;
  const m = Math.trunc(mode);
  if (m < 0 || m > 3) return err('#VALUE!');
  const out = [];
  const rows = v.length;
  const cols = v[0]?.length || 0;
  const push = (x) => {
    const val = x ?? null;
    if ((m === 1 || m === 3) && val == null) return;
    if ((m === 2 || m === 3) && isError(val)) return;
    out.push(val);
  };
  if (columns) { for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) push(v[r][c]); }
  else for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) push(v[r][c]);
  if (!out.length) return err('#CALC!');
  return out;
}

/** Case-insensitive identity of a value, for UNIQUE and COUNTUNIQUE. */
function valueKey(v) {
  if (v == null || v === '') return '';
  if (isError(v)) return `e:${v.error}`;
  return typeof v === 'string' ? `s:${comparisonText(v)}` : `${typeof v}:${v}`;
}

/** The delimiters a TEXTSPLIT-style argument names: one text, or every text of an array constant. */
function delimiterList(arg) {
  if (arg === undefined) return [];
  const out = [];
  for (const { v } of eachValue([arg])) {
    if (isError(v)) return v;
    const d = toText(v); if (isError(d)) return d;
    out.push(d);
  }
  return out;
}

/** A global pattern matching any of `delimiters`, the longest first where they overlap; case-insensitive when asked. */
function delimiterPattern(delimiters, ignoreCase) {
  const alternatives = [...delimiters].sort((a, b) => b.length - a.length).map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(alternatives.join('|'), ignoreCase ? 'gi' : 'g');
}

/** A piece SPLIT cut becomes a number or boolean when it reads as one, as in Google Sheets; TEXTSPLIT keeps its pieces as text, as in Excel. */
function splitValue(piece) {
  const t = piece.trim();
  if (t !== '' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return parseFloat(t);
  if (/^(TRUE|FALSE)$/i.test(t)) return t.toUpperCase() === 'TRUE';
  return piece;
}

/** Round to `digits` decimal places; negative digits round to tens, hundreds, ... */
/**
 * The binomial probability of `k` successes in `n` trials, computed wholly in
 * logarithms: past a thousand trials the coefficient alone overflows a double
 * while the power underflows, which multiplied gave Infinity, 0 or NaN.
 */
function binomialPmf(n, k, p) {
  if (p === 0) return k === 0 ? 1 : 0;
  if (p === 1) return k === n ? 1 : 0;
  // Up to a thousand trials, where C(n, k) is a double, the mass is its own product, so
  // BINOM.DIST(0,0,0.5,FALSE) is exactly 1 and BINOM.DIST(2,4,0.5,FALSE) exactly 0.375; only
  // when a power leaves the doubles do the logarithms below take over.
  if (n <= 1000) {
    const hits = p ** k;
    const misses = (1 - p) ** (n - k);
    if (hits >= 1e-307 && misses >= 1e-307) {
      let mass = hits; // C(n, k) is built as C(n-k+j, j), an integer at every step, so small ones come out exact
      for (let j = 1; j <= k; j++) mass = (mass * (n - k + j)) / j;
      return mass * misses;
    }
  }
  // C(n, k) p^k (1-p)^(n-k) = p^(k+1) (1-p)^(n-k+1) / B(k+1, n-k+1) / ((n+1) p (1-p)), in the conditioned
  // form of the incomplete beta's prefactor: the sum of three logarithms near n ln n kept seven digits at a billion trials.
  return Math.exp(lnBetaFront(p, 1 - p, k + 1, n - k + 1)) / ((n + 1) * p * (1 - p));
}

/** The binomial CDF P(X ≤ k) and its complement for n trials at probability p: the incomplete beta I_(1-p)(n-k, k+1). */
function binomialCdf(n, k, p) {
  if (k < 0) return { p: 0, q: 1 };
  if (k >= n) return { p: 1, q: 0 };
  // Up to a thousand trials the masses are exact products; their sum keeps BINOM.DIST(1,2,0.5,TRUE) at exactly 0.75.
  if (n <= 1000) {
    let total = 0;
    for (let i = 0; i <= k; i++) total += binomialPmf(n, i, p);
    total = Math.min(1, total);
    return { p: total, q: 1 - total };
  }
  return incompleteBeta(1 - p, n - k, k + 1, p);
}

/** Round half away from zero at `digits` decimals on the value's 15 significant digits, as ROUND does. */
function roundToDigits(n, digits) {
  if (digits >= 0 && Number.isInteger(n)) return n; // a whole number keeps its decimals, where scaling 1E+308 by 10^digits would overflow
  const f = 10 ** Math.abs(digits);
  const r = Math.round(sig15(digits >= 0 ? Math.abs(n) * f : Math.abs(n) / f));
  return Math.sign(n) * (digits >= 0 ? r / f : r * f);
}

const fixedFormatters = new Map();
/**
 * A number with exactly `dec` decimals in the regional format's notation (1.234,5 under German, as TEXT
 * and the cell write it, so VALUE reads it back); past the formatter's 100-digit limit the rest are zeros.
 */
function fixedDecimals(v, dec, grouping) {
  const shown = Math.min(dec, 100);
  const key = `${getLocale()}|${shown}|${grouping}`;
  let formatter = fixedFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(getLocale(), { minimumFractionDigits: shown, maximumFractionDigits: shown, useGrouping: grouping });
    fixedFormatters.set(key, formatter);
  }
  // A negative number rounded to nothing arrives as -0, which would print its sign: "-0.00".
  const text = formatter.format(v === 0 ? 0 : v);
  return dec > shown ? text + '0'.repeat(dec - shown) : text;
}

/**
 * A regular expression from a pattern argument, or #VALUE! when it does not compile, or when
 * `subject`, the text it is to run on, is longer than the pattern can be tried on in reasonable time.
 */
function regex(pattern, flags = '', subject = '') {
  let p = textArg(pattern);
  if (isError(p)) return p;
  // RE2's leading inline flags, (?i), (?s), (?m) and combinations of them, become JavaScript flags.
  for (let m = /^\(\?([ims]+)\)/.exec(p); m; m = /^\(\?([ims]+)\)/.exec(p)) {
    for (const f of m[1]) if (!flags.includes(f)) flags += f;
    p = p.slice(m[0].length);
  }
  if (nestedRepeat(p)) return err('#VALUE!');
  // Two overlapping repeats, (\w+)\s*(\w+)=, tried from every position of a long cell cost the cube of its
  // length, hours at the longest: past the pattern's limit the text is refused as the pattern would be.
  if (subject.length > subjectLimit(p)) return err('#VALUE!');
  // Match by character, so "." takes a whole emoji; a pattern the stricter unicode mode rejects falls back.
  try { return new RegExp(p, `${flags}u`); } catch { /* not valid with u */ }
  try { return new RegExp(p, flags); } catch { return err('#VALUE!'); }
}

/**
 * TEXTBEFORE and TEXTAFTER: the text either side of the nth delimiter, counting from the end when n
 * is negative. match_mode 1 ignores case; match_end 1 lets the end of the text (its start, counting
 * from the end) stand for a delimiter; if_not_found replaces #N/A. An instance of 0 or
 * one past the text's length is #VALUE!, and an empty delimiter matches at once.
 */
function textAround([text, delim, nth, matchMode, matchEnd, ifNotFound], before) {
  const t = textArg(text); if (isError(t)) return t;
  const delims = delimiterList(delim); if (isError(delims)) return delims;
  const k = nth === undefined ? 1 : toNumber(nth); if (isError(k)) return k;
  const mode = matchMode === undefined ? 0 : toNumber(matchMode); if (isError(mode)) return mode;
  const atEnd = matchEnd === undefined ? 0 : toNumber(matchEnd); if (isError(atEnd)) return atEnd;
  if ((mode !== 0 && mode !== 1) || (atEnd !== 0 && atEnd !== 1)) return err('#VALUE!');
  const n = Math.trunc(k);
  if (n === 0) return err('#VALUE!');
  if (t === '') return '';
  if (Math.abs(n) > t.length) return err('#VALUE!');
  const hits = [];
  if (delims.some((d) => d === '')) hits.push(n > 0 ? { i: 0, len: 0 } : { i: t.length, len: 0 });
  else if (delims.length) {
    const re = delimiterPattern(delims, mode === 1);
    for (let m = re.exec(t); m; m = re.exec(t)) hits.push({ i: m.index, len: m[0].length });
  }
  if (atEnd === 1) { if (n > 0) hits.push({ i: t.length, len: 0 }); else hits.unshift({ i: 0, len: 0 }); }
  const hit = hits[n > 0 ? n - 1 : hits.length + n];
  if (!hit) return ifNotFound === undefined ? err('#N/A') : ifNotFound;
  return before ? t.slice(0, hit.i) : t.slice(hit.i + hit.len);
}

/* ---------- Engineering helpers: error function and complex numbers ---------- */

/**
 * Complementary error function to double precision: a series of positive terms up to 2.5, so
 * nothing cancels, and a continued fraction beyond, where the series would lose the tail.
 */
function erfcOf(x) {
  if (Number.isNaN(x)) return NaN;
  if (x < 0) return 2 - erfcOf(-x);
  if (x > 27) return 0;
  if (x < 2.5) {
    // erf(x) = 2/sqrt(pi) * exp(-x^2) * sum of 2^n x^(2n+1) / (1*3*...*(2n+1))
    let term = x;
    let sum = x;
    for (let n = 1; n < 400; n++) {
      term *= (2 * x * x) / (2 * n + 1);
      sum += term;
      if (term < sum * 1e-17) break;
    }
    return 1 - (2 / Math.sqrt(Math.PI)) * Math.exp(-x * x) * sum;
  }
  // erfc(x) = exp(-x^2)/sqrt(pi) / (x + (1/2)/(x + 1/(x + (3/2)/(x + 2/(x + ...))))), taken from the tail end
  let f = x;
  for (let k = 80; k >= 1; k--) f = x + (k / 2) / f;
  return Math.exp(-x * x) / (Math.sqrt(Math.PI) * f);
}


/** "3+4i", "-2j", "5", 7 → { re, im, suffix } or an error; a real number has no suffix, and takes i when written. */
function parseComplex(v) {
  v = scalar(v);
  if (isError(v)) return v;
  if (v == null || v === '') return { re: 0, im: 0 };
  if (typeof v === 'number') return { re: v, im: 0 };
  if (typeof v !== 'string') return err('#VALUE!');
  const t = v.replace(/\s+/g, '');
  const NUM = '(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?';
  const CPLX_REAL = new RegExp(`^([-+]?${NUM})$`);
  const CPLX_IMAG = new RegExp(`^([-+]?)(${NUM})?([ij])$`);
  const CPLX_BOTH = new RegExp(`^([-+]?${NUM})([-+])(${NUM})?([ij])$`);
  let m = CPLX_REAL.exec(t);
  if (m) return { re: Number(m[1]), im: 0 };
  m = CPLX_IMAG.exec(t);
  if (m) return { re: 0, im: (m[1] === '-' ? -1 : 1) * (m[2] == null ? 1 : Number(m[2])), suffix: m[3] };
  m = CPLX_BOTH.exec(t);
  if (m) return { re: Number(m[1]), im: (m[2] === '-' ? -1 : 1) * (m[3] == null ? 1 : Number(m[3])), suffix: m[4] };
  return err('#NUM!');
}

function formatComplex(re, im, suffix = 'i', exact = false) {
  if (!Number.isFinite(re) || !Number.isFinite(im)) return err('#NUM!');
  // Floating-point noise in one part of a computed result — the 1.22E-16 beside the -1 of e^(iπ) — is
  // swept away, judged against the other part's size; a tiny number standing on its own scale, like
  // 1.5E-20i, is a value. Nothing tells a computed 1E-16 beside 1 from a given one, so a number whose
  // parts are given (COMPLEX) or added (IMSUM, IMSUB) is `exact` and keeps every part, 1E-20 beside 1 included.
  const noise = (n, other) => !exact && Math.abs(n) < 1e-14 && Math.abs(n) < Math.abs(other) * 1e-14;
  const [r0, i0] = [re, im];
  re = noise(r0, i0) ? 0 : Number(r0.toPrecision(15));
  im = noise(i0, r0) ? 0 : Number(i0.toPrecision(15));
  // Each part keeps 15 significant digits, as Excel writes complex numbers; one that needs exponent
  // form is written from the same digits as 1.23456789012345E-07, not handed to General, which keeps about 10.
  const part = (n) => {
    const t = String(Number(n.toPrecision(15)));
    if (!t.includes('e')) return t;
    const [mantissa, exponent] = n.toPrecision(15).split('e');
    const digits = mantissa.includes('.') ? mantissa.replace(/0+$/, '').replace(/\.$/, '') : mantissa;
    const e = Number(exponent);
    return `${digits}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
  };
  if (im === 0) return part(re);
  const imText = Math.abs(im) === 1 ? '' : part(Math.abs(im));
  if (re === 0) return `${im < 0 ? '-' : ''}${imText}${suffix}`;
  return `${part(re)}${im < 0 ? '-' : '+'}${imText}${suffix}`;
}

/** A complex function of one argument; the result keeps the argument's i/j suffix. */
function complexUnary(f) {
  return ([a]) => {
    const z = parseComplex(a);
    if (isError(z)) return z;
    const out = f(z);
    return isError(out) ? out : formatComplex(out.re, out.im, z.suffix);
  };
}

// Declarations (not consts): the function table above is built while this module loads.
function cMul(a, b) { return { re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re }; }
function cDiv(a, b) {
  const d = b.re * b.re + b.im * b.im;
  return d === 0 ? err('#NUM!') : { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
}
function cExp(z) { return { re: Math.exp(z.re) * Math.cos(z.im), im: Math.exp(z.re) * Math.sin(z.im) }; }
function cLn(z) { return z.re === 0 && z.im === 0 ? err('#NUM!') : { re: Math.log(Math.hypot(z.re, z.im)), im: Math.atan2(z.im, z.re) }; }
function cPow(z, n) {
  if (z.re === 0 && z.im === 0) return n > 0 ? { re: 0, im: 0 } : err('#NUM!');
  if (Number.isInteger(n) && Math.abs(n) <= 1e6) {
    // A whole power by repeated squaring stays exact for small integers: (2+3i)^3 is -46+9i, where the polar form gave 9.00000000000001i.
    let out = { re: 1, im: 0 };
    let base = z;
    for (let k = Math.abs(n); k > 0; k = Math.floor(k / 2)) {
      if (k % 2) out = cMul(out, base);
      base = cMul(base, base);
    }
    if (!Number.isFinite(out.re) || !Number.isFinite(out.im)) return err('#NUM!');
    return n < 0 ? cDiv({ re: 1, im: 0 }, out) : out;
  }
  const r = Math.hypot(z.re, z.im) ** n;
  const th = Math.atan2(z.im, z.re) * n;
  return { re: r * Math.cos(th), im: r * Math.sin(th) };
}

/** Discount-security helpers: settlement and maturity as serials, checked, plus the year fraction. */
function discountArgs(settlement, maturity, basis) {
  const s = toNumber(settlement); if (isError(s)) return s;
  const m = toNumber(maturity); if (isError(m)) return m;
  if (!(s < m)) return err('#NUM!');
  const yf = FUNCTIONS.YEARFRAC.fn([s, m, basis === undefined ? 0 : basis]);
  if (isError(yf)) return yf;
  return { s, m, yf, days: Math.trunc(m) - Math.trunc(s) };
}

/** Days between two serials under a day-count basis (0 US 30/360, 4 European 30/360, else actual). */
function basisDays(a, b, basis) {
  if (basis === 0) return days360(a, b, false);
  if (basis === 4) return days360(a, b, true);
  return Math.trunc(b) - Math.trunc(a);
}

/**
 * The coupon schedule around a settlement date: coupons fall every 12/freq
 * months back from maturity (month-end maturities keep to month ends).
 * Returns { s, m, freq, basis, pcd, ncd, num } — the previous and next
 * coupon dates and how many coupons remain — or an error.
 */
function couponArgs(settlement, maturity, frequency, basis) {
  const s = toNumber(settlement); if (isError(s)) return s;
  const m = toNumber(maturity); if (isError(m)) return m;
  const f = toNumber(frequency); if (isError(f)) return f;
  const b = basis === undefined ? 0 : toNumber(basis); if (isError(b)) return b;
  const freq = Math.trunc(f);
  const bas = Math.trunc(b);
  if (![1, 2, 4].includes(freq) || bas < 0 || bas > 4 || !(Math.trunc(s) < Math.trunc(m))) return err('#NUM!');
  const at = couponSchedule(Math.trunc(m), freq);
  let k = 0;
  while (at(-k) > Math.trunc(s)) k++;
  return { s: Math.trunc(s), m: Math.trunc(m), freq, basis: bas, pcd: at(-k), ncd: at(1 - k), num: k };
}

/**
 * The coupon dates every 12/freq months from an anchor serial (a maturity, or ACCRINT's first
 * interest date): at(k) is k periods after it, k < 0 before. A month-end anchor keeps to month
 * ends; any other day is capped to the month's last.
 */
function couponSchedule(anchor, freq) {
  const a = serialToYMD(anchor);
  const lastOf = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const eom = a.d === lastOf(a.y, a.m);
  const step = 12 / freq;
  return (k) => {
    const t = new Date(Date.UTC(a.y, a.m - 1 + k * step, 1));
    const ty = t.getUTCFullYear();
    const tm = t.getUTCMonth() + 1;
    const last = lastOf(ty, tm);
    return ymdToSerial(ty, tm, eom ? last : Math.min(a.d, last));
  };
}

/** The A (accrued days), E (days in the period), DSC (days to next coupon) of the bond formulas. */
function couponDays(cp) {
  const A = basisDays(cp.pcd, cp.s, cp.basis);
  const E = cp.basis === 1 ? cp.ncd - cp.pcd : cp.basis === 3 ? 365 / cp.freq : 360 / cp.freq;
  const DSC = cp.basis === 0 || cp.basis === 4 ? E - A : cp.ncd - cp.s;
  return { A, E, DSC };
}

/** Price per 100 face value of a security paying periodic interest (PRICE). */
function bondPrice(cp, rate, yld, redemption) {
  const { A, E, DSC } = couponDays(cp);
  const N = cp.num;
  const coupon = 100 * rate / cp.freq;
  if (N === 1) return (redemption + coupon) / (1 + (yld / cp.freq) * (DSC / E)) - coupon * (A / E);
  let price = redemption / Math.pow(1 + yld / cp.freq, N - 1 + DSC / E);
  for (let k = 1; k <= N; k++) price += coupon / Math.pow(1 + yld / cp.freq, k - 1 + DSC / E);
  return price - coupon * (A / E);
}

/** The yield that prices a bond at `pr` (closed form for one coupon left, otherwise by bisection). */
function bondYield(cp, rate, pr, redemption) {
  const { A, E, DSC } = couponDays(cp);
  const coupon = rate / cp.freq;
  if (cp.num === 1) {
    const base = pr / 100 + (A / E) * coupon;
    return ((redemption / 100 + coupon) - base) / base * ((cp.freq * E) / DSC);
  }
  let lo = -0.99 * cp.freq;
  let hi = 10;
  if (bondPrice(cp, rate, hi, redemption) > pr) return err('#NUM!');
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (bondPrice(cp, rate, mid, redemption) > pr) lo = mid; else hi = mid;
    if (hi - lo < 1e-14) break;
  }
  return (lo + hi) / 2;
}

/** Macaulay duration in years (DURATION): coupons fall (k - 1 + DSC/E) periods out, as in PRICE. */
function bondDuration(cp, rate, yld) {
  const { E, DSC } = couponDays(cp);
  const N = cp.num;
  const coupon = 100 * rate / cp.freq;
  const y = 1 + yld / cp.freq;
  let dur = 0;
  let p = 0;
  for (let k = 1; k <= N; k++) {
    const t = k - 1 + DSC / E;
    const cash = coupon + (k === N ? 100 : 0);
    dur += t * cash / Math.pow(y, t);
    p += cash / Math.pow(y, t);
  }
  return dur / p / cp.freq;
}

/** Read the money arguments of a bond function; each must be a number and non-negative (or positive). */
function bondNumbers(list) {
  const out = [];
  for (const [v, positive] of list) {
    const n = toNumber(v); if (isError(n)) return n;
    if (positive ? !(n > 0) : n < 0) return err('#NUM!');
    out.push(n);
  }
  return out;
}

/* ---------- Bessel functions ---------- */

/*
 * The Bessel functions of integer order n ≥ 0, each to rounding. J_n and I_n come from their
 * power series where its terms shrink from the first (I_n always: its terms are all positive);
 * J_n otherwise from Miller's downward recurrence normalised by J_0 + 2(J_2 + J_4 + …) = 1,
 * which also yields Y_0 and Y_1 through their Neumann series; K_0 and K_1 from the integral
 * ∫₀^∞ e^(-x cosh t) cosh(νt) dt by the trapezoidal rule, which converges geometrically for it;
 * far out, from Hankel's asymptotic expansions; and higher orders of Y and K by the three-term
 * recurrence upward, where it is stable.
 */
const EULER = 0.5772156649015329;

/** J_n(x) for 0 ≤ x ≤ 2√(n+1), where the power series' terms shrink from the first: no cancellation. */
function besselJSeries(n, x) {
  // The first term (x/2)^n / n! is at most (n+1)^(n/2) / n!, below e^-800 from n = 400 on: smaller than any double.
  if (n >= 400) return 0;
  const h = x / 2;
  const h2 = h * h;
  let term = 1;
  for (let j = 1; j <= n; j++) term *= h / j;
  let sum = term;
  for (let k = 1; term !== 0; k++) {
    term *= -h2 / (k * (n + k));
    sum += term;
    if (Math.abs(term) <= Math.abs(sum) * 1e-17) break;
  }
  return sum;
}

/**
 * I_n(x) for x ≥ 0 by its power series Σ (x/2)^(2k+n) / (k! (n+k)!), all terms positive: no
 * cancellation, about x terms. The first term comes as a product for small orders and through
 * lnΓ for large ones, where the sum is kept scaled: a large n with a large x can have a first
 * term below the doubles and a total above them.
 */
function besselISeries(n, x) {
  if (x === 0) return n === 0 ? 1 : 0;
  const h = x / 2;
  const h2 = h * h;
  let term;
  let offset = 0; // the sum stands for e^offset times itself
  if (n <= 300) {
    term = 1;
    for (let j = 1; j <= n; j++) term *= h / j;
    // For these orders the sum is within a factor e^(x²/4(n+1)) < 2 of the first term wherever that term is tiny.
    if (term === 0) return 0;
    if (!Number.isFinite(term)) return Infinity;
  } else {
    const lnTerm = n * Math.log(h) - gammaLn(n + 1);
    // Σ_k Π_j≤k h² / (j (n+j)) ≤ Σ_k (h² / (n+1))^k / k! = e^(h² / (n+1)): below that the whole sum rounds to nothing.
    if (lnTerm + h2 / (n + 1) < -745) return 0;
    if (lnTerm > 709) return Infinity;
    if (lnTerm < -700) { offset = lnTerm; term = 1; } else term = Math.exp(lnTerm);
  }
  let sum = term;
  for (let k = 1; ; k++) {
    term *= h2 / (k * (n + k));
    sum += term;
    if (term <= sum * 1e-17) break;
    if (sum > 1e250) { sum *= 1e-250; term *= 1e-250; offset += 250 * Math.LN10; }
  }
  return offset ? Math.exp(offset + Math.log(sum)) : sum;
}

/**
 * J_0(x), J_1(x), J_n(x) and the sums Σ (-1)^k J_2k / k and Σ (-1)^k (J_2k-1 - J_2k+1) / k over
 * k ≥ 1 for 0 < x ≤ 10000: Miller's downward recurrence from an order where J is negligible,
 * normalised by J_0 + 2(J_2 + J_4 + …) = 1, gives every order to rounding with nothing to start
 * from; the sums are the Neumann series of Y_0 and Y_1.
 */
function besselJMiller(x, n) {
  const top = Math.max(n, Math.ceil(x));
  let start = top + Math.ceil(Math.sqrt(40 * top)) + 40;
  if (start % 2) start++;
  let above = 0; // the unnormalised J at order k + 1
  let at = 1; // and at order k
  let norm = 0;
  let j0 = 0;
  let j1 = 0;
  let jn = 0;
  let s0 = 0;
  let s1 = 0;
  for (let k = start; ; k--) {
    if (k === n) jn = at;
    if (k % 2 === 0) {
      norm += k ? 2 * at : at;
      if (k) s0 += (((k / 2) % 2 ? -2 : 2) / k) * at; // J_2j weighs (-1)^j / j
      if (k === 0) { j0 = at; break; }
    } else {
      // J_k stands in the second sum as J_2j-1 (j = (k+1)/2) and, from k = 3, as -J_2j+1 (j = (k-1)/2), both with the sign (-1)^((k+1)/2).
      s1 += (((k + 1) / 2) % 2 ? -1 : 1) * (k === 1 ? 1 : (4 * k) / (k * k - 1)) * at;
      if (k === 1) j1 = at;
    }
    const below = ((2 * k) / x) * at - above;
    above = at;
    at = below;
    // The unnormalised values grow past the doubles on the way down: everything scales together.
    if (Math.abs(at) > 1e250) { above *= 1e-250; at *= 1e-250; norm *= 1e-250; j1 *= 1e-250; jn *= 1e-250; s0 *= 1e-250; s1 *= 1e-250; }
  }
  return { j0: j0 / norm, j1: j1 / norm, jn: jn / norm, s0: s0 / norm, s1: s1 / norm };
}

/** J_ν(x) and Y_ν(x) for ν = 0 or 1 and x ≥ 10000 from Hankel's asymptotic expansion, which needs a few terms there. */
function hankel(nu, x) {
  const mu = 4 * nu * nu;
  let p = 0;
  let q = 0;
  let term = 1; // (4ν² - 1)(4ν² - 9)…(4ν² - (2k-1)²) / (k! (8x)^k)
  for (let k = 0; k < 40; k++) {
    if (k % 2 === 0) p += ((k / 2) % 2 ? -1 : 1) * term; else q += (((k - 1) / 2) % 2 ? -1 : 1) * term;
    const next = (term * (mu - (2 * k + 1) ** 2)) / (8 * (k + 1) * x);
    if (Math.abs(next) < 1e-17) break;
    term = next;
  }
  const chi = x - (nu / 2 + 0.25) * Math.PI;
  const amp = Math.sqrt(2 / (Math.PI * x));
  return { j: amp * (p * Math.cos(chi) - q * Math.sin(chi)), y: amp * (p * Math.sin(chi) + q * Math.cos(chi)) };
}

function besselJ(n, x) {
  const ax = Math.abs(x);
  let v;
  if (ax * ax <= 4 * (n + 1)) v = besselJSeries(n, ax);
  else if (ax <= 1e4 || n >= ax) v = besselJMiller(ax, n).jn;
  else {
    // Far out, below the argument, the recurrence is stable upward from Hankel's J_0 and J_1.
    let below = hankel(0, ax).j;
    let at = hankel(1, ax).j;
    for (let k = 1; k < n; k++) { const next = ((2 * k) / ax) * at - below; below = at; at = next; }
    v = n === 0 ? below : at;
  }
  return x < 0 && n % 2 === 1 ? -v : v;
}

/** Y_n(x) for x > 0: Y_0 and Y_1 from the Neumann series over Miller's J's, then upward, where Y grows and the recurrence is stable. */
function besselY(n, x) {
  let y0;
  let y1;
  if (x > 1e4) { y0 = hankel(0, x).y; y1 = hankel(1, x).y; }
  // Below 1E-300 the recurrence's 2k / x would overflow; there the leading terms are the values to rounding.
  else if (x < 1e-300) { y0 = (2 / Math.PI) * (Math.log(x / 2) + EULER); y1 = -2 / (Math.PI * x); }
  else {
    const { j0, j1, s0, s1 } = besselJMiller(x, 1);
    const L = Math.log(x / 2) + EULER;
    y0 = (2 / Math.PI) * (L * j0 - 2 * s0);
    y1 = (2 / Math.PI) * (-j0 / x + L * j1 + s1);
  }
  if (n === 0) return y0;
  let below = y0;
  let at = y1;
  for (let k = 1; k < n && Number.isFinite(at); k++) { const next = ((2 * k) / x) * at - below; below = at; at = next; }
  return at;
}

function besselI(n, x) {
  const v = besselISeries(n, Math.abs(x));
  return x < 0 && n % 2 === 1 ? -v : v;
}

/**
 * K_0(x) or K_1(x) for x > 0: from x = 20 the asymptotic expansion, whose smallest term is
 * about e^-2x; below, the trapezoidal rule on ∫₀^∞ e^(-x cosh t) cosh(νt) dt, with the step
 * taken from the strip the integrand is analytic in, so the rule converges geometrically, and
 * the range cut where the integrand has fallen e^-40 below its start.
 */
function besselK01(nu, x) {
  const mu = 4 * nu * nu;
  if (x >= 20) {
    let sum = 0;
    let term = 1;
    for (let k = 0; k < 60; k++) {
      sum += term;
      const next = (term * (mu - (2 * k + 1) ** 2)) / (8 * (k + 1) * x);
      if (Math.abs(next) < 1e-17 * sum || Math.abs(next) > Math.abs(term)) break;
      term = next;
    }
    return Math.sqrt(Math.PI / (2 * x)) * Math.exp(-x) * sum;
  }
  const h = (Math.PI * Math.PI) / (2 * x + 40);
  const end = Math.acosh(1 + 42 / x);
  let sum = 0.5 * Math.exp(-x);
  for (let t = h; t <= end; t += h) { const c = Math.cosh(t); sum += Math.exp(-x * c) * (nu ? c : 1); }
  return h * sum;
}

/** K_n(x) for x > 0, upward from K_0 and K_1: K grows with the order, so the recurrence is stable. */
function besselK(n, x) {
  const k0 = besselK01(0, x);
  if (n === 0) return k0;
  let below = k0;
  let at = besselK01(1, x);
  for (let k = 1; k < n && Number.isFinite(at); k++) { const next = below + ((2 * k) / x) * at; below = at; at = next; }
  return at;
}

/** The (x, n) arguments of a Bessel function: n is truncated and must be >= 0; positive x only when `positive`. */
function besselArgs(x, n, positive) {
  const xv = toNumber(x); if (isError(xv)) return xv;
  const nv = toNumber(n); if (isError(nv)) return nv;
  const order = Math.trunc(nv);
  // The recurrences run once per order, so an order of a billion would recur for seconds: a million is the limit.
  if (order < 0 || order > 1e6 || (positive && !(xv > 0))) return err('#NUM!');
  return { x: xv, n: order };
}

/** A two-number function (ADD, POW, ...): both arguments coerced, the result checked. */
function arith(f) {
  return ([a, b]) => {
    const x = toNumber(a); if (isError(x)) return x;
    const y = toNumber(b); if (isError(y)) return y;
    const r = f(x, y);
    return isError(r) ? r : checkNum(r);
  };
}

/** A comparison function (EQ, GT, ...): spreadsheet ordering, blanks read as the other side's empty value. */
function relation(f) {
  return ([a, b]) => {
    let x = scalar(a); if (isError(x)) return x;
    let y = scalar(b); if (isError(y)) return y;
    const empty = (v) => (typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : '');
    if (x == null) x = empty(y ?? '');
    if (y == null) y = empty(x);
    return f(compareValues(x, y));
  };
}

function unaryMath(f) {
  return ([a]) => { const n = toNumber(a); return isError(n) ? n : checkNum(f(n)); };
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** The inclusive percentile: linear interpolation between order statistics. */
function percentile(list, p) {
  if (!list.length || p < 0 || p > 1) return err('#NUM!');
  const s = [...list].sort((a, b) => a - b);
  // Round the one-based rank before extracting its fractional part.
  // Computing a zero-based position instead changes boundary comparisons and
  // leaves tiny probabilities nonzero that this rounds onto the minimum.
  const rank = 1 + p * (s.length - 1), lo = Math.floor(rank);
  return rank === lo ? s[lo - 1] : s[lo - 1] + (s[lo] - s[lo - 1]) * (rank - lo);
}

/** Paired numeric samples (positions where both are numbers, whole columns on two sheets read to one depth) → summary stats → f(stats). */
/** An optional numeric argument of the ETS functions: its default when left out, else a number or the error. */
function etsOption(v, fallback) {
  if (v === undefined || v === EMPTY) return fallback;
  return toNumber(v);
}

/** The fitted ETS model for FORECAST.ETS* arguments, or the error they come to. */
function etsModel(values, timeline, seasonality, completion, aggregation) {
  const season = etsOption(seasonality, 1), fill = etsOption(completion, 1), agg = etsOption(aggregation, 1);
  for (const v of [season, fill, agg]) if (isError(v)) return v;
  if (!Number.isInteger(season) || season < 0) return err('#NUM!');
  if (fill !== 0 && fill !== 1) return err('#NUM!');
  if (!Number.isInteger(agg) || agg < 1 || agg > 7) return err('#NUM!');
  const ranges = [asRange(values), asRange(timeline)];
  if (!sameExtent(ranges)) return err('#N/A');
  const [Y, X] = readAlike(ranges);
  const ys = Y.flat(), xs = X.flat();
  if (ys.length !== xs.length) return err('#N/A');
  const points = [];
  for (let i = 0; i < xs.length; i++) {
    if (isError(xs[i])) return xs[i];
    if (isError(ys[i])) return ys[i];
    if (xs[i] == null && ys[i] == null) continue;
    if (typeof xs[i] !== 'number') return err('#VALUE!');
    points.push([xs[i], typeof ys[i] === 'number' ? ys[i] : null]);
  }
  if (points.length < 2 || !points.some((p) => p[1] != null)) return err('#VALUE!');
  const model = cachedModel(points, { completion: fill, aggregation: agg }, season);
  return model.error ? err(model.error) : model;
}

/** Apply an ETS answer to a target or to each target of an array. */
function etsEach(target, model, answer) {
  if (isError(model)) return model;
  const one = (t) => {
    if (isError(t)) return t;
    const x = toNumber(t);
    if (isError(x)) return x;
    const v = answer(model, x);
    return v && typeof v === 'object' ? err(v.error) : Number.isFinite(v) ? v : err('#NUM!');
  };
  return isRange(target) ? { range: true, values: target.values.map((row) => row.map(one)) } : one(target);
}

function pairStats(a, b, f) {
  const pairs = pairedNumbers(a, b); if (isError(pairs)) return pairs;
  const n = pairs.length;
  if (n < 1) return err('#DIV/0!'); // one pair has a population covariance of 0; the fits divide by its zero spread and fail on their own
  const mx = pairs.reduce((s, [x]) => s + x, 0) / n;
  const my = pairs.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  // As with variance, flush each product before accumulation: a sum of
  // subnormal products must not grow into a nonzero covariance or spread.
  for (const [x, y] of pairs) {
    sxx += flushUnderflow((x - mx) ** 2);
    syy += flushUnderflow((y - my) ** 2);
    sxy += flushUnderflow((x - mx) * (y - my));
  }
  return f({ n, mx, my, sxx, syy, sxy });
}

function correlation(s, correction = 0) {
  if (!s.sxx || !s.syy) return err('#DIV/0!');
  // Normalize the moments before combining their square roots. Taking
  // sqrt(sxx * syy) instead overflows/underflows even when r is representable.
  // RSQ uses sample moments; CORREL/PEARSON use population moments. Usually
  // that normalization cancels, but underflow can distinguish them. Nonzero
  // sums whose normalized moments vanish produce #NUM!, not #DIV/0!.
  const count = s.n - correction;
  const vx = flushUnderflow(s.sxx / count);
  const vy = flushUnderflow(s.syy / count);
  const covariance = flushUnderflow(s.sxy / count);
  return flushUnderflow(covariance / flushUnderflow(Math.sqrt(vx) * Math.sqrt(vy)));
}

/** Sorted list of function names, for the insert-function menu. */
/**
 * AI(prompt, [data]): a question for Puter's AI, with an optional range of
 * data appended as a table. The answer is asked for once per distinct prompt
 * and cached; the cell shows #BUSY! until it arrives.
 */
/**
 * TRANSLATE(text, [source_language], [target_language]) and
 * DETECTLANGUAGE(text): translation through Puter's AI, asked once per
 * distinct text and cached like AI(). Languages are codes ("fr") or names
 * ("French"); the target defaults to English.
 */
export function translatePrompt(text, source, target) {
  // Sheets' "auto" asks for the source language to be detected, as leaving it out does.
  const from = source && !/^auto$/i.test(source) ? `from ${source}` : 'from the language it is written in';
  return `Translate the text between the markers ${from} to ${target}. Reply with only the translation, no quotes, notes, or explanations.\n<<<\n${text}\n>>>`;
}

FUNCTIONS.TRANSLATE = {
  minArgs: 1, maxArgs: 3,
  fn: ([text, source, target], ctx) => {
    const t = toText(scalar(text)); if (isError(t)) return t;
    if (!String(t).trim()) return '';
    const from = source == null ? '' : toText(scalar(source)); if (isError(from)) return from;
    // The target defaults to English, as the hint promises, when it is left out, left empty
    // (TRANSLATE(A1,"es",) hands over the evaluator's empty marker, not "") or blank text; the
    // prompt otherwise asked for a translation "to ." and the model answered as it pleased.
    const to = target == null ? '' : toText(scalar(target)); if (isError(to)) return to;
    if (!ctx?.asyncValue) return err('#N/A');
    return ctx.asyncValue('TRANSLATE', translatePrompt(String(t), String(from).trim(), String(to).trim() || 'English'));
  },
};
FUNCTIONS.GOOGLETRANSLATE = FUNCTIONS.TRANSLATE;

FUNCTIONS.DETECTLANGUAGE = {
  minArgs: 1, maxArgs: 1,
  fn: ([text], ctx) => {
    const t = toText(scalar(text)); if (isError(t)) return t;
    if (!String(t).trim()) return '';
    if (!ctx?.asyncValue) return err('#N/A');
    return ctx.asyncValue('DETECTLANGUAGE', `Which language is the text between the markers written in? Reply with only its two-letter ISO 639-1 code (such as en, fr, de, es, ja), nothing else.\n<<<\n${t}\n>>>`);
  },
};

FUNCTIONS.AI = {
  minArgs: 1, maxArgs: 2,
  fn: ([prompt, data], ctx) => {
    const question = toText(scalar(prompt));
    if (isError(question)) return question;
    let text = String(question);
    if (data !== undefined) {
      const rows = isRange(data) ? data.values : [[data]];
      const width = rows.reduce((n, row) => Math.max(n, row.length), 0);
      // At most sixty rows by fifteen columns go to the model, as the Ask AI dialog sends, with a note of the rest.
      const shownRows = Math.min(rows.length, 60);
      const shownCols = Math.min(width, 15);
      // The cells as they read: numbers in the General format, TRUE and FALSE, errors by name, a
      // drawable as nothing, and, where the workbook offers their display text, dates as dates.
      const display = isRange(data) && data.ref && ctx?.getRangeDisplay ? ctx.getRangeDisplay(data.ref) : null;
      const cellText = (r, c) => {
        const v = rows[r][c];
        if (v != null && typeof v === 'object' && !isError(v)) return '';
        // Prompts describe displayed cells; numeric fallback uses General,
        // independently of VALUETOTEXT's formula conversion precision.
        return String(display?.[r]?.[c] ?? (typeof v === 'number' ? formatGeneral(v) : valueAsText(v, false))).replace(/\s+/g, ' ');
      };
      const lines = [];
      for (let r = 0; r < shownRows; r++) lines.push(Array.from({ length: shownCols }, (_, c) => cellText(r, c)).join('\t'));
      const cut = [];
      if (rows.length > shownRows) cut.push(`${rows.length - shownRows} more rows`);
      if (width > shownCols) cut.push(`${width - shownCols} more columns`);
      text = `${text}\n\nData:\n${lines.join('\n')}${cut.length ? `\n(${cut.join(' and ')} not shown)` : ''}`;
    }
    if (!ctx?.asyncValue) return err('#N/A');
    return ctx.asyncValue('AI', text);
  },
};

/**
 * QUERY(data, query, [headers]): Google Sheets' query language over a range
 * (select, where, group by, order by, limit, offset, label); see query.js.
 * The result spills. `headers` is the number of header rows; left out, a
 * text row over values counts as one.
 */
/**
 * A QUERY source in the shape its address names. A reference's values stop a
 * fixed distance past the data, so the rows and columns up to the address are
 * filled with blanks, as the evaluator fills a range for a function that does
 * not take addresses, and QUERY(A1:A1000,"select A") answers a thousand rows;
 * a whole column, or a reference of more cells than an array may hold, keeps
 * the rows read.
 */
function queryShape(range) {
  const values = range.values;
  if (!range.ref) return values;
  const [rows, cols] = rangeShape(range);
  const width = values[0]?.length || 0;
  if (!(rows > values.length || cols > width) || rows * cols > 100000) return values;
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => values[r]?.[c] ?? null));
}

FUNCTIONS.QUERY = {
  minArgs: 1, maxArgs: 3, array: true,
  refArgs: true, // one cell arrives with its address, so "select C" names its column as it does for a range
  fn: ([data, query, headers]) => {
    const source = asRange(data);
    const text = query === undefined ? '' : toText(scalar(query));
    if (isError(text)) return text;
    let h = -1;
    if (headers !== undefined) { h = toNumber(headers); if (isError(h)) return h; h = Math.trunc(h); }
    const values = queryShape(source).map((row) => row.map((v) => (isError(v) ? null : v)));
    const out = runQuery(values, String(text), { headers: h, firstCol: source.ref?.c1 ?? 0 });
    if (out.error) return err(out.error);
    // Query nulls are empty output fields, not references to empty cells.
    for (const row of out.values) for (let c = 0; c < row.length; c++) row[c] ??= '';
    return { range: true, values: out.values };
  },
};

/**
 * IMPORTDATA(url, [delimiter]): a CSV or TSV file from the web, spilled into
 * place; fetched once per address and remembered, F9 fetches again.
 */
FUNCTIONS.IMPORTDATA = {
  minArgs: 1, maxArgs: 2, array: true,
  fn: ([url, delimiter], ctx) => {
    const u = toText(scalar(url)); if (isError(u)) return u;
    if (!/^https?:\/\//i.test(String(u).trim())) return err('#VALUE!');
    const d = delimiter === undefined ? '' : toText(scalar(delimiter)); if (isError(d)) return d;
    if (!ctx?.asyncValue) return err('#N/A');
    return ctx.asyncValue('IMPORTDATA', JSON.stringify([String(u).trim(), String(d)]));
  },
};

/**
 * IMPORTHTML(url, "table" | "list", [index]): a table or list from a web
 * page, spilled into place; fetched once per address and remembered.
 */
FUNCTIONS.IMPORTHTML = {
  minArgs: 2, maxArgs: 3, array: true,
  fn: ([url, query, index], ctx) => {
    const u = toText(scalar(url)); if (isError(u)) return u;
    if (!/^https?:\/\//i.test(String(u).trim())) return err('#VALUE!');
    const kind = toText(scalar(query)); if (isError(kind)) return kind;
    const k = String(kind).trim().toLowerCase();
    if (k !== 'table' && k !== 'list') return err('#VALUE!');
    const i = index === undefined ? 1 : toNumber(index); if (isError(i)) return i;
    if (!ctx?.asyncValue) return err('#N/A');
    return ctx.asyncValue('IMPORTHTML', JSON.stringify([String(u).trim(), k, Math.max(1, Math.trunc(i))]));
  },
};

/**
 * IMPORTXML(url, xpath): nodes from an XML or HTML document, one per row.
 */
FUNCTIONS.IMPORTXML = {
  minArgs: 2, maxArgs: 2, array: true,
  fn: ([url, xpath], ctx) => {
    const u = toText(scalar(url)); if (isError(u)) return u;
    if (!/^https?:\/\//i.test(String(u).trim())) return err('#VALUE!');
    const x = toText(scalar(xpath)); if (isError(x)) return x;
    if (!String(x).trim()) return err('#VALUE!');
    if (!ctx?.asyncValue) return err('#N/A');
    return ctx.asyncValue('IMPORTXML', JSON.stringify([String(u).trim(), String(x)]));
  },
};

/**
 * IMPORTRANGE(file, range): cells from another spreadsheet on the Puter drive
 * ("Budget" for Spreadsheets/Budget.xlsx, or a full path), spilled into place.
 * The file is read once per distinct call and remembered; F9 reads it again.
 */
FUNCTIONS.IMPORTRANGE = {
  minArgs: 2, maxArgs: 2, array: true,
  fn: ([file, range], ctx) => {
    const name = toText(scalar(file)); if (isError(name)) return name;
    const where = toText(scalar(range)); if (isError(where)) return where;
    if (!String(name).trim() || !String(where).trim()) return err('#VALUE!');
    if (!ctx?.asyncValue) return err('#N/A');
    return ctx.asyncValue('IMPORTRANGE', JSON.stringify([String(name).trim(), String(where).trim()]));
  },
};

/* ---------- More statistics and array functions ---------- */

const cumulativeArg = (v) => {
  if (v === undefined) return false;
  const s = scalar(v);
  if (typeof s === 'boolean') return s;
  const n = toNumber(s);
  return isError(n) ? n : n !== 0;
};
const sortEmpty = (v) => v == null || v === '';
const lnChoose = (n, k) => gammaLn(n + 1) - gammaLn(k + 1) - gammaLn(n - k + 1);
const sampleVar = (l) => numericVariance(l, 1);

Object.assign(FUNCTIONS, {
  /** SORTBY(array, by1, [order1], [by2], [order2], ...): rows (or columns) of `array` in the order of the key arrays. */
  SORTBY: {
    fn: ([a, ...rest]) => {
      const aligned = alignWindows([asRange(a), ...rest.filter((arg, i) => i % 2 === 0 && isRange(arg))]);
      const rg = aligned[0];
      let next = 1;
      rest = rest.map((arg, i) => (i % 2 === 0 && isRange(arg) ? aligned[next++] : arg));
      const height = rg.values.length;
      const width = rg.values[0]?.length || 0;
      if (!rest.length) return err('#VALUE!');
      // A column of keys orders the rows and a row of keys as wide as the array orders its columns;
      // a row of keys as long as the array is tall is read as a column of keys.
      let byCol = null;
      const keys = [];
      for (let i = 0; i < rest.length; i += 2) {
        const by = rest[i];
        if (!isRange(by)) return err('#VALUE!');
        const rows = by.values.length;
        const cols = by.values[0]?.length || 0;
        let col;
        let columns;
        if (rows === height && cols === 1) { col = by.values.map((row) => row[0]); columns = false; }
        else if (rows === 1 && cols === width) { col = by.values[0]; columns = true; }
        else if (rows === 1 && cols === height) { col = by.values[0]; columns = false; }
        else return err('#VALUE!');
        if (byCol !== null && byCol !== columns) return err('#VALUE!');
        byCol = columns;
        let asc = true;
        if (rest[i + 1] !== undefined) {
          // 1 is ascending and -1 descending; any other order is #VALUE!.
          const n = toNumber(rest[i + 1]); if (isError(n)) return n;
          if (n !== 1 && n !== -1) return err('#VALUE!');
          asc = n === 1;
        }
        keys.push({ col, asc });
      }
      const lines = byCol ? FUNCTIONS.TRANSPOSE.fn([rg]).values : rg.values;
      const order = lines.map((_, li) => li);
      order.sort((x, y) => {
        for (const key of keys) {
          const p = key.col[x];
          const q = key.col[y];
          if (sortEmpty(p) && sortEmpty(q)) continue;
          if (sortEmpty(p)) return 1;
          if (sortEmpty(q)) return -1;
          if (isError(p) && isError(q)) continue;
          if (isError(p)) return 1;
          if (isError(q)) return -1;
          const cmp = compareStoredValues(p, q);
          if (cmp) return key.asc ? cmp : -cmp;
        }
        return x - y;
      });
      const sorted = { range: true, values: order.map((li) => lines[li]) };
      return byCol ? FUNCTIONS.TRANSPOSE.fn([sorted]) : sorted;
    },
    array: true,
  },

  /** AGGREGATE(function_num, options, ref1, [ref2 | k]): a SUBTOTAL that can also skip errors and take LARGE/SMALL/PERCENTILE style k. */
  AGGREGATE: {
    fn: ([code, options, ...refs], ctx) => {
      const k = toNumber(code); if (isError(k)) return k;
      const opt = toNumber(options); if (isError(opt)) return opt;
      const n = Math.trunc(k);
      const o = Math.trunc(opt);
      if (n < 1 || n > 19 || o < 0 || o > 7 || !refs.length) return err('#VALUE!');
      const skipHidden = (o & 1) === 1;
      const skipErrors = (o & 2) === 2;
      // Options 0-3 also leave out cells holding another SUBTOTAL or AGGREGATE, as SUBTOTAL always does,
      // so a grand total over a range with subtotal rows inside does not double count.
      const skipNested = o < 4;
      const names = ['AVERAGE', 'COUNT', 'COUNTA', 'MAX', 'MIN', 'PRODUCT', 'STDEV', 'STDEV.P', 'SUM', 'VAR', 'VAR.P', 'MEDIAN', 'MODE.SNGL', 'LARGE', 'SMALL', 'PERCENTILE.INC', 'QUARTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.EXC'];
      const clean = (rg) => {
        if (!isRange(rg)) return skipErrors && isError(rg) ? null : rg;
        // A union lists its cells as one column: each area is cleaned by its own rows and the column rebuilt.
        if (rg.areas) return { range: true, values: rg.areas.flatMap((area) => clean(area).values.flatMap((row) => row.map((v) => [v ?? null]))) };
        let rows = rg.ref && (skipNested || skipHidden)
          ? totalRows(rg, ctx, { skipNested, manual: skipHidden ? true : null })
          : rg.values;
        // An error is blanked in a copy of its own row, so a range with none is read, not rebuilt.
        if (skipErrors) {
          rows = rows.map((row) => {
            let kept = row;
            for (let j = 0; j < row.length; j++) {
              if (!isError(row[j])) continue;
              if (kept === row) kept = row.slice();
              kept[j] = null;
            }
            return kept;
          });
        }
        return { range: true, values: rows, ref: rg.ref };
      };
      const target = FUNCTIONS[names[n - 1]];
      if (n >= 14) {
        // Array form: one range then k.
        if (refs.length < 2) return err('#VALUE!');
        return target.fn([clean(refs[0]), refs[1]], ctx);
      }
      return target.fn(refs.map(clean), ctx);
    },
    refArgs: true,
  },

  /** MODE.MULT: every value that occurs most often (more than once), as a column. */
  'MODE.MULT': {
    refArgs: true, // a referenced text or boolean cell is skipped, whether the reference is one cell or a range, as for MODE
    fn: num((l) => {
      const counts = new Map();
      const order = [];
      let best = 0;
      for (const v of l) {
        if (!counts.has(v)) order.push(v);
        const count = (counts.get(v) || 0) + 1;
        counts.set(v, count);
        best = Math.max(best, count);
      }
      if (best < 2) return err('#N/A');
      return { range: true, values: order.filter((v) => counts.get(v) === best).map((v) => [v]) };
    }),
    array: true,
  },

  // refArgs: a referenced text cell counts as 0 and a boolean as 1 or 0 whether the reference is one cell or a range, as for AVERAGEA
  STDEVA: { refArgs: true, fn: (args) => { const l = numbersA(args); return isError(l) ? l : sampleStdev(l); } },
  STDEVPA: { refArgs: true, fn: (args) => { const l = numbersA(args); return isError(l) ? l : populationStdev(l); } },
  VARA: { refArgs: true, fn: (args) => { const l = numbersA(args); return isError(l) ? l : descriptiveVariance(l, 1); } },
  VARPA: { refArgs: true, fn: (args) => { const l = numbersA(args); return isError(l) ? l : descriptiveVariance(l, 0); } },

  GAUSS: { fn: ([z]) => { const a = finArgs([z]); return isError(a) ? a : normCdf(a[0]) - 0.5; } },
  PHI: { fn: ([x]) => { const a = finArgs([x]); return isError(a) ? a : Math.exp(-(a[0] * a[0]) / 2) / Math.sqrt(2 * Math.PI); } },

  'F.INV': {
    fn: ([p, df1, df2]) => {
      const a = finArgs([p, df1, df2]); if (isError(a)) return a;
      const d1 = Math.trunc(a[1]);
      const d2 = Math.trunc(a[2]);
      if (a[0] < 0 || a[0] >= 1 || d1 < 1 || d2 < 1) return err('#NUM!');
      if (a[0] === 0) return 0;
      return fQuantile(a[0], d1, d2);
    },
  },
  'F.INV.RT': {
    fn: ([p, df1, df2]) => {
      const a = finArgs([p, df1, df2]); if (isError(a)) return a;
      const d1 = Math.trunc(a[1]);
      const d2 = Math.trunc(a[2]);
      if (a[0] <= 0 || a[0] > 1 || d1 < 1 || d2 < 1) return err('#NUM!');
      if (a[0] === 1) return 0;
      return fQuantile(a[0], d1, d2, true);
    },
  },
  FINV: { alias: 'F.INV.RT' },
  'F.TEST': {
    fn: ([x, y]) => {
      const l1 = []; const l2 = [];
      // An error in either array is the answer, as for T.TEST and CORREL; text and blank cells are passed over.
      for (const { v } of eachValue([x])) { if (isError(v)) return v; if (typeof v === 'number') l1.push(v); }
      for (const { v } of eachValue([y])) { if (isError(v)) return v; if (typeof v === 'number') l2.push(v); }
      if (l1.length < 2 || l2.length < 2) return err('#DIV/0!');
      const v1 = sampleVar(l1);
      const v2 = sampleVar(l2);
      if (!Number.isFinite(v1) || !Number.isFinite(v2)) return err('#NUM!');
      if (!v1 || !v2) return err('#DIV/0!');
      // Normalize the larger variance, avoiding a vanishing reciprocal ratio.
      // F.TEST uses #NUM! for overflow, unlike direct F distribution calls.
      // Native F.TEST evaluates the right beta tail directly, even when its
      // argument exceeds 1/2. Reflecting it first changes unit-shape rounding.
      const f = v1 >= v2
        ? fDistribution(v1 / v2, l1.length - 1, l2.length - 1, true)
        : fDistribution(v2 / v1, l2.length - 1, l1.length - 1, true);
      if (isError(f)) return err('#NUM!');
      return 2 * Math.min(f.p, f.q);
    },
  },
  FTEST: { alias: 'F.TEST' },

  'BINOM.INV': {
    fn: ([n, p, alpha]) => {
      const a = finArgs([n, p, alpha]); if (isError(a)) return a;
      const trials = Math.trunc(a[0]);
      // Alpha runs from 0 to 1 inclusive: at 1 the answer is every trial a success, at 0 no trial at all.
      if (trials < 0 || a[1] < 0 || a[1] > 1 || a[2] < 0 || a[2] > 1) return err('#NUM!');
      // The smallest count whose CDF reaches alpha, by halving the range of counts rather than walking it.
      let lo = 0;
      let hi = trials;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (binomialCdf(trials, mid, a[1]).p >= a[2] - 1e-12) hi = mid; else lo = mid + 1;
      }
      return lo;
    },
  },
  CRITBINOM: { alias: 'BINOM.INV' },

  'GAMMA.INV': {
    fn: ([p, alpha, beta]) => {
      const a = finArgs([p, alpha, beta]); if (isError(a)) return a;
      if (a[0] < 0 || a[0] >= 1 || a[1] <= 0 || a[2] <= 0) return err('#NUM!');
      if (a[0] === 0) return 0;
      return gammaQuantile(a[0], a[1], a[2]);
    },
  },
  GAMMAINV: { alias: 'GAMMA.INV' },

  'BETA.DIST': {
    fn: ([x, alpha, beta, cumulative, lo, hi]) => {
      const a = finArgs([x, alpha, beta]); if (isError(a)) return a;
      const cum = cumulativeArg(cumulative); if (isError(cum)) return cum;
      const bounds = finArgs([lo === undefined ? 0 : lo, hi === undefined ? 1 : hi]); if (isError(bounds)) return bounds;
      const [A, B] = bounds;
      if (a[1] <= 0 || a[2] <= 0 || a[0] < A || a[0] > B || A === B) return err('#NUM!');
      const t = (a[0] - A) / (B - A);
      if (cum) return betaDistribution(t, a[1], a[2]).p;
      // Unit-support power errors are checked against the original x, even
      // when optional bounds map 0 or 1 into the interior of the interval.
      if ((a[0] === 0 && a[1] <= 1) || (a[0] === 1 && a[2] <= 1)) return err('#NUM!');
      if (t === 0 || t === 1) return 0;
      const logDensity = lnBetaFront(t, 1 - t, a[1], a[2]) - Math.log(t) - Math.log1p(-t);
      // The unit-interval density can underflow before rescaling the bounds.
      return flushUnderflow(flushUnderflow(Math.exp(logDensity)) / (B - A));
    },
  },
  BETADIST: { fn: ([x, alpha, beta, lo, hi]) => FUNCTIONS['BETA.DIST'].fn([x, alpha, beta, true, lo, hi]) },
  'BETA.INV': {
    fn: ([p, alpha, beta, lo, hi]) => {
      const a = finArgs([p, alpha, beta]); if (isError(a)) return a;
      const bounds = finArgs([lo === undefined ? 0 : lo, hi === undefined ? 1 : hi]); if (isError(bounds)) return bounds;
      const [A, B] = bounds;
      if (a[0] <= 0 || a[0] >= 1 || a[1] <= 0 || a[2] <= 0 || A >= B) return err('#NUM!');
      // Equal shapes are symmetric about exactly 1/2. Preserve that median
      // before rescaling, where a search residual can spoil cancellation.
      const quantile = a[0] === 0.5 && a[1] === a[2] ? 0.5
        : invertCdf((t) => incompleteBeta(t, a[1], a[2]).p, a[0], 0, 1);
      // Native scaling flushes the product, not the unit quantile or the
      // final addition: a subnormal lower bound can survive a zero offset.
      return A + flushUnderflow((B - A) * quantile);
    },
  },
  BETAINV: { alias: 'BETA.INV' },

  'HYPGEOM.DIST': {
    fn: ([successes, sample, popSuccesses, population, cumulative]) => {
      const a = finArgs([successes, sample, popSuccesses, population]); if (isError(a)) return a;
      const cum = cumulativeArg(cumulative); if (isError(cum)) return cum;
      const [x, n, M, N] = a.map(Math.trunc);
      if (x < 0 || n < 0 || M < 0 || N < 1 || n > N || M > N || x > n || x > M) return err('#NUM!');
      // The sample cannot hold fewer successes than remain after every failure is drawn: #NUM!.
      const lowest = Math.max(0, n - (N - M));
      if (x < lowest) return err('#NUM!');
      if (!cum) return Math.exp(lnHypergeometricPmf(x, n, M, N));
      // Sum outward from the mode, where the mass is largest, until the terms no
      // longer register: about eighty deviations of terms for any population.
      const highest = Math.min(n, M);
      if (x >= highest) return 1;
      const mode = Math.min(highest, Math.max(lowest, Math.floor(((n + 1) * (M + 1)) / (N + 2))));
      const start = Math.min(x, mode);
      const peak = Math.exp(lnHypergeometricPmf(start, n, M, N));
      let total = peak;
      let term = peak; // downward: pmf(k-1) / pmf(k) = k (N-M-n+k) / ((M-k+1)(n-k+1))
      for (let k = start; k > lowest && term > total * 1e-17; k--) {
        term *= (k * (N - M - n + k)) / ((M - k + 1) * (n - k + 1));
        total += term;
      }
      term = peak; // upward to x: pmf(k+1) / pmf(k) = (M-k)(n-k) / ((k+1)(N-M-n+k+1))
      for (let k = start; k < x && term > total * 1e-17; k++) {
        term *= ((M - k) * (n - k)) / ((k + 1) * (N - M - n + k + 1));
        total += term;
      }
      return Math.min(1, total);
    },
  },
  HYPGEOMDIST: { fn: ([s, n, M, N]) => FUNCTIONS['HYPGEOM.DIST'].fn([s, n, M, N, false]) },

  'NEGBINOM.DIST': {
    fn: ([failures, successes, p, cumulative]) => {
      const a = finArgs([failures, successes, p]); if (isError(a)) return a;
      const cum = cumulativeArg(cumulative); if (isError(cum)) return cum;
      const f = Math.trunc(a[0]);
      const s = Math.trunc(a[1]);
      if (f < 0 || s < 1 || a[2] < 0 || a[2] > 1) return err('#NUM!');
      // Every trial a success: the s-th comes with no failure at all; never a success: it never comes.
      if (a[2] === 1) return cum || f === 0 ? 1 : 0;
      if (a[2] === 0) return 0;
      // C(f+s-1, f) p^s (1-p)^f = p^s (1-p)^(f+1) / B(s, f+1) / ((s+f)(1-p)), in the conditioned form of the
      // incomplete beta's prefactor; the CDF is I_p(s, f + 1).
      if (!cum) return Math.exp(lnBetaFront(a[2], 1 - a[2], s, f + 1)) / ((s + f) * (1 - a[2]));
      return incompleteBeta(a[2], s, f + 1, 1 - a[2]).p;
    },
  },
  NEGBINOMDIST: { fn: ([f, s, p]) => FUNCTIONS['NEGBINOM.DIST'].fn([f, s, p, false]) },
});

/* ---------- Functions that were missing: French depreciation, odd-period bonds, Thai and DBCS text, pivots, external data ---------- */

/** The depreciation arguments shared by AMORLINC and AMORDEGRC, or an error. */
function amorArgs([cost, purchased, firstPeriod, salvage, period, rate, basis]) {
  const a = finArgs([cost, purchased, firstPeriod, salvage, period, rate, basis ?? 0]); if (isError(a)) return a;
  const [c, d, fp, sv, per, r, b] = a;
  const bas = Math.trunc(b);
  if (c < 0 || sv < 0 || sv > c || per < 0 || r <= 0 || d > fp || ![0, 1, 3, 4].includes(bas)) return err('#NUM!');
  const yf = FUNCTIONS.YEARFRAC.fn([d, fp, bas]); if (isError(yf)) return yf;
  return { c, sv, per: Math.trunc(per), r, yf };
}

/** Days from one coupon date to another under the bond basis, and the length of a regular period. */
const bondDayCount = (a, b, basis) => basisDays(a, b, basis);
const bondPeriodLength = (start, end, basis, freq) => (basis === 1 ? end - start : basis === 3 ? 365 / freq : 360 / freq);

/**
 * The odd first period of ODDFPRICE/ODDFYIELD: quasi-coupon periods
 * counted back from the first coupon until one starts on or before the issue date. Returns the sums
 * the price formula needs, or an error.
 */
function oddFirstArgs(settlement, maturity, issue, firstCoupon, frequency, basis) {
  const n = finArgs([settlement, maturity, issue, firstCoupon, frequency, basis ?? 0]); if (isError(n)) return n;
  const [s, m, i, fc] = n.slice(0, 4).map(Math.trunc);
  const freq = Math.trunc(n[4]);
  const bas = Math.trunc(n[5]);
  if (![1, 2, 4].includes(freq) || bas < 0 || bas > 4 || !(i < s && s < fc && fc < m)) return err('#NUM!');
  const at = couponSchedule(fc, freq);
  let dcSum = 0;
  let aSum = 0;
  let k = 0; // the quasi period holding settlement is (at(-k-1), at(-k)]
  for (let j = 1; ; j++) {
    const start = at(-j);
    const end = at(1 - j);
    const nl = bondPeriodLength(start, end, bas, freq);
    const from = Math.max(i, start);
    dcSum += bondDayCount(from, end, bas) / nl;
    if (s > from) aSum += bondDayCount(from, Math.min(s, end), bas) / nl;
    if (start < s && s <= end) k = j - 1;
    if (start <= i) break;
    if (j > 4000) return err('#NUM!');
  }
  const qStart = at(-k - 1);
  const qEnd = at(-k);
  const E = bondPeriodLength(qStart, qEnd, bas, freq);
  const DSC = bas === 0 || bas === 4 ? E - bondDayCount(qStart, s, bas) : qEnd - s;
  const regular = couponArgs(fc, m, freq, bas); if (isError(regular)) return regular;
  return { freq, dcSum, aSum, Nq: k, DSC, E, N: regular.num };
}

function oddFirstPrice(p, rate, yld, redemption) {
  const scale = 100 * rate / p.freq;
  const f = 1 + yld / p.freq;
  const t = p.Nq + p.DSC / p.E;
  let price = redemption / f ** (p.N + t) + scale * p.dcSum / f ** t;
  for (let k = 1; k <= p.N; k++) price += scale / f ** (k + t);
  return price - scale * p.aSum;
}

/** The odd last period of ODDLPRICE/ODDLYIELD: quasi-coupon periods counted on from the last interest date. */
function oddLastArgs(settlement, maturity, lastInterest, frequency, basis) {
  const n = finArgs([settlement, maturity, lastInterest, frequency, basis ?? 0]); if (isError(n)) return n;
  const [s, m, li] = n.slice(0, 3).map(Math.trunc);
  const freq = Math.trunc(n[3]);
  const bas = Math.trunc(n[4]);
  if (![1, 2, 4].includes(freq) || bas < 0 || bas > 4 || !(li < s && s < m)) return err('#NUM!');
  const at = couponSchedule(li, freq);
  let dc = 0;
  let a = 0;
  let dsc = 0;
  for (let j = 1; at(j - 1) < m; j++) {
    const start = at(j - 1);
    const end = at(j);
    const nl = bondPeriodLength(start, end, bas, freq);
    dc += bondDayCount(start, Math.min(end, m), bas) / nl;
    if (s > start) a += bondDayCount(start, Math.min(end, s), bas) / nl;
    if (s < end && Math.max(s, start) < m) dsc += bondDayCount(Math.max(s, start), Math.min(end, m), bas) / nl;
    if (j > 4000) return err('#NUM!');
  }
  return { freq, dc, a, dsc };
}

/** Thai words for a whole number from 1 to 999,999 (BAHTTEXT's blocks); `higher` when a higher block precedes it. */
function thaiBlock(n, higher = false) {
  const DIGITS = ['', 'หนึ่ง', 'สอง', 'สาม', 'สี่', 'ห้า', 'หก', 'เจ็ด', 'แปด', 'เก้า'];
  const POWERS = [[100000, 'แสน'], [10000, 'หมื่น'], [1000, 'พัน'], [100, 'ร้อย']];
  let out = '';
  const whole = n;
  for (const [p, word] of POWERS) {
    if (n >= p) { out += DIGITS[Math.floor(n / p)] + word; n %= p; }
  }
  const ten = Math.floor(n / 10);
  const one = n % 10;
  if (ten >= 1) out += (ten === 2 ? 'ยี่' : ten >= 3 ? DIGITS[ten] : '') + 'สิบ';
  // A final one after any higher digit, here or in a higher block, is "et": 11, 101, 1,000,001.
  if (one === 1 && (whole > 1 || higher)) out += 'เอ็ด';
  else if (one > 0) out += DIGITS[one];
  return out;
}

/** Full-width forms (U+FF01–FF5E, ideographic space) to ASCII, and back; katakana keeps its width. */
const toHalfWidth = (text) => text.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)).replace(/　/g, ' ');
const toFullWidth = (text) => text.replace(/[!-~]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0)).replace(/ /g, '　');
// Character widths are converted only under a double-byte language; elsewhere the text comes back unchanged.
const dbcsLocale = () => /^(ja|zh|ko)\b/i.test(getLocale() || '');

/** Does a pivot label cell hold this item? Numbers by value, text without regard to case. */
function pivotItemMatches(cell, item) {
  if (cell == null || cell === '' || isError(cell)) return false;
  if (typeof item === 'number' && typeof cell === 'number') return Math.abs(cell - item) < 1e-9;
  return String(toText(cell)).trim().toLowerCase() === String(toText(item)).trim().toLowerCase();
}
const PIVOT_SUMMARIES = ['sum', 'count', 'average', 'max', 'min', 'product', 'count numbers', 'stddev', 'stddevp', 'var', 'varp', 'distinct count'];
const isPivotTotal = (v) => typeof v === 'string' && /^(grand )?total$/i.test(v.trim());

/**
 * GETPIVOTDATA over the cells a pivot table shows: the data field names a value column
 * ("Sales" finds "Sum of Sales"); each item narrows to the row or column it labels; with no
 * item for an axis, the grand total stands. Items that the table does not show are #REF!.
 */
function getPivotData(dataField, area, read, pairs) {
  const name = String(toText(dataField)).trim().toLowerCase();
  if (!name) return err('#REF!');
  const rows = area.r2 - area.r1 + 1;
  const cols = area.c2 - area.c1 + 1;
  const at = (r, c) => read(area.r1 + r, area.c1 + c);
  const isField = (v) => {
    if (typeof v !== 'string') return false;
    const t = v.trim().toLowerCase();
    if (t === name) return true;
    const of = t.indexOf(' of ');
    return of > 0 && PIVOT_SUMMARIES.includes(t.slice(0, of)) && (t.slice(of + 4) === name || name === t);
  };
  let header = null;
  for (let r = 0; r < rows && !header; r++) for (let c = 0; c < cols; c++) if (isField(at(r, c))) { header = { r, c }; break; }
  if (!header) return err('#REF!');
  // The row of column labels: the header's own row, or the next one when the data field sits above
  // ("Sum of Sales | Column Labels" over "Row Labels | East | West | Grand Total").
  let labelRow = header.r;
  if (header.c === 0 && header.r + 1 < rows) labelRow = header.r + 1;
  const columnItems = [];
  for (let c = 1; c < cols; c++) columnItems.push(c);
  let row = null;
  let col = null;
  let searchFrom = labelRow + 1;
  for (const [field, item] of pairs) {
    if (isError(field)) return field;
    if (isError(item)) return item;
    const hitCol = labelRow !== header.r || header.c === 0 ? columnItems.find((c) => pivotItemMatches(at(labelRow, c), item)) : undefined;
    if (hitCol !== undefined && !isPivotTotal(at(labelRow, hitCol))) { col = hitCol; continue; }
    let hitRow = null;
    for (let r = searchFrom; r < rows && hitRow == null; r++) {
      for (let c = 0; c < Math.max(1, header.c === 0 ? 1 : header.c); c++) if (pivotItemMatches(at(r, c), item)) { hitRow = r; break; }
    }
    if (hitRow == null) return err('#REF!');
    row = hitRow;
    searchFrom = hitRow; // a nested item is looked for under its parent
  }
  if (row == null) {
    for (let r = rows - 1; r > labelRow; r--) if (isPivotTotal(at(r, 0))) { row = r; break; }
    if (row == null) return err('#REF!');
  }
  if (col == null) {
    const total = columnItems.find((c) => isPivotTotal(at(labelRow, c)));
    col = header.c > 0 && labelRow === header.r ? header.c : total ?? (header.c > 0 ? header.c : 1);
  }
  const v = at(row, col);
  return v == null || v === '' ? err('#REF!') : v;
}

Object.assign(FUNCTIONS, {
  AMORLINC: {
    fn: (args) => {
      const a = amorArgs(args); if (isError(a)) return a;
      const one = a.c * a.r;
      const first = a.yf * a.r * a.c;
      const full = Math.trunc((a.c - a.sv - first) / one);
      let dep = 0;
      if (a.per === 0) dep = first;
      else if (a.per <= full) dep = one;
      else if (a.per === full + 1) dep = a.c - a.sv - one * full - first;
      return dep > 0 ? dep : 0;
    },
  },
  AMORDEGRC: {
    // Measured against workbooks computed in Excel, whose answers depart from the published documentation: the coefficient follows
    // the life 1/rate in bands (2, 4], (4, 6] and above 6 (two years or less is #NUM!); the
    // first period is rounded before it is taken off, later ones are taken off unrounded; the
    // last two periods of the life rounded up each depreciate half of what then remains, and a
    // period that starts below the salvage value, or past the life, depreciates nothing.
    fn: (args) => {
      const a = amorArgs(args); if (isError(a)) return a;
      const life = 1 / a.r;
      if (!(life > 2)) return err('#NUM!');
      const coeff = life <= 4 ? 1.5 : life <= 6 ? 2 : 2.5;
      const rate = a.r * coeff;
      // Rounded as ROUND rounds, on 15 significant digits: 262.49999999999997 is 263.
      const round = (x) => FUNCTIONS.ROUND.fn([x, 0]);
      const first = round(a.yf * rate * a.c);
      if (a.per === 0) return first;
      const periods = Math.ceil(life - 1e-9);
      if (a.per > periods - 1) return 0;
      let cost = a.c - first;
      let half = null;
      for (let k = 1; k <= a.per; k++) {
        if (cost < a.sv) return 0;
        if (k >= periods - 2) half ??= cost * 0.5;
        const dep = half ?? rate * cost;
        if (k === a.per) return round(dep);
        cost -= dep;
      }
      return 0;
    },
  },
  ODDFPRICE: {
    fn: ([settlement, maturity, issue, firstCoupon, rate, yld, redemption, frequency, basis]) => {
      const p = oddFirstArgs(settlement, maturity, issue, firstCoupon, frequency, basis); if (isError(p)) return p;
      const nums = bondNumbers([[rate, false], [yld, false], [redemption, true]]); if (isError(nums)) return nums;
      return checkNum(oddFirstPrice(p, nums[0], nums[1], nums[2]));
    },
  },
  ODDFYIELD: {
    fn: ([settlement, maturity, issue, firstCoupon, rate, pr, redemption, frequency, basis]) => {
      const p = oddFirstArgs(settlement, maturity, issue, firstCoupon, frequency, basis); if (isError(p)) return p;
      const nums = bondNumbers([[rate, false], [pr, true], [redemption, true]]); if (isError(nums)) return nums;
      const [r, price, red] = nums;
      // Price falls as the yield rises: bisect between a yield just above -100% a period and one that prices below.
      let lo = -p.freq + 1e-6;
      let hi = 1;
      while (oddFirstPrice(p, r, hi, red) > price) { hi *= 2; if (hi > 1e6) return err('#NUM!'); }
      if (!(oddFirstPrice(p, r, lo, red) >= price)) return err('#NUM!');
      for (let i = 0; i < 300 && hi - lo > 1e-15; i++) {
        const mid = (lo + hi) / 2;
        if (oddFirstPrice(p, r, mid, red) > price) lo = mid; else hi = mid;
      }
      return checkNum((lo + hi) / 2);
    },
  },
  ODDLPRICE: {
    fn: ([settlement, maturity, lastInterest, rate, yld, redemption, frequency, basis]) => {
      const p = oddLastArgs(settlement, maturity, lastInterest, frequency, basis); if (isError(p)) return p;
      const nums = bondNumbers([[rate, false], [yld, false], [redemption, true]]); if (isError(nums)) return nums;
      const [r, y, red] = nums;
      const scale = 100 * r / p.freq;
      return checkNum((red + p.dc * scale) / (1 + p.dsc * y / p.freq) - p.a * scale);
    },
  },
  ODDLYIELD: {
    fn: ([settlement, maturity, lastInterest, rate, pr, redemption, frequency, basis]) => {
      const p = oddLastArgs(settlement, maturity, lastInterest, frequency, basis); if (isError(p)) return p;
      const nums = bondNumbers([[rate, false], [pr, true], [redemption, true]]); if (isError(nums)) return nums;
      const [r, price, red] = nums;
      const scale = 100 * r / p.freq;
      const paid = price + p.a * scale;
      return checkNum(((red + p.dc * scale) - paid) / paid * (p.freq / p.dsc));
    },
  },
  BAHTTEXT: {
    fn: ([value]) => {
      const n = toNumber(value); if (isError(n)) return n;
      const satangs = Math.floor(Math.abs(n) * 100 + 0.5);
      let baht = Math.floor(satangs / 100);
      const satang = satangs % 100;
      let text = '';
      if (baht === 0) { if (satang === 0) text = 'ศูนย์'; }
      while (baht > 0) {
        const block = baht % 1e6;
        baht = Math.floor(baht / 1e6);
        text = (baht > 0 ? 'ล้าน' : '') + (block > 0 ? thaiBlock(block, baht > 0) : '') + text;
      }
      if (text) text += 'บาท';
      text += satang === 0 ? 'ถ้วน' : `${thaiBlock(satang)}สตางค์`;
      return n < 0 ? `ลบ${text}` : text;
    },
  },
  ASC: { fn: ([text]) => { const t = toText(text); return isError(t) || !dbcsLocale() ? t : toHalfWidth(t); } },
  DBCS: { fn: ([text]) => { const t = toText(text); return isError(t) || !dbcsLocale() ? t : toFullWidth(t); } },
  JIS: { alias: 'DBCS' },
  // Furigana are stored only by East Asian editions; without them the answer is #N/A.
  PHONETIC: { refArgs: true, fn: () => err('#N/A') },
  // What-If Analysis ▸ Data Table writes {=TABLE(row input, column input)} over its results; either input may be left out.
  TABLE: {
    minArgs: 2,
    maxArgs: 2,
    refArgs: true,
    fn: ([rowInput, colInput], ctx) => {
      if (!ctx?.dataTable) return err('#REF!');
      const input = (arg) => {
        if (arg === undefined || arg === null || (!isRange(arg) && arg?.ref == null)) return null;
        const ref = arg.ref;
        return ref && ref.r1 === ref.r2 && ref.c1 === ref.c2 ? ref : false;
      };
      const row = input(rowInput), col = input(colInput);
      if (row === false || col === false || (!row && !col)) return err('#REF!');
      return ctx.dataTable(row, col);
    },
  },
  GETPIVOTDATA: {
    minArgs: 2,
    refArgs: true,
    fn: ([dataField, pivotTable, ...rest], ctx) => {
      if (!isRange(pivotTable) || !pivotTable.ref || !ctx?.pivotArea) return err('#REF!');
      if (rest.length % 2) return err('#REF!');
      const field = scalar(dataField); if (isError(field)) return field;
      const ref = pivotTable.ref;
      const area = ctx.pivotArea(ref.sheet, ref.r1, ref.c1);
      if (!area) return err('#REF!');
      const pairs = [];
      for (let i = 0; i < rest.length; i += 2) pairs.push([scalar(rest[i]), scalar(rest[i + 1])]);
      const read = (r, c) => scalar(ctx.getValue(ref.sheet, r, c));
      return getPivotData(field, area, read, pairs);
    },
  },
  // OLAP cube functions need a data connection to an Analysis Services cube, which a file here has none of.
  CUBEVALUE: { fn: () => err('#N/A') },
  CUBEMEMBER: { fn: () => err('#N/A') },
  CUBEMEMBERPROPERTY: { fn: () => err('#N/A') },
  CUBERANKEDMEMBER: { fn: () => err('#N/A') },
  CUBESET: { fn: () => err('#N/A') },
  CUBESETCOUNT: { fn: () => err('#N/A') },
  CUBEKPIMEMBER: { fn: () => err('#N/A') },
  // A COM real-time data server is a Windows program; there is none to ask.
  RTD: { fn: () => err('#N/A') },
  // Stock history comes from a data service this app does not reach.
  STOCKHISTORY: { minArgs: 2, fn: () => err('#CONNECT!') },
  /** WEBSERVICE(url): the text a web address returns, fetched as IMPORTDATA fetches. */
  WEBSERVICE: {
    minArgs: 1, maxArgs: 1,
    fn: ([url], ctx) => {
      const u = toText(scalar(url)); if (isError(u)) return u;
      const text = String(u).trim();
      if (!/^https?:\/\//i.test(text) || text.length > 2048) return err('#VALUE!');
      if (!ctx?.asyncValue) return err('#VALUE!');
      return ctx.asyncValue('WEBSERVICE', text);
    },
  },
});

// Resolve aliases once, after every group of functions has been added, so
// lookups are a single property read and late aliases (FINV, GAMMAINV) work.
for (const [name, def] of Object.entries(FUNCTIONS)) {
  if (def.alias) FUNCTIONS[name] = FUNCTIONS[def.alias];
}

/**
 * Single-value functions the evaluator applies cell by cell when handed an array, so
 * SUM(LEN(A1:A3)), SUM(ROUND(B1:B3/2,0)) and MONTH(D1:D3)=1 work element by element, and
 * =LEN(A1:A3) spills. Aggregates, lookups and anything that reads a range as a whole stay out.
 */
const LIFTED = `
ABS INT TRUNC ROUND ROUNDUP ROUNDDOWN MOD SQRT SQRTPI POWER EXP LN LOG LOG10 SIGN EVEN ODD QUOTIENT
CEILING CEILING.MATH CEILING.PRECISE ISO.CEILING FLOOR FLOOR.MATH FLOOR.PRECISE MROUND FACT FACTDOUBLE
DEGREES RADIANS SIN COS TAN ASIN ACOS ATAN ATAN2 SINH COSH TANH ASINH ACOSH ATANH SEC CSC COT SECH CSCH COTH ACOT ACOTH
LEN LEFT RIGHT MID UPPER LOWER PROPER TRIM CLEAN TEXT VALUE NUMBERVALUE FIND SEARCH SUBSTITUTE REPLACE REPT EXACT
CHAR CODE UNICHAR UNICODE T N
YEAR MONTH DAY HOUR MINUTE SECOND WEEKDAY WEEKNUM ISOWEEKNUM DATE TIME DATEVALUE TIMEVALUE EDATE EOMONTH DAYS DATEDIF
YEARFRAC DAYS360
NOT ISEVEN ISODD ISBETWEEN ERROR.TYPE
NORM.DIST NORM.S.DIST NORM.INV NORM.S.INV LOGNORM.DIST LOGNORM.INV EXPON.DIST POISSON.DIST BINOM.DIST BINOM.DIST.RANGE BINOM.INV
T.DIST T.DIST.RT T.DIST.2T T.INV T.INV.2T TDIST CHISQ.DIST CHISQ.DIST.RT CHISQ.INV CHISQ.INV.RT F.DIST F.DIST.RT F.INV F.INV.RT
GAMMA GAMMALN GAMMA.DIST GAMMA.INV BETA.DIST BETA.INV BETADIST WEIBULL.DIST HYPGEOM.DIST HYPGEOMDIST NEGBINOM.DIST NEGBINOMDIST
CONFIDENCE.NORM CONFIDENCE.T STANDARDIZE PHI GAUSS FISHER FISHERINV ERF ERF.PRECISE ERFC
COMBIN COMBINA PERMUT PERMUTATIONA RANDBETWEEN
FIXED DOLLAR ROMAN ARABIC BASE DECIMAL ENCODEURL REGEXMATCH REGEXTEST REGEXREPLACE
PMT IPMT PPMT FV PV NPER RATE SLN SYD DDB DB VDB EFFECT NOMINAL DOLLARDE DOLLARFR ISPMT PDURATION RRI CUMIPMT CUMPRINC
TBILLEQ TBILLPRICE TBILLYIELD DISC INTRATE RECEIVED PRICEDISC YIELDDISC PRICE YIELD DURATION MDURATION ACCRINT ACCRINTM
PRICEMAT YIELDMAT COUPPCD COUPNCD COUPNUM COUPDAYBS COUPDAYS COUPDAYSNC
CONVERT DEC2BIN DEC2OCT DEC2HEX BIN2DEC BIN2OCT BIN2HEX OCT2BIN OCT2DEC OCT2HEX HEX2BIN HEX2OCT HEX2DEC
BITAND BITOR BITXOR BITLSHIFT BITRSHIFT DELTA GESTEP ERF ERF.PRECISE ERFC ERFC.PRECISE BESSELJ BESSELY BESSELI BESSELK
COMPLEX IMREAL IMAGINARY IMABS IMARGUMENT IMCONJUGATE IMSUB IMDIV IMPOWER IMSQRT IMEXP IMLN IMLOG10 IMLOG2
IMSIN IMCOS IMTAN IMCSC IMSEC IMCOT IMSINH IMCOSH IMCSCH IMSECH
ADD MINUS MULTIPLY DIVIDE POW UMINUS UPLUS UNARY_PERCENT EQ NE GT GTE LT LTE
HYPERLINK ENCODEURL ADDRESS
`.trim().split(/\s+/);
for (const name of LIFTED) {
  const def = FUNCTIONS[name];
  if (def) { def.lift = true; def.elementwise = true; }
}

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort();
