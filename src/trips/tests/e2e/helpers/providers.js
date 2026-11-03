// Fixtures for map styles, tiles and third-party providers on bridge contexts, which refuse live network otherwise.
const CORS = { 'Access-Control-Allow-Origin': '*' };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const mapStyle = (dark) => ({
  version: 8,
  glyphs: 'https://map-fixture.test/fonts/{fontstack}/{range}.pbf',
  sources: { base: { type: 'vector', tiles: ['https://map-fixture.test/tiles/{z}/{x}/{y}.pbf'], maxzoom: 6 } },
  layers: [
    { id: 'background', type: 'background', paint: { 'background-color': dark ? '#18181a' : '#f4f2ee' } },
    { id: 'water', type: 'fill', source: 'base', 'source-layer': 'water', paint: { 'fill-color': '#9cc0f9' } },
  ],
});

/** A MET Norway `complete` forecast: hourly for two days from `from`, then 6-hourly to ten days. */
export function forecast({ from = Date.now(), temperature = 18, symbol = 'partlycloudy_day' } = {}) {
  const start = Math.floor(from / 3_600_000) * 3_600_000;
  const timeseries = [];
  for (let hour = 0; hour < 240; hour += hour < 48 ? 1 : 6) {
    const period = { summary: { symbol_code: symbol }, details: { precipitation_amount: 0.2, probability_of_precipitation: 30 } };
    timeseries.push({
      time: new Date(start + hour * 3_600_000).toISOString(),
      data: { instant: { details: { air_temperature: temperature + Math.round(4 * Math.sin(hour / 4)), wind_speed: 4, relative_humidity: 60 } }, ...(hour < 48 ? { next_1_hours: period } : { next_6_hours: period }) },
    });
  }
  return { type: 'Feature', properties: { meta: { updated_at: new Date(start).toISOString() }, timeseries } };
}

/** NASA POWER climatology with the same values every month. */
export function climatology({ mean = 16, high = 21, low = 11, rain = 2.5 } = {}) {
  const months = (value) => Object.fromEntries([...MONTHS, 'ANN'].map((key) => [key, value]));
  return { properties: { parameter: { T2M: months(mean), T2M_MAX: months(high), T2M_MIN: months(low), PRECTOTCORR: months(rain) } } };
}

/** Nager.Date v4 rows; `holidays` is `[{date, name, cc, regions?}]`. */
const nager = (holidays, code, year) => holidays.filter((item) => item.cc === code && item.date.startsWith(`${year}-`)).map((item) => ({
  date: item.date, localName: item.localName ?? item.name, name: item.name, countryCode: code,
  nationalHoliday: !item.regions, subdivisionCodes: item.regions ?? null, holidayTypes: ['Public'],
}));

/** A Photon feature for `geocode` fixtures. */
export const photonFeature = ({ name, lat, lng, city = 'Lisboa', country = 'Portugal', cc = 'PT', osm = ['N', 1], key = 'tourism', value = 'attraction' }) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] },
  properties: { name, city, country, countrycode: cc, osm_type: osm[0], osm_id: osm[1], osm_key: key, osm_value: value },
});

/**
 * Routes map styles, tiles, imagery, Photon (search, `pois` for explore, `reverse`), MET Norway, NASA POWER, Nager.Date,
 * OpenHolidays and the GDACS and DWD hazard feeds (empty) on a context.
 * Routes registered after the bridge's catch-all run first. Unknown hosts are still refused and listed in `unexpected`.
 * `config` patches `/config.json` (for example `{providers: {transit: ['transitous']}}`); `extra(url, route)` may answer
 * other hosts; it returns false for requests it leaves to the fixtures here.
 */
