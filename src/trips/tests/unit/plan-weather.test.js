import { describe, expect, it, vi } from 'vitest';
import { buildTimeline } from '../../src/lib/timeline/index.js';
import { zonedParts } from '../../src/shared/dates.js';
import {
  chooseWeather, dayLocations, dayStrip, forecastDays, holidaysOn, locationKey, regionMatters, regionOptions, zoneFromLongitude,
} from '../../src/views/trip/plan/weather/model.js';
import { sunTimes } from '../../src/views/trip/plan/weather/sun.js';
import { createWeatherStore } from '../../src/views/trip/plan/weather/store.js';

const day = (id, date, order) => ({ id, date, order });
const places = {
  hotelA: { id: 'hotelA', name: 'Hotel A', lat: 38.71, lng: -9.14, cc: 'PT', tz: 'Europe/Lisbon' },
  museum: { id: 'museum', name: 'Museum', lat: 38.69, lng: -9.21, cc: 'PT' },
  seville: { id: 'seville', name: 'Alcázar', lat: 37.38, lng: -5.99, cc: 'ES' },
  nowhere: { id: 'nowhere', name: 'Somewhere' },
};
const place = (id) => places[id] ?? null;
const lodging = (id, start, end, extra = {}) => ({ id, type: 'lodging', title: id, status: 'confirmed', start: { date: start }, end: { date: end }, ...extra });

function locate({ days, visits = [], reservations = [], resolved }) {
  const frozen = Object.freeze(days);
  const timeline = buildTimeline({ days: frozen, visits, notes: [], reservations });
  return dayLocations({ days: frozen, timeline, reservations, place, resolved });
}

