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

import { formatDate, formatTime, formatGeneral, formatNumberText } from './format.js';
import { numberOfText } from './condformat.js';
import { tokenize } from './formula/tokenizer.js';
import { parseRefText, isAbsoluteRef } from './refs.js';
import { t, tSource } from '../i18n/index.js';

/** The rule types, each with its label's catalog key. */
export const VALIDATION_TYPES = [
  { value: 'any', label: 'coreValidation.type.any' },
  { value: 'whole', label: 'coreValidation.type.whole' },
  { value: 'number', label: 'coreValidation.type.number' },
  { value: 'list', label: 'coreValidation.type.list' },
  { value: 'date', label: 'coreValidation.type.date' },
  { value: 'time', label: 'coreValidation.type.time' },
  { value: 'text', label: 'coreValidation.type.text' },
  { value: 'formula', label: 'coreValidation.type.formula' },
  { value: 'checkbox', label: 'coreValidation.type.checkbox' },
];

/** The comparisons, each with its label's catalog key. */
export const VALIDATION_OPERATORS = [
  ['between', 'coreValidation.operator.between'], ['notBetween', 'coreValidation.operator.notBetween'],
  ['equal', 'coreValidation.operator.equal'], ['notEqual', 'coreValidation.operator.notEqual'],
  ['greaterThan', 'coreValidation.operator.greaterThan'], ['lessThan', 'coreValidation.operator.lessThan'],
  ['greaterThanOrEqual', 'coreValidation.operator.greaterThanOrEqual'], ['lessThanOrEqual', 'coreValidation.operator.lessThanOrEqual'],
];
/** The comparisons as a rule's description reads them ("Whole number: between 1 and 10"), as catalog keys. */
const OPERATOR_PHRASES = {
  between: 'coreValidation.phrase.between', notBetween: 'coreValidation.phrase.notBetween', equal: 'coreValidation.phrase.equal',
  notEqual: 'coreValidation.phrase.notEqual', greaterThan: 'coreValidation.phrase.greaterThan', lessThan: 'coreValidation.phrase.lessThan',
  greaterThanOrEqual: 'coreValidation.phrase.greaterThanOrEqual', lessThanOrEqual: 'coreValidation.phrase.lessThanOrEqual',
};
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
  ['#e3edfd', 'coreValidation.color.blue'], ['#e2f6ea', 'coreValidation.color.green'], ['#fff3c4', 'coreValidation.color.yellow'], ['#fde3e0', 'coreValidation.color.red'],
  ['#efe4fb', 'coreValidation.color.purple'], ['#ffe8d1', 'coreValidation.color.orange'], ['#dcf4f6', 'coreValidation.color.teal'], ['#ececea', 'coreValidation.color.gray'],
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
  const text = String(source ?? '').trim();
  return text.startsWith('=') || RANGE_SOURCE.test(text)
    || /^[A-Za-z_][\w.]*\[.*\]$/.test(text); // a table column: Sales[Item]
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
  if (!tokens.some((tok, i) => tok.type === 'name' && tokens[i + 1]?.type === 'lparen')) return false;
  return tokens.some((tok) => {
    if (tok.type !== 'ref' || tok.sheetEnd) return false;
    const ref = parseRefText(tok.text, tok.sheet);
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
/** "Pick one of: Yes, No, Maybe", naming the first six options. */
function pickOne(options) {
  const items = options.slice(0, 6).reduce((list, item) => t('coreValidation.check.listItem', { list, item }));
  return options.length > 6 ? t('coreValidation.check.pickOneMore', { items }) : t('coreValidation.check.pickOne', { items });
}

function emptyListMessage(rule) {
  const source = Array.isArray(rule.source) ? '' : String(rule.source ?? '').trim();
  return isRangeSource(source)
    ? t('coreValidation.check.emptySource', { source })
    : t('coreValidation.check.emptyList');
}

/**
 * Check a stored value against a rule. Returns { ok, message }.
 * `evalFormula(source)` evaluates a custom formula for the cell (formula rules).
 */
export function checkValue(rule, value, resolveRange, evalFormula) {
  if (rule.type === 'any') return { ok: true };
  const blank = value == null || value === '';
  if (blank) return rule.allowBlank === false ? { ok: false, message: rule.message || t('coreValidation.check.blank') } : { ok: true };
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
      return ok ? { ok: true } : { ok: false, message: rule.message || pickOne(options) };
    }
    case 'number': {
      // Text counts when it spells a plain numeral; "0x10" or "Infinity", which Number() would take, is text.
      const n = typeof value === 'number' ? value : numberOfText(value);
      if (n == null || !Number.isFinite(n)) return { ok: false, message: rule.message || t('coreValidation.check.number') };
      if (rule.operator && rule.operator !== 'between') return compareValidation(n, rule) ? { ok: true } : { ok: false, message: rule.message || t('coreValidation.check.numberComparison') };
      if (rule.min != null && n < rule.min) return { ok: false, message: rule.message || t('coreValidation.check.numberMin', { min: boundText(rule, rule.min) }) };
      if (rule.max != null && n > rule.max) return { ok: false, message: rule.message || t('coreValidation.check.numberMax', { max: boundText(rule, rule.max) }) };
      return { ok: true };
    }
    case 'text': {
      // A number counts the characters LEN counts in it: 0.1+0.2 is "0.3", not "0.30000000000000004".
      const len = [...(typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : typeof value === 'number' ? formatNumberText(value) : String(value))].length;
      if (rule.operator && rule.operator !== 'between') return compareValidation(len, rule) ? { ok: true } : { ok: false, message: rule.message || t('coreValidation.check.lengthComparison') };
      if (rule.min != null && len < rule.min) return { ok: false, message: rule.message || t('coreValidation.check.lengthMin', { min: rule.min }) };
      if (rule.max != null && len > rule.max) return { ok: false, message: rule.message || t('coreValidation.check.lengthMax', { max: rule.max }) };
      return { ok: true };
    }
    case 'date': {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ok: false, message: rule.message || t('coreValidation.check.date') };
      if (rule.operator && rule.operator !== 'between') return compareValidation(value, rule) ? { ok: true } : { ok: false, message: rule.message || t('coreValidation.check.dateComparison') };
      if (rule.min != null && value < rule.min) return { ok: false, message: rule.message || t('coreValidation.check.dateMin', { min: formatDate(rule.min, 'iso') }) };
      if (rule.max != null && value > rule.max) return { ok: false, message: rule.message || t('coreValidation.check.dateMax', { max: formatDate(rule.max, 'iso') }) };
      return { ok: true };
    }
    case 'whole':
    case 'time': {
      const ok = typeof value === 'number' && Number.isFinite(value)
        && (rule.type !== 'whole' || Number.isInteger(value)) && compareValidation(value, rule);
      return ok ? { ok: true } : { ok: false, message: rule.message || (rule.type === 'whole' ? t('coreValidation.check.whole') : t('coreValidation.check.time')) };
    }
    case 'formula': {
      if (!evalFormula) return { ok: true };
      const r = evalFormula(rule.source);
      const ok = r === true || (typeof r === 'number' && r !== 0) || (typeof r === 'string' && r.trim().toUpperCase() === 'TRUE');
      return ok ? { ok: true } : { ok: false, message: rule.message || t('coreValidation.check.formula') };
    }
    case 'checkbox':
      return typeof value === 'boolean' ? { ok: true } : { ok: false, message: t('coreValidation.check.checkbox') };
    default:
      return { ok: true };
  }
}

