// Trip → GPX, KML and KMZ. Places become waypoints (category in `<sym>`), days become routes, track places tracks.
import GeoJsonToGpx from '@dwayneparton/geojson-to-gpx';
import { strToU8, zipSync } from 'fflate';
import { createTripModel } from '../route-plan/model.js';
import { buildTimeline } from '../timeline/index.js';
import { escapeXml } from './xml.js';
import { segmentsOf } from './geo.js';
import { symbolFor } from './symbols.js';

export const GEO_SCOPES = Object.freeze(['all', 'places', 'days']);
const GPX_NS = 'http://www.topografix.com/GPX/1/1';
const STYLE_NS = 'http://www.topografix.com/GPX/gpx_style/0/2';
const located = (value) => Number.isFinite(value?.lat) && Number.isFinite(value?.lng);
const hex = (value) => (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value) ? value.toLowerCase() : null);

/**
 * Collects what a geo export contains. `trip`: `{places, days, visits, reservations, notes}` from the replica;
 * `tracks`: Map fileId → Feature (missing ones fall back to a waypoint); `category(place)` → `{id, name}`;
 * `dayName(entry)` → route name, where `entry` is a timeline day.
 * Returns `{waypoints: [{name, lat, lng, desc?, cmt?, sym?, type?, web?, category?}], routes: [{name, points}], tracks: [{name, desc?, color?, segments}]}`.
 */
export function tripGeo(trip, { scope = 'all', tracks = new Map(), category = () => null, dayName = (entry) => `Day ${entry.number}` } = {}) {
  const waypoints = [];
  const lines = [];
  const routes = [];
  if (scope !== 'days') {
    for (const place of trip.places ?? []) {
      if (!located(place)) continue;
      const feature = place.track?.fileId ? tracks.get(place.track.fileId) : null;
      if (scope === 'all' && feature) {
        const item = { name: place.name, segments: segmentsOf(feature.geometry) };
        if (place.desc) item.desc = place.desc;
        if (place.track.color !== undefined) item.color = place.track.color;
        lines.push(item);
        continue;
      }
      const cat = category(place);
      const item = { name: place.name, lat: place.lat, lng: place.lng };
      if (place.desc || place.notes) item.desc = place.desc || place.notes;
      if (place.address) item.cmt = place.address;
      if (place.web) item.web = place.web;
      const sym = symbolFor(cat?.id, cat?.name);
      if (sym) item.sym = sym;
      if (cat?.name) { item.type = cat.name; item.category = cat.name; }
      if (cat?.color !== undefined) item.color = cat.color;
      waypoints.push(item);
    }
  }
  if (scope !== 'places') {
    const days = trip.days ?? [];
    const timeline = buildTimeline({ days, visits: trip.visits ?? [], notes: trip.notes ?? [], reservations: trip.reservations ?? [] });
    const order = (dayId) => {
      const seen = new Set();
      return (timeline.byDay.get(dayId)?.rows ?? []).filter((row) => row.primary && row.kind !== 'note' && !seen.has(`${row.kind}:${row.id}`) && seen.add(`${row.kind}:${row.id}`))
        .map((row) => ({ t: row.kind, id: row.id }));
    };
    const model = createTripModel({ days, visits: trip.visits ?? [], places: trip.places ?? [], reservations: trip.reservations ?? [], timeline: order });
    for (const entry of timeline.days) {
      const stops = model.dayStops(entry.day.id);
      if (!stops) continue;
      const points = [];
      const add = (name, point) => {
        if (!point) return;
        const [lng, lat] = point;
        const last = points.at(-1);
        if (last && last.lat === lat && last.lng === lng) return;
        points.push({ name: name || '', lat, lng });
      };
      if (stops.start) add(stops.start.res.title, stops.start.point);
      for (const item of stops.items) {
        const name = item.t === 'visit' ? (item.entity.placeId ? model.place(item.entity.placeId)?.name : item.entity.title) : item.entity.title;
        if (item.kind === 'transport') { add(name, item.from); add(name, item.to); } else add(name, item.point);
      }
      if (stops.end) add(stops.end.res.title, stops.end.point);
      if (points.length) routes.push({ name: dayName(entry), points });
    }
  }
  return { waypoints, routes, tracks: lines };
}

function insertBefore(parent, node, later) {
  const next = [...parent.childNodes].find((child) => later.includes(child.localName));
  if (next) parent.insertBefore(node, next); else parent.append(node);
}
function child(doc, parent, name, text, later = []) {
  if (text === undefined || text === null || text === '') return;
  const node = doc.createElementNS(GPX_NS, name);
  node.append(doc.createTextNode(String(text)));
  insertBefore(parent, node, later);
}
const WPT_AFTER = { cmt: ['desc', 'src', 'link', 'sym', 'type', 'extensions'], link: ['sym', 'type', 'extensions'], sym: ['type', 'extensions'] };

/**
 * GPX 1.1 text. `resolveColor(stored)` turns a stored track color into `#rrggbb` (or null). Waypoints and tracks go
 * through @dwayneparton/geojson-to-gpx; `<cmt>`, `<link>`, `<sym>`, routes and track colors are added after.
 */
