import { DAY, attribution, httpURL, plainText, text } from './core.js';
import { t } from '../lib/i18n/index.js';

const plain = (value, max = 300) => plainText(value, max);
const REFERRAL = 'utm_source=puter_trips&utm_medium=referral';
const withReferral = value => { const url = httpURL(value); if (!url) return null; const next = new URL(url); for (const pair of REFERRAL.split('&')) next.searchParams.set(...pair.split('=')); return next.href; };
// Commons licenses usable commercially with credit; NC/ND are excluded.
const COMMONS_LICENSE = /^(?:cc0(?:\s*1\.0)?|public domain|pd(?:[- ].*)?|cc[- ]by(?:[- ]sa)?(?:[- ]\d\.\d)?(?:[- ][a-z]{2,})?)$/i;

const none = photos => (photos.length ? {} : { empty: true });
/** Commons file pages to photo credits; shared with placeInfo. */
export function commonsPhotos(pages, limit = 12) {
  return Object.values(pages ?? {}).slice(0, 50).flatMap(page => {
    const item = page?.imageinfo?.[0]; const metadata = item?.extmetadata;
    const url = httpURL(item?.thumburl ?? item?.url), source = httpURL(item?.descriptionurl), license = plain(metadata?.LicenseShortName?.value, 100);
    const licenseURL = httpURL(metadata?.LicenseUrl?.value); const author = plain(metadata?.Artist?.value);
    if (!url || !source || !COMMONS_LICENSE.test(license) || /\b(?:nc|nd)\b/i.test(license)) return [];
    const free = /^(?:cc0|public domain|pd)/i.test(license);
    if (!free && (!licenseURL || !author)) return [];
    return [{ id: String(page.pageid ?? source).slice(0, 100), provider: 'wikimedia', url, thumbnail: url, title: plain(page.title?.replace(/^File:/, ''), 300), author, authorURL: null, source, license, licenseURL }];
  }).slice(0, limit);
}

export function createImages(ctx) {
  return {
    /** Cover-image search with per-image credits; the user's own Unsplash key is tried first when present. */
    search(query, opts = {}) {
      const q = text(query); if (q.length < 3) return Promise.resolve(null);
      return ctx.key('unsplash').then(key => ctx.run('images', { q, keyed: Boolean(key) }, {
        unsplash: async (_cfg, request = {}) => {
          const key = await ctx.key('unsplash'); if (!key) return null;
          const url = new URL('https://api.unsplash.com/search/photos'); url.search = new URLSearchParams({ query: q, per_page: 12, orientation: 'landscape', content_filter: 'high' });
          const { data } = await ctx.json(url.href, { provider: 'unsplash', headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' }, ...request });
          if (!Array.isArray(data?.results)) throw new Error('Invalid image response');
          const photos = data.results.slice(0, 24).flatMap(item => {
            const image = httpURL(item?.urls?.regular), thumbnail = httpURL(item?.urls?.small) ?? image, source = withReferral(item?.links?.html);
            const download = httpURL(item?.links?.download_location);
            if (!image || !source || !item.user?.name) return [];
            return [{ id: String(item.id).slice(0, 100), provider: 'unsplash', url: image, thumbnail, title: plain(item.alt_description ?? item.description ?? ''), author: plain(item.user.name), authorURL: withReferral(item.user.links?.html), source, license: 'Unsplash License', licenseURL: attribution.unsplash.licenseURL, ...(download && new URL(download).hostname === 'api.unsplash.com' ? { downloadLocation: download } : {}) }];
          });
          return { data: photos, attribution: [{ text: attribution.unsplash.text, url: attribution.unsplash.url }], ...none(photos) };
        },
        openverse: async (_cfg, request = {}) => {
          const url = new URL('https://api.openverse.org/v1/images/'); url.search = new URLSearchParams({ q, license_type: 'commercial', page_size: 12 });
          const { data } = await ctx.json(url.href, { provider: 'openverse', ...request }); if (!Array.isArray(data?.results)) throw new Error('Invalid image response');
          const photos = data.results.slice(0, 24).flatMap(item => {
            const image = httpURL(item.url), source = httpURL(item.foreign_landing_url), licenseURL = httpURL(item.license_url);
            if (!image || !source || !licenseURL || !/^(cc0|pdm|by|by-sa)$/i.test(item.license)) return [];
            return [{ id: String(item.id).slice(0, 100), provider: 'openverse', url: image, thumbnail: httpURL(item.thumbnail) ?? image, title: plain(String(item.title ?? '')), author: plain(String(item.creator ?? '')), authorURL: httpURL(item.creator_url), source, license: String(item.license).toUpperCase(), licenseURL }];
          });
          return { data: photos, attribution: [{ ...attribution.openverse, license: t('services.licensePerImage') }], ...none(photos) };
        },
        wikimedia: async (_cfg, request = {}) => {
          const url = new URL('https://commons.wikimedia.org/w/api.php');
          url.search = new URLSearchParams({ action: 'query', format: 'json', origin: '*', generator: 'search', gsrsearch: `${q} filetype:bitmap`, gsrnamespace: 6, gsrlimit: 20, prop: 'imageinfo', iiprop: 'url|extmetadata', iiurlwidth: 1280, iiextmetadatafilter: 'Artist|LicenseShortName|LicenseUrl' });
          const { data } = await ctx.json(url.href, { provider: 'wikimedia', interval: 250, headers: { 'Api-User-Agent': 'PuterTrips/1.0 (https://trips.puter.com)' }, ...request });
          if (data?.query != null && typeof data.query !== 'object') throw new Error('Invalid image response');
          const photos = commonsPhotos(data?.query?.pages);
          return { data: photos, attribution: [{ ...attribution.commons, license: t('services.licensePerImage') }], ...none(photos) };
        },
      }, { ttl: DAY, signal: opts.signal }));
    },
    /** Unsplash requires a download ping when a photo is chosen; other providers need nothing. */
    async markUsed(photo, opts = {}) {
      if (photo?.provider !== 'unsplash' || !photo.downloadLocation) return false;
      const location = httpURL(photo.downloadLocation); const key = await ctx.key('unsplash');
      if (!location || new URL(location).hostname !== 'api.unsplash.com' || !key) return false;
      try { await ctx.json(location, { provider: 'unsplash', headers: { Authorization: `Client-ID ${key}`, 'Accept-Version': 'v1' }, retries: 0, signal: opts.signal }); return true; }
      catch (cause) { if (cause.name === 'AbortError') throw cause; return false; }
    },
  };
}
