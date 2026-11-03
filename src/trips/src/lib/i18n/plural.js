// Plural values in locale files: `{one: '{count} Tag', other: '{count} Tage'}` keyed by `Intl.PluralRules` categories.
export const CATEGORIES = Object.freeze(['zero', 'one', 'two', 'few', 'many', 'other']);
export const PLACEHOLDER = /\{(\w+)\}/g;

export const isPlural = (value) => value !== null && typeof value === 'object' && typeof value.other === 'string';
export const placeholders = (text) => [...String(text).matchAll(PLACEHOLDER)].map((match) => match[1]);

/** The value that picks the form: `{count}`, else `{n}`, else the first placeholder of the `other` form. */
export function selector(forms) {
  const names = placeholders(forms.other);
  return names.includes('count') ? 'count' : names.includes('n') ? 'n' : names[0];
}

// Zero code points of the decimal digit sets `Intl.NumberFormat` can print.
const ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50, 0xed0, 0xf20, 0x1040, 0x17e0, 0x1810, 0xff10];
function digit(char) {
  const code = char.codePointAt(0);
  const zero = ZEROS.find((start) => code >= start && code <= start + 9);
  return zero === undefined ? null : String(code - zero);
}

/** `{value, fraction}` from a number or a string formatted in `locale` ("1,234", "٢٫٥", "2,5"); null when not numeric. */
export function numeric(value, locale) {
  if (typeof value === 'number') return Number.isFinite(value) ? { value, fraction: fractionDigits(String(value)) } : null;
  if (typeof value === 'bigint') return { value: Number(value), fraction: 0 };
  if (typeof value !== 'string') return null;
  const decimal = decimalSign(locale);
  let text = '';
  for (const char of value) {
    const found = digit(char);
    if (found !== null) text += found;
    else if (char === decimal || char === '٫') text += '.';
    else if (char === '-' || char === '−') { if (!text) text = '-'; }
  }
  if (!/\d/.test(text)) return null;
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? { value: number, fraction: fractionDigits(text) } : null;
}
const decimals = new Map();
function decimalSign(locale) {
  if (!decimals.has(locale)) {
    let sign = '.';
    try { sign = new Intl.NumberFormat(locale).formatToParts(1.5).find((part) => part.type === 'decimal')?.value ?? '.'; } catch { /* Default. */ }
    decimals.set(locale, sign);
  }
  return decimals.get(locale);
}
const fractionDigits = (text) => { const index = text.indexOf('.'); return index < 0 ? 0 : text.length - index - 1; };

const rules = new Map();
function pluralRules(locale, fraction) {
  const key = `${locale}|${fraction}`;
  if (!rules.has(key)) {
    let made;
    try { made = new Intl.PluralRules(locale, { minimumFractionDigits: fraction }); } catch { made = new Intl.PluralRules('en'); }
    rules.set(key, made);
  }
  return rules.get(key);
}

/** The form of a plural value for `values`, using the plural rules of `locale` and digits of `numberLocale`. */
export function pickForm(forms, values, locale, numberLocale = locale) {
  const name = selector(forms);
  const found = name === undefined ? null : numeric(values?.[name], numberLocale);
  if (!found) return forms.other;
  const category = pluralRules(locale, Math.min(found.fraction, 20)).select(found.value);
  return typeof forms[category] === 'string' ? forms[category] : forms.other;
}

/** Categories a locale uses for whole numbers (every plural value must give each one, or rely on `other`). */
export function integerCategories(locale) {
  const select = new Intl.PluralRules(locale);
  const found = new Set(['other']);
  for (let n = 0; n <= 1000; n += 1) found.add(select.select(n));
  return CATEGORIES.filter((category) => found.has(category));
}
export const allCategories = (locale) => new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
