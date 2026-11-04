/**
 * The interface's words in the person's language.
 *
 * Every message lives in a catalog, src/locales/<language>/<namespace>.json, as ICU MessageFormat
 * (https://unicode-org.github.io/icu/userguide/format_parse/messages/), the syntax translation tools
 * read: arguments ({name}), plurals ({count, plural, one {# row} other {# rows}}), selects, number
 * and date arguments, and tags (<b>…</b>) for the rich messages tRich formats. A message is asked
 * for by `<namespace>.<key>`: t('home.newSpreadsheet') is "newSpreadsheet" in home.json.
 *
 * English, the source language, is bundled with the code and is what every missing message falls
 * back to. Any other language is a separate chunk, loaded once by initI18n before the first screen
 * is drawn, so t() itself is synchronous and cheap (each message is compiled once, on first use).
 *
 * The language is chosen once per page: changing it in File ▸ Options reloads the app (see
 * relaunch in main.js), as a desktop office suite restarts to change its display language. The
 * workbook's own content is never translated: sheet names, function names, error values and
 * number formats stay as the file has them, so a workbook reads the same in every language.
 *
 * See docs/i18n.md for adding a message or a language.
 */
import { IntlMessageFormat } from 'intl-messageformat';
import { SOURCE_LANGUAGE, PSEUDO_LANGUAGE, isLanguage, languageDir, negotiateLanguage, browserLanguages } from './languages.js';
import { pseudoLocalize } from './pseudo.js';

export { LANGUAGES, SOURCE_LANGUAGE, PSEUDO_LANGUAGE, negotiateLanguage } from './languages.js';

/** Where a chosen language is kept in this browser. Absent: follow the browser's languages. */
export const LANGUAGE_STORAGE_KEY = 'spreadsheet:language';

