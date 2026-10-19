/**
 * Data validation rules: what a cell may hold.
 *
 * rule = { id, range, type: 'list' | 'number' | 'whole' | 'text' | 'date' | 'time' | 'any' | 'formula' | 'checkbox',
 *          source, min, max, operator, strict, allowBlank, message, prompt, chips, colors }
 *   prompt and optional promptTitle appear beside the selected cell unless showInputMessage is false;
 *   message is shown when a value is rejected or flagged.
 *   list      source is "Yes, No, Maybe", an array of literal values,
 *             or a reference like Lists!$A$1:$A$9 or =Options;
 *             chips draws the values as colored pills, colors picks a fill per option
 *   number    min and/or max (either may be omitted)
 *   text      min and/or max length
 *   date      a date, optionally between min and max (serials)
 *   whole     numeric integer values; time uses numeric day fractions; any imposes no constraint
 *   operator  defaults to inclusive between; other comparisons use min as the first operand
 *   formula   source is a formula (written for the range's top-left cell) that must be TRUE
 *   checkbox  TRUE / FALSE, drawn as a checkbox
 * strict rejects bad input; otherwise the cell is flagged as invalid. Non-strict
 * rules may also carry errorStyle ('warning' or 'information'), showErrorMessage
 * and errorTitle for a decision before committing a typed entry. A false
 * showErrorMessage preserves a disabled native alert independently of its style.
 */

import { formatDate } from './format.js';
import { numberOfText } from './condformat.js';
import { tokenize } from './formula/tokenizer.js';
import { parseRefText, isAbsoluteRef } from './refs.js';

export const VALIDATION_TYPES = [
  { value: 'any', label: 'Any value' },
  { value: 'whole', label: 'Whole number' },
  { value: 'number', label: 'Decimal' },
  { value: 'list', label: 'Dropdown list' },
  { value: 'date', label: 'Date' },
  { value: 'time', label: 'Time' },
  { value: 'text', label: 'Text length' },
  { value: 'formula', label: 'Custom formula is true' },
  { value: 'checkbox', label: 'Checkbox' },
];

export const VALIDATION_OPERATORS = [
  ['between', 'Between'], ['notBetween', 'Not between'], ['equal', 'Equal to'], ['notEqual', 'Not equal to'],
  ['greaterThan', 'Greater than'], ['lessThan', 'Less than'],
  ['greaterThanOrEqual', 'Greater than or equal to'], ['lessThanOrEqual', 'Less than or equal to'],
];
export const VALIDATION_COMPARISONS = Object.freeze({ equal: '=', notEqual: '<>', greaterThan: '>', lessThan: '<', greaterThanOrEqual: '>=', lessThanOrEqual: '<=' });
/** Non-default criteria use min as their first operand; max is used only by two-bound comparisons. */
export function compareValidation(value, rule) {
  const { min, max } = rule;
  const op = rule.operator || 'between';
  const finite = v => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v));
  if (op !== 'between' && (!finite(min) || op === 'notBetween' && !finite(max))) return false;
  switch (op) {
    case 'between': return (min == null || value >= min) && (max == null || value <= max);
    case 'notBetween': return min != null && max != null && (value < min || value > max);
    case 'equal': return min != null && value === Number(min);
    case 'notEqual': return min != null && value !== Number(min);
    case 'greaterThan': return min != null && value > min;
    case 'lessThan': return min != null && value < min;
    case 'greaterThanOrEqual': return min != null && value >= min;
    case 'lessThanOrEqual': return min != null && value <= min;
    default: return false;
  }
}
/** Public-format expression for literal comparison bounds; callers supply their value expression. */
export function validationComparisonFormula(rule, value) {
  const bound = v => (typeof v === 'number' || typeof v === 'string' && v.trim()) && Number.isFinite(Number(v)) ? Number(v) : null;
  const min = bound(rule.min), max = bound(rule.max), op = rule.operator || 'between';
  if (op === 'between' || op === 'notBetween') {
    if (op === 'notBetween' && (min == null || max == null)) return 'FALSE()';
    const checks = [min != null ? `${value}>=${min}` : '', max != null ? `${value}<=${max}` : ''].filter(Boolean);
    const result = checks.length ? `AND(${checks.join(',')})` : 'TRUE()';
    return op === 'notBetween' ? `NOT(${result})` : result;
  }
  return min != null && Object.hasOwn(VALIDATION_COMPARISONS, op) ? `${value}${VALIDATION_COMPARISONS[op]}${min}` : 'FALSE()';
}

/** Strip a rule formula's optional marker without changing quoted content. */
export function ruleFormulaBody(formula) {
  return String(formula ?? '').trim().replace(/^=\s*/, '');
}

/**
 * Colored chips for dropdown lists: a rule with `chips: true` draws each
 * value as a pill. `colors` maps an option (as typed) to a fill; options
 * without one take a color from the palette in turn.
 */
