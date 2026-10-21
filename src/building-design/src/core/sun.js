/**
 * Project location and the sun: where the sun is for a place, date and
 * time, as a direction in model coordinates (true north rotated by the
 * project's north angle).
 *
 *   project.location { name, lat, lon, utcOffset }   degrees, hours
 *   project.sun      { date: 'YYYY-MM-DD', time: 'HH:MM' }
 *   project.trueNorth  degrees, counterclockwise from the model's +Y axis
 */

export const DEFAULT_LOCATION = { name: 'San Francisco, CA', lat: 37.77, lon: -122.42, utcOffset: -8 };
export const DEFAULT_SUN = { date: '2026-06-21', time: '15:00' };

export const PLACES = [
  { name: 'San Francisco, CA', lat: 37.77, lon: -122.42, utcOffset: -8 },
  { name: 'New York, NY', lat: 40.71, lon: -74.01, utcOffset: -5 },
  { name: 'Chicago, IL', lat: 41.88, lon: -87.63, utcOffset: -6 },
  { name: 'Mexico City', lat: 19.43, lon: -99.13, utcOffset: -6 },
  { name: 'Sao Paulo', lat: -23.55, lon: -46.63, utcOffset: -3 },
  { name: 'London', lat: 51.51, lon: -0.13, utcOffset: 0 },
  { name: 'Paris', lat: 48.86, lon: 2.35, utcOffset: 1 },
  { name: 'Berlin', lat: 52.52, lon: 13.4, utcOffset: 1 },
  { name: 'Madrid', lat: 40.42, lon: -3.7, utcOffset: 1 },
  { name: 'Cairo', lat: 30.04, lon: 31.24, utcOffset: 2 },
  { name: 'Lagos', lat: 6.52, lon: 3.38, utcOffset: 1 },
  { name: 'Nairobi', lat: -1.29, lon: 36.82, utcOffset: 3 },
  { name: 'Dubai', lat: 25.2, lon: 55.27, utcOffset: 4 },
  { name: 'Mumbai', lat: 19.08, lon: 72.88, utcOffset: 5.5 },
  { name: 'Singapore', lat: 1.35, lon: 103.82, utcOffset: 8 },
  { name: 'Shanghai', lat: 31.23, lon: 121.47, utcOffset: 8 },
  { name: 'Tokyo', lat: 35.68, lon: 139.69, utcOffset: 9 },
  { name: 'Sydney', lat: -33.87, lon: 151.21, utcOffset: 10 },
  { name: 'Auckland', lat: -36.85, lon: 174.76, utcOffset: 12 },
];

const RAD = Math.PI / 180;

/**
 * Solar altitude and azimuth (degrees; azimuth clockwise from north) for a
 * location and local clock time. Accurate to a fraction of a degree, which
 * is plenty for shadow studies.
 */
export function solarPosition(location, date, time) {
  const [y, mo, d] = String(date).split('-').map(Number);
  const [hh, mm] = String(time).split(':').map(Number);
  const local = Date.UTC(y || 2026, (mo || 6) - 1, d || 21, hh || 0, mm || 0);
  const utc = local - (location.utcOffset || 0) * 3600e3;
  // Days since J2000.0.
  const n = utc / 86400e3 - 10957.5;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * n) % 24;
  const lst = (gmst * 15 + location.lon) * RAD;
  const ha = lst - ra;
  const lat = location.lat * RAD;
  const alt = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(ha));
  return { altitude: alt / RAD, azimuth: ((az / RAD) % 360 + 360) % 360 };
}

/** Unit vector towards the sun in model coordinates. */
export function sunDirection(project) {
  const loc = { ...DEFAULT_LOCATION, ...(project?.location || {}) };
  const sun = { ...DEFAULT_SUN, ...(project?.sun || {}) };
  const { altitude, azimuth } = solarPosition(loc, sun.date, sun.time);
  // East-north-up: azimuth is clockwise from north.
  const c = Math.cos(altitude * RAD);
  const x = Math.sin(azimuth * RAD) * c;
  const y = Math.cos(azimuth * RAD) * c;
  // True north is the model's +Y turned counterclockwise by the north angle.
  const n = (+project?.trueNorth || 0) * RAD;
  return { dir: [x * Math.cos(n) - y * Math.sin(n), x * Math.sin(n) + y * Math.cos(n), Math.sin(altitude * RAD)], altitude, azimuth };
}
