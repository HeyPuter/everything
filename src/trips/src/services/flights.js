import { DAY, HOUR, MINUTE, plainText } from './core.js';
import { isDate, isTimeZone } from '../shared/dates.js';

// AeroDataBox through RapidAPI, called from the browser with the user's own subscription key.
export const AERODATABOX_HOST = 'aerodatabox.p.rapidapi.com';
export const FLIGHT_ATTRIBUTION = Object.freeze({ text: 'AeroDataBox', url: 'https://aerodatabox.com/' });
/** Personal KV key holding `{v: 1, key, upd}`; written with `disableSharing`, never exported or sent to a worker. */
export const FLIGHT_KEY = 'me:key:aerodatabox';
const KEY_PATTERN = /^[\x21-\x7e]{8,256}$/;
const DESIGNATOR = /^([A-Z]{3}|[A-Z0-9]{2})\d{1,4}[A-Z]?$/;
const FINAL = new Set(['arrived', 'cancelled', 'diverted']);
const STATUSES = Object.freeze({
  unknown: 'unknown', expected: 'expected', enroute: 'enroute', checkin: 'checkin', boarding: 'boarding', gateclosed: 'gateclosed',
  departed: 'departed', delayed: 'delayed', approaching: 'approaching', arrived: 'arrived', canceled: 'cancelled', cancelled: 'cancelled',
  diverted: 'diverted', canceleduncertain: 'uncertain',
});

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const short = (value, max = 40) => (typeof value === 'string' || typeof value === 'number' ? plainText(String(value), max) || null : null);
export const validFlightKey = (value) => typeof value === 'string' && KEY_PATTERN.test(value.trim());
/** An airline code (IATA, with at least one letter, or ICAO) followed by the flight number: `KL1395`, `U21234`, `KLM1395`. */
export function validDesignator(value) {
  const match = typeof value === 'string' ? value.match(DESIGNATOR) : null;
  return Boolean(match) && /[A-Z]/.test(match[1]);
}

/** An AeroDataBox time ("2026-11-02 10:15Z", "2026-11-02 11:15+01:00") as `{at, date, time, offset}`; `offset` is minutes or null. */
export function parseTime(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return null;
  const [, y, m, d, hh, mm, zone] = match;
  const wall = Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm));
  if (!Number.isFinite(wall) || Number(hh) > 23 || Number(mm) > 59) return null;
  let offset = null;
  if (zone === 'Z') offset = 0;
  else if (zone) {
    const digits = zone.replace(':', '');
    offset = (digits[0] === '-' ? -1 : 1) * (Number(digits.slice(1, 3)) * 60 + Number(digits.slice(3, 5)));
    if (Math.abs(offset) > 14 * 60) return null;
  }
  return { at: offset === null ? null : wall - offset * MINUTE, date: `${y}-${m}-${d}`, time: `${hh}:${mm}`, offset };
}

// Current responses nest `{utc, local}`; older ones used flat `<name>TimeUtc` / `<name>TimeLocal` fields.
function moment(raw, name, legacy = name) {
  const nested = plain(raw[`${name}Time`]) ? raw[`${name}Time`] : {};
  const utc = parseTime(nested.utc ?? raw[`${legacy}TimeUtc`]);
  const local = parseTime(nested.local ?? raw[`${legacy}TimeLocal`]);
  return { at: utc?.at ?? local?.at ?? null, offset: local?.offset ?? null };
}

function movement(raw) {
  if (!plain(raw)) return null;
  const airport = plain(raw.airport) ? raw.airport : {};
  const scheduled = moment(raw, 'scheduled');
  const revised = moment(raw, 'revised', 'actual');
  const predicted = moment(raw, 'predicted', 'estimated');
  const runway = moment(raw, 'runway');
  return {
    iata: typeof airport.iata === 'string' && /^[A-Z]{3}$/.test(airport.iata) ? airport.iata : null,
    icao: typeof airport.icao === 'string' && /^[A-Z0-9]{4}$/.test(airport.icao) ? airport.icao : null,
    name: short(airport.shortName ?? airport.name, 120),
    city: short(airport.municipalityName, 120),
    tz: isTimeZone(airport.timeZone) ? airport.timeZone : null,
    offset: scheduled.offset ?? revised.offset ?? predicted.offset,
    scheduled: scheduled.at, revised: revised.at, predicted: predicted.at, runway: runway.at,
    terminal: short(raw.terminal, 20), gate: short(raw.gate, 20), checkIn: short(raw.checkInDesk, 40), belt: short(raw.baggageBelt, 20),
    live: Array.isArray(raw.quality) && raw.quality.includes('Live'),
  };
}

/** One AeroDataBox flight in a provider-neutral shape; null when it has neither a departure nor an arrival. */
export function mapFlight(raw) {
  if (!plain(raw)) return null;
  const dep = movement(raw.departure);
  const arr = movement(raw.arrival);
  if (!dep && !arr) return null;
  const airline = plain(raw.airline) ? { name: short(raw.airline.name, 120), iata: short(raw.airline.iata, 3), icao: short(raw.airline.icao, 4) } : null;
  return {
    number: short(raw.number, 20), callSign: short(raw.callSign, 20),
    status: STATUSES[String(raw.status ?? '').toLowerCase().replace(/[^a-z]/g, '')] ?? 'unknown',
    airline, aircraft: plain(raw.aircraft) ? short(raw.aircraft.model, 80) : null,
    codeshare: raw.codeshareStatus === 'IsCodeshared', cargo: raw.isCargo === true,
    updatedAt: parseTime(raw.lastUpdatedUtc)?.at ?? null,
    dep, arr,
  };
}

