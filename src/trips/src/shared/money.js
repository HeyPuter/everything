import { invariant } from './errors.js';

const currencyCache = new Map();
const currencies = new Set(Intl.supportedValuesOf('currency'));
currencies.add('CLF');
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

export function currencyDigits(currency) {
  invariant(typeof currency === 'string' && currencies.has(currency), 'invalid_currency');
  if (!currencyCache.has(currency)) {
    currencyCache.set(currency, new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits);
  }
  return currencyCache.get(currency);
}

export function isCurrency(value) {
  return typeof value === 'string' && currencies.has(value);
}

function decimal(value) {
  if (typeof value === 'number') {
    invariant(Number.isSafeInteger(value), 'decimal_string_required');
    value = String(value);
  }
  invariant(typeof value === 'string' && value.length <= 80 && /^-?(0|[1-9]\d*)(\.\d{1,18})?$/.test(value), 'invalid_decimal');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return { n: BigInt(whole + fraction) * (negative ? -1n : 1n), d: 10n ** BigInt(fraction.length) };
}

function weightDecimal(value) {
  if (typeof value !== 'number' || Number.isSafeInteger(value)) return decimal(value);
  invariant(Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER, 'invalid_weights');
  let rendered = String(value);
  if (rendered.includes('e')) {
    const [coefficient, exponent] = rendered.split('e');
    const negative = coefficient.startsWith('-');
    const unsigned = negative ? coefficient.slice(1) : coefficient;
    const digits = unsigned.replace('.', '');
    const position = (unsigned.includes('.') ? unsigned.indexOf('.') : unsigned.length) + Number(exponent);
    invariant(Math.abs(position) <= 50, 'invalid_weights');
    rendered = (negative ? '-' : '') + (position <= 0 ? `0.${'0'.repeat(-position)}${digits}`
      : position >= digits.length ? digits + '0'.repeat(position - digits.length)
        : `${digits.slice(0, position)}.${digits.slice(position)}`);
  }
  return decimal(rendered);
}

export function isWeight(value) {
  try { return weightDecimal(value).n >= 0n; } catch { return false; }
}

function seedOffset(seed, count) {
  let hash = 0;
  for (const char of seed) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return hash % count;
}

function safe(value) {
  invariant(value <= MAX_SAFE && value >= -MAX_SAFE, 'money_overflow');
  return Number(value);
}

export function roundRatio(numerator, denominator) {
  invariant(typeof numerator === 'bigint' && typeof denominator === 'bigint' && denominator > 0n, 'invalid_ratio');
  const sign = numerator < 0n ? -1n : 1n;
  const n = numerator * sign;
  return sign * (n / denominator + (n % denominator * 2n >= denominator ? 1n : 0n));
}

export function toMinor(value, currency, { round = false } = {}) {
  const { n, d } = decimal(value);
  const scaled = n * 10n ** BigInt(currencyDigits(currency));
  invariant(round || scaled % d === 0n, 'too_many_decimals');
  return safe(roundRatio(scaled, d));
}

export function fromMinor(amount, currency) {
  invariant(Number.isSafeInteger(amount), 'invalid_amount');
  const digits = currencyDigits(currency);
  const absolute = BigInt(amount) < 0n ? -BigInt(amount) : BigInt(amount);
  const padded = String(absolute).padStart(digits + 1, '0');
  return `${amount < 0 ? '-' : ''}${digits ? `${padded.slice(0, -digits)}.${padded.slice(-digits)}` : padded}`;
}

export function convertMinor(amount, rate, from, to) {
  invariant(Number.isSafeInteger(amount), 'invalid_amount');
  const { n, d } = decimal(rate);
  invariant(n > 0n, 'invalid_rate');
  return safe(roundRatio(BigInt(amount) * n * 10n ** BigInt(currencyDigits(to)), d * 10n ** BigInt(currencyDigits(from))));
}

