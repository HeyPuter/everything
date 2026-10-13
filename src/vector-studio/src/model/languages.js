/**
 * Text languages: a character attribute (`char.language`, a BCP 47 tag)
 * that hyphenation and spell checking follow. Hyphenation uses the pattern
 * file of the language (model/hyphenation/patterns.js); spell checking the
 * dictionaries in SPELLING_LANGUAGES. Text in a language without them is
 * left whole and unchecked (rather than broken with the wrong rules), and
 * 'none' turns both off.
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
export const SPELLING_LANGUAGES = new Set(['en', 'fr']);

export function canSpellCheck(code) {
  return SPELLING_LANGUAGES.has(languageBase(code));
}
