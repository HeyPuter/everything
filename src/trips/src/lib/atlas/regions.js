// Admin-1 regions in the atlas: codes, per-country aggregation and totals. Regions match by code, never by name.
import { countryCode } from './countries.js';

export const REGION_CODE = /^[A-Z]{2}-[A-Z0-9]{1,3}$/;
export const isRegionCode = (value) => typeof value === 'string' && REGION_CODE.test(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The atlas country a region belongs to: the region index's `moved` entry, else its ISO prefix. */
export function regionCountry(code, moved = {}) {
  if (!isRegionCode(code)) return null;
  return countryCode(Object.hasOwn(moved, code) ? moved[code] : code.slice(0, 2));
}

/**
 * One country's regions. `country` is its `aggregateAtlas` entry (or null), `regions` the decoded region list
 * (`[{code, name, local, iso}]`), `marks` the normalized `me:atlas` value and `locate(lat, lng)` the country's region
 * locator. An item counts by its `admin1` when the country has that region, else by its coordinates. Items of a
 * hidden country do not count; manual marks always do.
 */
export function aggregateRegions({ country = null, regions = [], marks = null, locate = () => null }) {
  const known = new Set(regions.map((region) => region.code));
  const found = new Map();
  if (country && country.status !== 'hidden') {
    for (const item of country.items ?? []) {
      const code = (isRegionCode(item.admin1) && known.has(item.admin1) ? item.admin1 : null) ?? (finite(item.lat) && finite(item.lng) ? locate(item.lat, item.lng) : null);
      if (!code || !known.has(code)) continue;
      const entry = found.get(code) ?? { visited: false, planned: false, items: [] };
      entry.items.push(item);
      if (item.planned) entry.planned = true; else entry.visited = true;
      found.set(code, entry);
    }
  }
  const manual = plain(marks?.regions) ? marks.regions : {};
  const list = regions.map((region) => {
    const auto = found.get(region.code);
    const isManual = Object.hasOwn(manual, region.code);
    const status = isManual || auto?.visited ? 'visited' : auto?.planned ? 'planned' : null;
    return { ...region, status, manual: isManual, auto: Boolean(auto?.visited), items: auto?.items ?? [] };
  });
  return {
    total: list.length,
    visited: list.filter((region) => region.status === 'visited').length,
    planned: list.filter((region) => region.status === 'planned').length,
    regions: list,
    byCode: new Map(list.map((region) => [region.code, region])),
  };
}

/**
 * Visited regions across the atlas. `loaded` maps a country code to its decoded regions (or null when the dataset
 * has none); countries not loaded yet count their manual marks only and are reported in `pending`.
 * Returns `{regions, countries, pending, byCountry: Map<cc, aggregateRegions result>}`.
 */
export function regionTotals({ atlas, loaded = new Map(), marks = null, moved = {} }) {
  const manualBy = new Map();
  for (const code of Object.keys(plain(marks?.regions) ? marks.regions : {})) {
    const cc = regionCountry(code, moved);
    if (!cc) continue;
    if (!manualBy.has(cc)) manualBy.set(cc, new Set());
    manualBy.get(cc).add(code);
  }
  const byCountry = new Map();
  let regions = 0; let pending = 0; const counted = new Set();
  for (const cc of new Set([...(atlas?.visited ?? []), ...(atlas?.planned ?? []), ...manualBy.keys()])) {
    const country = atlas?.countries.get(cc) ?? null;
    if (loaded.has(cc)) {
      const data = loaded.get(cc);
      if (!data) continue;
      const result = aggregateRegions({ country, regions: data.regions, marks, locate: data.locate });
      byCountry.set(cc, result);
      if (result.visited) { regions += result.visited; counted.add(cc); }
      continue;
    }
    const manual = manualBy.get(cc)?.size ?? 0;
    if (manual) { regions += manual; counted.add(cc); }
    if (country?.status === 'visited' && country.items.some((item) => !item.planned)) pending += 1;
  }
  return { regions, countries: counted.size, pending, byCountry };
}
