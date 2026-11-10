/**
 * The interface languages the app ships, and how one is chosen for a person.
 *
 * Languages are named by BCP 47 tag with the script where a language is written in more than one:
 * zh-Hans is Simplified Chinese, whatever the region (mainland China, Singapore, Malaysia). A
 * Traditional Chinese reader (zh-TW, zh-HK, zh-Hant…) is not given Simplified Chinese in its place:
 * the choice falls through to their next language, as a browser's does.
 */

/** The language the messages are written in, and the one any missing message falls back to. */
export const SOURCE_LANGUAGE = 'en';

/**
 * Every language the interface can be shown in, by tag. `name` is the language's name in itself
 * (its endonym), which is how a language picker lists it whatever language is showing.
 */
export const LANGUAGES = Object.freeze([
  Object.freeze({ id: 'en', name: 'English', dir: 'ltr' }),
  Object.freeze({ id: 'zh-Hans', name: '简体中文', dir: 'ltr' }),
]);

/**
 * A pseudo-language for finding text that does not go through the catalogs: every message is shown
 * accented, bracketed and padded (see pseudo.js), so anything still plain English is hard-coded.
 * Reachable with ?lang=en-XA, and listed in the picker only in development.
 */
export const PSEUDO_LANGUAGE = 'en-XA';

const IDS = new Set(LANGUAGES.map((l) => l.id));

/** True when `id` is a language the interface ships (or the pseudo-language). */
export function isLanguage(id) {
  return IDS.has(id) || id === PSEUDO_LANGUAGE;
}

/** The text direction of `id`. */
export function languageDir(id) {
  return LANGUAGES.find((l) => l.id === id)?.dir || 'ltr';
}

const maximized = (tag) => {
  try { return new Intl.Locale(tag).maximize(); } catch { return null; }
};

/**
 * The shipped language that best serves `requested` (most preferred first, as navigator.languages
 * lists them): the first requested tag whose language and script one of `available` shares, after
 * filling in the likely script (zh-CN → zh-Hans-CN, en-GB → en-Latn-GB). Regions do not have to
 * match: English (United Kingdom) is served English. Nothing matching gives the source language.
 */
export function negotiateLanguage(requested, available = [...IDS]) {
  const offered = available.map((id) => [id, maximized(id)]).filter(([, l]) => l);
  for (const tag of requested || []) {
    if (available.includes(tag)) return tag;
    const want = maximized(tag);
    if (!want) continue;
    const hit = offered.find(([, l]) => l.language === want.language && l.script === want.script);
    if (hit) return hit[0];
  }
  return SOURCE_LANGUAGE;
}

/** The browser's languages, most preferred first. */
export function browserLanguages() {
  const nav = globalThis.navigator;
  const list = nav?.languages?.length ? nav.languages : [nav?.language].filter(Boolean);
  return [...list];
}
