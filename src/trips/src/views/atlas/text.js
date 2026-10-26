import { locale, t } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { CONTINENTS, countryName } from '../../lib/atlas/countries.js';

let rules;
/** `<base>.one` or `<base>.other` with a formatted `{count}`. */
export function plural(base, count, values = {}) {
  rules ??= new Intl.PluralRules(locale);
  return t(`${base}.${rules.select(count) === 'one' ? 'one' : 'other'}`, { count: formatNumber(count), ...values });
}

// Names follow the interface language so lists and search read consistently.
export const nameOf = (code) => countryName(code, locale);

/** Name of a continent code (`EU`, `AS`, …). */
export const continentLabel = (continent) => (CONTINENTS.includes(continent) ? t(`atlas.continent.${continent}`) : '');

export function listText(items) {
  try { return new Intl.ListFormat(locale, { type: 'conjunction', style: 'short' }).format(items); } catch { return items.join(', '); }
}
