// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../../src/services/index.js';
import { createMemoryCache } from '../../src/services/core.js';
import { FLIGHT_KEY, createFlightKeyStore, mapFlight, mapFlights, parseTime, statusTtl, validDesignator } from '../../src/services/flights.js';
import { personalKeys, readPersonal } from '../../src/lib/io/data-export.js';

const KEY = 'rapid-key-1234567890';
const adbFlight = (overrides = {}) => ({
  greatCircleDistance: { km: 370 },
  departure: {
    airport: { icao: 'EHAM', iata: 'AMS', name: 'Amsterdam Schiphol', shortName: 'Schiphol', municipalityName: 'Amsterdam', location: { lat: 52.31, lon: 4.76 }, countryCode: 'NL', timeZone: 'Europe/Amsterdam' },
    scheduledTime: { utc: '2026-11-02 09:15Z', local: '2026-11-02 10:15+01:00' },
    revisedTime: { utc: '2026-11-02 09:40Z', local: '2026-11-02 10:40+01:00' },
    terminal: '2', gate: 'D7', checkInDesk: '1-28', quality: ['Basic', 'Live'],
  },
  arrival: {
    airport: { icao: 'EGLL', iata: 'LHR', name: 'London Heathrow', shortName: 'Heathrow', municipalityName: 'London', timeZone: 'Europe/London' },
    scheduledTime: { utc: '2026-11-02 10:35Z', local: '2026-11-02 10:35+00:00' },
    predictedTime: { utc: '2026-11-02 10:58Z', local: '2026-11-02 10:58+00:00' },
    terminal: '4', baggageBelt: '7', quality: ['Basic'],
  },
  lastUpdatedUtc: '2026-11-02 08:50Z', number: 'KL 1001', callSign: 'KLM1001', status: 'Delayed', codeshareStatus: 'IsOperator', isCargo: false,
  aircraft: { reg: 'PH-EXA', modeS: '484C55', model: 'Embraer 175', image: { url: 'https://example.com/a.jpg' } },
  airline: { name: 'KLM', iata: 'KL', icao: 'KLM' },
  ...overrides,
});
const config = (providers = { flights: ['aerodatabox'] }) => ({ providers, disabled: [], geoWorker: null, nagerVersion: 4 });
function setup(respond, { providers, keys, now = () => Date.UTC(2026, 10, 2, 8, 0) } = {}) {
  const fetcher = vi.fn(async (url, init) => respond(String(url), init));
  const services = createServices({ userId: 'alice', fetch: fetcher, cache: createMemoryCache(), config: config(providers), keys, sleep: async () => {}, now });
  return { fetcher, services };
}