export async function routeProviders(context, { holidays = [], school = [], photon = [], pois = [], reverse = null, weather = {}, normals = {}, config = null, extra = null } = {}) {
  const traffic = { styles: [], tiles: 0, imagery: 0, weather: 0, normals: 0, holidays: 0, photon: 0, unexpected: [] };
  const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
  await context.route((url) => !['127.0.0.1', 'localhost'].includes(url.hostname), async (route) => {
    const url = new URL(route.request().url());
    const host = url.hostname;
    if (extra && await extra(url, route) !== false) return;
    if (host === 'tiles.openfreemap.org' && url.pathname.startsWith('/styles/')) { traffic.styles.push(url.pathname.split('/').pop()); return json(route, mapStyle(url.pathname.endsWith('/dark'))); }
    if (host === 'map-fixture.test') { traffic.tiles++; return route.fulfill({ status: 200, body: Buffer.alloc(0), contentType: 'application/x-protobuf', headers: CORS }); }
    if (host === 'server.arcgisonline.com') { traffic.imagery++; return route.fulfill({ status: 200, body: PNG, contentType: 'image/png', headers: CORS }); }
    if (host === 'api.met.no') { traffic.weather++; return route.fulfill({ status: 200, contentType: 'application/json', headers: { ...CORS, expires: new Date(Date.now() + 3_600_000).toUTCString() }, body: JSON.stringify(forecast(weather)) }); }
    if (host === 'power.larc.nasa.gov') { traffic.normals++; return json(route, climatology(normals)); }
    if (host === 'nagerholidays.com') {
      traffic.holidays++;
      const [, code, year] = url.pathname.match(/\/Holidays\/([A-Z]{2})\/(\d{4})/) ?? [];
      return json(route, nager(holidays, code, year));
    }
    if (host === 'openholidaysapi.org') {
      traffic.holidays++;
      const code = url.searchParams.get('countryIsoCode');
      if (url.pathname === '/SchoolHolidays') return json(route, school.filter((item) => item.cc === code).map((item, index) => ({ id: `s${index}`, startDate: item.start, endDate: item.end, name: [{ language: 'EN', text: item.name }], subdivisions: (item.regions ?? []).map((value) => ({ code: value })) })));
      if (url.pathname === '/Subdivisions') return json(route, code === 'DE' ? [{ code: 'DE-BY', name: [{ language: 'EN', text: 'Bavaria' }] }, { code: 'DE-BE', name: [{ language: 'EN', text: 'Berlin' }] }] : []);
      return json(route, []);
    }
    if (host === 'www.gdacs.org' || host === 'maps.dwd.de') { traffic.hazards = (traffic.hazards ?? 0) + 1; return json(route, { type: 'FeatureCollection', features: [] }); }
    if (host === 'photon.komoot.io') {
      traffic.photon++;
      if (url.pathname === '/reverse') return json(route, { type: 'FeatureCollection', features: reverse ? [photonFeature(reverse)] : [] });
      if (url.searchParams.has('include')) {
        // Explore POIs without coordinates sit at the centre of the searched box.
        const [west, south, east, north] = (url.searchParams.get('bbox') ?? '0,0,0,0').split(',').map(Number);
        return json(route, { type: 'FeatureCollection', features: pois.map((item) => photonFeature({ lat: (south + north) / 2, lng: (west + east) / 2, ...item })) });
      }
      const query = (url.searchParams.get('q') ?? '').toLowerCase();
      return json(route, { type: 'FeatureCollection', features: photon.filter((item) => !query || item.name.toLowerCase().includes(query)).map(photonFeature) });
    }
    traffic.unexpected.push(url.href);
    return route.abort('blockedbyclient');
  });
  if (config) {
    await context.route((url) => url.pathname.endsWith('/config.json'), async (route) => {
      const response = await route.fetch();
      const base = await response.json();
      const merged = { ...base, ...config, providers: { ...base.providers, ...config.providers } };
      return route.fulfill({ response, json: merged });
    });
  }
  return traffic;
}

/**
 * Seeds entities as `as` through the mock hook. `items` are `{key, type, fields}`; string fields `$key` resolve to the id
 * created for an earlier item. Resolves `{key: id}` once the worker has them.
 */
export async function seed(world, ref, items, as = 'alice') {
  const page = await world.open(as);
  try {
    await page.locator('html[data-worker="ready"]').waitFor({ state: 'attached' });
    return await page.evaluate(async ([target, list]) => {
      await globalThis.trips.open(target);
      const ids = {};
      const resolve = (value) => (typeof value === 'string' && value.startsWith('$') ? ids[value.slice(1)] : Array.isArray(value) ? value.map(resolve) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item)])) : value);
      for (const item of list) ids[item.key] = await globalThis.trips.create(target, item.type, resolve(item.fields));
      await globalThis.trips.flush(target);
      globalThis.trips.close(target);
      return ids;
    }, [ref, items]);
  } finally { await page.close(); }
}

/** Reads entities `[[type, id], …]` as `as` after a fresh sync, in a page of its own. */
export async function read(world, ref, items, as = 'alice') {
  const page = await world.open(as);
  try {
    await page.locator('html[data-worker="ready"]').waitFor({ state: 'attached' });
    return await page.evaluate(async ([target, list]) => {
      await globalThis.trips.open(target);
      await globalThis.trips.sync(target);
      const found = list.map(([type, id]) => globalThis.trips.get(target, type, id));
      globalThis.trips.close(target);
      return found;
    }, [ref, items]);
  } finally { await page.close(); }
}

/** `YYYY-MM-DD` for today plus `days` in the browser's zone (the specs and browsers share the machine's zone). */
export function isoDay(days = 0, from = new Date()) {
  const date = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
