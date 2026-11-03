import { invariant } from '../../shared/errors.js';
import { allocate, fromMinor, toMinor } from '../../shared/money.js';

const separators = new Map();
/** The decimal separator of a locale ('.' or ','). */
export function decimalSeparator(locale = 'en') {
  if (!separators.has(locale)) {
    const part = new Intl.NumberFormat(locale).formatToParts(1.5).find((item) => item.type === 'decimal');
    separators.set(locale, part?.value === ',' ? ',' : '.');
  }
  return separators.get(locale);
}

/**
 * Normalises a typed number ("1 234,50", "1,234.50", "12.5", "-3") to a canonical decimal string. When only one
 * separator kind appears once, it is a grouping separator only if it is not the locale's decimal separator and
 * exactly three digits follow. Returns null for anything that is not a number.
 */
export function parseDecimal(text, locale = 'en') {
  if (typeof text !== 'string') return null;
  let value = text.trim().replace(/[\s  '’]/g, '').replace(/^−/, '-');
  const negative = value.startsWith('-');
  if (negative || value.startsWith('+')) value = value.slice(1);
  if (!/^[\d.,]+$/.test(value) || !/\d/.test(value)) return null;
  const dots = (value.match(/\./g) ?? []).length;
  const commas = (value.match(/,/g) ?? []).length;
  let decimal = null;
  if (dots && commas) decimal = value.lastIndexOf('.') > value.lastIndexOf(',') ? '.' : ',';
  else if (dots + commas === 1) {
    const mark = dots ? '.' : ',';
    const after = value.length - value.indexOf(mark) - 1;
    decimal = mark !== decimalSeparator(locale) && after === 3 ? null : mark;
  }
  const group = decimal === '.' ? ',' : decimal === ',' ? '.' : null;
  if (decimal && value.split(decimal).length > 2) return null;
  let [whole, fraction = ''] = decimal ? value.split(decimal) : [value];
  if (group) whole = whole.split(group).join('');
  whole = whole.replace(/[.,]/g, '');
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction) || (!whole && !fraction)) return null;
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  fraction = fraction.replace(/0+$/, '');
  if (whole.length > 30 || fraction.length > 18) return null;
  const result = fraction ? `${whole}.${fraction}` : whole;
  return negative && /[1-9]/.test(result) ? `-${result}` : result;
}

/** Minor units from typed text; throws `invalid_amount` or `too_many_decimals`. */
export function parseMoney(text, currency, locale = 'en') {
  const decimal = parseDecimal(text, locale);
  invariant(decimal !== null, 'invalid_amount');
  return toMinor(decimal, currency);
}

/** Minor units as text for an input, in the locale's decimal separator, without grouping. */
export function moneyInput(amount, currency, locale = 'en') {
  if (!Number.isSafeInteger(amount)) return '';
  const text = fromMinor(amount, currency);
  return decimalSeparator(locale) === ',' ? text.replace('.', ',') : text;
}

/** A canonical decimal string as text for an input. */
export function decimalInput(value, locale = 'en') {
  if (value === undefined || value === null || value === '') return '';
  const text = String(value);
  return decimalSeparator(locale) === ',' ? text.replace('.', ',') : text;
}

/** Percentages with two decimals that add up to exactly 100, rotated by `seed` like equal splits. */
export function evenPercents(count, seed = '') {
  invariant(Number.isSafeInteger(count) && count > 0 && count <= 50, 'invalid_count');
  return allocate(10_000, Array.from({ length: count }, () => 1), { seed }).map((value) => {
    const whole = Math.trunc(value / 100);
    const cents = String(value % 100).padStart(2, '0').replace(/0+$/, '');
    return cents ? `${whole}.${cents}` : String(whole);
  });
}

/** Sum of decimal strings scaled to integers, compared without floats. */
export function decimalTotal(values) {
  let scale = 0;
  const parsed = values.map((value) => {
    const text = String(value);
    invariant(/^-?\d+(\.\d+)?$/.test(text), 'invalid_decimal');
    const fraction = text.split('.')[1] ?? '';
    scale = Math.max(scale, fraction.length);
    return text;
  });
  const total = parsed.reduce((sum, text) => {
    const [whole, fraction = ''] = text.replace('-', '').split('.');
    const value = BigInt(whole + fraction.padEnd(scale, '0'));
    return sum + (text.startsWith('-') ? -value : value);
  }, 0n);
  return { total, scale };
}

/** True when decimal strings add up to exactly `target`. */
export function decimalsEqual(values, target) {
  const { total, scale } = decimalTotal(values);
  return total === BigInt(target) * 10n ** BigInt(scale);
}