export function allocate(amount, weights, { seed = '' } = {}) {
  invariant(Number.isSafeInteger(amount) && Array.isArray(weights) && weights.length > 0 && weights.length <= 50, 'invalid_allocation');
  invariant(typeof seed === 'string' && seed.length <= 1000, 'invalid_seed');
  const ratios = weights.map(weightDecimal);
  invariant(ratios.every(({ n }) => n >= 0n), 'invalid_weights');
  const scale = ratios.reduce((max, { d }) => d > max ? d : max, 1n);
  const integers = ratios.map(({ n, d }) => n * (scale / d));
  const total = integers.reduce((sum, n) => sum + n, 0n);
  invariant(total > 0n, 'invalid_weights');
  const absolute = BigInt(amount) < 0n ? -BigInt(amount) : BigInt(amount);
  const values = integers.map((weight) => absolute * weight / total);
  let remainder = absolute - values.reduce((sum, n) => sum + n, 0n);
  const start = seedOffset(seed, integers.length);
  const ranked = integers.map((weight, index) => ({ index, remainder: absolute * weight % total }))
    .sort((a, b) => a.remainder === b.remainder
      ? (a.index - start + integers.length) % integers.length - (b.index - start + integers.length) % integers.length
      : a.remainder > b.remainder ? -1 : 1);
  for (const { index } of ranked) {
    if (remainder === 0n) break;
    values[index] += 1n;
    remainder -= 1n;
  }
  return values.map((n) => safe(amount < 0 ? -n : n));
}

export function splitAmount(amount, split, { expenseId = '' } = {}) {
  invariant(Number.isSafeInteger(amount) && split && Array.isArray(split.parts) && split.parts.length > 0 && split.parts.length <= 50, 'invalid_split');
  const people = split.parts.map((part) => part?.who);
  invariant(people.every((who) => typeof who === 'string' && who.length > 0) && new Set(people).size === people.length, 'invalid_participants');
  let amounts;
  if (split.mode === 'equal') amounts = allocate(amount, people.map(() => 1), { seed: expenseId });
  else if (split.mode === 'shares') amounts = allocate(amount, split.parts.map((part) => part.value), { seed: expenseId });
  else if (split.mode === 'percent') {
    const ratios = split.parts.map((part) => weightDecimal(part.value));
    const scale = ratios.reduce((max, { d }) => d > max ? d : max, 1n);
    invariant(ratios.reduce((sum, { n, d }) => sum + n * (scale / d), 0n) === 100n * scale, 'percent_total');
    amounts = allocate(amount, split.parts.map((part) => part.value), { seed: expenseId });
  } else if (split.mode === 'amounts') {
    amounts = split.parts.map((part) => part.value);
    invariant(amounts.every((value) => Number.isSafeInteger(value) && (amount < 0 ? value <= 0 : value >= 0)), 'invalid_amount');
    invariant(amounts.reduce((sum, value) => sum + BigInt(value), 0n) === BigInt(amount), 'split_total');
  } else if (split.mode === 'items') {
    invariant(Array.isArray(split.items) && split.items.length > 0 && split.items.length <= 1000, 'invalid_items');
    amounts = people.map(() => 0);
    let total = 0n;
    for (const item of split.items) {
      invariant(Number.isSafeInteger(item.amount) && (amount < 0 ? item.amount <= 0 : item.amount >= 0), 'invalid_amount');
      invariant(Array.isArray(item.who) && item.who.length > 0 && new Set(item.who).size === item.who.length && item.who.every((who) => people.includes(who)), 'invalid_participants');
      const shares = allocate(item.amount, item.who.map(() => 1));
      item.who.forEach((who, index) => { amounts[people.indexOf(who)] = safe(BigInt(amounts[people.indexOf(who)]) + BigInt(shares[index])); });
      total += BigInt(item.amount);
    }
    invariant(total === BigInt(amount), 'split_total');
  } else invariant(false, 'invalid_split_mode');
  return people.map((who, index) => ({ who, amount: amounts[index] }));
}

/**
 * Payers must add up to the amount, or be empty (unpaid). With `partial` (an expense with a due date) they may add up
 * to less: the rest is still to pay.
 */
export function validatePayers(amount, payers, { partial = false } = {}) {
  invariant(Number.isSafeInteger(amount) && Array.isArray(payers) && payers.length <= 50, 'invalid_payers');
  const seen = new Set();
  for (const payer of payers) {
    invariant(payer && typeof payer.who === 'string' && payer.who.length > 0 && !seen.has(payer.who), 'invalid_payers');
    invariant(Number.isSafeInteger(payer.amount) && (amount < 0 ? payer.amount <= 0 : payer.amount >= 0), 'invalid_amount');
    seen.add(payer.who);
  }
  const paid = payers.reduce((sum, payer) => sum + BigInt(payer.amount), 0n);
  const whole = BigInt(amount);
  if (partial) invariant(whole < 0n ? paid >= whole : paid <= whole, 'payer_total');
  else invariant(payers.length === 0 || paid === whole, 'payer_total');
  return true;
}

export function formatMoney(amount, currency, locale = 'en', options = {}) {
  currencyDigits(currency);
  invariant(Number.isSafeInteger(amount), 'invalid_amount');
  return new Intl.NumberFormat(locale, { style: 'currency', currency, ...options }).format(fromMinor(amount, currency));
}