export function mapFlights(data) {
  if (!Array.isArray(data)) throw new Error('Invalid flight status');
  return data.slice(0, 20).map(mapFlight).filter(Boolean);
}

const best = (side) => side?.runway ?? side?.revised ?? side?.predicted ?? side?.scheduled ?? null;
/** How long a status stays fresh: long before departure and after landing, short around the flight. */
export function statusTtl(flights, now) {
  if (!flights?.length) return HOUR;
  if (flights.every((flight) => FINAL.has(flight.status))) return 7 * DAY;
  const departures = flights.map((flight) => best(flight.dep)).filter(Number.isFinite);
  if (!departures.length) return 30 * MINUTE;
  const until = Math.min(...departures) - now;
  if (until > 2 * DAY) return 12 * HOUR;
  if (until > 12 * HOUR) return 2 * HOUR;
  if (until > 3 * HOUR) return 30 * MINUTE;
  return until > 0 ? 10 * MINUTE : 15 * MINUTE;
}

export class FlightStatusError extends Error {
  constructor(code) { super(`flight_status_${code}`); this.name = 'FlightStatusError'; this.code = code; }
}
const failure = (cause) => {
  if (cause?.status === 401 || cause?.status === 403) return 'key_rejected';
  if (cause?.status === 429 || cause?.status === 402) return 'quota';
  if (cause?.status === 400) return 'invalid';
  return 'unavailable';
};

/**
 * Flight status by designator and local departure date. `status()` answers like every adapter (`null` offline with
 * nothing cached) and throws `FlightStatusError` (`key_rejected|quota|invalid|unavailable|no_key`) when the provider
 * failed and nothing is cached. The key comes from `opts.key` or the service `keys('aerodatabox')`.
 */
export function createFlights(ctx) {
  return {
    async available() {
      const cfg = await ctx.loadConfig();
      return (cfg.providers.flights ?? []).some((provider) => provider === 'aerodatabox' && !cfg.disabled.includes(provider));
    },
    async status({ number, date } = {}, opts = {}) {
      if (!validDesignator(number) || !isDate(date)) throw new RangeError('Invalid flight query');
      const key = validFlightKey(opts.key) ? opts.key.trim() : await ctx.key('aerodatabox');
      let failed = null;
      const result = await ctx.run('flights', { number, date }, {
        aerodatabox: async (_cfg, request = {}) => {
          if (!key) { failed = 'no_key'; return null; }
          const url = new URL(`https://${AERODATABOX_HOST}/flights/number/${number}/${date}`);
          url.search = new URLSearchParams({ withAircraftImage: 'false', withLocation: 'false', dateLocalRole: 'Departure' });
          try {
            // No retries: each call counts against the user's paid quota.
            const { data } = await ctx.json(url.href, { provider: 'aerodatabox', retries: 0, headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': AERODATABOX_HOST }, ...request });
            const flights = mapFlights(data);
            return { data: { flights, fetchedAt: ctx.now() }, attribution: [FLIGHT_ATTRIBUTION], ttl: statusTtl(flights, ctx.now()), ...(flights.length ? {} : { empty: true }) };
          } catch (cause) {
            if (cause?.name === 'AbortError') throw cause;
            // "No such flight" is an empty 204 body or a 404.
            if (cause instanceof SyntaxError || cause?.status === 404) return { data: { flights: [], fetchedAt: ctx.now() }, attribution: [FLIGHT_ATTRIBUTION], ttl: HOUR, empty: true };
            failed = failure(cause);
            throw cause;
          }
        },
      }, { ttl: 30 * MINUTE, signal: opts.signal });
      if (!result && failed) throw new FlightStatusError(failed);
      return result;
    },
  };
}

const keyCache = new Map();
const keyListeners = new Set();
/** The user's AeroDataBox key in their own KV, read at most every five minutes per session unless `fresh`. */
export function createFlightKeyStore(puter, { now = Date.now, maxAge = 5 * MINUTE } = {}) {
  const session = puter?.authToken ?? '';
  const read = (value) => {
    if (plain(value) && value.v === 1 && validFlightKey(value.key)) return value.key.trim();
    return validFlightKey(value) ? value.trim() : null;
  };
  const remember = (value) => { keyCache.set(session, { value, at: now() }); for (const listener of keyListeners) listener(session, value); return value; };
  return {
    async get({ fresh = false } = {}) {
      const saved = keyCache.get(session);
      if (!fresh && saved && now() - saved.at < maxAge) return saved.value;
      if (!puter?.kv) return null;
      return remember(read(await puter.kv.get(FLIGHT_KEY)));
    },
    async set(value) {
      if (!validFlightKey(value)) throw Object.assign(new Error('invalid_key'), { code: 'invalid_key' });
      await puter.kv.set(FLIGHT_KEY, { v: 1, key: value.trim(), upd: now() }, { disableSharing: true });
      return remember(value.trim());
    },
    async remove() { await puter.kv.del(FLIGHT_KEY); return remember(null); },
    subscribe(fn) {
      const listener = (owner, value) => { if (owner === session) fn(value); };
      keyListeners.add(listener);
      return () => keyListeners.delete(listener);
    },
  };
}
