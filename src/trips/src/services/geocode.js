import { DAY, attribution, coordinate, point, text, delay, assertActive } from './core.js';
import { distance } from './route.js';

// Photon `osm.<key>.<value>` categories; comma-separated includes match any.
export const POI_CATEGORIES = Object.freeze({
  food: ['amenity.restaurant', 'amenity.fast_food', 'amenity.food_court'],
  cafe: ['amenity.cafe', 'amenity.ice_cream'],
  bar: ['amenity.bar', 'amenity.pub', 'amenity.biergarten'],
  lodging: ['tourism.hotel', 'tourism.hostel', 'tourism.guest_house', 'tourism.motel', 'tourism.apartment', 'tourism.camp_site'],
  sights: ['tourism.attraction', 'tourism.viewpoint', 'historic.monument', 'historic.castle', 'historic.memorial', 'historic.ruins'],
  museum: ['tourism.museum', 'tourism.gallery'],
  nature: ['leisure.park', 'leisure.nature_reserve', 'leisure.garden', 'natural.peak', 'natural.beach', 'boundary.national_park'],
  activities: ['tourism.theme_park', 'tourism.zoo', 'tourism.aquarium', 'leisure.water_park', 'amenity.theatre', 'amenity.cinema'],
  charging: ['amenity.charging_station'],
  fuel: ['amenity.fuel'],
});
const GEOAPIFY_CATEGORIES = Object.freeze({
  food: 'catering.restaurant,catering.fast_food,catering.food_court', cafe: 'catering.cafe,catering.ice_cream', bar: 'catering.bar,catering.pub,catering.biergarten',
  lodging: 'accommodation', sights: 'tourism.sights,tourism.attraction', museum: 'entertainment.museum,entertainment.culture.gallery',
  nature: 'leisure.park,natural,national_park', activities: 'entertainment.theme_park,entertainment.zoo,entertainment.aquarium,entertainment.water_park,entertainment.culture.theatre,entertainment.cinema',
  charging: 'service.vehicle.charging_station', fuel: 'service.vehicle.fuel',
});
const ALIASES = { hotel: 'lodging', attraction: 'sights' };
// photon.komoot.io rejects languages it was not imported with.
const PHOTON_LANGUAGES = new Set(['en', 'de', 'fr']);
const clean = (value, max = 500) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
const osmType = value => ({ N: 'node', W: 'way', R: 'relation', node: 'node', way: 'way', relation: 'relation' })[value] ?? '';
const wikidataId = value => typeof value === 'string' && /^Q[1-9]\d{0,12}$/.test(value) ? value : undefined;
const category = name => { const key = ALIASES[name] ?? name; return Object.hasOwn(POI_CATEGORIES, key) ? key : null; };
const language = lang => { const value = lang ?? 'en'; if (typeof value !== 'string' || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(value)) throw new RangeError('Invalid language'); return value.toLowerCase(); };

