import { DAY, HOUR } from './core.js';
import { t } from '../lib/i18n/index.js';

const currencies = typeof Intl.supportedValuesOf === 'function' ? new Set(Intl.supportedValuesOf('currency')) : null;
const validCurrency = code => typeof code === 'string' && /^[A-Z]{3}$/.test(code) && (!currencies || currencies.has(code));
export function validDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value; }

/** Converts a positive rate to the decimal string stored on expenses (≤12 significant digits, ≤18 decimals). */
export function rateString(value) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1e50) return null;
  const decimals = Math.min(18, Math.max(0, 11 - Math.floor(Math.log10(value))));
  const fixed = value.toFixed(decimals);
  const trimmed = fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed;
  return /[1-9]/.test(trimmed) ? trimmed : null;
}
/** Units of `to` per unit of `from` from a `rates()` result, or null. */
export function crossRate(data, from, to) {
  const rates = data?.rates; if (!rates || !validCurrency(from) || !validCurrency(to)) return null;
  if (from === to) return 1;
  const a = from === data.base ? 1 : rates[from], b = to === data.base ? 1 : rates[to];
  return Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0 ? b / a : null;
}
/**
 * Freezes a conversion for one expense: `convertMinor(amount, frozen.rate, from, to)` from `src/shared/money.js`
 * then gives the amount in `to`. Store the whole object; never re-fetch rates for a saved expense.
 */
export function freezeRate(result, from, to) {
  const rate = rateString(crossRate(result?.data, from, to));
  return rate ? { rate, from, to, date: result.data.date, provider: result.provider } : null;
}

export function createFx(ctx) {
  return { rates(base, date, opts = {}) {
    if (!validCurrency(base) || (date !== undefined && !validDate(date))) throw new RangeError('Invalid currency/date');
    // Dated rates are final once the provider answers for that day or the day is a week old; otherwise refresh like latest.
    const lifetime = effective => (date && (effective === date || Date.parse(date + 'T00:00:00Z') < ctx.now() - 7 * DAY) ? 365 * DAY : 12 * HOUR);
    return ctx.run('fx', { base, date }, {
      frankfurter: async (_cfg, request = {}) => {
        const url = new URL('https://api.frankfurter.dev/v2/rates'); url.search = new URLSearchParams({ base, ...(date ? { date } : {}) });
        const { data } = await ctx.json(url.href, { provider: 'frankfurter', ...request }); if (!Array.isArray(data)) throw new Error('Invalid FX response');
        const rates = { [base]: 1 }; let effectiveDate;
        for (const row of data) if (String(row.base).toUpperCase() === base && validCurrency(String(row.quote).toUpperCase()) && Number.isFinite(row.rate) && row.rate > 0 && validDate(row.date)) { rates[row.quote.toUpperCase()] = row.rate; effectiveDate = row.date; }
        if (!effectiveDate) throw new Error('Empty FX rates');
        return { data: { base, date: effectiveDate, rates }, attribution: [{ text: `Frankfurter · ${t('services.centralBankRates')}`, url: 'https://frankfurter.dev/', license: 'MIT' }], ttl: lifetime(effectiveDate) };
      },
      fawaz: async (_cfg, request = {}) => {
        const version = date ?? 'latest'; const code = base.toLowerCase();
        let data;
        try { ({ data } = await ctx.json(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${version}/v1/currencies/${code}.json`, { provider: 'fawaz', ...request })); }
        catch (cause) { if (cause.name === 'AbortError') throw cause; ({ data } = await ctx.json(`https://${version}.currency-api.pages.dev/v1/currencies/${code}.json`, { provider: 'fawaz-pages', ...request })); }
        if (!validDate(data?.date) || !data[code] || typeof data[code] !== 'object') throw new Error('Invalid FX response');
        const rates = { [base]: 1 }; for (const [currency, value] of Object.entries(data[code])) if (validCurrency(currency.toUpperCase()) && Number.isFinite(value) && value > 0) rates[currency.toUpperCase()] = value;
        if (Object.keys(rates).length < 2) throw new Error('Empty FX rates');
        return { data: { base, date: data.date, rates }, attribution: [{ text: 'Exchange API', url: 'https://github.com/fawazahmed0/exchange-api', license: 'CC0' }], ttl: lifetime(data.date) };
      },
    }, { ttl: 12 * HOUR, signal: opts.signal });
  } };
}
