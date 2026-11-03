// GPX, KML and KMZ files → waypoints and tracks ready for import planning.
import { gpx, kml } from '@tmcw/togeojson';
import { unzipSync } from 'fflate';
import { IoError } from './errors.js';
import { IO_LIMITS } from './limits.js';
import { parseXml } from './xml.js';
import { cleanPosition, lengthKm, segmentsOf, simplifySegments } from './geo.js';
import { cleanLine, cleanText, htmlToText, webUrl } from './text.js';
import { trackColor } from './symbols.js';

export const GEO_ACCEPT = '.gpx,.kml,.kmz';

const extension = (name) => /\.([a-z0-9]{2,5})$/i.exec(String(name ?? ''))?.[1]?.toLowerCase() ?? '';
const isZip = (bytes) => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/** `gpx`, `kml` or `kmz` from the name, falling back to the content. */
export function detectFormat(name, bytes) {
  const ext = extension(name);
  if (['gpx', 'kml', 'kmz'].includes(ext)) return ext === 'kml' && isZip(bytes) ? 'kmz' : ext;
  if (isZip(bytes)) return 'kmz';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
  if (/<gpx[\s>]/.test(head)) return 'gpx';
  if (/<kml[\s>]/.test(head)) return 'kml';
  return null;
}

function decodeText(bytes) {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const label = /^\s*<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/.exec(head)?.[1];
  try { return new TextDecoder(label && !/^utf-?8$/i.test(label) ? label : 'utf-8').decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

function kmlFromKmz(bytes) {
  let files;
  try {
    files = unzipSync(bytes, { filter: (file) => /\.kml$/i.test(file.name) && !file.name.includes('..') && file.originalSize > 0 && file.originalSize <= IO_LIMITS.kmlBytes });
  } catch { throw new IoError('invalid_kmz'); }
  const names = Object.keys(files).sort((a, b) => (a.toLowerCase() === 'doc.kml' ? -1 : b.toLowerCase() === 'doc.kml' ? 1 : a.split('/').length - b.split('/').length || a.localeCompare(b)));
  if (!names.length) throw new IoError('invalid_kmz');
  return files[names[0]];
}

const text = (value) => (value && typeof value === 'object' ? htmlToText(value.value) : typeof value === 'string' ? value : '');

function describe(properties) {
  const parts = [text(properties.desc), text(properties.description), text(properties.cmt)].map((part) => cleanText(part, 20_000)).filter(Boolean);
  return cleanText([...new Set(parts)].join('\n\n'));
}

function linkOf(properties) {
  for (const link of Array.isArray(properties.links) ? properties.links : []) {
    const url = webUrl(link?.href);
    if (url) return url;
  }
  return undefined;
}

function waypoint(properties, coordinates, format) {
  const position = cleanPosition(coordinates);
  if (!position) return null;
  const item = { kind: 'waypoint', format, name: cleanLine(text(properties.name)), lat: position[1], lng: position[0] };
  const desc = describe(properties);
  if (desc) item.desc = desc;
  for (const field of ['sym', 'type', 'category']) { const value = cleanLine(text(properties[field]), 100); if (value) item[field] = value; }
  const web = linkOf(properties);
  if (web) item.web = web;
  const address = cleanLine(text(properties.address), 2000);
  if (address) item.address = address;
  const phone = cleanLine(text(properties.phoneNumber), 100);
  if (phone) item.phone = phone;
  return item;
}

/** A track from line segments, or null when fewer than two valid positions remain. */
export function makeTrack(properties, rawSegments, format, source) {
  const segments = rawSegments.map((segment) => (Array.isArray(segment) ? segment.map(cleanPosition).filter(Boolean) : [])).filter((segment) => segment.length >= 2);
  if (!segments.length) return null;
  const km = Math.round(lengthKm(segments) * 100) / 100;
  const thin = simplifySegments(segments, IO_LIMITS.trackPoints);
  const item = {
    kind: 'track', format, source, name: cleanLine(text(properties.name)), km,
    start: segments[0][0].slice(0, 2), end: segments.at(-1).at(-1).slice(0, 2),
    geometry: thin.length === 1 ? { type: 'LineString', coordinates: thin[0] } : { type: 'MultiLineString', coordinates: thin },
    points: thin.reduce((sum, segment) => sum + segment.length, 0),
  };
  const desc = describe(properties);
  if (desc) item.desc = desc;
  const color = trackColor(properties.stroke) ?? trackColor(text(properties.gpxx_DisplayColor));
  if (color !== undefined) item.color = color;
  const web = linkOf(properties);
  if (web) item.web = web;
  return item;
}

function flatten(geometry, out = { points: [], lines: [], shapes: 0 }) {
  if (!geometry) return out;
  switch (geometry.type) {
    case 'Point': out.points.push(geometry.coordinates); break;
    case 'MultiPoint': out.points.push(...geometry.coordinates); break;
    case 'LineString': out.lines.push(geometry.coordinates); break;
    case 'MultiLineString': out.lines.push(...geometry.coordinates); break;
    case 'GeometryCollection': for (const part of geometry.geometries ?? []) flatten(part, out); break;
    default: out.shapes += 1;
  }
  return out;
}

/** GeoJSON features from togeojson → `{items, skipped: {empty, shapes, invalid, over}}`. */
export function normalizeFeatures(features, format) {
  const items = [];
  const skipped = { empty: 0, shapes: 0, invalid: 0, over: 0 };
  let tracks = 0;
  for (const feature of features) {
    const properties = feature?.properties && typeof feature.properties === 'object' ? feature.properties : {};
    if (!feature?.geometry) { skipped.empty += 1; continue; }
    const { points, lines, shapes } = flatten(feature.geometry);
    skipped.shapes += shapes;
    const source = properties._gpxType === 'rte' ? 'rte' : properties._gpxType === 'trk' ? 'trk' : 'line';
    const found = [];
    if (lines.length) {
      const track = makeTrack(properties, lines, format, source);
      if (track) found.push(track); else skipped.invalid += 1;
    }
    for (const position of points) {
      const item = waypoint(properties, position, format);
      if (item) found.push(item); else skipped.invalid += 1;
    }
    for (const item of found) {
      if (items.length >= IO_LIMITS.features || (item.kind === 'track' && tracks >= IO_LIMITS.tracks)) { skipped.over += 1; continue; }
      if (item.kind === 'track') tracks += 1;
      items.push(item);
    }
  }
  return { items, skipped };
}

/**
 * Reads a GPX, KML or KMZ file: `{name, bytes}` → `{format, items, skipped}`. Items are
 * `{kind: 'waypoint', name, lat, lng, desc?, sym?, type?, category?, web?, address?, phone?}` or
 * `{kind: 'track', name, km, start, end, geometry, points, source: trk|rte|line, desc?, color?, web?}`; names may be ''.
 */
export function readGeoFile({ name, bytes: input }) {
  if (!ArrayBuffer.isView(input) || !input.byteLength) throw new IoError('file_empty');
  const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length > IO_LIMITS.geoFileBytes) throw new IoError('file_too_large');
  let format = detectFormat(name, bytes);
  if (!format) throw new IoError('unsupported_format');
  const data = format === 'kmz' ? kmlFromKmz(bytes) : bytes;
  const doc = parseXml(decodeText(data));
  const root = doc.documentElement.localName;
  if (root === 'gpx') format = 'gpx';
  else if (root === 'kml') format = format === 'kmz' ? 'kmz' : 'kml';
  else throw new IoError('unsupported_format');
  let collection;
  try { collection = root === 'gpx' ? gpx(doc) : kml(doc); } catch { throw new IoError('invalid_xml'); }
  const result = normalizeFeatures(collection.features ?? [], format);
  if (!result.items.length) throw new IoError('no_features', { skipped: result.skipped });
  return { format, ...result };
}