describe('AeroDataBox mapping', () => {
  it('parses UTC and local times with their offsets', () => {
    expect(parseTime('2026-11-02 09:15Z')).toEqual({ at: Date.UTC(2026, 10, 2, 9, 15), date: '2026-11-02', time: '09:15', offset: 0 });
    expect(parseTime('2026-11-02 10:15+01:00')).toMatchObject({ at: Date.UTC(2026, 10, 2, 9, 15), offset: 60 });
    expect(parseTime('2026-11-02T05:30-0330')).toMatchObject({ at: Date.UTC(2026, 10, 2, 9, 0), offset: -210 });
    expect(parseTime('2026-11-02 10:15')).toMatchObject({ at: null, time: '10:15', offset: null });
    expect(parseTime('2026-11-02 25:15Z')).toBeNull();
    expect(parseTime('soon')).toBeNull();
  });
  it('maps a flight to the provider-neutral shape and drops extras', () => {
    const flight = mapFlight(adbFlight());
    expect(flight).toMatchObject({ number: 'KL 1001', status: 'delayed', aircraft: 'Embraer 175', codeshare: false, airline: { iata: 'KL' }, updatedAt: Date.UTC(2026, 10, 2, 8, 50) });
    expect(flight.dep).toMatchObject({ iata: 'AMS', tz: 'Europe/Amsterdam', offset: 60, scheduled: Date.UTC(2026, 10, 2, 9, 15), revised: Date.UTC(2026, 10, 2, 9, 40), gate: 'D7', terminal: '2', checkIn: '1-28', live: true });
    expect(flight.arr).toMatchObject({ iata: 'LHR', predicted: Date.UTC(2026, 10, 2, 10, 58), belt: '7', live: false });
    expect(JSON.stringify(flight)).not.toContain('example.com');
  });
  it('reads the older flat time fields and odd statuses', () => {
    const flight = mapFlight({ number: 'BA 1', status: 'CanceledUncertain', departure: { airport: { iata: 'LHR' }, scheduledTimeUtc: '2026-11-02 10:00Z', scheduledTimeLocal: '2026-11-02 10:00+00:00', actualTimeUtc: '2026-11-02 10:20Z' }, arrival: { airport: { iata: 'bad' } } });
    expect(flight.status).toBe('uncertain');
    expect(flight.dep).toMatchObject({ scheduled: Date.UTC(2026, 10, 2, 10), revised: Date.UTC(2026, 10, 2, 10, 20) });
    expect(flight.arr.iata).toBeNull();
    expect(mapFlight({ number: 'X' })).toBeNull();
    expect(() => mapFlights({ flights: [] })).toThrow();
  });
  it('keeps provider text as plain text', () => {
    const flight = mapFlight(adbFlight({ number: '<b>KL 1001</b>', departure: { ...adbFlight().departure, gate: '<img src=x onerror=1>D7' } }));
    expect(flight.number).toBe('KL 1001');
    expect(flight.dep.gate).toBe('D7');
  });
  it('validates designators', () => {
    for (const value of ['KL1395', 'U21234', 'KLM1395', '9W123', 'BA1A']) expect(validDesignator(value), value).toBe(true);
    for (const value of ['1395', '12345', 'KL12345', 'kl1395', '991234', 'KL 1395']) expect(validDesignator(value), value).toBe(false);
  });
  it('refreshes rarely far from the flight and often around it', () => {
    const now = Date.UTC(2026, 10, 2, 8, 0);
    const at = (minutes, status = 'expected') => [{ status, dep: { scheduled: now + minutes * 60_000 } }];
    expect(statusTtl([], now)).toBe(3_600_000);
    expect(statusTtl(at(5 * 24 * 60), now)).toBe(12 * 3_600_000);
    expect(statusTtl(at(24 * 60), now)).toBe(2 * 3_600_000);
    expect(statusTtl(at(6 * 60), now)).toBe(30 * 60_000);
    expect(statusTtl(at(60), now)).toBe(10 * 60_000);
    expect(statusTtl(at(-60, 'enroute'), now)).toBe(15 * 60_000);
    expect(statusTtl(at(-120, 'arrived'), now)).toBe(7 * 24 * 3_600_000);
  });
});

