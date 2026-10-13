/**
 * Document Setup, Type: the document's language and quote marks, and
 * whether straight quotes typed with the Type tool become typographer's
 * quotes. Stored on the root as `typeOptions` ({ language, double,
 * single, quotes }); a document without them uses English quotes with
 * typographer's quotes on.
 */

/** Quote pairs (open + close) offered for double and single quotes. */
export const DOUBLE_QUOTES = ['\u201c\u201d', '\u201e\u201c', '\u00ab\u00bb', '\u00bb\u00ab', '\u201d\u201d', '""'];
export const SINGLE_QUOTES = ['\u2018\u2019', '\u201a\u2018', '\u2039\u203a', '\u203a\u2039', '\u2019\u2019', "''"];

/** Languages with their usual quote marks. */
export const LANGUAGES = [
  { value: 'en', label: 'English', double: '\u201c\u201d', single: '\u2018\u2019' },
  { value: 'de', label: 'German', double: '\u201e\u201c', single: '\u201a\u2018' },
  { value: 'fr', label: 'French', double: '\u00ab\u00bb', single: '\u2039\u203a' },
  { value: 'es', label: 'Spanish', double: '\u00ab\u00bb', single: '\u201c\u201d' },
  { value: 'it', label: 'Italian', double: '\u00ab\u00bb', single: '\u201c\u201d' },
  { value: 'nl', label: 'Dutch', double: '\u201c\u201d', single: '\u2018\u2019' },
  { value: 'pt', label: 'Portuguese', double: '\u201c\u201d', single: '\u2018\u2019' },
  { value: 'sv', label: 'Swedish', double: '\u201d\u201d', single: '\u2019\u2019' },
  { value: 'da', label: 'Danish', double: '\u00bb\u00ab', single: '\u203a\u2039' },
  { value: 'pl', label: 'Polish', double: '\u201e\u201d', single: '\u201a\u2019' },
];

export const DEFAULT_TYPE_OPTIONS = Object.freeze({
  language: 'en',
  double: '\u201c\u201d',
  single: '\u2018\u2019',
  quotes: true,
  // Superscript, subscript and small caps, % of the type size (positions: baseline offset).
  superSize: 58.3,
  superPos: 33.3,
  subSize: 58.3,
  subPos: 33.3,
  smallCaps: 70,
});

/** Limits of the superscript, subscript and small caps settings (%). */
export const SCRIPT_LIMITS = Object.freeze({ superSize: [1, 200], superPos: [-500, 500], subSize: [1, 200], subPos: [-500, 500], smallCaps: [1, 200] });

export function typeOptionsOf(root) {
  return { ...DEFAULT_TYPE_OPTIONS, ...(root?.typeOptions || {}) };
}

const metricsCache = new WeakMap();

/**
 * The layout metrics (text-layout TYPE_METRICS, fractions) of a document's
 * type options, or null for the defaults. The same object comes back while
 * root.typeOptions is the same.
 */
export function typeMetricsOf(root) {
  const o = root?.typeOptions;
  if (!o) return null;
  let m = metricsCache.get(o);
  if (m === undefined) {
    const t = typeOptionsOf(root);
    const keys = Object.keys(SCRIPT_LIMITS);
    m = keys.every((k) => t[k] === DEFAULT_TYPE_OPTIONS[k]) ? null : Object.freeze(Object.fromEntries(keys.map((k) => [k, t[k] / 100])));
    metricsCache.set(o, m);
  }
  return m;
}

/** Characters after which a quote opens. */
const OPENS_AFTER = /[\s([{\u2014\u2013\-/\u00a0\u2028]/;

/**
 * The character to insert for a straight quote typed at `at` in `text`:
 * the document's opening or closing mark (or an apostrophe inside a word),
 * or the straight quote when typographer's quotes are off.
 */
export function typedQuote(root, text, at, quote) {
  const o = typeOptionsOf(root);
  if (!o.quotes || (quote !== '"' && quote !== "'")) return quote;
  const pair = quote === '"' ? o.double : o.single;
  const prev = at > 0 ? String(text ?? '')[at - 1] : '';
  const opens = !prev || OPENS_AFTER.test(prev) || prev === o.double[0] || prev === o.single[0];
  // After a letter or digit a single quote is an apostrophe (it's).
  if (quote === "'" && /[\p{L}\p{N}]/u.test(prev)) return '\u2019';
  return opens ? pair[0] : pair[1];
}
