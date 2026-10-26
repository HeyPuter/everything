import { DAY, country, text, year } from './core.js';
import { validDate } from './fx.js';
import { t } from '../lib/i18n/index.js';

const SUBDIVISION = /^[A-Z]{2}-[A-Z0-9]{1,6}(?:-[A-Z0-9]{1,6})?$/;
const regionList = (values, code) => Array.isArray(values) ? [...new Set(values.filter(value => typeof value === 'string' && SUBDIVISION.test(value) && value.startsWith(`${code}-`)))].slice(0, 100) : [];
const languageCode = lang => { const value = (lang ?? 'en').split('-')[0]; if (!/^[a-zA-Z]{2}$/.test(value)) throw new RangeError('Invalid language'); return value.toUpperCase(); };
const localized = (names, language) => {
  if (!Array.isArray(names)) return '';
  const pick = names.find(n => n?.language === language) ?? names.find(n => n?.language === 'EN') ?? names[0];
  return typeof pick?.text === 'string' ? pick.text.slice(0, 300) : '';
};
const openHolidaysCredit = { text: 'OpenHolidays API', url: 'https://www.openholidaysapi.org/', license: 'ODbL' };

function normalizeHolidays(data, { code, dateYear, region, version }) {
  if (!Array.isArray(data) || data.length > 5000) throw new Error('Invalid holiday response');
  const days = []; let validRows = 0;
  for (const day of data) {
    if (!day || typeof day !== 'object' || !validDate(day.date)
      || typeof day.name !== 'string' || !day.name.trim() || (day.countryCode != null && day.countryCode !== code)) continue;
    if (version === 4 && (!day.date.startsWith(`${dateYear}-`) || day.countryCode !== code
      || typeof day.nationalHoliday !== 'boolean' || (day.subdivisionCodes != null && !Array.isArray(day.subdivisionCodes)))) continue;
    const global = version === 4 ? day.nationalHoliday === true : day.global === true;
    const subdivisions = version === 4 ? day.subdivisionCodes : day.counties;
    const types = version === 4 ? day.holidayTypes : day.types;
    if (version === 4 && (!Array.isArray(types) || !types.length || !types.every(value => ['Public', 'Bank', 'School', 'Authorities', 'Optional', 'Observance'].includes(value)))) continue;
    validRows++;
    if (version === 4 && !types.includes('Public')) continue;
    const regions = regionList(subdivisions, code);
    if (region && !global && !regions.includes(region)) continue;
    days.push({ date: day.date, name: day.name.slice(0, 300),
      localName: typeof day.localName === 'string' ? day.localName.slice(0, 300) : day.name.slice(0, 300), global, regions });
  }
  if (data.length && !validRows) throw new Error('Invalid holiday response');
  return days;
}
// OpenHolidays rows are date ranges; public holidays expand to one row per day within the year.
function openPublicHolidays(data, { code, dateYear, region, language }) {
  if (!Array.isArray(data) || data.length > 5000) throw new Error('Invalid holiday response');
  const days = [];
  for (const row of data) {
    if (!row || !validDate(row.startDate) || !validDate(row.endDate) || row.endDate < row.startDate) continue;
    const name = localized(row.name, language); if (!name.trim()) continue;
    const local = Array.isArray(row.name) ? row.name.find(n => n?.language && n.language !== 'EN' && typeof n.text === 'string')?.text?.slice(0, 300) : undefined;
    const global = row.nationwide === true;
    const regions = regionList(Array.isArray(row.subdivisions) ? row.subdivisions.map(item => item?.code) : [], code);
    if (region && !global && !regions.includes(region)) continue;
    for (let at = Date.parse(row.startDate + 'T00:00:00Z'), end = Date.parse(row.endDate + 'T00:00:00Z'), n = 0; at <= end && n < 31; at += DAY, n++) {
      const date = new Date(at).toISOString().slice(0, 10);
      if (date.startsWith(`${dateYear}-`)) days.push({ date, name, localName: local ?? name, global, regions });
    }
  }
  return days.sort((a, b) => a.date.localeCompare(b.date));
}

