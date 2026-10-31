// Collection logic without DOM: filters, copies between trips and collections, and JSON/GPX import and export.
import { validateEntity } from '../../shared/schema/index.js';
import { orderBetween, orderKeys } from '../../shared/order.js';
import { isId } from '../../shared/ids.js';
import { distanceMeters } from '../../shared/geo.js';

export const STATUSES = Object.freeze(['idea', 'want', 'visited', 'revisit']);
/** Map tones per status (src/map TONES). */
export const STATUS_TONES = Object.freeze({ idea: 'day-6', want: 'accent', visited: 'success', revisit: 'warn' });
export const SORTS = Object.freeze(['order', 'name', 'recent', 'rating']);
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_PLACES = 5000;
export const JSON_FORMAT = 'trips-collection';

const PLACE_FIELDS = ['name', 'desc', 'notes', 'address', 'lat', 'lng', 'tz', 'cc', 'admin1', 'price', 'web', 'phone', 'ids'];
const has = (value) => value !== undefined && value !== null && value !== '';
const clone = (value) => structuredClone(value);
const located = (item) => Number.isFinite(item?.lat) && Number.isFinite(item?.lng);

/** Lower-case, accent-free, single-spaced text for matching and search. */
export function fold(text) {
  return String(text ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

/** Same real-world place: a shared OSM or Wikidata id, or the same name within 100 m (or the same name and address). */
export function samePlace(a, b) {
  if (!a || !b) return false;
  for (const key of ['osm', 'wikidata', 'google']) if (a.ids?.[key] && a.ids[key] === b.ids?.[key]) return true;
  if (fold(a.name) !== fold(b.name) || !fold(a.name)) return false;
  if (located(a) && located(b)) return distanceMeters(a, b) <= 100;
  return !located(a) && !located(b) && fold(a.address) === fold(b.address);
}

export const averageRating = (item) => {
  const values = Object.values(item?.rating ?? {}).filter((value) => Number.isInteger(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
};
export const myTags = (item, uid) => (Array.isArray(item?.tags?.[uid]) ? item.tags[uid] : []);
export const isVisitedBy = (item, uid) => item?.visited?.[uid] === true;

/** Items matching every active filter. `cats` holds category ids, with `''` for none. */
export function filterSaved(items, { query = '', statuses = new Set(), cats = new Set(), labels = new Set(), uid = '' } = {}) {
  const words = fold(query).split(' ').filter(Boolean);
  return items.filter((item) => {
    if (statuses.size && !statuses.has(item.status)) return false;
    if (cats.size && !cats.has(item.cat ?? '')) return false;
    if (labels.size && !(item.labels ?? []).some((label) => labels.has(label))) return false;
    if (!words.length) return true;
    const text = fold([item.name, item.address, item.desc, item.notes, ...myTags(item, uid)].filter(Boolean).join(' '));
    return words.every((word) => text.includes(word));
  });
}

export function sortSaved(items, sort = 'order') {
  const list = [...items];
  if (sort === 'name') return list.sort((a, b) => fold(a.name).localeCompare(fold(b.name)));
  if (sort === 'recent') return list.sort((a, b) => (b.cr ?? 0) - (a.cr ?? 0));
  if (sort === 'rating') return list.sort((a, b) => averageRating(b) - averageRating(a) || fold(a.name).localeCompare(fold(b.name)));
  return list.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : (a.cr ?? 0) - (b.cr ?? 0)));
}

/** `count` order keys after the last item. */
export function appendOrders(items, count) {
  const last = items.reduce((max, item) => (typeof item.order === 'string' && (!max || item.order > max) ? item.order : max), null);
  return orderKeys(count, last, null);
}

/** Order key for moving `item` to `index` among `items` (sorted by order, item included). */
export function moveOrder(items, from, to) {
  const rest = items.filter((_, index) => index !== from);
  return orderBetween(rest[to - 1]?.order ?? null, rest[to]?.order ?? null);
}

const ownOnly = (map, uid) => (map && Object.hasOwn(map, uid) ? { [uid]: clone(map[uid]) } : undefined);
const imageOf = (img) => (img?.url ? clone(img) : undefined);

/** Shared place fields plus the caller's own rating, tags and visited flag. */
function common(source, { uid, cats = () => true }) {
  const fields = {};
  for (const key of PLACE_FIELDS) if (has(source[key])) fields[key] = clone(source[key]);
  if (!located(fields)) { delete fields.lat; delete fields.lng; delete fields.tz; }
  if (has(source.cat) && cats(source.cat)) fields.cat = source.cat;
  const img = imageOf(source.img);
  if (img) fields.img = img;
  for (const key of ['rating', 'tags', 'visited']) {
    const own = ownOnly(source[key], uid);
    if (own) fields[key] = own;
  }
  return fields;
}

/** Fields for a saved place copied from a trip place. Trip categories are not carried over (collections have none). */
export function fromPlace(place, { uid, trip, order, status, builtin = () => false }) {
  const fields = common(place, { uid, cats: builtin });
  fields.status = status ?? (isVisitedBy(place, uid) ? 'visited' : 'want');
  fields.order = order;
  if (trip?.k === 'trip' && isId(place.id)) fields.src = { trip: { w: trip.w, s: trip.s, k: 'trip' }, placeId: place.id };
  return fields;
}

/** Fields for a trip place copied from a saved place, with its photo link, the caller's tags and rating. */
export function toPlace(saved, { uid, builtin = () => true }) {
  const fields = common(saved, { uid, cats: builtin });
  if (saved.status === 'visited' && !fields.visited) fields.visited = { [uid]: true };
  fields.src = 'collection';
  return fields;
}

/** Fields for a copy in another collection. `labelIds` maps source label ids to target ids. */
export function copySaved(saved, { uid, order, labelIds = new Map() }) {
  const fields = common(saved, { uid });
  fields.status = STATUSES.includes(saved.status) ? saved.status : 'idea';
  fields.order = order;
  if (saved.src) fields.src = clone(saved.src);
  if (saved.links?.length) fields.links = clone(saved.links);
  const labels = (saved.labels ?? []).map((id) => labelIds.get(id)).filter(Boolean);
  if (labels.length) fields.labels = [...new Set(labels)];
  return fields;
}

// ---- JSON

/** Export without other members' per-user data. */
export function exportJson({ meta = {}, labels = [], saved = [], uid }) {
  const names = new Map(labels.map((label) => [label.id, label.name]));
  const out = {
    format: JSON_FORMAT, version: 1, name: meta.name ?? '',
    ...Object.fromEntries(['desc', 'color', 'icon', 'urls'].filter((key) => has(meta[key])).map((key) => [key, clone(meta[key])])),
    ...(typeof meta.cover === 'object' && meta.cover?.url ? { cover: clone(meta.cover) } : {}),
    labels: labels.map((label) => ({ name: label.name, ...(label.color !== undefined ? { color: label.color } : {}) })),
    places: [],
  };
  for (const item of saved) {
    const place = {};
    for (const key of [...PLACE_FIELDS, 'cat', 'status']) if (has(item[key])) place[key] = clone(item[key]);
    if (item.img?.url) place.img = clone(item.img);
    const own = item.labels?.map((id) => names.get(id)).filter(Boolean) ?? [];
    if (own.length) place.labels = own;
    if (Number.isInteger(item.rating?.[uid])) place.rating = item.rating[uid];
    if (myTags(item, uid).length) place.tags = [...myTags(item, uid)];
    if (isVisitedBy(item, uid)) place.visited = true;
    out.places.push(place);
  }
  return out;
}

const textValue = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/**
 * Reads a collection JSON file. Each place is checked against the saved-place schema (with placeholder order),
 * so only valid entries come back; `skipped` counts the rest.
 */
export function parseJson(text, { uid }) {
  let data;
  try { data = JSON.parse(text); } catch { throw Object.assign(new Error('import_unreadable'), { code: 'import_unreadable' }); }
  if (!data || typeof data !== 'object' || data.format !== JSON_FORMAT || !Array.isArray(data.places)) throw Object.assign(new Error('import_unreadable'), { code: 'import_unreadable' });
  const labels = [];
  for (const entry of Array.isArray(data.labels) ? data.labels.slice(0, 200) : []) {
    const name = textValue(entry?.name, 100);
    if (name && !labels.some((label) => fold(label.name) === fold(name))) labels.push({ name, ...(Number.isInteger(entry.color) && entry.color >= 1 && entry.color <= 8 ? { color: entry.color } : {}) });
  }
  const places = [];
  let skipped = 0;
  for (const entry of data.places.slice(0, MAX_IMPORT_PLACES)) {
    if (!entry || typeof entry !== 'object') { skipped++; continue; }
    const fields = {};
    for (const key of [...PLACE_FIELDS, 'cat']) if (has(entry[key])) fields[key] = entry[key];
    if (entry.img?.url) fields.img = entry.img;
    fields.status = STATUSES.includes(entry.status) ? entry.status : 'idea';
    if (Number.isInteger(entry.rating)) fields.rating = { [uid]: entry.rating };
    if (Array.isArray(entry.tags) && entry.tags.length) fields.tags = { [uid]: entry.tags };
    if (entry.visited === true) fields.visited = { [uid]: true };
    try { validateEntity('collection', 'saved', { ...fields, order: 'V' }); } catch { skipped++; continue; }
    const labelNames = (Array.isArray(entry.labels) ? entry.labels : []).map((name) => textValue(name, 100)).filter(Boolean);
    places.push({ fields: clone(fields), labels: [...new Set(labelNames)] });
  }
  skipped += Math.max(0, data.places.length - MAX_IMPORT_PLACES);
  const meta = { name: textValue(data.name, 200) };
  for (const key of ['desc', 'color', 'icon', 'urls', 'cover']) if (has(data[key])) meta[key] = data[key];
  return { meta, labels, places, skipped };
}

// ---- GPX (also OsmAnd favourites: groups in <type>, address in <osmand:address>)

const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const xml = (value) => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (char) => XML_ESCAPES[char]);
const coordinate = (value) => String(Math.round(value * 1e7) / 1e7);

/** GPX 1.1 waypoints for located places; the first label becomes the OsmAnd group. */
export function exportGpx({ meta = {}, labels = [], saved = [] }) {
  const names = new Map(labels.map((label) => [label.id, label.name]));
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Trips" xmlns="http://www.topografix.com/GPX/1/1" xmlns:osmand="https://osmand.net">',
    `  <metadata><name>${xml(meta.name ?? '')}</name>${meta.desc ? `<desc>${xml(meta.desc)}</desc>` : ''}</metadata>`];
  let count = 0;
  for (const item of saved) {
    if (!located(item)) continue;
    count++;
    const group = (item.labels ?? []).map((id) => names.get(id)).find(Boolean);
    const parts = [`    <name>${xml(item.name)}</name>`];
    const desc = [item.desc, item.notes].filter(Boolean).join('\n\n');
    if (desc) parts.push(`    <desc>${xml(desc)}</desc>`);
    if (group) parts.push(`    <type>${xml(group)}</type>`);
    if (item.web) parts.push(`    <link href="${xml(item.web)}"><text>${xml(item.web)}</text></link>`);
    if (item.address) parts.push(`    <extensions><osmand:address>${xml(item.address)}</osmand:address></extensions>`);
    lines.push(`  <wpt lat="${coordinate(item.lat)}" lon="${coordinate(item.lng)}">`, ...parts, '  </wpt>');
  }
  lines.push('</gpx>', '');
  return { text: lines.join('\n'), count, skipped: saved.length - count };
}

