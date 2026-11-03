import * as modules from './en/index.js';
import { LOCALES, PSEUDO, browserTags, formatLocale, isLocale, localeDir, matchLocale } from './locales.js';
import { PLACEHOLDER, isPlural, numeric, pickForm } from './plural.js';

export { LOCALES, PSEUDO, localeDir } from './locales.js';

// One lazy chunk per locale; keys a locale lacks fall back to English.
const LOADERS = {
  ar: () => import('./ar/index.js'),
  cs: () => import('./cs/index.js'),
  da: () => import('./da/index.js'),
  de: () => import('./de/index.js'),
  es: () => import('./es/index.js'),
  fr: () => import('./fr/index.js'),
  he: () => import('./he/index.js'),
  hu: () => import('./hu/index.js'),
  id: () => import('./id/index.js'),
  it: () => import('./it/index.js'),
  ja: () => import('./ja/index.js'),
  ko: () => import('./ko/index.js'),
  nl: () => import('./nl/index.js'),
  pl: () => import('./pl/index.js'),
  'pt-BR': () => import('./pt-BR/index.js'),
  ru: () => import('./ru/index.js'),
  sv: () => import('./sv/index.js'),
  tr: () => import('./tr/index.js'),
  uk: () => import('./uk/index.js'),
  vi: () => import('./vi/index.js'),
  'zh-CN': () => import('./zh-CN/index.js'),
  'zh-TW': () => import('./zh-TW/index.js'),
};
const DEV = import.meta.env.DEV || import.meta.env.MODE === 'mock';
const STORAGE_KEY = 'trips:lang';

export const english = Object.freeze(Object.assign({}, ...Object.values(modules)));
/** The active UI locale tag. */
export let locale = 'en';
/** The active strings, English where the locale has no value. */
export let strings = english;
/** `ltr` or `rtl` for the active locale. */
export let direction = 'ltr';
let requested = 'auto';
let pinned = false;
let numbers = 'en';
let serial = 0;
let forced;
const listeners = new Set();

/** Locales a picker offers (the pseudo-locale only in dev and mock builds). */
export const availableLocales = () => (DEV ? [...LOCALES, PSEUDO] : LOCALES);
/** `auto` or the tag chosen on this device or account. */
export const requestedLocale = () => requested;
/** True when `?lang=` chose the locale; it then outranks the account's saved choice for this page load. */
export const localePinned = () => pinned;
/** The locale `Intl` formats with: see `formatLocale`. */
export function intlLocale(nav = globalThis.navigator) {
  return nav === globalThis.navigator ? numbers : formatLocale(locale, browserTags(nav));
}
export function onLocaleChange(listener) { listeners.add(listener); return () => listeners.delete(listener); }

/** What `auto` resolves to on this browser. */
export const automaticLocale = () => matchLocale(browserTags());

// A "…One"/".one" key is meant for exactly 1. Callers that pick it by the locale's plural rules (21 in Russian,
// 0 in French) are sent to the counted sibling, whose plural forms handle the number.
function countedKey(key, count) {
  const dotted = key.endsWith('.one');
  if (!dotted && !key.endsWith('One')) return key;
  const found = numeric(count, numbers);
  if (!found || (found.value === 1 && found.fraction === 0)) return key;
  const base = key.slice(0, dotted ? -4 : -3);
  const siblings = dotted ? [`${base}.other`] : [`${base}Other`, `${base}Many`, base, `${base}s`];
  return siblings.find((name) => Object.hasOwn(strings, name)) ?? key;
}

export function t(key, values = {}) {
  let name = String(key);
  const given = values ?? {};
  if (Object.hasOwn(given, 'count')) name = countedKey(name, given.count);
  let value = Object.hasOwn(strings, name) ? strings[name] : name;
  if (typeof value !== 'string') value = isPlural(value) ? pickForm(value, given, locale === PSEUDO.tag ? 'en' : locale, numbers) : name;
  return value.replace(PLACEHOLDER, (match, part) => String(Object.hasOwn(given, part) ? given[part] : match));
}

async function table(tag) {
  // Inline condition so production builds drop the module.
  if (tag === PSEUDO.tag && (import.meta.env.DEV || import.meta.env.MODE === 'mock')) return (await import('./pseudo.js')).pseudoStrings(english);
  const loaded = await LOADERS[tag]();
  return Object.freeze({ ...english, ...Object.assign({}, ...Object.values(loaded)) });
}

function resolve(choice) {
  if (choice === 'auto') return automaticLocale();
  if (choice === PSEUDO.tag) return DEV ? choice : 'en';
  return Object.hasOwn(LOADERS, choice) ? choice : 'en';
}

function remember(choice) {
  try { if (choice === 'auto') globalThis.localStorage?.removeItem(STORAGE_KEY); else globalThis.localStorage?.setItem(STORAGE_KEY, choice); } catch { /* Storage blocked. */ }
}

function apply(tag, next, forcedDir) {
  const changed = tag !== locale || next !== strings;
  locale = tag; strings = next;
  direction = forcedDir ?? localeDir(tag);
  numbers = formatLocale(tag, browserTags());
  const root = globalThis.document?.documentElement;
  if (root) { root.lang = tag; root.dir = direction; }
  if (!changed) return;
  for (const listener of [...listeners]) { try { listener(tag); } catch { /* One listener must not stop the rest. */ } }
}

/**
 * Switches the UI language: `auto` follows the browser. Loads the locale's chunk (English when it fails) and
 * sets `lang` and `dir` on <html>. `persist` keeps the choice on this device for the next start.
 */
export async function setLocale(choice = 'auto', { persist = true } = {}) {
  const wanted = choice === 'auto' || isLocale(choice) ? choice : 'auto';
  requested = wanted;
  if (persist) remember(wanted);
  const tag = resolve(wanted);
  const mine = ++serial;
  if (tag === locale) { apply(tag, strings, forced); return tag; }
  let next = english; let found = tag;
  if (tag !== 'en') {
    try { next = await table(tag); } catch { found = 'en'; next = english; }
  }
  if (mine === serial) apply(found, next, forced);
  return locale;
}

function initial() {
  let choice = null;
  try { choice = new URLSearchParams(globalThis.location?.search ?? '').get('lang'); } catch { /* No location. */ }
  if (choice && (choice === 'auto' || isLocale(choice))) { pinned = true; return { choice, persist: false }; }
  try { choice = globalThis.localStorage?.getItem(STORAGE_KEY); } catch { choice = null; }
  return { choice: choice && isLocale(choice) ? choice : 'auto', persist: false };
}
// `?dir=rtl` mirrors the layout in any language (dev and mock only), for RTL checks with English text.
if (DEV) {
  try { const dir = new URLSearchParams(globalThis.location?.search ?? '').get('dir'); if (dir === 'rtl' || dir === 'ltr') forced = dir; } catch { /* No location. */ }
}
{
  const { choice, persist } = initial();
  await setLocale(choice, { persist });
}
