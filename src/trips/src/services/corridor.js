import { DAY, attribution, assertActive, point } from './core.js';
import { corridorBoxes, withinCorridor } from '../lib/road/geo.js';

// Photon `osm.<key>.<value>` tags per road-trip search category; one request per box asks for all chosen ones.
export const CORRIDOR_TAGS = Object.freeze({
  fuel: ['amenity.fuel'],
  charging: ['amenity.charging_station'],
  rest: ['highway.rest_area', 'highway.services'],
  camping: ['tourism.camp_site', 'tourism.caravan_site'],
  lodging: ['tourism.hotel', 'tourism.motel', 'tourism.guest_house', 'tourism.hostel'],
  food: ['amenity.restaurant', 'amenity.fast_food', 'amenity.cafe'],
  sights: ['tourism.attraction', 'tourism.viewpoint', 'historic.castle', 'historic.monument', 'historic.ruins'],
});
export const CORRIDOR_CATEGORIES = Object.freeze(Object.keys(CORRIDOR_TAGS));
const GEOAPIFY = Object.freeze({
  fuel: 'service.vehicle.fuel', charging: 'service.vehicle.charging_station', rest: 'highway.rest_area', camping: 'camping',
  lodging: 'accommodation.hotel,accommodation.motel,accommodation.guest_house,accommodation.hostel', food: 'catering.restaurant,catering.fast_food,catering.cafe',
  sights: 'tourism.sights,tourism.attraction',
});
const PHOTON_LANGUAGES = new Set(['en', 'de', 'fr']);
const clean = (value, max = 300) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const osmType = (value) => ({ N: 'node', W: 'way', R: 'relation' })[value] ?? '';

/** The search category of an OSM key and value, or null. */
export function categoryOf(key, value) {
  const tag = `${key}.${value}`;
  return CORRIDOR_CATEGORIES.find((name) => CORRIDOR_TAGS[name].includes(tag)) ?? null;
}

function photonResults(data) {
  if (!Array.isArray(data?.features)) throw new Error('Invalid Photon response');
  return data.features.slice(0, 50).flatMap((feature) => {
    try {
      const [lng, lat] = point(feature.geometry?.coordinates); const p = feature.properties ?? {};
      const osmId = /^\d{1,15}$/.test(String(p.osm_id ?? '')) ? String(p.osm_id) : '';
      const type = osmType(p.osm_type);
      const category = categoryOf(clean(p.osm_key, 64), clean(p.osm_value, 64));
      if (!category) return [];
      return [{
        id: `${type || 'osm'}:${osmId || `${lat},${lng}`}`, name: clean(p.name), lat, lng, category, source: 'photon',
        address: [[p.street, p.housenumber].filter((x) => typeof x === 'string').join(' '), p.postcode, p.city, p.country].filter((x) => typeof x === 'string' && x).map((x) => clean(x, 200)).join(', '),
        country: clean(p.countrycode, 2).toUpperCase(), osm: osmId && type ? { type, id: osmId } : null,
      }];
    } catch { return []; }
  });
}

/**
 * Places within a corridor of a route line; boxes are searched one after another through the client's Photon throttle.
 * `search(line, {categories, widthKm, lang, signal, maxBoxes, onProgress})` → `{results: [{…, category, off, along}],
 * truncated, offline, failed, attribution}`, results sorted along the line.
 */
export function createCorridor(ctx) {
  function box(bbox, categories, lang, signal) {
    return ctx.run('pois', { road: 1, bbox, categories, lang }, {
      photon: async (_cfg, request = {}) => {
        const tags = categories.flatMap((name) => CORRIDOR_TAGS[name]);
        const get = async (extra) => {
          const url = new URL('https://photon.komoot.io/api/');
          url.search = new URLSearchParams([['bbox', bbox.join(',')], ['limit', '50'], ...(PHOTON_LANGUAGES.has(lang) ? [['lang', lang]] : []), ...extra]);
          return (await ctx.json(url.href, { provider: 'photon', interval: 1000, ...request })).data;
        };
        let data;
        try { data = await get([['include', tags.map((tag) => `osm.${tag}`).join(',')]]); } catch (cause) {
          if (cause.status !== 400) throw cause;
          data = await get(tags.map((tag) => ['osm_tag', tag.replace('.', ':')]));
        }
        const results = photonResults(data).filter((item) => categories.includes(item.category));
        return { data: results, attribution: [attribution.photon], ...(results.length ? {} : { empty: true }) };
      },
      geoapify: async (_cfg, request = {}) => {
        const key = await ctx.key('geoapify'); if (!key) return null;
        const url = new URL('/v2/places', 'https://api.geoapify.com');
        url.search = new URLSearchParams({ categories: categories.map((name) => GEOAPIFY[name]).join(','), filter: `rect:${bbox.join(',')}`, limit: '50', lang, apiKey: key });
        const { data } = await ctx.json(url.href, { provider: 'geoapify', interval: 200, ...request });
        const rows = Array.isArray(data?.features) ? data.features : [];
        const results = rows.flatMap((feature) => {
          try {
            const [lng, lat] = point(feature.geometry?.coordinates); const p = feature.properties ?? {};
            const tags = Array.isArray(p.categories) ? p.categories : [];
            const category = categories.find((name) => GEOAPIFY[name].split(',').some((tag) => tags.includes(tag))) ?? categories[0];
            return [{ id: `geoapify:${clean(String(p.place_id ?? `${lat},${lng}`), 120)}`, name: clean(p.name), lat, lng, category, source: 'geoapify', address: clean(p.formatted, 500), country: clean(p.country_code, 2).toUpperCase(), osm: null }];
          } catch { return []; }
        });
        return { data: results, attribution: [attribution.geoapify], ...(results.length ? {} : { empty: true }) };
      },
    }, { ttl: DAY, signal });
  }

  return {
    categories: CORRIDOR_CATEGORIES,
    async search(line, { categories = ['fuel'], widthKm = 5, lang = 'en', signal, maxBoxes = 12, onProgress } = {}) {
      const chosen = CORRIDOR_CATEGORIES.filter((name) => categories.includes(name));
      if (!chosen.length || !line?.length) return { results: [], truncated: false, offline: false, failed: 0, attribution: [] };
      const language = String(lang).split('-')[0].toLowerCase();
      const { boxes, truncated } = corridorBoxes(line, widthKm, { maxBoxes });
      const found = []; const credits = []; let offline = false; let failed = 0;
      for (const [index, bbox] of boxes.entries()) {
        assertActive(signal);
        try {
          const result = await box(bbox.map((n) => Number(n.toFixed(3))), chosen, language, signal);
          if (!result) offline = true;
          else {
            found.push(...result.data);
            for (const credit of result.attribution ?? []) if (!credits.some((item) => item.url === credit.url)) credits.push(credit);
          }
        } catch (error) { if (error?.name === 'AbortError') throw error; failed++; }
        onProgress?.({ done: index + 1, total: boxes.length });
      }
      return { results: withinCorridor(found, line, widthKm), truncated, offline, failed, attribution: credits };
    },
  };
}
