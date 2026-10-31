import { DAY, HOUR, attribution, coordinate } from './core.js';
import { t } from '../lib/i18n/index.js';

const reading = value => Number.isFinite(value) && value !== -999 ? value : null;
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const CONDITIONS = Object.freeze(['clear', 'partly', 'cloudy', 'fog', 'drizzle', 'rain', 'sleet', 'snow', 'thunder']);
/** Maps a MET Norway symbol code to a provider-neutral condition. */
export function metCondition(symbol) {
  if (typeof symbol !== 'string') return null;
  const code = symbol.replace(/_(day|night|polartwilight)$/, '');
  if (code.includes('thunder')) return 'thunder';
  if (code.includes('sleet')) return 'sleet';
  if (code.includes('snow')) return 'snow';
  if (code.includes('rain')) return code.startsWith('light') && !code.includes('showers') ? 'drizzle' : 'rain';
  if (code === 'fog') return 'fog';
  if (code === 'cloudy') return 'cloudy';
  if (code === 'partlycloudy' || code === 'fair') return 'partly';
  if (code === 'clearsky') return 'clear';
  return null;
}
/** Maps a WMO weather code (Open-Meteo) to a provider-neutral condition. */
export function wmoCondition(code) {
  if (!Number.isInteger(code)) return null;
  if (code === 0) return 'clear';
  if (code <= 2) return 'partly';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return code >= 56 ? 'sleet' : 'drizzle';
  if ((code >= 61 && code <= 65) || (code >= 80 && code <= 82)) return 'rain';
  if (code === 66 || code === 67) return 'sleet';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'thunder';
  return null;
}
const severity = condition => CONDITIONS.indexOf(condition);
/** Groups forecast entries into local days: min/max °C, precipitation sum and the most common condition. */
export function dailySummary(entries, timeZone = 'UTC') {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Map();
  for (const entry of entries ?? []) {
    const date = format.format(new Date(entry.time));
    const day = days.get(date) ?? { date, minC: Infinity, maxC: -Infinity, precipitationMm: 0, counts: new Map() };
    day.minC = Math.min(day.minC, entry.temperatureC); day.maxC = Math.max(day.maxC, entry.temperatureC);
    if (entry.precipitationMm != null) day.precipitationMm += entry.precipitationMm;
    if (entry.condition) day.counts.set(entry.condition, (day.counts.get(entry.condition) ?? 0) + 1);
    days.set(date, day);
  }
  return [...days.values()].map(({ counts, ...day }) => ({
    ...day, precipitationMm: Math.round(day.precipitationMm * 10) / 10,
    condition: [...counts].sort((a, b) => b[1] - a[1] || severity(b[0]) - severity(a[0]))[0]?.[0] ?? null,
  }));
}
function metno(data) {
  if (!Array.isArray(data?.properties?.timeseries)) throw new Error('Invalid forecast');
  return data.properties.timeseries.slice(0, 250).flatMap(entry => {
    const details = entry.data?.instant?.details; const hourly = entry.data?.next_1_hours; const period = hourly ?? entry.data?.next_6_hours;
    if (!Number.isFinite(Date.parse(entry.time)) || !Number.isFinite(details?.air_temperature)) return [];
    const symbol = typeof period?.summary?.symbol_code === 'string' ? period.summary.symbol_code.slice(0, 100) : null;
    // The hourly probability is regional; the 6-hour one is global and bounds it.
    const probability = reading(period?.details?.probability_of_precipitation ?? entry.data?.next_6_hours?.details?.probability_of_precipitation);
    return [{ time: new Date(entry.time).toISOString(), temperatureC: details.air_temperature, windMps: reading(details.wind_speed), humidityPercent: reading(details.relative_humidity), precipitationMm: reading(period?.details?.precipitation_amount), precipitationProbability: probability, periodHours: hourly ? 1 : period ? 6 : null, symbol, condition: metCondition(symbol) }];
  });
}
function openMeteo(data) {
  const hourly = data?.hourly;
  if (!Array.isArray(hourly?.time) || !Array.isArray(hourly.temperature_2m)) throw new Error('Invalid forecast');
  return hourly.time.slice(0, 400).flatMap((time, i) => {
    const at = Date.parse(typeof time === 'string' ? time + (time.endsWith('Z') ? '' : 'Z') : '');
    const temperature = hourly.temperature_2m[i];
    if (!Number.isFinite(at) || !Number.isFinite(temperature)) return [];
    const code = hourly.weather_code?.[i];
    return [{ time: new Date(at).toISOString(), temperatureC: temperature, windMps: reading(hourly.wind_speed_10m?.[i]), humidityPercent: reading(hourly.relative_humidity_2m?.[i]), precipitationMm: reading(hourly.precipitation?.[i]), precipitationProbability: reading(hourly.precipitation_probability?.[i]), periodHours: 1, symbol: null, condition: wmoCondition(code) }];
  });
}
const average = values => { const valid = values.filter(Number.isFinite); return valid.length ? Math.round(valid.reduce((a, b) => a + b, 0) / valid.length * 10) / 10 : null; };