export function toGpx(geo, { name = '', desc, resolveColor = hex, implementation = globalThis.document?.implementation } = {}) {
  const features = [
    ...geo.waypoints.map((item) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [item.lng, item.lat] }, properties: { name: item.name, ...(item.desc ? { desc: item.desc } : {}), ...(item.type ? { type: item.type } : {}) } })),
    ...geo.tracks.map((item) => ({ type: 'Feature', geometry: item.segments.length === 1 ? { type: 'LineString', coordinates: item.segments[0] } : { type: 'MultiLineString', coordinates: item.segments },
      properties: { name: item.name, ...(item.desc ? { desc: item.desc } : {}) } })),
  ];
  const doc = GeoJsonToGpx({ type: 'FeatureCollection', features }, { creator: 'Trips', metadata: { name: name || undefined, desc: desc || undefined } }, implementation);
  const root = doc.documentElement;
  const wpts = [...root.childNodes].filter((node) => node.localName === 'wpt');
  wpts.forEach((node, index) => {
    const item = geo.waypoints[index];
    child(doc, node, 'cmt', item.cmt, WPT_AFTER.cmt);
    if (item.web) {
      const link = doc.createElementNS(GPX_NS, 'link');
      link.setAttribute('href', item.web);
      insertBefore(node, link, WPT_AFTER.link);
    }
    child(doc, node, 'sym', item.sym, WPT_AFTER.sym);
  });
  const trks = [...root.childNodes].filter((node) => node.localName === 'trk');
  trks.forEach((node, index) => {
    const color = resolveColor(geo.tracks[index].color);
    if (!color) return;
    const extensions = doc.createElementNS(GPX_NS, 'extensions');
    const line = doc.createElementNS(STYLE_NS, 'line');
    const value = doc.createElementNS(STYLE_NS, 'color');
    value.append(doc.createTextNode(color.slice(1).toUpperCase()));
    line.append(value); extensions.append(line);
    insertBefore(node, extensions, ['trkseg']);
  });
  for (const route of geo.routes) {
    const rte = doc.createElementNS(GPX_NS, 'rte');
    child(doc, rte, 'name', route.name);
    for (const point of route.points) {
      const pt = doc.createElementNS(GPX_NS, 'rtept');
      pt.setAttribute('lat', String(point.lat));
      pt.setAttribute('lon', String(point.lng));
      child(doc, pt, 'name', point.name);
      rte.append(pt);
    }
    insertBefore(root, rte, ['trk', 'extensions']);
  }
  return new XMLSerializer().serializeToString(doc);
}

const kmlColor = (value) => (value ? `ff${value.slice(5, 7)}${value.slice(3, 5)}${value.slice(1, 3)}` : null);
const coordinate = (point) => `${point[0]},${point[1]}${point.length > 2 ? `,${point[2]}` : ''}`;

/** KML 2.2 text with Places, Days and Tracks folders; `labels` names the folders. */
export function toKml(geo, { name = '', desc, resolveColor = hex, labels = {} } = {}) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<kml xmlns="http://www.opengis.net/kml/2.2">', '<Document>'];
  const tag = (element, value) => (value === undefined || value === null || value === '' ? '' : `<${element}>${escapeXml(value)}</${element}>`);
  out.push(tag('name', name), tag('description', desc));
  const styles = new Map();
  const styleFor = (kind, color) => {
    const resolved = resolveColor(color);
    if (!resolved) return '';
    const id = `${kind}-${resolved.slice(1)}`;
    if (!styles.has(id)) {
      styles.set(id, kind === 'line'
        ? `<Style id="${id}"><LineStyle><color>${kmlColor(resolved)}</color><width>3</width></LineStyle></Style>`
        : `<Style id="${id}"><IconStyle><color>${kmlColor(resolved)}</color></IconStyle></Style>`);
    }
    return `<styleUrl>#${id}</styleUrl>`;
  };
  const body = [];
  if (geo.waypoints.length) {
    body.push('<Folder>', tag('name', labels.places ?? 'Places'));
    for (const item of geo.waypoints) {
      const data = item.category ? `<ExtendedData><Data name="category"><value>${escapeXml(item.category)}</value></Data></ExtendedData>` : '';
      body.push(`<Placemark>${tag('name', item.name)}${tag('address', item.cmt)}${tag('description', [item.desc, item.web].filter(Boolean).join('\n\n'))}${styleFor('icon', item.color)}${data}<Point><coordinates>${item.lng},${item.lat}</coordinates></Point></Placemark>`);
    }
    body.push('</Folder>');
  }
  if (geo.routes.length) {
    body.push('<Folder>', tag('name', labels.days ?? 'Days'));
    for (const route of geo.routes) {
      const coordinates = route.points.map((point) => `${point.lng},${point.lat}`).join(' ');
      const geometry = route.points.length > 1 ? `<LineString><tessellate>1</tessellate><coordinates>${coordinates}</coordinates></LineString>` : `<Point><coordinates>${coordinates}</coordinates></Point>`;
      body.push(`<Placemark>${tag('name', route.name)}${tag('description', route.points.map((point) => point.name).filter(Boolean).join(' → '))}${geometry}</Placemark>`);
    }
    body.push('</Folder>');
  }
  if (geo.tracks.length) {
    body.push('<Folder>', tag('name', labels.tracks ?? 'Tracks'));
    for (const item of geo.tracks) {
      const lines = item.segments.map((segment) => `<LineString><tessellate>1</tessellate><coordinates>${segment.map(coordinate).join(' ')}</coordinates></LineString>`);
      const geometry = lines.length === 1 ? lines[0] : `<MultiGeometry>${lines.join('')}</MultiGeometry>`;
      body.push(`<Placemark>${tag('name', item.name)}${tag('description', item.desc)}${styleFor('line', item.color)}${geometry}</Placemark>`);
    }
    body.push('</Folder>');
  }
  out.push(...styles.values(), ...body, '</Document>', '</kml>');
  return out.filter(Boolean).join('\n');
}

/** A KMZ archive (zip) holding `doc.kml`. */
export const toKmz = (kmlText) => zipSync({ 'doc.kml': [strToU8(kmlText), { level: 6 }] }, { mtime: new Date(1980, 0, 2) });