describe('day location', () => {
  const days = [day('d1', '2027-05-01', 'a1'), day('d2', '2027-05-02', 'a2'), day('d3', '2027-05-03', 'a3'), day('d4', '2027-05-04', 'a4')];
  const reservations = [
    lodging('A', '2027-05-01', '2027-05-03', { placeId: 'hotelA' }),
    lodging('B', '2027-05-03', '2027-05-04', { location: { name: 'Porto flat', lat: 41.15, lng: -8.61 }, start: { date: '2027-05-03', tz: 'Europe/Lisbon' } }),
  ];
  const visits = [
    { id: 'v1', dayId: 'd1', placeId: 'museum', order: 'a1' },
    { id: 'v4', dayId: 'd4', placeId: 'seville', order: 'a1' },
  ];

  it('prefers tonight\'s stay, then the morning\'s, over visits', () => {
    const map = locate({ days, visits, reservations });
    expect(map.get('d1').location).toMatchObject({ name: 'Hotel A', source: 'stay', cc: 'PT', tz: 'Europe/Lisbon' });
    expect(map.get('d2').location.name).toBe('Hotel A');
    expect(map.get('d3').location).toMatchObject({ name: 'Porto flat', lat: 41.15, source: 'stay', cc: null, tz: 'Europe/Lisbon' });
    expect(map.get('d3').countries).toEqual(['PT']);
    expect(map.get('d4').location.name).toBe('Porto flat');
    expect(map.get('d4').countries).toEqual(['ES']);
  });

  it('ignores cancelled stays and falls back to the first located visit', () => {
    const map = locate({
      days,
      visits: [{ id: 'free', dayId: 'd2', placeId: null, title: 'Lunch', order: 'a0' }, { id: 'x', dayId: 'd2', placeId: 'nowhere', order: 'a1' }, { id: 'v2', dayId: 'd2', placeId: 'seville', order: 'a2' }],
      reservations: [lodging('A', '2027-05-01', '2027-05-04', { placeId: 'hotelA', status: 'cancelled' })],
    });
    expect(map.get('d2').location).toMatchObject({ name: 'Alcázar', source: 'visit', cc: 'ES' });
  });

  it('uses a transport\'s arrival when nothing else is located', () => {
    const flight = {
      id: 'F', type: 'flight', title: 'TP 1', status: 'confirmed',
      legs: [{ from: { code: 'LHR', lat: 51.47, lng: -0.45, tz: 'Europe/London' }, to: { code: 'LIS', lat: 38.77, lng: -9.13, tz: 'Europe/Lisbon' }, dep: { date: '2027-05-01', time: '08:00' }, arr: { date: '2027-05-01', time: '10:40' } }],
    };
    const map = locate({ days: [day('d1', '2027-05-01', 'a1')], reservations: [flight] });
    expect(map.get('d1').location).toMatchObject({ name: 'LIS', source: 'booking', tz: 'Europe/Lisbon' });
  });

  it('borrows the previous located day, else the next one', () => {
    const map = locate({ days, visits: [{ id: 'v2', dayId: 'd2', placeId: 'museum', order: 'a1' }, { id: 'v4', dayId: 'd4', placeId: 'seville', order: 'a1' }] });
    expect(map.get('d1').location).toMatchObject({ name: 'Museum', from: 'd2' });
    expect(map.get('d3').location).toMatchObject({ name: 'Museum', from: 'd2' });
    expect(map.get('d3').countries).toEqual(['PT']);
    expect(map.get('d4').location.from).toBeUndefined();
  });

  it('asks for a country where none is known, and takes a resolved one', () => {
    const only = [lodging('B', '2027-05-03', '2027-05-04', { location: { name: 'Flat', lat: 41.15, lng: -8.61 } })];
    const first = locate({ days: days.slice(2), reservations: only });
    expect(first.get('d3')).toMatchObject({ needsCountry: true, countries: [] });
    const key = locationKey(first.get('d3').location);
    const second = locate({ days: days.slice(2), reservations: only, resolved: new Map([[key, 'PT']]) });
    expect(second.get('d3')).toMatchObject({ needsCountry: false, countries: ['PT'] });
    expect(second.get('d3').location.cc).toBe('PT');
    const third = locate({ days: days.slice(2), reservations: only, resolved: new Map([[key, { cc: 'PT', admin1: 'PT-13' }]]) });
    expect(third.get('d3').location).toMatchObject({ cc: 'PT', region: 'PT-13' });
    expect(third.get('d3')).toMatchObject({ needsCountry: false, needsRegion: false });
  });

  it('asks for the region of a place that has a country but none, and keeps a region from another country out', () => {
    const map = locate({ days: days.slice(0, 1), visits: [{ id: 'v1', dayId: 'd1', placeId: 'museum', order: 'a1' }] });
    expect(map.get('d1')).toMatchObject({ needsCountry: false, needsRegion: true });
    const key = locationKey(map.get('d1').location);
    const other = locate({ days: days.slice(0, 1), visits: [{ id: 'v1', dayId: 'd1', placeId: 'museum', order: 'a1' }], resolved: new Map([[key, { cc: 'ES', admin1: 'ES-M' }]]) });
    expect(other.get('d1').location).toMatchObject({ cc: 'PT', region: null });
    expect(other.get('d1').needsRegion).toBe(false);
  });

  it('falls back to a longitude zone', () => {
    expect(zoneFromLongitude(-9.1)).toBe('Etc/GMT+1');
    expect(zoneFromLongitude(139.7)).toBe('Etc/GMT-9');
    expect(zoneFromLongitude(3)).toBe('UTC');
  });
});