/** Flatten { 'path/to/<ns>.json': { key: message } } into Map('<ns>.<key>' → message). */
export function flattenCatalogs(modules) {
  const out = new Map();
  for (const [path, messages] of Object.entries(modules)) {
    const ns = path.replace(/^.*\//, '').replace(/\.json$/, '');
    for (const [key, message] of Object.entries(messages || {})) out.set(`${ns}.${key}`, message);
  }
  return out;
}

/**
 * A language's catalogs read straight from disk, for code run by Node without Vite (a script, a test
 * that starts its own `node`), where import.meta.glob does not exist. Null in a browser.
 */
function catalogsFromDisk(lang) {
  const fs = globalThis.process?.getBuiltinModule?.('node:fs');
  if (!fs) return null;
  const dir = new URL(`../locales/${lang}/`, import.meta.url);
  const out = {};
  for (const file of fs.readdirSync(dir)) {
    if (file.endsWith('.json')) out[file] = JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'));
  }
  return out;
}

function sourceCatalogs() {
  try {
    return import.meta.glob('../locales/en/*.json', { eager: true, import: 'default' });
  } catch (e) {
    const fromDisk = catalogsFromDisk(SOURCE_LANGUAGE);
    if (fromDisk) return fromDisk;
    throw e;
  }
}

const SOURCE = flattenCatalogs(sourceCatalogs());

/** Each language's catalogs, as its own chunk: only the one chosen is downloaded. */
const LOADERS = {
  'zh-Hans': () => import('./bundles/zh-Hans.js'),
};

let current = SOURCE_LANGUAGE;
let messages = SOURCE; // the current language's messages; any key missing falls back to SOURCE
const compiled = new Map(); // `${rich}${key}` → IntlMessageFormat, or the plain string
const warned = new Set();

const DEV = (() => { try { return !!import.meta.env?.DEV; } catch { return false; } })();

/** The language the interface is showing. */
export function language() {
  return current;
}

/** Plain text needs no formatter: nothing ICU would read differently (braces, a doubled apostrophe, a tag). */
const isPlain = (message, rich) => !/[{}]|''/.test(message) && !(rich && /</.test(message));

function warnOnce(key, what, error) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[i18n] ${what}: ${key}`, error || '');
}

function formatter(key, rich) {
  const id = `${rich ? 1 : 0}${key}`;
  const known = compiled.get(id);
  if (known !== undefined) return known;
  let message = messages.get(key);
  let lang = current;
  if (message === undefined && messages !== SOURCE) { message = SOURCE.get(key); lang = SOURCE_LANGUAGE; }
  if (message === undefined) {
    if (DEV) warnOnce(key, 'Missing message');
    compiled.set(id, key);
    return key;
  }
  let made;
  if (isPlain(message, rich)) made = message;
  else {
    const build = (text, locale) => new IntlMessageFormat(text, locale, undefined, { ignoreTag: !rich });
    try { made = build(message, lang === PSEUDO_LANGUAGE ? SOURCE_LANGUAGE : lang); } catch (e) {
      // A translation that does not parse is shown in English rather than not at all.
      warnOnce(key, `Message does not parse in ${lang}`, e);
      const fallback = SOURCE.get(key);
      made = fallback === undefined ? key : isPlain(fallback, rich) ? fallback : build(fallback, SOURCE_LANGUAGE);
    }
  }
  compiled.set(id, made);
  return made;
}

function run(key, values, rich) {
  const f = formatter(key, rich);
  if (typeof f === 'string') return f;
  try { return f.format(values); } catch (e) {
    // A value left out, or of the wrong kind: the message without it is still better than nothing.
    warnOnce(key, 'Message could not be formatted', e);
    return messages.get(key) ?? SOURCE.get(key) ?? key;
  }
}

/**
 * The message `key` in the interface language, with `values` put in. Tags in the message are kept
 * as text; a message with markup is formatted with tRich instead.
 *
 * Numbers are formatted for the language where the message asks ({count, number}, or # in a
 * plural); a bare {count} is put in as given, so pass a number there only where its plain digits
 * are wanted (a row number, a year).
 */
export function t(key, values) {
  const out = run(key, values, false);
  return Array.isArray(out) ? out.join('') : out;
}

/**
 * A message with markup, as children for el(): each tag in it is a function in `values` that is
 * handed the tag's content and returns a node, and any other value may be a node itself.
 *
 *   tRich('home.signInPrompt', { link: (text) => el('a', { href }, text) })
 *   // "<link>Sign in</link> to save to your own cloud." → [<a>Sign in</a>, ' to save to your own cloud.']
 */
export function tRich(key, values) {
  const out = run(key, values, true);
  return Array.isArray(out) ? out : [out];
}

const sourceCompiled = new Map();
/**
 * The message `key` in English whatever the interface language: for text that is not for the person
 * to read, where the same words are also shown to them (a description handed to the AI model, a
 * label written into a file). Prefer this to keeping a second English copy of a message.
 */
export function tSource(key, values) {
  let f = sourceCompiled.get(key);
  if (f === undefined) {
    const message = SOURCE.get(key);
    if (message === undefined) { if (DEV) warnOnce(key, 'Missing message'); f = key; }
    else {
      try { f = isPlain(message, false) ? message : new IntlMessageFormat(message, SOURCE_LANGUAGE, undefined, { ignoreTag: true }); } catch (e) { warnOnce(key, 'Message does not parse', e); f = message; }
    }
    sourceCompiled.set(key, f);
  }
  if (typeof f === 'string') return f;
  try { return f.format(values); } catch (e) { warnOnce(key, 'Message could not be formatted', e); return SOURCE.get(key) ?? key; }
}

/** True when `key` names a message in the source catalogs. */
export function hasMessage(key) {
  return SOURCE.has(key);
}

/* ---------- Choosing and loading the language ---------- */

const storage = () => { try { return globalThis.localStorage || null; } catch { return null; } };

/** The language the person chose, or 'auto' to follow the browser's. */
export function languagePreference() {
  let saved = null;
  try { saved = storage()?.getItem(LANGUAGE_STORAGE_KEY) || null; } catch { /* storage unavailable */ }
  return saved && isLanguage(saved) ? saved : 'auto';
}

/** Keep the person's choice ('auto', or a language id) for the next time the app opens. */
export function setLanguagePreference(pref) {
  try {
    if (pref && pref !== 'auto' && isLanguage(pref)) storage()?.setItem(LANGUAGE_STORAGE_KEY, pref);
    else storage()?.removeItem(LANGUAGE_STORAGE_KEY);
  } catch { /* storage unavailable */ }
}

/**
 * The language to show: ?lang= in the address (for a link, or for testing), then the person's
 * choice, then the best match for the browser's languages.
 */
export function resolveLanguage({ search = globalThis.location?.search || '', preference = languagePreference(), requested = browserLanguages() } = {}) {
  const asked = new URLSearchParams(search).get('lang');
  if (asked && isLanguage(asked)) return asked;
  if (preference !== 'auto' && isLanguage(preference)) return preference;
  return negotiateLanguage(requested);
}

/** The catalogs of `id`, flattened. */
async function catalogsOf(id) {
  if (id === SOURCE_LANGUAGE) return SOURCE;
  if (id === PSEUDO_LANGUAGE) return new Map([...SOURCE].map(([k, m]) => [k, pseudoLocalize(m)]));
  let catalogs;
  try { catalogs = (await LOADERS[id]()).default; } catch (e) {
    catalogs = catalogsFromDisk(id);
    if (!catalogs) throw e;
  }
  return flattenCatalogs(catalogs);
}

/**
 * Show the interface in `id` from now on (what is already drawn keeps its words). Resolves to the
 * language in force: the source language when `id`'s catalogs could not be loaded (offline, say).
 */
export async function useLanguage(id) {
  if (!isLanguage(id)) id = SOURCE_LANGUAGE;
  let next = SOURCE;
  try { next = await catalogsOf(id); } catch (e) {
    console.warn(`[i18n] Could not load ${id}; showing ${SOURCE_LANGUAGE}`, e);
    id = SOURCE_LANGUAGE;
  }
  current = id;
  messages = next;
  compiled.clear();
  formatters.clear();
  const root = globalThis.document?.documentElement;
  if (root) {
    root.lang = id;
    root.dir = languageDir(id);
  }
  return id;
}

/** Choose and load the language before the first screen is drawn. */
export function initI18n(options) {
  return useLanguage(resolveLanguage(options));
}

/* ---------- Formatting for the interface language ---------- */

// Intl formatters are costly to build and cheap to reuse: one per kind and options, per language.
const formatters = new Map();
function cached(kind, options, make) {
  const id = `${kind}${JSON.stringify(options || {})}`;
  let f = formatters.get(id);
  if (!f) { f = make(intlLocale(), options); formatters.set(id, f); }
  return f;
}

/** The tag Intl formats with: the pseudo-language formats as its source. */
export function intlLocale() {
  return current === PSEUDO_LANGUAGE ? SOURCE_LANGUAGE : current;
}

/**
 * These format what the interface says (a count in a status line, a date in the version list), not
 * a cell's value: cells follow their number format and the workbook's regional format (core/format.js).
 */
export const formatNumber = (n, options) => cached('n', options, (l, o) => new Intl.NumberFormat(l, o)).format(n);
export const formatDate = (d, options) => cached('d', options, (l, o) => new Intl.DateTimeFormat(l, o)).format(d);
export const formatList = (items, options = { type: 'conjunction' }) => cached('l', options, (l, o) => new Intl.ListFormat(l, o)).format(items);
export const formatRelativeTime = (value, unit, options = { numeric: 'auto' }) => cached('r', options, (l, o) => new Intl.RelativeTimeFormat(l, o)).format(value, unit);
/** Sorting for lists shown to the person (fonts, names), in the interface language's order. */
export const compareText = (a, b) => cached('c', { sensitivity: 'base', numeric: true }, (l, o) => new Intl.Collator(l, o)).compare(a, b);
/** A language's or region's name in the interface language: displayName('fr', 'language') → "French" / "法语". */
export const displayName = (code, type = 'language') => {
  try { return cached(`dn${type}`, { type, fallback: 'code' }, (l, o) => new Intl.DisplayNames(l, o)).of(code) || code; } catch { return code; }
};