function decode(text) {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>|&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, cdata, entity) => {
    if (cdata !== undefined) return cdata;
    const name = entity.toLowerCase();
    if (name.startsWith('#')) {
      const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[name];
  });
}
/** Text content of the first direct `<tag>` (namespace prefix allowed), tags inside dropped. */
function child(body, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i').exec(body);
  if (!match) return '';
  const raw = match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (whole) => whole.replace(/</g, '\u0000'));
  return decode(raw.replace(/<[^>\u0000]*>/g, '').replace(/\u0000/g, '<')).replace(/\s+/g, ' ').trim();
}
function attributes(text) {
  const out = {};
  for (const match of text.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[match[1].toLowerCase()] = decode(match[2] ?? match[3]);
  return out;
}

/** Waypoints from a GPX or OsmAnd favourites file. Returns `{name, places: [{name, lat, lng, desc?, address?, web?, group?}], skipped}`. */
export function parseGpx(text) {
  if (typeof text !== 'string' || !/<gpx[\s>]/i.test(text)) throw Object.assign(new Error('import_unreadable'), { code: 'import_unreadable' });
  const source = text.replace(/<!--[\s\S]*?-->/g, '');
  const metadata = /<metadata(?:\s[^>]*)?>([\s\S]*?)<\/metadata>/i.exec(source)?.[1] ?? '';
  const places = [];
  let skipped = 0;
  for (const match of source.matchAll(/<wpt\b([^>]*?)(?:\/>|>([\s\S]*?)<\/wpt>)/gi)) {
    if (places.length >= MAX_IMPORT_PLACES) { skipped++; continue; }
    const attrs = attributes(match[1]);
    const body = match[2] ?? '';
    const lat = Number(attrs.lat);
    const lng = Number(attrs.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { skipped++; continue; }
    const name = child(body, 'name').slice(0, 500) || child(body, 'cmt').slice(0, 500);
    const place = { name, lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
    const desc = child(body, 'desc') || (name === child(body, 'cmt') ? '' : child(body, 'cmt'));
    if (desc) place.desc = desc.slice(0, 100_000);
    const address = child(body, 'osmand:address');
    if (address) place.address = address.slice(0, 2000);
    const link = /<link\b([^>]*)>/i.exec(body);
    const href = link ? attributes(link[1]).href : '';
    if (href && /^https?:\/\//i.test(href) && href.length <= 2048) place.web = href;
    const group = child(body, 'type');
    if (group) place.group = group.slice(0, 100);
    places.push(place);
  }
  return { name: child(metadata, 'name').slice(0, 200), places, skipped };
}

/** Saved-place fields for a parsed GPX waypoint; invalid ones (such as a bad link) lose the offending field. */
export function gpxFields(place, { status = 'idea' } = {}) {
  const fields = { name: place.name || `${place.lat}, ${place.lng}`, lat: place.lat, lng: place.lng, status };
  for (const key of ['desc', 'address', 'web']) if (place[key]) fields[key] = place[key];
  try { validateEntity('collection', 'saved', { ...fields, order: 'V' }); } catch { delete fields.web; }
  return fields;
}

/** Collections in the member's own order, then the rest by name. */
export function orderCollections(entries, order = []) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...entries].sort((a, b) => {
    const ra = rank.get(a.ref.s); const rb = rank.get(b.ref.s);
    if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity);
    return fold(a.title).localeCompare(fold(b.title));
  });
}
