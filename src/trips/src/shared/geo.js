export const EARTH_RADIUS_M = 6371008.8; // mean radius

const rad = (degrees) => degrees * Math.PI / 180;

/** Great-circle (haversine) distance in metres between two latitude/longitude pairs in degrees. */
export function haversine(lat1, lng1, lat2, lng2) {
  const h = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

/** Metres between `{lat, lng}` points. */
export const distanceMeters = (a, b) => haversine(a.lat, a.lng, b.lat, b.lng);

/** Metres between GeoJSON `[lng, lat]` positions. */
export const lngLatMeters = (a, b) => haversine(a[1], a[0], b[1], b[0]);
