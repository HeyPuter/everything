// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../../src/services/index.js';
import { createMemoryCache, DEFAULT_CONFIG } from '../../src/services/core.js';
import { decodePolyline } from '../../src/services/route.js';
import { encodePolyline, fitShape, mapPlan, routeColor, transitMode } from '../../src/services/transit.js';

const line = (from, to, steps = 10) => Array.from({ length: steps + 1 }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps]);
const stop = (name, lat, lon, extra = {}) => ({ name, lat, lon, ...extra });
const busShape = line([13.3777, 52.5163], [13.4019, 52.5208]);
const motisPlan = () => ({
  requestParameters: {}, debugOutput: {},
  from: stop('START', 52.5163, 13.3777), to: stop('END', 52.5251, 13.4094),
  direct: [{ duration: 2700, startTime: '2026-11-02T08:00:00Z', endTime: '2026-11-02T08:45:00Z', transfers: 0, legs: [{ mode: 'WALK', from: stop('START', 52.5163, 13.3777), to: stop('END', 52.5251, 13.4094), duration: 2700, startTime: '2026-11-02T08:00:00Z', endTime: '2026-11-02T08:45:00Z' }] }],
  itineraries: [{
    duration: 1500, startTime: '2026-11-02T08:02:00Z', endTime: '2026-11-02T08:27:00Z', transfers: 1,
    legs: [
      { mode: 'WALK', from: stop('START', 52.5163, 13.3777), to: stop('Brandenburger Tor', 52.5163, 13.3790), duration: 180, startTime: '2026-11-02T08:02:00Z', endTime: '2026-11-02T08:05:00Z', legGeometry: { points: '', precision: 7, length: 0 } },
      {
        mode: 'BUS', from: stop('Brandenburger Tor', 52.5163, 13.3777, { tz: 'Europe/Berlin', track: '2' }), to: stop('Museumsinsel', 52.5208, 13.4019, { tz: 'Europe/Berlin' }),
        duration: 600, startTime: '2026-11-02T08:07:00Z', endTime: '2026-11-02T08:17:00Z', scheduledStartTime: '2026-11-02T08:05:00Z', scheduledEndTime: '2026-11-02T08:15:00Z',
        realTime: true, routeShortName: '100', headsign: '<b>Alexanderplatz</b>', agencyName: 'BVG', routeColor: 'A5027D', routeTextColor: 'FFFFFF',
        intermediateStops: [stop('A', 52.517, 13.38), stop('B', 52.518, 13.39)], legGeometry: { points: encodePolyline(busShape, 7), precision: 7, length: busShape.length },
      },
      { mode: 'WALK', from: stop('Museumsinsel', 52.5208, 13.4019), to: stop('Hackescher Markt', 52.5225, 13.4024), duration: 120, startTime: '2026-11-02T08:17:00Z', endTime: '2026-11-02T08:19:00Z' },
      {
        mode: 'TRAM', from: stop('Hackescher Markt', 52.5225, 13.4024), to: stop('END', 52.5251, 13.4094), duration: 480, startTime: '2026-11-02T08:19:00Z', endTime: '2026-11-02T08:27:00Z',
        routeShortName: 'M4', agencyName: 'BVG', routeColor: 'not-a-color',
      },
    ],
  }, { duration: 900, startTime: '2026-11-02T08:00:00Z', endTime: '2026-11-02T08:15:00Z', legs: [{ mode: 'WALK', from: stop('START', 52.5163, 13.3777), to: stop('END', 52.5251, 13.4094), startTime: '2026-11-02T08:00:00Z', endTime: '2026-11-02T08:15:00Z' }] }],
});
const config = (providers) => ({ providers, disabled: [], geoWorker: null, nagerVersion: 4 });
function setup(respond, providers = { transit: ['transitous'] }) {
  const fetcher = vi.fn(async (url) => respond(String(url)));
  return { fetcher, services: createServices({ userId: 'alice', fetch: fetcher, cache: createMemoryCache(), config: config(providers), sleep: async () => {}, retries: 0, now: () => Date.UTC(2026, 10, 1, 12) }) };
}
const from = { lat: 52.516312, lng: 13.377689 };
const to = { lat: 52.525112, lng: 13.409421 };