export function createHolidays(ctx) {
  return {
    /** Public holidays; `region` is an ISO 3166-2 code such as `DE-BY`. */
    public(code, dateYear, region, opts = {}) {
      country(code); year(dateYear); if (region !== undefined) text(region, 20);
      const language = languageCode(opts.lang);
      return ctx.run('publicHolidays', { code, year: dateYear, region, language }, {
        nager: async (cfg, request = {}) => {
          const version = cfg.nagerVersion === 3 ? 3 : 4;
          const url = version === 4 ? `https://nagerholidays.com/api/v4/Holidays/${code}/${dateYear}` : `https://date.nager.at/api/v3/PublicHolidays/${dateYear}/${code}`;
          const { data } = await ctx.json(url, { provider: 'nager', ...request });
          return { data: normalizeHolidays(data, { code, dateYear, region, version }),
            attribution: [{ text: 'Nager.Date', url: version === 4 ? 'https://nagerholidays.com/api' : 'https://date.nager.at/', license: t('services.providerTerms') }] };
        },
        openholidays: async (_cfg, request = {}) => {
          const url = new URL('https://openholidaysapi.org/PublicHolidays'); url.search = new URLSearchParams({ countryIsoCode: code, validFrom: `${dateYear}-01-01`, validTo: `${dateYear}-12-31` });
          const { data } = await ctx.json(url.href, { provider: 'openholidays', ...request });
          return { data: openPublicHolidays(data, { code, dateYear, region, language }), attribution: [openHolidaysCredit] };
        },
      }, { ttl: 365 * DAY, signal: opts.signal, cacheVariant: cfg => cfg.nagerVersion });
    },
    school(code, dateYear, subdivision, opts = {}) {
      country(code); year(dateYear); if (subdivision !== undefined) text(subdivision, 20);
      const language = languageCode(opts.lang);
      return ctx.run('schoolHolidays', { code, year: dateYear, subdivision, language }, { openholidays: async (_cfg, request = {}) => {
        const url = new URL('https://openholidaysapi.org/SchoolHolidays'); url.search = new URLSearchParams({ countryIsoCode: code, validFrom: `${dateYear}-01-01`, validTo: `${dateYear}-12-31`, ...(subdivision ? { subdivisionCode: subdivision } : {}) });
        const { data } = await ctx.json(url.href, { provider: 'openholidays', ...request }); if (!Array.isArray(data)) throw new Error('Invalid school holiday response');
        return { data: data.filter(day => validDate(day.startDate) && validDate(day.endDate) && day.endDate >= day.startDate && Array.isArray(day.name)).map(day => ({
          id: String(day.id ?? '').slice(0, 100), start: day.startDate, end: day.endDate, name: localized(day.name, language),
          regions: regionList(Array.isArray(day.subdivisions) ? day.subdivisions.map(item => item?.code) : [], code),
        })), attribution: [openHolidaysCredit] };
      } }, { ttl: 30 * DAY, signal: opts.signal });
    },
    /** Subdivisions with school or regional holiday data, for region pickers. */
    subdivisions(code, opts = {}) {
      country(code); const language = languageCode(opts.lang);
      return ctx.run('subdivisions', { code, language }, { openholidays: async (_cfg, request = {}) => {
        const url = new URL('https://openholidaysapi.org/Subdivisions'); url.search = new URLSearchParams({ countryIsoCode: code });
        const { data } = await ctx.json(url.href, { provider: 'openholidays', ...request }); if (!Array.isArray(data)) throw new Error('Invalid subdivision response');
        const rows = [];
        const visit = (items, depth) => { for (const item of items ?? []) { if (rows.length >= 500 || depth > 3) return; if (typeof item?.code === 'string' && SUBDIVISION.test(item.code) && item.code.startsWith(`${code}-`)) rows.push({ code: item.code, name: localized(item.name, language) || item.code }); visit(item?.children, depth + 1); } };
        visit(data, 0);
        return { data: rows, attribution: [openHolidaysCredit] };
      } }, { ttl: 30 * DAY, signal: opts.signal });
    },
  };
}
