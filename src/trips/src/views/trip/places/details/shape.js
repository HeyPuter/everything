// Turns a place and a `placeInfo.details` result into what the details section renders.
import { safeURL } from '../../../../ui/dom.js';
import { httpURL, plainText } from '../../../../services/core.js';
import { t, strings } from '../../../../lib/i18n/index.js';
import { formatNumber } from '../../../../lib/format.js';

const QID = /^Q[1-9]\d{0,12}$/;
const OSM_TYPES = { n: 'node', node: 'node', w: 'way', way: 'way', r: 'relation', relation: 'relation' };
const label = (key, fallback) => (Object.hasOwn(strings, key) ? t(key) : fallback);
const hostOf = (url) => { try { return new URL(url).host; } catch { return ''; } };
const sameURL = (a, b) => { try { const x = new URL(a); const y = new URL(b); return x.host === y.host && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, ''); } catch { return false; } };

/** `{wikidata, osm: {type, id}, osmURL}` from `place.ids`; malformed ids read as absent. */
export function placeRefs(place) {
  const wikidata = typeof place?.ids?.wikidata === 'string' && QID.test(place.ids.wikidata) ? place.ids.wikidata : null;
  const match = /^(node|way|relation|[nwr])[/:]?(\d{1,15})$/i.exec(String(place?.ids?.osm ?? '').trim());
  const osm = match ? { type: OSM_TYPES[match[1].toLowerCase()], id: match[2] } : null;
  return { wikidata, osm, osmURL: osm ? `https://www.openstreetmap.org/${osm.type}/${osm.id}` : null };
}

/** Arguments for `placeInfo.details`, or null when the place links to neither OpenStreetMap nor Wikidata. */
export function detailsQuery(place, { lang = 'en' } = {}) {
  const { wikidata, osm } = placeRefs(place);
  if (!wikidata && !osm) return null;
  const located = Number.isFinite(place.lat) && Number.isFinite(place.lng) && Math.abs(place.lat) <= 90 && Math.abs(place.lng) <= 180;
  const language = String(lang).toLowerCase().split('-')[0];
  return {
    ...(wikidata ? { wikidata } : {}), ...(osm ? { osm: `${osm.type}/${osm.id}` } : {}),
    ...(place.name ? { name: String(place.name).slice(0, 200) } : {}),
    ...(located ? { lat: place.lat, lng: place.lng } : {}),
    ...(typeof place.tz === 'string' ? { tz: place.tz } : {}),
    lang: /^[a-z]{2,3}$/.test(language) ? language : 'en',
  };
}

function photo(item) {
  // Images load in the page, so only https; `httpURL` is https-only.
  const url = httpURL(item?.url); const source = safeURL(item?.source);
  if (!url || !source) return null;
  const license = plainText(item.license, 100);
  const author = plainText(item.author, 300);
  if (!license || (!author && !/^(?:cc0|pdm|public domain|pd)/i.test(license))) return null;
  return {
    url: httpURL(item.thumbnail) ?? url, source, title: plainText(item.title, 300), author, authorURL: safeURL(item.authorURL),
    license, licenseURL: safeURL(item.licenseURL), provider: item.provider === 'openverse' ? 'openverse' : 'wikimedia',
  };
}

function credit(item) {
  const text = plainText(item?.text, 200);
  return text ? { text, url: safeURL(item.url), license: plainText(item.license, 100) || null, licenseURL: safeURL(item.licenseURL) } : null;
}

/**
 * The section's view model. `osmLookup` says whether OSM tags can be looked up by id (a geo worker is configured);
 * without it, a place linked only to OSM has no hours or facts yet and `limited` is set.
 */
export function shapeDetails(result, place, { osmLookup = false } = {}) {
  const refs = placeRefs(place);
  const limited = Boolean(refs.osm && !osmLookup);
  const data = result?.data;
  const view = { description: null, photos: [], hours: null, timeZone: null, facts: [], links: [], credits: [], stale: Boolean(result?.stale), limited, empty: true };
  if (data && typeof data === 'object') {
    const summaries = (Array.isArray(data.summaries) ? data.summaries : [])
      .map((entry) => ({ source: entry?.source, lang: entry?.lang, text: plainText(entry?.text, 5000), url: safeURL(entry?.url) }))
      .filter((entry) => ['wikipedia', 'wikivoyage'].includes(entry.source) && entry.url);
    const text = plainText(data.description, 5000);
    const source = ['osm', 'wikipedia', 'wikivoyage', 'wikidata'].includes(data.descriptionSource) ? data.descriptionSource : null;
    const wikidata = typeof data.wikidata === 'string' && QID.test(data.wikidata) ? data.wikidata : refs.wikidata;
    const wikidataURL = wikidata ? `https://www.wikidata.org/wiki/${wikidata}` : null;
    if (text && source && text !== String(place.desc ?? '').trim()) {
      const article = summaries.find((entry) => entry.source === source);
      view.description = { text, source, url: article?.url ?? (source === 'osm' ? refs.osmURL : source === 'wikidata' ? wikidataURL : null), lang: article?.lang ?? null };
    }
    view.photos = (Array.isArray(data.photos) ? data.photos : []).map(photo).filter(Boolean).slice(0, 3);
    if (data.hours && typeof data.hours.raw === 'string') view.hours = data.hours;
    view.timeZone = typeof data.timeZone === 'string' ? data.timeZone : null;
    const facts = Array.isArray(data.facts) ? data.facts.filter((fact) => typeof fact?.key === 'string') : [];
    const website = facts.find((fact) => fact.key === 'website');
    view.facts = facts.filter((fact) => fact.key !== 'website');
    const links = [];
    const web = safeURL(website?.value);
    if (web && !(place.web && sameURL(web, place.web))) links.push({ id: 'website', url: web });
    for (const entry of summaries) links.push({ id: entry.source, url: entry.url });
    if (wikidataURL) links.push({ id: 'wikidata', url: wikidataURL });
    if (refs.osmURL) links.push({ id: 'osm', url: refs.osmURL });
    view.links = links.map((link) => ({ ...link, host: hostOf(link.url) }));
    view.credits = (Array.isArray(result.attribution) ? result.attribution : []).map(credit).filter(Boolean);
    view.empty = !view.description && !view.photos.length && !view.hours && !view.facts.length;
  }
  return view;
}

/** A fact as `{key, label, text}`; enum values and cuisines are translated when a string exists. */
export function formatFact(fact, { locale = 'en', distanceUnit = 'km' } = {}) {
  const { key, value } = fact;
  let text;
  if (Array.isArray(value)) {
    const words = value.map((word) => label(`placeDetails.cuisine.${word}`, String(word).replaceAll('_', ' ')));
    try { text = new Intl.ListFormat(locale, { style: 'short', type: 'conjunction' }).format(words); } catch { text = words.join(', '); }
  } else if (key === 'elevation' && Number.isFinite(value)) {
    const feet = distanceUnit === 'mi';
    text = new Intl.NumberFormat(locale, { style: 'unit', unit: feet ? 'foot' : 'meter', maximumFractionDigits: 0 }).format(feet ? value * 3.28084 : value);
  } else if (typeof value === 'number') text = formatNumber(value, { locale });
  else if (['phone', 'operator', 'brand'].includes(key)) text = String(value);
  else text = label(`placeDetails.value.${key}.${value}`, label(`placeDetails.value.${value}`, String(value).replaceAll('_', ' ')));
  return { key, label: label(`placeDetails.fact.${key}`, key), text };
}