/** Provider switch per services.md D3: `weather` and `normals` provider lists in config.json. */
export function createWeather(ctx) {
  return {
    forecast(lat, lng, opts = {}) {
      coordinate(lat, lng); lat = Number(lat.toFixed(4)); lng = Number(lng.toFixed(4));
      return ctx.run('weather', { lat, lng }, {
        metno: async (_cfg, request = {}) => {
          const url = new URL('https://api.met.no/weatherapi/locationforecast/2.0/complete'); url.search = new URLSearchParams({ lat, lon: lng });
          const { data, headers } = await ctx.json(url.href, { provider: 'metno', ...request });
          const entries = metno(data); if (!entries.length) throw new Error('Empty forecast');
          const expires = Date.parse(headers.get('expires'));
          return { data: { entries, updatedAt: data.properties.meta?.updated_at ?? null }, attribution: [attribution.metno], ttl: Number.isFinite(expires) ? Math.max(0, Math.min(DAY, expires - ctx.now())) : HOUR };
        },
        openmeteo: async (_cfg, request = {}) => {
          const url = new URL('https://api.open-meteo.com/v1/forecast');
          url.search = new URLSearchParams({ latitude: lat, longitude: lng, hourly: 'temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,weather_code,wind_speed_10m', wind_speed_unit: 'ms', timezone: 'GMT', forecast_days: 10 });
          const { data } = await ctx.json(url.href, { provider: 'openmeteo', ...request });
          const entries = openMeteo(data); if (!entries.length) throw new Error('Empty forecast');
          return { data: { entries, updatedAt: null }, attribution: [attribution.openmeteo] };
        },
      }, { ttl: HOUR, signal: opts.signal });
    },
    normals(lat, lng, month, opts = {}) {
      coordinate(lat, lng); if (!Number.isInteger(month) || month < 1 || month > 12) throw new RangeError('Invalid month');
      lat = Math.round(lat * 2) / 2; lng = Math.round(lng * 2) / 2;
      return ctx.run('normals', { lat, lng, month }, {
        nasa: async (_cfg, request = {}) => {
          const url = new URL('https://power.larc.nasa.gov/api/temporal/climatology/point'); url.search = new URLSearchParams({ parameters: 'T2M,T2M_MAX,T2M_MIN,PRECTOTCORR', community: 'RE', latitude: lat, longitude: lng, format: 'JSON' });
          const { data } = await ctx.json(url.href, { provider: 'nasa', ...request }); const values = data?.properties?.parameter; const key = MONTHS[month - 1];
          const temperatureC = reading(values?.T2M?.[key]); if (temperatureC === null) throw new Error('Invalid climatology');
          return { data: { month, lat, lng, temperatureC, highC: reading(values?.T2M_MAX?.[key]), lowC: reading(values?.T2M_MIN?.[key]), precipitationMmDay: reading(values?.PRECTOTCORR?.[key]) }, attribution: [{ text: 'NASA POWER', url: 'https://power.larc.nasa.gov/', license: t('services.publicDomain') }] };
        },
        openmeteo: async (_cfg, request = {}) => {
          const last = new Date(ctx.now()).getUTCFullYear() - 1;
          const url = new URL('https://archive-api.open-meteo.com/v1/archive');
          url.search = new URLSearchParams({ latitude: lat, longitude: lng, start_date: `${last - 9}-01-01`, end_date: `${last}-12-31`, daily: 'temperature_2m_mean,temperature_2m_max,temperature_2m_min,precipitation_sum', timezone: 'GMT' });
          const { data } = await ctx.json(url.href, { provider: 'openmeteo', ...request }); const daily = data?.daily;
          if (!Array.isArray(daily?.time)) throw new Error('Invalid climatology');
          const rows = daily.time.flatMap((date, i) => typeof date === 'string' && Number(date.slice(5, 7)) === month ? [i] : []);
          const pick = name => rows.map(i => daily[name]?.[i]);
          const temperatureC = average(pick('temperature_2m_mean')); if (temperatureC === null) throw new Error('Invalid climatology');
          return { data: { month, lat, lng, temperatureC, highC: average(pick('temperature_2m_max')), lowC: average(pick('temperature_2m_min')), precipitationMmDay: average(pick('precipitation_sum')) }, attribution: [attribution.openmeteo] };
        },
      }, { ttl: 365 * DAY, signal: opts.signal });
    },
  };
}