export const CHIP_PALETTE = [
  ['#e3edfd', 'Blue'], ['#e2f6ea', 'Green'], ['#fff3c4', 'Yellow'], ['#fde3e0', 'Red'],
  ['#efe4fb', 'Purple'], ['#ffe8d1', 'Orange'], ['#dcf4f6', 'Teal'], ['#ececea', 'Gray'],
];
const CHIP_INK = '#1a1a1a';

/**
 * The fill and text color for one value of a chip list, or null when the rule has no chips. `alias` is
 * another spelling of the option (a date's plain serial beside its label) a colour may have been chosen under.
 */
export function chipFor(rule, text, options, alias = null) {
  if (!rule || rule.type !== 'list' || !rule.chips) return null;
  const key = String(text ?? '').trim().toLowerCase();
  if (!key) return null;
  const keys = alias == null ? [key] : [key, String(alias).trim().toLowerCase()];
  const explicit = Object.entries(rule.colors || {}).find(([k]) => keys.includes(k.trim().toLowerCase()));
  if (explicit && /^#[0-9a-f]{6}$/i.test(explicit[1])) return { bg: explicit[1].toLowerCase(), color: CHIP_INK };
  // `options` is the list, or the value's place in it when the caller already knows it.
  const i = typeof options === 'number' ? options : (options || []).findIndex((o) => String(o).trim().toLowerCase() === key);
  return { bg: CHIP_PALETTE[(i < 0 ? 0 : i) % CHIP_PALETTE.length][0], color: CHIP_INK };
}

/**
 * Split a literal source like `Yes, No,Maybe` into its options: separated by
 * commas or line breaks, each trimmed. Double quotes around an option keep
 * the commas, line breaks and end spaces inside it, and a doubled quote
 * stands for one quote; `joinList` writes options back in this form.
 */
export function splitList(source) {
  if (Array.isArray(source)) return source.filter((v) => v != null && v !== '' && ['string', 'number', 'boolean'].includes(typeof v))
    .map((v) => typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
  const text = String(source ?? '');
  const out = [];
  let item = ''; // the option, or the quoted part of a quoted option
  let tail = ''; // text after a quoted part's closing quote
  let quoted = false;
  let literal = false;
  let started = false;
  const push = () => {
    const v = literal ? item + tail.trim() : item.trim();
    if (v !== '') out.push(v);
    item = tail = '';
    quoted = literal = started = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') item += ch;
      else if (text[i + 1] === '"') { item += '"'; i++; } else quoted = false;
    } else if (ch === '"' && !started) quoted = literal = started = true;
    else if (ch === ',' || ch === '\n') push();
    else if (ch === '\r' || (!started && (ch === ' ' || ch === '\t'))) continue;
    else { started = true; if (literal) tail += ch; else item += ch; }
  }
  push();
  return out;
}

/** Write options as a literal source that splitList reads back unchanged: comma-separated, quoted where needed. */
export function joinList(options) {
  return options.map((v) => {
    const s = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
    return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(', ');
}

// A block A1:B2, a whole column A:A or row 3:5, or the spill of an array formula B1#, with or without a sheet
// in front. A sheet-qualified single cell (Lists!A1) is a reference too, while a bare A1 could be an option.
const CELL = '\\$?[A-Za-z]{1,3}\\$?\\d+';
const AREA = `${CELL}:${CELL}|\\$?[A-Za-z]{1,3}:\\$?[A-Za-z]{1,3}|\\$?\\d+:\\$?\\d+|${CELL}#`;
const RANGE_SOURCE = new RegExp(`^(?:(?:'(?:[^']|'')+'|[A-Za-z_][\\w.]*)!(?:${CELL}|${AREA})|${AREA})$`);

/** References and explicit formulas are distinct from literal list options. */
export function isRangeSource(source) {
  if (Array.isArray(source)) return false;
  const t = String(source ?? '').trim();
  return t.startsWith('=') || RANGE_SOURCE.test(t)
    || /^[A-Za-z_][\w.]*\[.*\]$/.test(t); // a table column: Sales[Item]
}

/**
 * Whether a list source typed as a formula reads its cells relative to each cell of the rule, as Excel reads a list
 * source: a function over a relative reference, the dependent dropdown =INDIRECT(A2) above all, whose second row
 * reads A3. A bare range typed for the options stays fixed, as the app has always read one (and as Excel's range
 * picker writes one, with $ signs).
 */
export function relativeListSource(source) {
  const text = typeof source === 'string' ? source.trim() : '';
  if (!text.startsWith('=')) return false;
  let tokens;
  try { tokens = tokenize(text.slice(1)); } catch { return false; }
  if (!tokens.some((t, i) => t.type === 'name' && tokens[i + 1]?.type === 'lparen')) return false;
  return tokens.some((t) => {
    if (t.type !== 'ref' || t.sheetEnd) return false;
    const ref = parseRefText(t.text, t.sheet);
    return !!ref && !isAbsoluteRef(ref);
  });
}

/**
 * Options for a list rule. `resolveRange(source)` returns the computed
 * values of a referenced range (flattened) or null. `typed` keeps those
 * original values for insertion instead of returning their text labels.
 */
export function listOptions(rule, resolveRange, { typed = false } = {}) {
  if (rule.type !== 'list') return [];
  const entry = optionEntry(rule, resolveRange);
  return (typed ? entry.typed : entry.options).slice();
}

/** Where `text` sits among a list rule's options (trimmed, ignoring case), or -1. */
export function listOptionIndex(rule, resolveRange, text) {
  if (rule.type !== 'list') return -1;
  return optionEntry(rule, resolveRange).index.get(String(text ?? '').trim().toLowerCase()) ?? -1;
}

/**
 * The grid checks a list rule for every cell it draws, so a long source must
 * not be walked each time. The deduped options and their lookups are kept per
 * source: per values array (the workbook hands back one cached array per
 * source and version, and a literal rule keeps its own) or per literal text.
 */
const entriesByValues = new WeakMap();
const entriesByText = new Map();

function optionEntry(rule, resolveRange) {
  if (Array.isArray(rule.source) || isRangeSource(rule.source)) {
    const values = Array.isArray(rule.source) ? rule.source : resolveRange?.(rule.source);
    if (!values) return optionsEntry([]);
    let entry = entriesByValues.get(values);
    if (!entry) { entry = optionsEntry(values); entriesByValues.set(values, entry); }
    return entry;
  }
  const text = String(rule.source ?? '');
  let entry = entriesByText.get(text);
  if (!entry) {
    if (entriesByText.size >= 200) entriesByText.clear();
    entry = optionsEntry(splitList(text));
    entriesByText.set(text, entry);
  }
  return entry;
}

/** The distinct option texts (and typed values) of a source with the sets that answer a lookup at once. */
function optionsEntry(values) {
  const options = [];
  const typed = [];
  const seenText = new Set();
  const seenTyped = new Set();
  const lower = new Set();
  const numbers = new Set();
  const index = new Map();
  for (const v of values) {
    if (v == null || v === '' || typeof v === 'object') continue;
    const text = typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v);
    if (!seenText.has(text)) {
      seenText.add(text);
      const i = options.push(text) - 1;
      lower.add(text.toLowerCase());
      const key = text.trim().toLowerCase();
      if (!index.has(key)) index.set(key, i);
      const n = numberOfText(text);
      if (n != null) numbers.add(n);
    }
    const typedKey = `${typeof v}:${text}`;
    if (!seenTyped.has(typedKey)) { seenTyped.add(typedKey); typed.push(v); }
  }
  return { options, typed, lower, numbers, index };
}

/** Why a dropdown offers nothing: its source names no cells or none of them holds a value, or it is empty. */
function emptyListMessage(rule) {
  const source = Array.isArray(rule.source) ? '' : String(rule.source ?? '').trim();
  return isRangeSource(source)
    ? `This dropdown has no values to pick: its source ${source} is empty or no longer exists`
    : 'This dropdown has no values to pick. Add some under Data validation in the cell menu';
}

/**
 * Check a stored value against a rule. Returns { ok, message }.
 * `evalFormula(source)` evaluates a custom formula for the cell (formula rules).
 */
export function checkValue(rule, value, resolveRange, evalFormula) {
  if (rule.type === 'any') return { ok: true };
  const blank = value == null || value === '';
  if (blank) return rule.allowBlank === false ? { ok: false, message: rule.message || 'This cell cannot be empty' } : { ok: true };
  if (value != null && typeof value === 'object') return { ok: true }; // errors are the formula's problem
  switch (rule.type) {
    case 'list': {
      const { options, lower, numbers } = optionEntry(rule, resolveRange);
      // A list with nothing in it can never be satisfied: say why, and name the source to go and look at,
      // rather than offering "Pick one of: " with nothing after it. A source stops resolving when the sheet
      // it names is deleted or the table column it names is renamed away.
      if (!options.length) return { ok: false, message: rule.message || emptyListMessage(rule) };
      const text = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
      // A number typed as text ("10") is the option 10; the sets answer in one lookup however long the list.
      const n = numberOfText(text);
      const ok = lower.has(text.toLowerCase()) || (n != null && numbers.has(n));
      return ok ? { ok: true } : { ok: false, message: rule.message || `Pick one of: ${options.slice(0, 6).join(', ')}${options.length > 6 ? ', …' : ''}` };
    }
    case 'number': {
      // Text counts when it spells a plain numeral; "0x10" or "Infinity", which Number() would take, is text.
      const n = typeof value === 'number' ? value : numberOfText(value);
      if (n == null || !Number.isFinite(n)) return { ok: false, message: rule.message || 'Enter a number' };
      if (rule.operator && rule.operator !== 'between') return compareValidation(n, rule) ? { ok: true } : { ok: false, message: rule.message || 'This number does not meet the comparison' };
      if (rule.min != null && n < rule.min) return { ok: false, message: rule.message || `Enter a number of at least ${rule.min}` };
      if (rule.max != null && n > rule.max) return { ok: false, message: rule.message || `Enter a number of at most ${rule.max}` };
      return { ok: true };
    }
    case 'text': {
      const len = [...(typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value))].length;
      if (rule.operator && rule.operator !== 'between') return compareValidation(len, rule) ? { ok: true } : { ok: false, message: rule.message || 'This text length does not meet the comparison' };
      if (rule.min != null && len < rule.min) return { ok: false, message: rule.message || `Enter at least ${rule.min} character${rule.min === 1 ? '' : 's'}` };
      if (rule.max != null && len > rule.max) return { ok: false, message: rule.message || `Enter at most ${rule.max} character${rule.max === 1 ? '' : 's'}` };
      return { ok: true };
    }
    case 'date': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ok: false, message: rule.message || 'Enter a date' };
      if (rule.operator && rule.operator !== 'between') return compareValidation(value, rule) ? { ok: true } : { ok: false, message: rule.message || 'This date does not meet the comparison' };
      if (rule.min != null && value < rule.min) return { ok: false, message: rule.message || `Enter a date on or after ${formatDate(rule.min, 'iso')}` };
      if (rule.max != null && value > rule.max) return { ok: false, message: rule.message || `Enter a date on or before ${formatDate(rule.max, 'iso')}` };
      return { ok: true };
    }
    case 'whole':
    case 'time': {
      const ok = typeof value === 'number' && Number.isFinite(value)
        && (rule.type !== 'whole' || Number.isInteger(value)) && compareValidation(value, rule);
      return ok ? { ok: true } : { ok: false, message: rule.message || (rule.type === 'whole' ? 'Enter a whole number that meets the comparison' : 'Enter a time that meets the comparison') };
    }
    case 'formula': {
      if (!evalFormula) return { ok: true };
      const r = evalFormula(rule.source);
      const ok = r === true || (typeof r === 'number' && r !== 0) || (typeof r === 'string' && r.trim().toUpperCase() === 'TRUE');
      return ok ? { ok: true } : { ok: false, message: rule.message || 'This value does not meet the rule' };
    }
    case 'checkbox':
      return typeof value === 'boolean' ? { ok: true } : { ok: false, message: 'Use the checkbox' };
    default:
      return { ok: true };
  }
}