describe('forecast days', () => {
  const entries = [
    { time: '2026-11-01T00:00:00Z', temperatureC: 10, precipitationMm: 1, periodHours: 6, condition: 'rain', precipitationProbability: 40, windMps: 3 },
    { time: '2026-11-01T03:00:00Z', temperatureC: 14, precipitationMm: 2, periodHours: 6, condition: 'rain', windMps: 8 },
    { time: '2026-11-01T09:00:00Z', temperatureC: 12, precipitationMm: 0, periodHours: 6, condition: 'cloudy', precipitationProbability: 70 },
    { time: '2026-11-01T21:00:00Z', temperatureC: 8, precipitationMm: 0, periodHours: 6, condition: 'clear' },
  ];

  it('groups by local day and counts overlapping periods once', () => {
    const day = forecastDays(entries, 'UTC').get('2026-11-01');
    expect(day).toMatchObject({ minC: 8, maxC: 14, precipitationMm: 2, probability: 70, windMps: 8, condition: 'rain', hours: 18 });
  });

  it('uses the place\'s zone for day boundaries', () => {
    const days = forecastDays(entries, 'Asia/Tokyo');
    expect([...days.keys()]).toEqual(['2026-11-01', '2026-11-02']);
    expect(days.get('2026-11-02').maxC).toBe(8);
  });

  it('builds a strip at least two hours apart on even hours', () => {
    const hourly = Array.from({ length: 10 }, (_, hour) => ({ time: `2026-11-02T${String(hour + 5).padStart(2, '0')}:00:00Z`, temperatureC: hour, periodHours: 1, condition: 'clear' }));
    const strip = dayStrip(forecastDays(hourly, 'UTC').get('2026-11-02'), 'UTC');
    expect(strip.map((slot) => slot.local)).toEqual(['06:00', '08:00', '10:00', '12:00', '14:00']);
  });
});

describe('forecast or normals', () => {
  const today = '2026-11-01';
  const forecast = new Map([
    ['2026-11-01', { hours: 4 }],
    ['2026-11-02', { hours: 24 }],
    ['2026-11-10', { hours: 6 }],
    ['2026-11-20', { hours: 24 }],
  ]);
  const normals = { temperatureC: 15 };

  it('uses the forecast inside the window, including what is left of today', () => {
    expect(chooseWeather({ date: '2026-11-01', today, forecast, normals })).toMatchObject({ kind: 'forecast' });
    expect(chooseWeather({ date: '2026-11-02', today, forecast, normals: undefined })).toMatchObject({ kind: 'forecast', day: { hours: 24 } });
  });

  it('uses normals for a thin last forecast day, beyond the window and in the past', () => {
    expect(chooseWeather({ date: '2026-11-10', today, forecast, normals: undefined })).toEqual({ kind: 'pending', needs: 'normals' });
    expect(chooseWeather({ date: '2026-11-10', today, forecast, normals })).toEqual({ kind: 'normals', normals });
    expect(chooseWeather({ date: '2026-11-20', today, forecast, normals })).toEqual({ kind: 'normals', normals });
    expect(chooseWeather({ date: '2026-10-30', today, forecast, normals })).toEqual({ kind: 'normals', normals });
  });

  it('waits for the forecast, falls back when it is unavailable, and gives up without normals', () => {
    expect(chooseWeather({ date: '2026-11-03', today, forecast: undefined, normals })).toEqual({ kind: 'pending', needs: 'forecast' });
    expect(chooseWeather({ date: '2026-11-03', today, forecast: null, normals })).toEqual({ kind: 'normals', normals });
    expect(chooseWeather({ date: '2026-11-25', today, forecast, normals: null })).toEqual({ kind: 'none' });
    expect(chooseWeather({ date: null, today, forecast, normals })).toEqual({ kind: 'none' });
  });
});

