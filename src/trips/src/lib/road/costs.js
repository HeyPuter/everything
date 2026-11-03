import { isCurrency, toMinor } from '../../shared/money.js';

/** Units a vehicle buys: litres, or kWh for an electric one. */
export const fuelUnit = (prefs) => (prefs.fuel === 'electric' ? 'kwh' : 'l');

/**
 * Fuel or energy for `meters` of driving: `{km, units, unit, amount, currency}`; `amount` (minor units) needs a price
 * and currency, `units` a consumption. Null without a consumption.
 */
export function fuelEstimate({ meters, prefs, currency = prefs.currency }) {
  if (!prefs.use || !(meters >= 0)) return null;
  const km = meters / 1000;
  const units = km * prefs.use / 100;
  let amount = null;
  if (prefs.price && isCurrency(currency)) {
    const value = (units * Number(prefs.price)).toFixed(6);
    amount = toMinor(value, currency, { round: true });
  }
  return { km, units, unit: fuelUnit(prefs), amount, currency: amount === null ? null : currency };
}

/** Drive legs whose route has tolls, ferries or motorways, from the routing flags (`Map<legKey, flags>`). */
export function routeFlags(chain, flags) {
  const out = { toll: [], ferry: [], motorway: [], unknown: 0 };
  for (const leg of chain.legs) {
    if (leg.kind !== 'drive') continue;
    const value = flags.get(leg.key);
    if (!value) { out.unknown++; continue; }
    for (const name of ['toll', 'ferry', 'motorway']) if (value[name]) out[name].push(leg.key);
  }
  return out;
}

/**
 * A new expense for the costs form to show for review (it saves nothing): split equally between `people`, paid by
 * `payer` when given.
 */
export function expenseDraft({ name, amount, currency, people, payer = null, date = null, note = '' }) {
  const who = [...new Set(people)].slice(0, 50);
  return {
    name, amount, currency, cat: 'fuel', date, note,
    payers: payer ? [{ who: payer, amount }] : [],
    split: { mode: 'equal', parts: (who.length ? who : payer ? [payer] : []).map((id) => ({ who: id })) },
    links: [],
  };
}