export function describeValidation(rule) {
  if (rule.type === 'any') return 'Any value';
  if (['whole', 'time'].includes(rule.type) || rule.operator && rule.operator !== 'between') {
    const label = VALIDATION_TYPES.find(t => t.value === rule.type)?.label || rule.type;
    const operator = VALIDATION_OPERATORS.find(([op]) => op === (rule.operator || 'between'))?.[1] || 'Comparison';
    return `${label}: ${operator.toLowerCase()} ${rule.min ?? ''}${['between', 'notBetween'].includes(rule.operator || 'between') ? ` and ${rule.max ?? ''}` : ''}`;
  }
  if (rule.type === 'list') return `${isRangeSource(rule.source) ? `List from ${rule.source}` : `List: ${joinList(splitList(rule.source))}`}${rule.chips ? ' (colored chips)' : ''}`;
  if (rule.type === 'number') {
    if (rule.min != null && rule.max != null) return `Number between ${rule.min} and ${rule.max}`;
    if (rule.min != null) return `Number at least ${rule.min}`;
    if (rule.max != null) return `Number at most ${rule.max}`;
    return 'Any number';
  }
  if (rule.type === 'text') {
    if (rule.min != null && rule.max != null) return `Text of ${rule.min} to ${rule.max} characters`;
    if (rule.min != null) return `Text of at least ${rule.min} characters`;
    if (rule.max != null) return `Text of at most ${rule.max} characters`;
    return 'Any text';
  }
  if (rule.type === 'date') {
    if (rule.min != null && rule.max != null) return `Date between ${formatDate(rule.min, 'iso')} and ${formatDate(rule.max, 'iso')}`;
    if (rule.min != null) return `Date on or after ${formatDate(rule.min, 'iso')}`;
    if (rule.max != null) return `Date on or before ${formatDate(rule.max, 'iso')}`;
    return 'Any date';
  }
  if (rule.type === 'formula') return `Formula ${rule.source}`;
  return 'Checkbox';
}
