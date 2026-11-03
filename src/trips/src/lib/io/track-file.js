// Track geometry files: a gzipped GeoJSON Feature stored as a trip `file` with `kind: 'track'`.
import { gzipSync, gunzipSync, strFromU8, strToU8 } from 'fflate';
import { IoError } from './errors.js';
import { IO_LIMITS } from './limits.js';
import { cleanPosition, segmentsOf } from './geo.js';
import { cleanLine, slug } from './text.js';

export const TRACK_MIME = 'application/gzip';

/** The stored file name; the worker accepts only `*.geojson.gz` for tracks. */
export const trackFileName = (name) => `${slug(name, 'track')}.geojson.gz`;

/** GeoJSON Feature for a parsed track: geometry plus `{name, source, start, end, km}`. */
export function trackFeature(track) {
  const properties = { name: track.name, source: track.source ?? 'line', start: track.start, end: track.end, km: track.km };
  return { type: 'Feature', properties, geometry: track.geometry };
}

export function encodeTrack(feature) {
  return gzipSync(strToU8(JSON.stringify(feature)), { level: 6, mtime: 0 });
}

/** Validates a stored or embedded track Feature; returns a clean copy or null. */
export function cleanTrackFeature(value) {
  if (!value || typeof value !== 'object' || value.type !== 'Feature' || !value.geometry) return null;
  const type = value.geometry.type;
  if (!['LineString', 'MultiLineString'].includes(type)) return null;
  const segments = segmentsOf(value.geometry);
  if (!Array.isArray(segments) || segments.length > 1000) return null;
  let total = 0;
  const clean = [];
  for (const segment of segments) {
    if (!Array.isArray(segment)) return null;
    const points = segment.map(cleanPosition).filter(Boolean);
    total += points.length;
    if (total > IO_LIMITS.trackPoints * 2) return null;
    if (points.length >= 2) clean.push(points);
  }
  if (!clean.length) return null;
  const p = value.properties && typeof value.properties === 'object' ? value.properties : {};
  const km = Number.isFinite(p.km) && p.km >= 0 && p.km <= 100_000 ? p.km : undefined;
  const properties = { name: cleanLine(p.name), source: ['trk', 'rte', 'line'].includes(p.source) ? p.source : 'line',
    start: clean[0][0].slice(0, 2), end: clean.at(-1).at(-1).slice(0, 2), ...(km !== undefined ? { km } : {}) };
  return { type: 'Feature', properties, geometry: clean.length === 1 ? { type: 'LineString', coordinates: clean[0] } : { type: 'MultiLineString', coordinates: clean } };
}

/** Reads a downloaded track file; throws `invalid_track` for anything that is not a sane gzipped Feature. */
export function decodeTrack(input) {
  const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : null;
  if (!bytes || bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new IoError('invalid_track');
  const size = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true);
  if (size > IO_LIMITS.trackBytes * 4) throw new IoError('invalid_track');
  let feature;
  try { feature = cleanTrackFeature(JSON.parse(strFromU8(gunzipSync(bytes)))); } catch { throw new IoError('invalid_track'); }
  if (!feature) throw new IoError('invalid_track');
  return feature;
}

/** Downloads and decodes a trip's track file. */
export async function downloadTrack(ref, fileId, { api, signal } = {}) {
  if (!api) throw new IoError('session_unavailable');
  const blob = await api.download(ref, fileId, { signal });
  return decodeTrack(new Uint8Array(await blob.arrayBuffer()));
}