describe('flight status service', () => {
  it('calls AeroDataBox from the browser with the key in headers only', async () => {
    const { services, fetcher } = setup(() => Response.json([adbFlight()]));
    const result = await services.flights.status({ number: 'KL1001', date: '2026-11-02' }, { key: KEY });
    const [url, init] = fetcher.mock.calls[0];
    expect(new URL(url).origin).toBe('https://aerodatabox.p.rapidapi.com');
    expect(new URL(url).pathname).toBe('/flights/number/KL1001/2026-11-02');
    expect(new URL(url).searchParams.get('dateLocalRole')).toBe('Departure');
    expect(url).not.toContain(KEY);
    expect(init.headers).toMatchObject({ 'X-RapidAPI-Key': KEY, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' });
    expect(init.credentials).toBe('omit');
    expect(result).toMatchObject({ provider: 'aerodatabox', cached: false, attribution: [{ text: 'AeroDataBox' }] });
    expect(result.data.flights).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(KEY);
    const again = await services.flights.status({ number: 'KL1001', date: '2026-11-02' }, { key: KEY });
    expect(again.cached).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('uses the service key source when no key is passed', async () => {
    const keys = vi.fn(async (provider) => (provider === 'aerodatabox' ? KEY : null));
    const { services, fetcher } = setup(() => Response.json([adbFlight()]), { keys });
    await services.flights.status({ number: 'KL1001', date: '2026-11-02' });
    expect(fetcher.mock.calls[0][1].headers['X-RapidAPI-Key']).toBe(KEY);
  });
  it('answers an empty list for unknown flights without retrying', async () => {
    const { services, fetcher } = setup(() => new Response(null, { status: 204 }));
    const result = await services.flights.status({ number: 'KL9999', date: '2026-11-02' }, { key: KEY });
    expect(result.data.flights).toEqual([]);
    expect(fetcher).toHaveBeenCalledOnce();
    const missing = setup(() => new Response('', { status: 404 }));
    expect((await missing.services.flights.status({ number: 'KL9999', date: '2026-11-02' }, { key: KEY })).data.flights).toEqual([]);
  });
  it('reports key, quota and outage failures once, with no cached answer', async () => {
    for (const [status, code] of [[401, 'key_rejected'], [403, 'key_rejected'], [429, 'quota'], [400, 'invalid'], [503, 'unavailable']]) {
      const { services, fetcher } = setup(() => new Response('', { status }));
      await expect(services.flights.status({ number: 'KL1001', date: '2026-11-02' }, { key: KEY })).rejects.toMatchObject({ name: 'FlightStatusError', code });
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });
  it('refuses to call without a key or without the provider in config', async () => {
    const none = setup(() => Response.json([adbFlight()]));
    await expect(none.services.flights.status({ number: 'KL1001', date: '2026-11-02' })).rejects.toMatchObject({ code: 'no_key' });
    expect(none.fetcher).not.toHaveBeenCalled();
    const off = setup(() => Response.json([adbFlight()]), { providers: { flights: [] } });
    expect(await off.services.flights.available()).toBe(false);
    expect(await off.services.flights.status({ number: 'KL1001', date: '2026-11-02' }, { key: KEY })).toBeNull();
    expect(off.fetcher).not.toHaveBeenCalled();
    expect(await none.services.flights.available()).toBe(true);
    await expect(none.services.flights.status({ number: 'KL 1001', date: '2026-11-02' }, { key: KEY })).rejects.toThrow(RangeError);
  });
});

function fakeKv() {
  const items = new Map(); const options = new Map();
  return {
    items, options,
    kv: {
      get: vi.fn(async (key) => items.get(key)),
      set: vi.fn(async (key, value, opts) => { items.set(key, structuredClone(value)); options.set(key, opts); return true; }),
      del: vi.fn(async (key) => items.delete(key)),
    },
  };
}

describe('flight key store', () => {
  it('keeps the key private in personal KV and caches reads per session', async () => {
    const { kv, items, options } = fakeKv();
    const puter = { authToken: 'token-a', kv };
    const store = createFlightKeyStore(puter);
    expect(await store.get({ fresh: true })).toBeNull();
    await expect(store.set('short')).rejects.toMatchObject({ code: 'invalid_key' });
    const seen = vi.fn(); const off = store.subscribe(seen);
    await store.set(`  ${KEY} `);
    expect(items.get(FLIGHT_KEY)).toMatchObject({ v: 1, key: KEY });
    expect(options.get(FLIGHT_KEY)).toEqual({ disableSharing: true });
    expect(seen).toHaveBeenCalledWith(KEY);
    kv.get.mockClear();
    expect(await createFlightKeyStore(puter).get()).toBe(KEY);
    expect(kv.get).not.toHaveBeenCalled();
    expect(await createFlightKeyStore({ authToken: 'token-b', kv }).get()).toBe(KEY);
    expect(kv.get).toHaveBeenCalledOnce();
    await store.remove();
    expect(items.has(FLIGHT_KEY)).toBe(false);
    expect(await store.get()).toBeNull();
    off();
  });
  it('is never part of the data export', async () => {
    expect(personalKeys({ spaces: [], templates: {} })).not.toContain(FLIGHT_KEY);
    const { kv, items } = fakeKv();
    items.set(FLIGHT_KEY, { v: 1, key: KEY });
    items.set('me:prefs', { theme: 'dark' });
    const exported = await readPersonal({ kv });
    expect(exported).toHaveProperty('me:prefs');
    expect(JSON.stringify(exported)).not.toContain(KEY);
  });
});
