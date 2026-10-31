// UI locales. `name` is the language's own name, shown untranslated in pickers.
export const LOCALES = Object.freeze([
  { tag: 'en', name: 'English' },
  { tag: 'ar', name: 'العربية', dir: 'rtl' },
  { tag: 'cs', name: 'Čeština' },
  { tag: 'da', name: 'Dansk' },
  { tag: 'de', name: 'Deutsch' },
  { tag: 'es', name: 'Español' },
  { tag: 'fr', name: 'Français' },
  { tag: 'he', name: 'עברית', dir: 'rtl' },
  { tag: 'hu', name: 'Magyar' },
  { tag: 'id', name: 'Bahasa Indonesia' },
  { tag: 'it', name: 'Italiano' },
  { tag: 'ja', name: '日本語' },
  { tag: 'ko', name: '한국어' },
  { tag: 'nl', name: 'Nederlands' },
  { tag: 'pl', name: 'Polski' },
  { tag: 'pt-BR', name: 'Português (Brasil)' },
  { tag: 'ru', name: 'Русский' },
  { tag: 'sv', name: 'Svenska' },
  { tag: 'tr', name: 'Türkçe' },
  { tag: 'uk', name: 'Українська' },
  { tag: 'vi', name: 'Tiếng Việt' },
  { tag: 'zh-CN', name: '简体中文' },
  { tag: 'zh-TW', name: '繁體中文' },
].map(Object.freeze));
/** Accented, lengthened English for layout checks; dev and mock builds only. */
export const PSEUDO = Object.freeze({ tag: 'en-XA', name: 'Ƥşéûđö (en-XA)' });

const byTag = new Map(LOCALES.map((entry) => [entry.tag.toLowerCase(), entry]));
const LEGACY = { iw: 'he', in: 'id', no: null, nb: null, nn: null };

export const isLocale = (tag) => typeof tag === 'string' && (byTag.has(tag.toLowerCase()) || tag === PSEUDO.tag);
export const localeDir = (tag) => (byTag.get(String(tag).toLowerCase())?.dir ?? 'ltr');

function parts(tag) {
  try { const locale = new Intl.Locale(tag).maximize(); return { language: locale.language, script: locale.script, region: locale.region }; } catch { return null; }
}

/** The supported locale for one browser tag, or null: exact, then Chinese by script, Portuguese to pt-BR, then the language. */
export function matchTag(tag) {
  if (typeof tag !== 'string' || !tag) return null;
  const exact = byTag.get(tag.toLowerCase());
  if (exact) return exact.tag;
  if (tag === PSEUDO.tag) return tag;
  const found = parts(tag);
  if (!found) return null;
  const language = Object.hasOwn(LEGACY, found.language) ? LEGACY[found.language] : found.language;
  if (!language) return null;
  if (language === 'zh') return found.script === 'Hant' ? 'zh-TW' : 'zh-CN';
  if (language === 'pt') return 'pt-BR';
  return byTag.get(language)?.tag ?? null;
}

/** The first supported locale among the browser's languages, else English. */
export function matchLocale(tags = []) {
  for (const tag of tags) { const match = matchTag(tag); if (match) return match; }
  return 'en';
}

/** Browser language tags in preference order. */
export function browserTags(nav = globalThis.navigator) {
  return [...(nav?.languages ?? []), nav?.language].filter((tag) => typeof tag === 'string' && tag);
}

/**
 * The locale for `Intl` dates and numbers: a browser locale in the UI language (keeps its region, like de-AT),
 * else the UI language with the browser's region (en-DE), else the UI tag.
 */
export function formatLocale(ui, tags = []) {
  const want = parts(ui === PSEUDO.tag ? 'en' : ui);
  if (!want) return 'en';
  let region;
  for (const tag of tags) {
    let supported;
    try { [supported] = Intl.DateTimeFormat.supportedLocalesOf(tag); } catch { continue; }
    const found = supported && parts(supported);
    if (!found) continue;
    if (found.language === want.language && (want.language !== 'zh' || found.script === want.script)) return supported;
    region ??= found.region;
  }
  if (region && want.language !== 'zh') {
    try { const [combined] = Intl.DateTimeFormat.supportedLocalesOf(`${want.language}-${region}`); if (combined) return combined; } catch { /* Not a valid tag. */ }
  }
  return ui === PSEUDO.tag ? 'en' : ui;
}
