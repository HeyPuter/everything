import { timelineOf } from '../ops.js';
import { sunTimes } from './sun.js';
import {
  chooseWeather, dayLocations, dayStrip, forecastDays, holidaysOn, inForecastWindow, locationKey, normalsKey, regionMatters, regionOptions,
  todayIn, tripYears, zoneFromLongitude,
} from './model.js';

const MINUTE = 60_000;
const FORECAST_TTL = 30 * MINUTE;
const RETRY_AFTER = 5 * MINUTE;
const WATCHED = ['day', 'visit', 'res', 'place'];

function readJSON(storage, key) {
  try { const value = JSON.parse(storage?.getItem(key) ?? '{}'); return value && typeof value === 'object' ? value : {}; } catch { return {}; }
}

const boundaries = async (lat, lng) => (await import('../../../../lib/atlas/boundaries.js')).locatePlace(lat, lng);

/**
 * Weather and holidays for a trip's days, loaded on demand and kept for the session. `day(dayId)` answers
 * synchronously from what is loaded and starts what is missing; `onChange` fires when more arrives.
 * Holiday regions are per trip and per device (`trips:holidays:<spaceId>` in localStorage).
 */
export function createWeatherStore({ space, services, lang = 'en', now = Date.now, online = () => globalThis.navigator?.onLine !== false, storage = globalThis.localStorage, onChange = () => {}, locate = boundaries }) {
  const controller = new AbortController();
  const cells = new Map();
  const derived = new WeakMap();
  const regionKey = `trips:holidays:${space.ref?.s ?? 'trip'}`;
  let regions = readJSON(storage, regionKey).regions ?? {};
  let model = null;
  let timer = 0;
  let destroyed = false;
  // Each day is asked for by several nodes per render; answers hold until data changes or the minute turns.
  let version = 0;
  const answers = { key: '', days: new Map(), regions: new Map() };
  const fresh = () => {
    const key = `${version}:${Math.floor(now() / MINUTE)}`;
    if (answers.key !== key) { answers.key = key; answers.days.clear(); answers.regions.clear(); }
    return answers;
  };

  const notify = () => { version++; if (!timer && !destroyed) timer = setTimeout(() => { timer = 0; if (!destroyed) onChange(); }, 30); };

  // `undefined` while the first request runs, `null` when unavailable (offline with nothing cached, or failed), else the result.
  function load(key, request, { ttl = Infinity } = {}) {
    const cell = cells.get(key);
    if (cell?.loading) return cell.previous;
    if (cell && now() - cell.at < (cell.value == null ? RETRY_AFTER : ttl)) return cell.value;
    const next = { loading: true, previous: cell?.value ?? undefined, at: now() };
    cells.set(key, next);
    Promise.resolve().then(() => request(controller.signal)).then((value) => value ?? null, () => null).then((value) => {
      if (destroyed || cells.get(key) !== next) return;
      cells.set(key, { value: value ?? next.previous ?? null, at: now() });
      if (key.startsWith('cc:')) model = null;
      notify();
    });
    return next.previous;
  }
  const data = (result) => (result === undefined ? undefined : result?.data ?? null);

  function plan() {
    if (model) return model;
    const days = space.select.day.all();
    const timeline = timelineOf(space);
    const resolved = new Map();
    for (const [key, cell] of cells) if (key.startsWith('cc:') && !cell.loading) resolved.set(key.slice(3), cell.value);
    const byDay = dayLocations({ days, timeline, reservations: space.select.res.all(), place: (id) => space.get('place', id), resolved });
    model = { timeline, byDay, dates: timeline.days.map((entry) => entry.date).filter(Boolean) };
    return model;
  }

  function zoneOf(location) {
    if (location.tz) return location.tz;
    if (!services.tz?.zoneAt) return zoneFromLongitude(location.lng);
    const zone = load(`zone:${locationKey(location)}`, () => services.tz.zoneAt(location.lat, location.lng));
    return zone === undefined ? undefined : zone ?? zoneFromLongitude(location.lng);
  }
  function forecastOf(result, zone) {
    let entry = derived.get(result.data);
    if (!entry || entry.zone !== zone) { entry = { zone, days: forecastDays(result.data?.entries, zone) }; derived.set(result.data, entry); }
    return entry.days;
  }

  function weatherFor(date, location) {
    const zone = zoneOf(location);
    if (zone === undefined) return { kind: 'pending' };
    const today = todayIn(zone, now());
    const { lat, lng } = location;
    let forecastResult;
    let forecast;
    if (inForecastWindow(date, today)) {
      forecastResult = load(`forecast:${locationKey(location)}`, (signal) => services.weather.forecast(lat, lng, { signal }), { ttl: FORECAST_TTL });
      forecast = forecastResult === undefined ? undefined : forecastResult?.data ? forecastOf(forecastResult, zone) : null;
    }
    let choice = chooseWeather({ date, today, forecast, normals: undefined });
    let normalsResult;
    if (choice.kind === 'pending' && choice.needs === 'normals') {
      const month = Number(date.slice(5, 7));
      normalsResult = load(`normals:${normalsKey(location, month)}`, (signal) => services.weather.normals(lat, lng, month, { signal }));
      choice = chooseWeather({ date, today, forecast, normals: data(normalsResult) });
    }
    const source = choice.kind === 'forecast' ? forecastResult : choice.kind === 'normals' ? normalsResult : null;
    return {
      ...choice, zone, today, offline: !online(),
      attribution: source?.attribution ?? [], stale: Boolean(source?.stale),
      updatedAt: choice.kind === 'forecast' ? forecastResult.data.updatedAt ?? null : null,
      strip: choice.kind === 'forecast' ? dayStrip(choice.day, zone) : [],
      sun: sunTimes(date, lat, lng, zone),
    };
  }

  const publicList = (cc, year) => data(load(`public:${cc}:${year}`, (signal) => services.holidays.public(cc, year, undefined, { lang, signal })));
  const schoolList = (cc, year) => data(load(`school:${cc}:${year}`, (signal) => services.holidays.school(cc, year, undefined, { lang, signal })));
  const regionFor = (location) => (cc) => (location?.region?.startsWith(`${cc}-`) ? location.region : regions[cc] ?? null);

  function holidaysFor(date, countries, location, dates) {
    const year = Number(date.slice(0, 4));
    const found = holidaysOn({ date, countries, publicList, schoolList, regionFor: regionFor(location) });
    const attribution = [];
    for (const cc of countries) {
      for (const kind of ['public', 'school']) {
        for (const credit of cells.get(`${kind}:${cc}:${year}`)?.value?.attribution ?? []) if (!attribution.some((item) => item.text === credit.text)) attribution.push(credit);
      }
    }
    return {
      ...found, attribution, offline: !online(),
      pending: countries.some((cc) => publicList(cc, year) === undefined),
      failed: countries.some((cc) => publicList(cc, year) === null),
      regions: countries.filter((cc) => !location?.region?.startsWith(`${cc}-`) && mattersFor(cc, dates))
        .map((cc) => ({ cc, code: regions[cc] ?? null, name: regionName(cc, regions[cc]) })),
    };
  }
  function mattersFor(cc, dates) {
    const { regions: known } = fresh();
    if (!known.has(cc)) known.set(cc, regionMatters({ cc, dates, publicList, schoolList }));
    return known.get(cc);
  }
  function regionName(cc, code) {
    if (!code) return null;
    const list = data(load(`subdivisions:${cc}`, (signal) => services.holidays.subdivisions?.(cc, { lang, signal })));
    return list?.find((item) => item.code === code)?.name ?? code;
  }

  const offs = [
    space.subscribe((event) => { if (WATCHED.some((type) => event.types.has(type))) { model = null; notify(); } }),
  ];
  const reconnect = () => {
    for (const [key, cell] of cells) if (!cell.loading && cell.value == null) cells.delete(key);
    model = null;
    notify();
  };
  globalThis.addEventListener?.('online', reconnect);

  // Country and region offline from the bundled boundaries; the geocoder only for a missing country they cannot give.
  async function placeOf(location, signal, needsCountry) {
    let found = null;
    try { found = await locate(location.lat, location.lng); } catch { found = null; }
    if (found?.cc) return { cc: found.cc, admin1: found.admin1 ?? null };
    if (!needsCountry || !services.geocode?.reverse) return null;
    const cc = (await services.geocode.reverse(location.lat, location.lng, { lang, signal }))?.data?.[0]?.country;
    return cc ? { cc, admin1: null } : null;
  }

  function dayModel(dayId) {
    const { timeline, byDay, dates } = plan();
    const entry = timeline.byDay.get(dayId);
    if (!entry) return null;
    const info = byDay.get(dayId) ?? { location: null, countries: [], needsCountry: false };
    const { location } = info;
    const stops = entry.rows.filter((row) => row.kind === 'visit' && row.primary && row.entity.placeId).length;
    if (location && (info.needsCountry || info.needsRegion)) load(`cc:${locationKey(location)}`, (signal) => placeOf(location, signal, info.needsCountry));
    if (!entry.date) return { dayId, date: null, location, stops, weather: { kind: 'undated' }, holidays: null };
    return {
      dayId, date: entry.date, location, stops,
      weather: location ? weatherFor(entry.date, location) : { kind: 'nolocation' },
      holidays: holidaysFor(entry.date, info.countries, location, dates),
    };
  }

  return {
    /** Everything shown for one day, or null for an unknown day. */
    day(dayId) {
      const { days } = fresh();
      if (!days.has(dayId)) days.set(dayId, dayModel(dayId));
      return days.get(dayId);
    },
    /** Region pickers for the countries given: `[{cc, code, options}]`, with subdivisions loaded first. */
    async regionChoices(countries) {
      const { dates } = plan();
      const years = tripYears(dates);
      return Promise.all(countries.map(async (cc) => {
        let subdivisions = null;
        try { subdivisions = (await services.holidays.subdivisions(cc, { lang, signal: controller.signal }))?.data ?? null; } catch { subdivisions = null; }
        if (subdivisions) cells.set(`subdivisions:${cc}`, { value: { data: subdivisions }, at: now() });
        const options = regionOptions({ cc, subdivisions, publicLists: years.map((year) => publicList(cc, year)), schoolLists: years.map((year) => schoolList(cc, year)) });
        return { cc, code: regions[cc] ?? null, options };
      }));
    },
    setRegions(patch) {
      regions = { ...regions };
      for (const [cc, code] of Object.entries(patch)) { if (code) regions[cc] = code; else delete regions[cc]; }
      try { storage?.setItem(regionKey, JSON.stringify({ regions })); } catch { /* The choice still applies for this session. */ }
      notify();
    },
    /** Asks again for everything that came back empty. */
    retry: reconnect,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      controller.abort();
      for (const off of offs) off();
      globalThis.removeEventListener?.('online', reconnect);
      cells.clear();
    },
  };
}