describe('transit mapping', () => {
  it('normalizes modes and route colors', () => {
    expect(['BUS', 'COACH', 'SUBWAY', 'METRO', 'REGIONAL_RAIL', 'HIGHSPEED_RAIL', 'TRAM', 'FERRY', 'AERIAL_LIFT', 'AIRPLANE', 'WALK', 'RENTAL', 'HOVERCRAFT'].map(transitMode))
      .toEqual(['bus', 'coach', 'subway', 'subway', 'rail', 'rail', 'tram', 'ferry', 'cable', 'air', 'walk', 'bike', 'other']);
    expect(routeColor('A5027D')).toBe('#a5027d');
    expect(routeColor('#00FF00')).toBe('#00ff00');
    expect(routeColor('red')).toBeNull();
    expect(routeColor('FFF')).toBeNull();
  });
  it('maps itineraries with rides, walks, delays and plain text', () => {
    const plan = mapPlan(motisPlan());
    expect(plan.itineraries).toHaveLength(1);
    expect(plan.direct).toEqual({ duration: 2700 });
    const [itinerary] = plan.itineraries;
    expect(itinerary).toMatchObject({ start: Date.UTC(2026, 10, 2, 8, 2), end: Date.UTC(2026, 10, 2, 8, 27), duration: 1500, transfers: 1, walk: 300 });
    const bus = itinerary.legs[1];
    expect(bus).toMatchObject({
      mode: 'bus', route: '100', headsign: 'Alexanderplatz', agency: 'BVG', color: '#a5027d', textColor: '#ffffff', stops: 2, realTime: true,
      start: Date.UTC(2026, 10, 2, 8, 7), scheduledStart: Date.UTC(2026, 10, 2, 8, 5), from: { name: 'Brandenburger Tor', tz: 'Europe/Berlin', track: '2' },
    });
    expect(itinerary.legs[3]).toMatchObject({ mode: 'tram', route: 'M4', color: null, shape: null, from: { tz: null } });
  });
  it('re-encodes shapes at precision 5 so they land on the departure stop', () => {
    const bus = mapPlan(motisPlan()).itineraries[0].legs[1];
    const decoded = decodePolyline(bus.shape, 5);
    expect(decoded).toHaveLength(busShape.length);
    expect(decoded[0][0]).toBeCloseTo(13.3777, 4);
    expect(decoded.at(-1)[1]).toBeCloseTo(52.5208, 4);
    // Without a precision field the one that starts next to the stop wins.
    const raw = motisPlan(); delete raw.itineraries[0].legs[1].legGeometry.precision;
    expect(decodePolyline(mapPlan(raw).itineraries[0].legs[1].shape, 5)[0][1]).toBeCloseTo(52.5163, 4);
  });
  it('thins long shapes to the 8 KB leg limit', () => {
    const long = line([0, 0], [3, 3], 4000);
    const shape = fitShape(long, 8192);
    expect(shape.length).toBeLessThanOrEqual(8192);
    const decoded = decodePolyline(shape, 5);
    expect(decoded[0]).toEqual([0, 0]);
    expect(decoded.at(-1)[0]).toBeCloseTo(3, 5);
    expect(fitShape([[0, 0], [1, 1]], 4)).toBeNull();
  });
  it('rejects malformed plans and skips broken legs', () => {
    expect(() => mapPlan({})).toThrow();
    const raw = motisPlan(); raw.itineraries[0].legs[1].from.lat = 120;
    expect(mapPlan(raw).itineraries).toEqual([]);
  });
});

describe('transit service', () => {
  it('is off unless config lists Transitous', async () => {
    expect(DEFAULT_CONFIG.providers.transit).toBeUndefined();
    const { services, fetcher } = setup(() => Response.json(motisPlan()), {});
    expect(await services.transit.available()).toBe(false);
    expect(await services.transit.plan({ from, to, at: Date.UTC(2026, 10, 2, 8) })).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('plans with rounded points and caches the answer', async () => {
    const { services, fetcher } = setup(() => Response.json(motisPlan()));
    expect(await services.transit.available()).toBe(true);
    const result = await services.transit.plan({ from, to, at: Date.UTC(2026, 10, 2, 8, 0, 31), arriveBy: true });
    const url = new URL(fetcher.mock.calls[0][0]);
    expect(url.origin + url.pathname).toBe('https://api.transitous.org/api/v1/plan');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ fromPlace: '52.51631,13.37769', toPlace: '52.52511,13.40942', time: '2026-11-02T08:01:00.000Z', arriveBy: 'true' });
    expect(result).toMatchObject({ provider: 'transitous', data: { arriveBy: true, at: Date.UTC(2026, 10, 2, 8, 1) } });
    expect(result.attribution[0].text).toBe('Transitous');
    await services.transit.plan({ from, to, at: Date.UTC(2026, 10, 2, 8, 0, 50), arriveBy: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('answers no connections as an empty list and validates input', async () => {
    const { services } = setup(() => Response.json({ itineraries: [], direct: [] }));
    expect((await services.transit.plan({ from, to, at: Date.UTC(2026, 10, 2, 8) })).data.itineraries).toEqual([]);
    expect(() => services.transit.plan({ from: { lat: 91, lng: 0 }, to, at: 0 })).toThrow();
    expect(() => services.transit.plan({ from, to, at: NaN })).toThrow();
  });
});
