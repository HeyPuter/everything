// Bundled boundaries: countries-50m (whole world, once per page) and Natural Earth admin-1 regions (one small
// TopoJSON per country under data/regions/, fetched on demand). Both follow Natural Earth's default point of view.
import { topologyFeatures } from '../../map/topology.js';
import { countryCode, featureCode } from './countries.js';
import { splitAntimeridian } from './geometry.js';
import { createLocator, createShapeLocator } from './locate.js';
import { isRegionCode } from './regions.js';

const dataURL = (path) => new URL(`data/${path}`, globalThis.document?.baseURI ?? globalThis.location?.href).href;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function fetchJSON(fetcher, url) {
  const response = await fetcher(url, { credentials: 'omit' });
  if (!response.ok) { const error = new Error(`${url} ${response.status}`); error.status = response.status; throw error; }
  return response.json();
}

let countries = null;
/** countries-50m decoded and split at the antimeridian, the codes it draws and a locator; fetched once per page. */
export function loadCountries({ fetch: fetcher = globalThis.fetch, url } = {}) {
  if (countries) return countries;
  countries = (async () => {
    const features = splitAntimeridian(topologyFeatures(await fetchJSON(fetcher, url ?? dataURL('countries-50m.json')), 'countries'));
    return { features, codes: new Set(features.features.map(featureCode).filter(Boolean)), locate: createLocator(features) };
  })();
  countries.catch(() => { countries = null; });
  return countries;
}

let regionIndex = null;
/** `{countries: {cc: regionCount}, moved: {regionCode: cc}}` from data/regions/index.json; fetched once per page. */
export function loadRegionIndex({ fetch: fetcher = globalThis.fetch } = {}) {
  if (regionIndex) return regionIndex;
  regionIndex = fetchJSON(fetcher, dataURL('regions/index.json')).then((value) => {
    const counts = {}; const moved = {};
    for (const [cc, count] of Object.entries(plain(value?.countries) ? value.countries : {})) if (countryCode(cc) === cc && Number.isSafeInteger(count) && count > 0) counts[cc] = count;
    for (const [code, cc] of Object.entries(plain(value?.moved) ? value.moved : {})) if (isRegionCode(code) && countryCode(cc) === cc) moved[code] = cc;
    return { countries: counts, moved };
  });
  regionIndex.catch(() => { regionIndex = null; });
  return regionIndex;
}

/** Decodes one country's region file: `{cc, features, regions: [{code, name, local, iso}], byCode, locate}`. */
export function decodeRegions(cc, topology) {
  const decoded = splitAntimeridian(topologyFeatures(topology, 'regions'));
  const byCode = new Map();
  const features = [];
  for (const feature of decoded.features) {
    const code = feature.id;
    if (!isRegionCode(code) || byCode.has(code)) continue;
    const properties = feature.properties ?? {};
    const name = typeof properties.name === 'string' && properties.name.trim() ? properties.name.trim().slice(0, 120) : code;
    const local = typeof properties.local === 'string' && properties.local.trim() && properties.local.trim() !== name ? properties.local.trim().slice(0, 120) : null;
    byCode.set(code, { code, name, local, iso: properties.iso !== false });
    features.push({ type: 'Feature', id: code, properties: { id: code }, geometry: feature.geometry });
  }
  const collection = { type: 'FeatureCollection', features };
  const regions = [...byCode.values()];
  return { cc, features: collection, regions, byCode, locate: createShapeLocator(collection, (feature) => feature.id) };
}

const regionFiles = new Map();
/**
 * One country's admin-1 regions (see `decodeRegions`), cached per page. Resolves null when the dataset has none for
 * that country; rejects on network errors so a later call retries.
 */
export function loadRegions(cc, { fetch: fetcher = globalThis.fetch } = {}) {
  const code = countryCode(cc);
  if (code !== cc) return Promise.resolve(null);
  if (regionFiles.has(code)) return regionFiles.get(code);
  const pending = (async () => {
    const index = await loadRegionIndex({ fetch: fetcher });
    if (!index.countries[code]) return null;
    return decodeRegions(code, await fetchJSON(fetcher, dataURL(`regions/${code}.json`)));
  })();
  regionFiles.set(code, pending);
  pending.catch(() => { if (regionFiles.get(code) === pending) regionFiles.delete(code); });
  return pending;
}

/**
 * Country and region of a coordinate from the bundled boundaries, offline once the files are cached:
 * `{cc, admin1}`. `cc` is the atlas country (territories the map draws inside another country get that country's
 * code); `admin1` is set only for regions with an ISO 3166-2 code. Both are null when the point is in no country.
 */
export async function locatePlace(lat, lng, { fetch: fetcher = globalThis.fetch } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { cc: null, admin1: null };
  const { locate } = await loadCountries({ fetch: fetcher });
  const cc = locate(lat, lng);
  if (!cc) return { cc: null, admin1: null };
  const regions = await loadRegions(cc, { fetch: fetcher }).catch(() => null);
  const code = regions?.locate(lat, lng) ?? null;
  return { cc, admin1: code && regions.byCode.get(code)?.iso ? code : null };
}

/** Clears the page caches (tests). */
export function resetBoundaries() { countries = null; regionIndex = null; regionFiles.clear(); }