/** A rule's bound as the dialog takes it: a date as a date, a time as a clock time, a number in the regional format. */
function boundText(rule, v) {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null;
  if (n == null) return v ?? '';
  if (rule.type === 'date' && n >= 0) return formatDate(n, 'iso');
  if (rule.type === 'time' && n >= 0 && n < 1) return formatTime(n, true);
  return formatGeneral(n);
}

/**
 * A rule in a few words ("Number between 1 and 10"). In English unless `display` is set: the AI model reads
 * it as well; the rules list on screen asks for the interface language.
 */
export function describeValidation(rule, { display = false } = {}) {
  const tr = display ? t : tSource;
  if (rule.type === 'any') return tr('coreValidation.describe.any');
  if (['whole', 'time'].includes(rule.type) || rule.operator && rule.operator !== 'between') {
    const key = VALIDATION_TYPES.find(type => type.value === rule.type)?.label;
    const type = key ? tr(key) : rule.type;
    const op = rule.operator || 'between';
    const operator = OPERATOR_PHRASES[op] ? tr(OPERATOR_PHRASES[op]) : tr('coreValidation.phrase.comparison');
    return ['between', 'notBetween'].includes(op)
      ? tr('coreValidation.describe.comparisonTwo', { type, operator, min: boundText(rule, rule.min), max: boundText(rule, rule.max) })
      : tr('coreValidation.describe.comparison', { type, operator, min: boundText(rule, rule.min) });
  }
  if (rule.type === 'list') {
    const chips = rule.chips ? 'yes' : 'no';
    return isRangeSource(rule.source) ? tr('coreValidation.describe.listFrom', { source: rule.source, chips })
      : tr('coreValidation.describe.list', { items: joinList(splitList(rule.source)), chips });
  }
  if (rule.type === 'number') {
    if (rule.min != null && rule.max != null) return tr('coreValidation.describe.numberBetween', { min: boundText(rule, rule.min), max: boundText(rule, rule.max) });
    if (rule.min != null) return tr('coreValidation.describe.numberMin', { min: boundText(rule, rule.min) });
    if (rule.max != null) return tr('coreValidation.describe.numberMax', { max: boundText(rule, rule.max) });
    return tr('coreValidation.describe.anyNumber');
  }
  if (rule.type === 'text') {
    if (rule.min != null && rule.max != null) return tr('coreValidation.describe.textBetween', { min: rule.min, max: rule.max });
    if (rule.min != null) return tr('coreValidation.describe.textMin', { min: rule.min });
    if (rule.max != null) return tr('coreValidation.describe.textMax', { max: rule.max });
    return tr('coreValidation.describe.anyText');
  }
  if (rule.type === 'date') {
    if (rule.min != null && rule.max != null) return tr('coreValidation.describe.dateBetween', { min: formatDate(rule.min, 'iso'), max: formatDate(rule.max, 'iso') });
    if (rule.min != null) return tr('coreValidation.describe.dateMin', { min: formatDate(rule.min, 'iso') });
    if (rule.max != null) return tr('coreValidation.describe.dateMax', { max: formatDate(rule.max, 'iso') });
    return tr('coreValidation.describe.anyDate');
  }
  if (rule.type === 'formula') return tr('coreValidation.describe.formula', { source: rule.source });
  return tr('coreValidation.describe.checkbox');
}