function result(source, { id, name, lat, lng, address, country, osm, kind, extent, wikidata, city, postcode }) {
  return { id, source, name, lat, lng, address, country, osm, ...(kind ? { kind } : {}), ...(extent ? { extent } : {}), ...(wikidata ? { wikidata } : {}), ...(city ? { city } : {}), ...(postcode ? { postcode } : {}) };
}
function photon(data) {
  if (!Array.isArray(data?.features)) throw new Error('Invalid Photon response');
  return data.features.slice(0, 50).flatMap(feature => {
    try {
      const [lng, lat] = point(feature.geometry?.coordinates); const p = feature.properties ?? {};
      const type = osmType(p.osm_type); const osmId = /^\d{1,15}$/.test(String(p.osm_id ?? '')) ? String(p.osm_id) : '';
      const extent = Array.isArray(p.extent) && p.extent.length === 4 && p.extent.every(Number.isFinite) ? [...p.extent] : undefined;
      return [result('photon', {
        id: `${p.osm_type ?? 'osm'}:${osmId || `${lat},${lng}`}`, name: clean(p.name) || clean(p.street) || clean(p.city), lat, lng,
        address: [[p.street, p.housenumber].filter(x => typeof x === 'string').join(' '), p.postcode, p.city, p.state, p.country].filter(x => typeof x === 'string' && x).map(x => clean(x, 200)).join(', ').slice(0, 1000),
        country: clean(p.countrycode, 2).toUpperCase(), osm: osmId && type ? { type, id: osmId } : null,
        kind: typeof p.osm_key === 'string' && typeof p.osm_value === 'string' ? { key: clean(p.osm_key, 64), value: clean(p.osm_value, 64) } : undefined,
        extent, wikidata: wikidataId(p.extra?.wikidata), city: clean(p.city, 200) || undefined, postcode: clean(p.postcode, 20) || undefined,
      })];
    } catch { return []; }
  });
}
function nominatim(data) {
  const items = Array.isArray(data) ? data : [data];
  return items.slice(0, 50).flatMap(item => {
    try {
      const lat = Number(item.lat), lng = Number(item.lon); coordinate(lat, lng);
      const osmId = /^\d{1,15}$/.test(String(item.osm_id ?? '')) ? String(item.osm_id) : '';
      return [result('nominatim', {
        id: `${String(item.osm_type ?? 'osm').slice(0, 1).toUpperCase()}:${osmId || `${lat},${lng}`}`, name: clean(item.name) || clean(item.display_name), address: clean(item.display_name, 1000), lat, lng,
        country: clean(item.address?.country_code, 2).toUpperCase(), osm: osmId && osmType(item.osm_type) ? { type: osmType(item.osm_type), id: osmId } : null,
        kind: typeof item.category === 'string' && typeof item.type === 'string' ? { key: clean(item.category, 64), value: clean(item.type, 64) } : undefined,
        wikidata: wikidataId(item.extratags?.wikidata), city: clean(item.address?.city ?? item.address?.town ?? item.address?.village, 200) || undefined, postcode: clean(item.address?.postcode, 20) || undefined,
      })];
    } catch { return []; }
  });
}
function geoapify(data) {
  const rows = Array.isArray(data?.results) ? data.results : Array.isArray(data?.features) ? data.features.map(feature => ({ ...feature.properties, lon: feature.geometry?.coordinates?.[0], lat: feature.geometry?.coordinates?.[1] })) : null;
  if (!rows) throw new Error('Invalid Geoapify response');
  return rows.slice(0, 50).flatMap(row => {
    try {
      const lat = Number(row.lat), lng = Number(row.lon); coordinate(lat, lng);
      const raw = row.datasource?.raw ?? {}; const osmId = /^\d{1,15}$/.test(String(raw.osm_id ?? '')) ? String(raw.osm_id) : '';
      return [result('geoapify', {
        id: osmId ? `${String(raw.osm_type ?? 'n').slice(0, 1).toUpperCase()}:${osmId}` : `geoapify:${clean(String(row.place_id ?? `${lat},${lng}`), 120)}`,
        name: clean(row.name) || clean(row.address_line1) || clean(row.formatted), lat, lng, address: clean(row.formatted, 1000), country: clean(row.country_code, 2).toUpperCase(),
        osm: osmId && osmType(raw.osm_type) ? { type: osmType(raw.osm_type), id: osmId } : null, wikidata: wikidataId(raw.wikidata), city: clean(row.city, 200) || undefined, postcode: clean(row.postcode, 20) || undefined,
      })];
    } catch { return []; }
  });
}
// Empty lists let the next provider try before they become the answer.
const found = (data, credit) => ({ data, attribution: [credit], ...(data.length ? {} : { empty: true }) });
const normalizedName = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
/** Drops later results with the same name within `meters` of an earlier one; keeps order and the first source. */
export function dedupeResults(results, meters = 60) {
  const kept = [];
  for (const item of results ?? []) {
    const name = normalizedName(item.name ?? '');
    if (!kept.some(other => normalizedName(other.name ?? '') === name && distance([other.lng, other.lat], [item.lng, item.lat]) <= meters)) kept.push(item);
  }
  return kept;
}
function validBox(bbox, maxSpan) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new RangeError('Invalid bounds');
  coordinate(bbox[1], bbox[0]); coordinate(bbox[3], bbox[2]);
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3] || bbox[2] - bbox[0] > maxSpan || bbox[3] - bbox[1] > maxSpan) throw new RangeError('Bounds too large');
  // Rounded outward so a tiny box never collapses.
  return [Math.floor(bbox[0] * 1000) / 1000, Math.floor(bbox[1] * 1000) / 1000, Math.ceil(bbox[2] * 1000) / 1000, Math.ceil(bbox[3] * 1000) / 1000];
}

