import { freezeRate } from '../../services/fx.js';
import { convertMinor, currencyDigits, roundRatio } from '../../shared/money.js';
import { localDate as localToday } from '../../shared/dates.js';

export { localToday };

/** The date to ask rates for: the entity's date when it is not in the future, otherwise the latest rates. */
export const rateDate = (date, today) => (typeof date === 'string' && date <= today ? date : undefined);

/**
 * A rate string (units of `to` per unit of `from`) to freeze on an expense or settlement, or null when no rate
 * is available (offline with nothing cached, or the provider failed).
 */
export async function fetchRate({ fx, from, to, date, today = localToday(), signal }) {
  if (from === to) return null;
  if (!fx?.rates) return null;
  try {
    const result = await fx.rates(from, rateDate(date, today), { signal });
    return freezeRate(result, from, to)?.rate ?? null;
  } catch { return null; }
}

/** Live (not frozen) conversion for display totals; null without a rate. */
export async function displayConverter({ fx, from, to, signal }) {
  if (from === to) return (amount) => amount;
  const rate = await fetchRate({ fx, from, to, signal });
  return rate ? (amount) => convertMinor(amount, rate, from, to) : null;
}

/**
 * Groups entities whose rate is pending by currency and date, fetches each rate once and returns
 * `[{entity, rate}]` for those that got one.
 */
export async function resolvePending({ fx, entities, tripCurrency, today = localToday(), signal }) {
  const groups = new Map();
  for (const entity of entities) {
    if (entity.currency === tripCurrency || typeof entity.rate === 'string') continue;
    const key = `${entity.currency}|${rateDate(entity.date, today) ?? ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entity);
  }
  const resolved = [];
  for (const list of groups.values()) {
    if (signal?.aborted) break;
    const rate = await fetchRate({ fx, from: list[0].currency, to: tripCurrency, date: list[0].date, today, signal });
    if (rate) for (const entity of list) resolved.push({ entity, rate });
  }
  return resolved;
}

/**
 * The amount in `other` that a frozen `rate` (units of `trip` per unit of `other`) turns into `amount` of `trip`,
 * rounded half away from zero. Used to prefill a settlement paid in another currency.
 */
export function convertBack(amount, rate, trip, other) {
  const [whole, fraction = ''] = rate.split('.');
  const n = BigInt(whole + fraction);
  if (n <= 0n) return null;
  const value = roundRatio(BigInt(amount) * 10n ** BigInt(currencyDigits(other) + fraction.length), n * 10n ** BigInt(currencyDigits(trip)));
  return Number.isSafeInteger(Number(value)) ? Number(value) : null;
}