describe('holidays', () => {
  const lists = {
    DE: [
      { date: '2026-10-03', name: 'German Unity Day', localName: 'Tag der Deutschen Einheit', global: true, regions: [] },
      { date: '2026-11-01', name: 'All Saints\' Day', localName: 'Allerheiligen', global: false, regions: ['DE-BY', 'DE-BW'] },
    ],
  };
  const school = {
    DE: [
      { start: '2026-10-26', end: '2026-10-31', name: 'Autumn', regions: ['DE-BY'] },
      { start: '2026-10-19', end: '2026-10-31', name: 'Autumn', regions: ['DE-BE'] },
    ],
    NL: [{ start: '2026-10-24', end: '2026-11-01', name: 'Herfstvakantie', regions: [] }],
  };
  const publicList = (cc) => lists[cc];
  const schoolList = (cc) => school[cc];
  const on = (date, region = null, countries = ['DE']) => holidaysOn({ date, countries, publicList, schoolList, regionFor: () => region });

  it('shows national holidays and resolves regional ones by the chosen region', () => {
    expect(on('2026-10-03').public).toEqual([{ cc: 'DE', name: 'German Unity Day', localName: 'Tag der Deutschen Einheit', regional: false }]);
    expect(on('2026-11-01').public[0]).toMatchObject({ unresolved: true, regions: ['DE-BY', 'DE-BW'] });
    expect(on('2026-11-01', 'DE-BY').public[0]).toMatchObject({ regional: true, region: 'DE-BY' });
    expect(on('2026-11-01', 'DE-BE').public).toEqual([]);
  });

  it('collapses unresolved school holidays per country and keeps nationwide ones', () => {
    expect(on('2026-10-28').school).toEqual([{ cc: 'DE', name: 'Autumn', regional: true, unresolved: true, regions: ['DE-BY', 'DE-BE'] }]);
    expect(on('2026-10-28', 'DE-BY').school).toEqual([{ cc: 'DE', name: 'Autumn', regional: true, region: 'DE-BY' }]);
    expect(on('2026-10-28', 'DE-NW').school).toEqual([]);
    expect(on('2026-10-28', null, ['NL']).school).toEqual([{ cc: 'NL', name: 'Herfstvakantie', regional: false }]);
  });

  it('knows when a region matters and what to offer', () => {
    expect(regionMatters({ cc: 'DE', dates: ['2026-10-01', '2026-10-05'], publicList, schoolList })).toBe(false);
    expect(regionMatters({ cc: 'DE', dates: ['2026-10-25', '2026-10-27'], publicList, schoolList })).toBe(true);
    expect(regionOptions({ cc: 'DE', subdivisions: [{ code: 'DE-BY', name: 'Bavaria' }, { code: 'AT-9', name: 'Vienna' }] })).toEqual([{ code: 'DE-BY', name: 'Bavaria' }]);
    expect(regionOptions({ cc: 'DE', subdivisions: null, publicLists: [lists.DE], schoolLists: [school.DE] }).map((item) => item.code)).toEqual(['DE-BE', 'DE-BW', 'DE-BY']);
  });
});

describe('sun times', () => {
  const minutes = (epoch, zone) => { const { time } = zonedParts(epoch, zone); return Number(time.slice(0, 2)) * 60 + Number(time.slice(3)); };

  it('matches known sunrise and sunset within a few minutes', () => {
    const london = sunTimes('2026-06-21', 51.5074, -0.1278, 'Europe/London');
    expect(Math.abs(minutes(london.rise, 'Europe/London') - (4 * 60 + 43))).toBeLessThanOrEqual(3);
    expect(Math.abs(minutes(london.set, 'Europe/London') - (21 * 60 + 21))).toBeLessThanOrEqual(3);
    const tokyo = sunTimes('2026-12-21', 35.6762, 139.6503, 'Asia/Tokyo');
    expect(Math.abs(minutes(tokyo.rise, 'Asia/Tokyo') - (6 * 60 + 47))).toBeLessThanOrEqual(3);
  });

  it('reports polar day and night', () => {
    expect(sunTimes('2026-06-21', 69.65, 18.96, 'Europe/Oslo')).toEqual({ polar: 'day' });
    expect(sunTimes('2026-12-21', 69.65, 18.96, 'Europe/Oslo')).toEqual({ polar: 'night' });
  });

  it('keeps the requested local date where the zone is far from the longitude', () => {
    const result = sunTimes('2026-06-21', 1.87, -157.4, 'Pacific/Kiritimati');
    expect(zonedParts(result.rise, 'Pacific/Kiritimati').date).toBe('2026-06-21');
    expect(zonedParts(result.set, 'Pacific/Kiritimati').date).toBe('2026-06-21');
  });
});

