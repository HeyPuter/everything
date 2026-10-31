import { isDate, isTimeZone, zonedParts } from '../../../../shared/dates.js';

const RAD = Math.PI / 180;
const DAY = 86_400_000;
const J2000 = 2451545;
const julian = (epoch) => epoch / DAY + 2440587.5;
const epochOf = (jd) => Math.round((jd - 2440587.5) * DAY);

// Sunrise equation: mean solar noon, solar anomaly, equation of center, declination, hour angle at -0.833°.
function solve(n, lat, lng) {
  const mean = n - lng / 360;
  const anomaly = (357.5291 + 0.98560028 * mean) % 360;
  const m = anomaly * RAD;
  const center = 1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m);
  const longitude = ((anomaly + center + 180 + 102.9372) % 360) * RAD;
  const transit = J2000 + mean + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * longitude);
  const declination = Math.asin(Math.sin(longitude) * Math.sin(23.4397 * RAD));
  const cosHour = (Math.sin(-0.833 * RAD) - Math.sin(lat * RAD) * Math.sin(declination)) / (Math.cos(lat * RAD) * Math.cos(declination));
  return { transit, cosHour };
}

/**
 * Sunrise and sunset on a local date at a place: `{rise, set}` as epoch ms, or `{polar: 'day'|'night'}`.
 * Accurate to a minute or two away from the poles; `zone` picks the solar noon that falls on `date` there.
 */
export function sunTimes(date, lat, lng, zone = 'UTC') {
  if (!isDate(date) || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const tz = isTimeZone(zone) ? zone : 'UTC';
  const noon = julian(Date.parse(`${date}T12:00:00Z`));
  let n = Math.round(noon - J2000);
  let result = solve(n, lat, lng);
  const local = zonedParts(epochOf(result.transit), tz).date;
  if (local !== date) { n += local < date ? 1 : -1; result = solve(n, lat, lng); }
  if (result.cosHour < -1) return { polar: 'day' };
  if (result.cosHour > 1) return { polar: 'night' };
  const half = Math.acos(result.cosHour) / RAD / 360;
  return { rise: epochOf(result.transit - half), set: epochOf(result.transit + half) };
}