const photonLanguage = lang => PHOTON_LANGUAGES.has(lang.split('-')[0]) ? [['lang', lang.split('-')[0]]] : [];

export function createGeocode(ctx) {
  // `include` categories need no query text; servers without them reject the request, so retry with the older `osm_tag` filters.
  const photonSearch = async (params, key, interval, request) => {
    const get = async extra => { const url = new URL('https://photon.komoot.io/api/'); url.search = new URLSearchParams([...params, ...extra]); return (await ctx.json(url.href, { provider: 'photon', interval, ...request })).data; };
    if (!key) return get([]);
    try { return await get([['include', POI_CATEGORIES[key].map(value => 'osm.' + value).join(',')]]); }
    catch (cause) {
      if (cause.status !== 400) throw cause;
      const text = params.some(([name]) => name === 'q') ? [] : [['q', POI_CATEGORIES[key][0].split('.')[1].replaceAll('_', ' ')]];
      return get([...text, ...POI_CATEGORIES[key].map(value => ['osm_tag', value.replace('.', ':')])]);
    }
  };
  const geoapifyRequest = async (path, params, request) => {
    const key = await ctx.key('geoapify'); if (!key) return null;
    const url = new URL(path, 'https://api.geoapify.com'); url.search = new URLSearchParams({ ...params, apiKey: key });
    const { data } = await ctx.json(url.href, { provider: 'geoapify', interval: 200, ...request });
    return found(geoapify(data), attribution.geoapify);
  };
  const search = (query, opts = {}, automatic = false) => {
    const q = text(query); if (q.length < (automatic ? 3 : 1)) return Promise.resolve(null);
    const lang = language(opts.lang);
    if (opts.bias) coordinate(opts.bias.lat, opts.bias.lng);
    const zoom = opts.bias?.zoom === undefined ? undefined : Math.round(opts.bias.zoom);
    if (zoom !== undefined && !(zoom >= 0 && zoom <= 18)) throw new RangeError('Invalid bias zoom');
    const bbox = opts.bbox ? validBox(opts.bbox, 20) : undefined;
    const filter = opts.category === undefined ? undefined : category(opts.category);
    if (opts.category !== undefined && !filter) throw new RangeError('Invalid category');
    const bias = opts.bias ? { lat: Number(opts.bias.lat.toFixed(3)), lng: Number(opts.bias.lng.toFixed(3)), zoom } : undefined;
    const args = { q, lang, bias, bbox, filter, automatic };
    return ctx.run('geocode', args, {
      photon: async (_cfg, request = {}) => {
        const params = [['q', q], ['limit', automatic ? '8' : '10'], ...photonLanguage(lang)];
        if (bias) params.push(['lat', bias.lat], ['lon', bias.lng], ...(zoom !== undefined ? [['zoom', zoom]] : []));
        if (bbox) params.push(['bbox', bbox.join(',')]);
        return found(photon(await photonSearch(params, filter, 300, request)), attribution.photon);
      },
      ...(!automatic ? { nominatim: async (cfg, request = {}) => {
        if (!cfg.geoWorker || filter) return null;
        const url = new URL('/nominatim/search', cfg.geoWorker); url.searchParams.set('q', q); url.searchParams.set('lang', lang);
        if (bbox) url.searchParams.set('viewbox', bbox.join(','));
        const { data } = await ctx.json(url.href, { provider: 'geo-nominatim', retries: 0, ...request }); return found(nominatim(data), attribution.nominatim);
      } } : {}),
      geoapify: (_cfg, request = {}) => geoapifyRequest(automatic ? '/v1/geocode/autocomplete' : '/v1/geocode/search', {
        text: q, lang: lang.split('-')[0], limit: automatic ? 8 : 10, format: 'json',
        ...(bias ? { bias: `proximity:${bias.lng},${bias.lat}` } : {}), ...(bbox ? { filter: `rect:${bbox.join(',')}` } : {}),
      }, request),
    }, { ttl: 30 * DAY, signal: opts.signal });
  };
  let debounceController;
  return {
    search: (q, opts) => search(q, opts),
    async autocomplete(q, opts = {}) {
      debounceController?.abort(); const controller = new AbortController(); debounceController = controller;
      const abort = () => controller.abort(); opts.signal?.addEventListener('abort', abort, { once: true });
      try { assertActive(opts.signal); await delay(300, controller.signal); return await search(q, { ...opts, signal: controller.signal }, true); }
      finally { opts.signal?.removeEventListener('abort', abort); if (debounceController === controller) debounceController = null; }
    },
    reverse(lat, lng, opts = {}) {
      coordinate(lat, lng); lat = Number(lat.toFixed(5)); lng = Number(lng.toFixed(5)); const lang = language(opts.lang);
      return ctx.run('geocode', { reverse: true, lat, lng, lang }, {
        photon: async (_cfg, request = {}) => {
          const url = new URL('https://photon.komoot.io/reverse'); url.search = new URLSearchParams([['lat', lat], ['lon', lng], ['limit', 1], ...photonLanguage(lang)]);
          const { data } = await ctx.json(url.href, { provider: 'photon', interval: 300, ...request }); return found(photon(data), attribution.photon);
        },
        nominatim: async (cfg, request = {}) => {
          if (!cfg.geoWorker) return null; const url = new URL('/nominatim/reverse', cfg.geoWorker); url.search = new URLSearchParams({ lat, lon: lng, lang });
          const { data } = await ctx.json(url.href, { provider: 'geo-nominatim', retries: 0, ...request }); return found(nominatim(data), attribution.nominatim);
        },
        geoapify: (_cfg, request = {}) => geoapifyRequest('/v1/geocode/reverse', { lat, lon: lng, lang: lang.split('-')[0], format: 'json' }, request),
      }, { ttl: 30 * DAY, signal: opts.signal });
    },
    /** Places of one category inside a viewport of at most 2° per side. */
    pois(bbox, name, opts = {}) {
      const key = category(name); if (!key) throw new RangeError('Invalid POI category');
      bbox = validBox(bbox, 2); const lang = language(opts.lang);
      return ctx.run('pois', { bbox, category: key, lang }, {
        photon: async (_cfg, request = {}) => {
          const data = await photonSearch([['bbox', bbox.join(',')], ['limit', '50'], ...photonLanguage(lang)], key, 1000, request);
          return found(photon(data).filter(item => item.lng >= bbox[0] && item.lng <= bbox[2] && item.lat >= bbox[1] && item.lat <= bbox[3]), attribution.photon);
        },
        geoapify: (_cfg, request = {}) => geoapifyRequest('/v2/places', { categories: GEOAPIFY_CATEGORIES[key], filter: `rect:${bbox.join(',')}`, limit: 50, lang: lang.split('-')[0] }, request),
      }, { ttl: DAY, signal: opts.signal });
    },
  };
}
