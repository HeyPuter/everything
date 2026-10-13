/**
 * Text languages: a character attribute (`char.language`, a BCP 47 tag)
 * that hyphenation and spell checking follow. Hyphenation rules and the
 * spelling dictionary exist for English; text in other languages is neither
 * hyphenated nor spell checked (rather than broken with the wrong rules),
 * and 'none' turns both off. More languages plug in through
 * `hyphenationRules` (model/hyphenate.js) and SPELLING_LANGUAGES.
 */
export const DEFAULT_LANGUAGE = 'en-US';

export const LANGUAGES = [
  { code: 'none', label: 'None' },
  { code: 'en-US', label: 'English: USA' },
  { code: 'en-GB', label: 'English: UK' },
  { code: 'en-CA', label: 'English: Canada' },
  { code: 'en-AU', label: 'English: Australia' },
  { code: 'da-DK', label: 'Danish' },
  { code: 'nl-NL', label: 'Dutch' },
  { code: 'fi-FI', label: 'Finnish' },
  { code: 'fr-FR', label: 'French' },
  { code: 'fr-CA', label: 'French: Canada' },
  { code: 'de-DE', label: 'German' },
  { code: 'de-CH', label: 'German: Switzerland' },
  { code: 'it-IT', label: 'Italian' },
  { code: 'nb-NO', label: 'Norwegian' },
  { code: 'pl-PL', label: 'Polish' },
  { code: 'pt-BR', label: 'Portuguese: Brazil' },
  { code: 'pt-PT', label: 'Portuguese' },
  { code: 'es-ES', label: 'Spanish' },
  { code: 'sv-SE', label: 'Swedish' },
  { code: 'cs-CZ', label: 'Czech' },
  { code: 'ru-RU', label: 'Russian' },
  { code: 'ja-JP', label: 'Japanese' },
  { code: 'zh-CN', label: 'Chinese' },
];

/** The primary language subtag ('en' for 'en-GB'); stored text without a language is English. */
export function languageBase(code) {
  if (code == null || code === '') code = DEFAULT_LANGUAGE;
  return String(code).toLowerCase().split(/[-_]/)[0];
}

export function languageLabel(code) {
  return LANGUAGES.find((l) => l.code === code)?.label || String(code || DEFAULT_LANGUAGE);
}

/** Languages the spelling dictionary covers (primary subtags). */
export const SPELLING_LANGUAGES = new Set(['en']);

export function canSpellCheck(code) {
  return SPELLING_LANGUAGES.has(languageBase(code));
}