describe('weather store', () => {
  const now = Date.parse('2026-11-01T03:00:00Z');
  const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
  function stubSpace({ days, visits }) {
    const frozen = Object.freeze(days);
    const all = (list) => ({ all: () => list });
    return {
      ref: { s: '0000000000000001' },
      select: { day: all(frozen), visit: all(visits), dayNote: all([]), res: all([]) },
      get: (type, id) => (type === 'place' ? { id, name: 'Lisbon', lat: 38.71, lng: -9.14, cc: 'PT', tz: 'UTC' } : null),
      subscribe: () => () => {},
    };
  }
  const hourly = Array.from({ length: 48 }, (_, hour) => ({ time: new Date(now + hour * 3_600_000).toISOString(), temperatureC: 10 + (hour % 12), periodHours: 1, condition: 'clear' }));
  function services({ offline = false } = {}) {
    return {
      weather: {
        forecast: vi.fn(async () => (offline ? null : { data: { entries: hourly, updatedAt: null }, attribution: [{ text: 'MET Norway' }] })),
        normals: vi.fn(async (_lat, _lng, month) => (offline ? null : { data: { month, temperatureC: 15, highC: 19, lowC: 11 }, attribution: [{ text: 'NASA POWER' }] })),
      },
      holidays: {
        public: vi.fn(async () => ({ data: [{ date: '2026-12-01', name: 'Restoration of Independence', global: true, regions: [] }], attribution: [] })),
        school: vi.fn(async () => null),
      },
    };
  }
  const setup = (options) => {
    const api = services(options);
    const space = stubSpace({
      days: [day('d1', '2026-11-02', 'a1'), day('d2', '2026-12-01', 'a2')],
      visits: [{ id: 'v1', dayId: 'd1', placeId: 'p1', order: 'a1' }, { id: 'v2', dayId: 'd2', placeId: 'p1', order: 'a1' }],
    });
    const locate = vi.fn(options?.locate ?? (async () => null));
    const store = createWeatherStore({ space, services: api, now: () => now, online: () => !options?.offline, storage: null, locate });
    return { api, store, locate };
  };

  it('fills a missing region from the bundled boundaries without the geocoder', async () => {
    const { api, store, locate } = setup({ locate: async () => ({ cc: 'PT', admin1: 'PT-11' }) });
    api.geocode = { reverse: vi.fn() };
    expect(store.day('d1').location.region).toBeNull();
    await tick();
    expect(store.day('d1').location).toMatchObject({ cc: 'PT', region: 'PT-11' });
    expect(locate).toHaveBeenCalledTimes(1);
    expect(api.geocode.reverse).not.toHaveBeenCalled();
    store.destroy();
  });

  it('loads the forecast for near days and normals for far ones', async () => {
    const { api, store } = setup();
    expect(store.day('d1').weather.kind).toBe('pending');
    expect(store.day('d2').weather.kind).toBe('pending');
    await tick();
    expect(store.day('d1').weather).toMatchObject({ kind: 'forecast', day: { maxC: 21 } });
    expect(store.day('d1').weather.strip.length).toBeGreaterThan(1);
    expect(store.day('d2').weather).toMatchObject({ kind: 'normals', normals: { highC: 19 }, attribution: [{ text: 'NASA POWER' }] });
    expect(store.day('d2').holidays.public[0]).toMatchObject({ cc: 'PT', name: 'Restoration of Independence' });
    expect(api.weather.forecast).toHaveBeenCalledTimes(1);
    expect(api.weather.normals).toHaveBeenCalledTimes(1);
    expect(api.weather.normals.mock.calls[0][2]).toBe(12);
    store.destroy();
  });

  it('shows nothing offline with an empty cache and retries on request', async () => {
    const { api, store } = setup({ offline: true });
    store.day('d1');
    await tick();
    expect(store.day('d1').weather).toMatchObject({ kind: 'pending', needs: 'normals' });
    await tick();
    expect(store.day('d1').weather).toMatchObject({ kind: 'none', offline: true });
    store.retry();
    store.day('d1');
    await tick();
    expect(api.weather.forecast).toHaveBeenCalledTimes(2);
    store.destroy();
  });
});
