import { DAY, HOUR, attribution, coordinate, httpURL, plainText } from './core.js';
import { commonsPhotos } from './images.js';
import { openingStatus, parseOpeningHours } from './hours.js';
import { t } from '../lib/i18n/index.js';

const HEADERS = { 'Api-User-Agent': 'PuterTrips/1.0 (https://trips.puter.com)' };
const plain = (value, max = 1000) => plainText(value, max);
const QID = /^Q[1-9]\d{0,12}$/;
const OSM_TYPES = { n: 'N', node: 'N', w: 'W', way: 'W', r: 'R', relation: 'R' };
const webLink = value => { try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; } };
const word = value => typeof value === 'string' && /^[a-z0-9_]{1,40}$/.test(value) ? value : null;
const yesNo = (...allowed) => value => allowed.includes(value) ? value : null;
const list = value => typeof value === 'string' ? [...new Set(value.split(';').map(item => word(item.trim().toLowerCase())).filter(Boolean))].slice(0, 10) : null;
// Fact keys are stable identifiers for the view to translate; values are normalized enums, numbers or links.
const FACTS = [
  ['cuisine', tags => list(tags.cuisine)?.length ? list(tags.cuisine) : null],
  ['wheelchair', tags => yesNo('yes', 'limited', 'no', 'designated')(tags.wheelchair)],
  ['internet', tags => yesNo('yes', 'wlan', 'no', 'terminal', 'wired')(tags.internet_access)],
  ['outdoorSeating', tags => yesNo('yes', 'no')(tags.outdoor_seating)],
  ['takeaway', tags => yesNo('yes', 'no', 'only')(tags.takeaway)],
  ['delivery', tags => yesNo('yes', 'no')(tags.delivery)],
  ['reservation', tags => yesNo('yes', 'no', 'required', 'recommended')(tags.reservation)],
  ['fee', tags => yesNo('yes', 'no')(tags.fee)],
  ['smoking', tags => yesNo('yes', 'no', 'outside', 'separated', 'isolated')(tags.smoking)],
  ['vegetarian', tags => yesNo('yes', 'no', 'only', 'limited')(tags['diet:vegetarian'])],
  ['vegan', tags => yesNo('yes', 'no', 'only', 'limited')(tags['diet:vegan'])],
  ['toilets', tags => yesNo('yes', 'no', 'customers')(tags.toilets)],
  ['cards', tags => yesNo('yes', 'no')(tags['payment:cards'] ?? tags['payment:credit_cards'])],
  ['cash', tags => yesNo('yes', 'no')(tags['payment:cash'])],
  ['dogs', tags => yesNo('yes', 'no', 'leashed')(tags.dog)],
  ['airConditioning', tags => yesNo('yes', 'no')(tags.air_conditioning)],
  ['stars', tags => /^[1-7]S?$/.test(tags.stars ?? '') ? Number.parseInt(tags.stars, 10) : null],
  ['elevation', tags => /^-?\d{1,5}(\.\d+)?$/.test(tags.ele ?? '') ? Math.round(Number(tags.ele)) : null],
  ['website', tags => webLink(tags.website ?? tags['contact:website'])],
  ['phone', tags => { const value = tags.phone ?? tags['contact:phone']; return typeof value === 'string' && /^[+\d][\d ()./-]{3,40}$/.test(value.split(';')[0].trim()) ? value.split(';')[0].trim() : null; }],
  ['operator', tags => plain(tags.operator, 200) || null],
  ['brand', tags => plain(tags.brand, 200) || null],
];
export function osmFacts(tags) {
  if (!tags) return [];
  return FACTS.flatMap(([key, read]) => { const value = read(tags); return value == null ? [] : [{ key, value }]; });
}
function osmRef(value) {
  if (value == null) return null;
  if (typeof value === 'object') value = `${value.type ?? ''}${value.id ?? ''}`;
  const match = /^(node|way|relation|[nwr])[/:]?(\d{1,15})$/i.exec(String(value).trim());
  if (!match) throw new RangeError('Invalid OSM reference');
  return OSM_TYPES[match[1].toLowerCase()] + match[2];
}
const TAG_KEYS = new Set(['name', 'wikidata', 'opening_hours', 'description', 'cuisine', 'wheelchair', 'internet_access', 'outdoor_seating', 'takeaway', 'delivery', 'reservation', 'fee', 'smoking', 'diet:vegetarian', 'diet:vegan', 'toilets', 'payment:cards', 'payment:credit_cards', 'payment:cash', 'dog', 'air_conditioning', 'stars', 'ele', 'website', 'contact:website', 'phone', 'contact:phone', 'operator', 'brand']);
function cleanTags(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new RangeError('Invalid tags');
  // Only tags this module reads, so cache keys stay small.
  const entries = Object.entries(input).filter(([key, value]) => (TAG_KEYS.has(key) || /^description:[a-z]{2,3}$/.test(key)) && typeof value === 'string' && value.length <= 500).slice(0, 40);
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

export function createPlaceInfo(ctx, { timezone } = {}) {
  const wiki = (url, request) => ctx.json(url, { provider: 'wikimedia', interval: 250, headers: HEADERS, ...request });
  const summary = async (host, title, request) => {
    try {
      const { data } = await wiki(`https://${host}/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(' ', '_'))}`, request);
      const extract = plain(data?.extract, 5000); return extract ? extract : null;
    } catch (cause) { if (cause.name === 'AbortError') throw cause; return null; }
  };
  // Labels, descriptions and sitelinks only (full entity JSON can be several MB), then the P18 image claims.
  const wikidataEntity = async (qid, languages, request) => {
    const api = params => { const url = new URL('https://www.wikidata.org/w/api.php'); url.search = new URLSearchParams({ ...params, format: 'json', origin: '*' }); return url.href; };
    const { data } = await wiki(api({ action: 'wbgetentities', ids: qid, props: 'labels|descriptions|sitelinks', languages: languages.join('|'), sitefilter: languages.flatMap(code => [`${code}wiki`, `${code}wikivoyage`]).join('|') }), request);
    const entity = data?.entities?.[qid] ?? Object.values(data?.entities ?? {})[0];
    if (!entity || typeof entity !== 'object' || 'missing' in entity) throw new Error('Invalid entity');
    try {
      const { data: claims } = await wiki(api({ action: 'wbgetclaims', entity: QID.test(entity.id ?? '') ? entity.id : qid, property: 'P18' }), request);
      entity.claims = claims?.claims && typeof claims.claims === 'object' ? claims.claims : {};
    } catch (cause) { if (cause.name === 'AbortError') throw cause; entity.claims = {}; }
    return entity;
  };
  return {
    /**
     * Description (OSM, Wikivoyage, Wikipedia, Wikidata in that order), Commons photos with credits,
     * opening hours with open/closed in the place's time zone, and facts from OSM tags.
     */
    details({ wikidata, osm, tags, name, lat, lng, tz, lang = 'en' } = {}, opts = {}) {
      if (wikidata != null && !QID.test(wikidata)) throw new RangeError('Invalid Wikidata id');
      lang = typeof lang === 'string' ? lang.toLowerCase() : lang;
      if (typeof lang !== 'string' || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(lang)) throw new RangeError('Invalid language');
      if (lat != null || lng != null) coordinate(lat, lng);
      const ref = osmRef(osm); const given = cleanTags(tags);
      if (!wikidata && !ref && !given) return Promise.resolve(null);
      const label = plain(name, 200) || undefined;
      const languages = [...new Set([lang.split('-')[0], 'en'])];
      return ctx.run('placeInfo', { wikidata, osm: ref, tags: given, name: label, lang }, { wikimedia: async (cfg, request = {}) => {
        const credits = [];
        let osmTags = given; let partial = false;
        if (!osmTags && ref && cfg.geoWorker) {
          try {
            const url = new URL('/nominatim/lookup', cfg.geoWorker); url.search = new URLSearchParams({ osm_ids: ref, lang });
            const { data } = await ctx.json(url.href, { provider: 'geo-nominatim', retries: 0, ...request });
            const row = Array.isArray(data) ? data[0] : null;
            osmTags = cleanTags({ ...(row?.extratags ?? {}), ...(typeof row?.name === 'string' ? { name: row.name } : {}) });
          } catch (cause) { if (cause.name === 'AbortError') throw cause; partial = true; }
        }
        const qid = wikidata ?? (QID.test(osmTags?.wikidata ?? '') ? osmTags.wikidata : null);
        let entity = null;
        if (qid) {
          try { entity = await wikidataEntity(qid, languages, request); }
          catch (cause) { if (cause.name === 'AbortError' || !osmTags) throw cause; partial = true; }
          if (entity) credits.push({ ...attribution.wikidata, url: `https://www.wikidata.org/wiki/${qid}` });
        }
        if (!entity && !osmTags) return null;
        const pick = field => { for (const code of languages) { const value = plain(entity?.[field]?.[code]?.value, 300); if (value) return value; } return ''; };
        const summaries = [];
        for (const [site, suffix, credit] of [['wikivoyage', 'wikivoyage', 'services.wikivoyageContributors'], ['wikipedia', 'wiki', 'services.wikipediaContributors']]) {
          for (const code of languages) {
            const title = entity?.sitelinks?.[`${code}${suffix}`]?.title; if (typeof title !== 'string' || title.length > 300) continue;
            const host = `${code}.${site}.org`; const text = await summary(host, title, request);
            if (!text) continue;
            const url = `https://${host}/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
            summaries.push({ source: site, lang: code, text, url });
            credits.push({ text: t(credit), url, license: 'CC BY-SA 4.0', licenseURL: 'https://creativecommons.org/licenses/by-sa/4.0/' });
            break;
          }
        }
        const osmDescription = plain(osmTags?.[`description:${languages[0]}`] ?? osmTags?.description, 2000);
        const [description, descriptionSource] = osmDescription ? [osmDescription, 'osm'] : summaries[0] ? [summaries[0].text, summaries[0].source] : pick('descriptions') ? [pick('descriptions'), 'wikidata'] : ['', null];
        const files = (entity?.claims?.P18 ?? []).map(claim => claim?.mainsnak?.datavalue?.value).filter(file => typeof file === 'string' && file.length < 500).slice(0, 3);
        let photos = [];
        if (files.length) {
          try {
            const url = new URL('https://commons.wikimedia.org/w/api.php');
            url.search = new URLSearchParams({ action: 'query', format: 'json', origin: '*', titles: files.map(file => 'File:' + file).join('|'), prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: 800, iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl' });
            const { data } = await wiki(url.href, request); photos = commonsPhotos(data?.query?.pages, 3);
            if (photos.length) credits.push({ ...attribution.commons, license: t('services.licensePerImage') });
          } catch (cause) { if (cause.name === 'AbortError') throw cause; }
        }
        const searchName = label ?? (pick('labels') || plain(osmTags?.name, 200));
        if (!photos.length && searchName && searchName.length >= 3) {
          try {
            const url = new URL('https://api.openverse.org/v1/images/'); url.search = new URLSearchParams({ q: searchName, license_type: 'commercial', page_size: 3 });
            const { data } = await ctx.json(url.href, { provider: 'openverse', ...request });
            photos = (Array.isArray(data?.results) ? data.results : []).slice(0, 3).flatMap(item => {
              const image = httpURL(item.url), source = httpURL(item.foreign_landing_url), licenseURL = httpURL(item.license_url);
              return image && source && licenseURL && /^(cc0|pdm|by|by-sa)$/i.test(item.license) ? [{ id: String(item.id).slice(0, 100), provider: 'openverse', url: image, thumbnail: httpURL(item.thumbnail) ?? image, title: plain(String(item.title ?? ''), 300), author: plain(String(item.creator ?? ''), 300), authorURL: httpURL(item.creator_url), source, license: String(item.license).toUpperCase(), licenseURL }] : [];
            });
            if (photos.length) credits.push({ ...attribution.openverse, license: t('services.licensePerImage') });
          } catch (cause) { if (cause.name === 'AbortError') throw cause; }
        }
        const hours = await parseOpeningHours(osmTags?.opening_hours);
        const facts = osmFacts(osmTags);
        if (osmTags && (hours || facts.length || descriptionSource === 'osm')) credits.push(attribution.osm);
        // A failed lookup is cached briefly so the full answer replaces it soon.
        return { data: { wikidata: qid, name: pick('labels') || plain(osmTags?.name, 200) || null, description, descriptionSource, summaries, photos, hours, facts }, attribution: credits, ...(partial ? { ttl: HOUR } : {}) };
      } }, { ttl: 30 * DAY, signal: opts.signal, cacheVariant: cfg => Boolean(ref && !given && cfg.geoWorker) }).then(async result => {
        if (!result?.data?.hours) return result;
        const valid = value => { try { return typeof value === 'string' && value.length <= 64 && Boolean(new Intl.DateTimeFormat('en', { timeZone: value })); } catch { return false; } };
        let zone = valid(tz) ? tz : null;
        if (!zone && lat != null && timezone) { try { zone = await timezone.zoneAt(lat, lng); } catch { zone = null; } }
        result.data.timeZone = zone;
        result.data.hours.open = openingStatus(result.data.hours, { timeZone: zone, now: ctx.now() }).open;
        return result;
      });
    },
  };
}
export { openingStatus };
