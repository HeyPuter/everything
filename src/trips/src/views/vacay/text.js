import { locale, t } from '../../lib/i18n/index.js';
import { formatNumber } from '../../lib/format.js';
import { errorCode } from '../../lib/vacay/errors.js';

let rules;
/** `<base>.one` or `<base>.other` with a formatted `{count}`. */
export function plural(base, count, values = {}) {
  rules ??= new Intl.PluralRules(locale);
  return t(`${base}.${rules.select(count) === 'one' ? 'one' : 'other'}`, { count: formatNumber(count, { digits: 1 }), ...values });
}

/** "2.5 days". */
export const daysText = (count) => plural('vacay.days', count);

const ERRORS = new Set(['offline', 'credit', 'disabled', 'gone', 'denied', 'limit', 'recipient', 'noUser', 'self', 'already', 'rate', 'account', 'failed']);
/** A translated message for any Vacay failure. */
export function errorText(error) {
  const code = errorCode(error);
  return t(`vacay.error.${ERRORS.has(code) ? code : 'failed'}`);
}

/** A person's display name, or a placeholder when the share carried none. */
export const nameOf = (name) => (typeof name === 'string' && name.trim() ? name.trim() : t('vacay.someone'));

/** The leave year label: "2026" or "2026–27". */
export function yearLabel(range) {
  const start = range.start.slice(0, 4); const end = range.end.slice(0, 4);
  return start === end ? start : t('vacay.yearSpan', { start, end: end.slice(2) });
}
