// Trip photos (spec §22 [3]): a pool mixing photos shared with members (trip files of kind 'photo') and the member's
// private ones, kept as references to files in their own drive (`me:photos:<spaceId>`, data-model §4), plus an
// optional linked drive folder whose images join the pool. Bytes are never copied unless a photo is shared.
import { invariant } from '../../shared/errors.js';
import { isDate, isTime } from '../../shared/dates.js';
import { isId, newId } from '../../shared/ids.js';
import { readExif } from '../../views/journey/exif.js';

export const PHOTO_INDEX = 'me:photos';
export const PHOTO_MAX = 1000;
export const FOLDER_MAX = 400;
export const EXIF_BYTES = 128 * 1024;
export const IMAGE_NAME = /\.(jpe?g|png|gif|webp|avif|heic|heif)$/i;
export const photoKey = (spaceId) => { invariant(isId(spaceId), 'invalid_space'); return `me:photos:${spaceId}`; };

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const located = (lat, lng) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** The first `max` bytes of a Blob, also where `Blob.arrayBuffer` is missing (older browsers). */
export async function blobBytes(blob, max = Infinity) {
  const part = Number.isFinite(max) ? blob.slice(0, max) : blob;
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(part);
  });
}

/** `{date, time?}` and coordinates from a JPEG's first bytes, or `{}`. */
export function photoMeta(bytes) {
  const exif = readExif(bytes) ?? {};
  return {
    ...(isDate(exif.date) ? { taken: { date: exif.date, ...(isTime(exif.time) ? { time: exif.time } : {}) } } : {}),
    ...(located(exif.lat, exif.lng) ? { lat: exif.lat, lng: exif.lng } : {}),
  };
}

function cleanItem(value) {
  if (!plain(value) || typeof value.uid !== 'string' || !value.uid || value.uid.length > 200) return null;
  const out = { uid: value.uid, name: text(value.name, 500) || 'photo' };
  const path = text(value.path, 2000);
  if (path) out.path = path;
  if (isDate(value.taken?.date)) out.taken = { date: value.taken.date, ...(isTime(value.taken.time) ? { time: value.taken.time } : {}) };
  if (located(value.lat, value.lng)) Object.assign(out, { lat: value.lat, lng: value.lng });
  if (isId(value.shared)) out.shared = value.shared;
  out.upd = Number.isSafeInteger(value.upd) ? value.upd : 0;
  return out;
}

/** The stored value as `{folder, items: Map<id, item>}`; malformed entries are dropped. */
export function readPhotos(value) {
  const source = plain(value) && value.v === 1 ? value : {};
  const items = new Map();
  for (const [id, item] of Object.entries(plain(source.items) ? source.items : {})) {
    const clean = isId(id) ? cleanItem(item) : null;
    if (clean) items.set(id, clean);
  }
  const folder = plain(source.folder) && typeof source.folder.uid === 'string' && text(source.folder.path, 2000)
    ? { uid: source.folder.uid.slice(0, 200), path: text(source.folder.path, 2000), name: text(source.folder.name, 500) } : null;
  return { folder, items };
}

const serialize = ({ folder, items }) => ({ v: 1, ...(folder ? { folder } : {}), items: Object.fromEntries(items) });

/**
 * The member's private photos for one trip. Every change re-reads the stored value and writes it whole, then names
 * the trip in the `me:photos` index (one path write).
 */
export function createPhotoStore({ personal, puter, spaceId, now = Date.now, makeId = newId }) {
  const key = photoKey(spaceId);
  async function change(update) {
    const current = readPhotos(await personal.get(key, { fresh: true }));
    const next = update(current) ?? current;
    invariant(next.items.size <= PHOTO_MAX, 'photos_full');
    await personal.set(key, serialize(next));
    await puter.kv.update(PHOTO_INDEX, { [spaceId]: now() });
    return next;
  }
  return {
    key,
    async load({ fresh = false } = {}) { return readPhotos(await personal.get(key, { fresh })); },
    /** Adds drive files `{uid, name, path?, taken?, lat?, lng?}`; ones already in the pool (same uid) are skipped. */
    add(list) {
      return change((current) => {
        const known = new Set([...current.items.values()].map((item) => item.uid));
        for (const raw of list) {
          const item = cleanItem({ ...raw, upd: now() });
          if (!item || known.has(item.uid)) continue;
          known.add(item.uid);
          current.items.set(makeId(), item);
        }
        return current;
      });
    },
    remove(id) { return change((current) => { current.items.delete(id); return current; }); },
    /** Records the trip photo made from a private one (or clears it with null). */
    setShared(id, fileId) {
      return change((current) => {
        const item = current.items.get(id);
        if (!item) return current;
        const next = { ...item, upd: now() };
        if (fileId) next.shared = fileId; else delete next.shared;
        current.items.set(id, next);
        return current;
      });
    },
    setFolder(folder) { return change((current) => ({ ...current, folder: folder ? { uid: String(folder.uid).slice(0, 200), path: text(folder.path, 2000), name: text(folder.name, 500) } : null })); },
  };
}

const takenKey = (photo) => (photo.taken ? `${photo.taken.date}T${photo.taken.time ?? '99:99'}` : '~');

/**
 * One list for the grid: shared photos (`files` of kind photo, not trashed), private items and folder images, each
 * `{key, source: shared|private|folder, id, name, taken?, lat?, lng?, fileId?, uid?, path?, mine?}`. A private item
 * already shared shows once, as shared and `mine`. Sorted by capture time, undated last.
 */
export function photoPool({ files = [], items = new Map(), folderItems = [] }) {
  const sharedFrom = new Map([...items].filter(([, item]) => item.shared).map(([id, item]) => [item.shared, id]));
  const out = [];
  for (const file of files) {
    if (file.kind !== 'photo' || file.trashed || file.deleted) continue;
    out.push({ key: `f:${file.id}`, source: 'shared', id: file.id, fileId: file.id, name: file.name, ...(file.taken ? { taken: file.taken } : {}),
      ...(file.geo ? { lat: file.geo.lat, lng: file.geo.lng } : {}), ...(sharedFrom.has(file.id) ? { mine: sharedFrom.get(file.id) } : {}) });
  }
  const sharedIds = new Set(out.map((photo) => photo.fileId));
  const uids = new Set();
  for (const [id, item] of items) {
    uids.add(item.uid);
    if (item.shared && sharedIds.has(item.shared)) continue;
    out.push({ key: `p:${id}`, source: 'private', id, uid: item.uid, path: item.path, name: item.name, ...(item.taken ? { taken: item.taken } : {}), ...(Number.isFinite(item.lat) ? { lat: item.lat, lng: item.lng } : {}) });
  }
  for (const entry of folderItems) {
    if (!entry?.uid || uids.has(entry.uid)) continue;
    uids.add(entry.uid);
    out.push({ key: `d:${entry.uid}`, source: 'folder', id: entry.uid, uid: entry.uid, path: entry.path, name: entry.name, ...(entry.taken ? { taken: entry.taken } : {}), ...(Number.isFinite(entry.lat) ? { lat: entry.lat, lng: entry.lng } : {}) });
  }
  return out.sort((a, b) => (takenKey(a) < takenKey(b) ? -1 : takenKey(a) > takenKey(b) ? 1 : a.name.localeCompare(b.name)));
}

/**
 * Groups the pool by trip day: `[{dayId, date, index, photos}]` for days with photos (in trip order), then photos from
 * other dates (`dayId: 'other'`) and undated ones (`dayId: 'none'`).
 */
export function photosByDay(pool, days = []) {
  const byDate = new Map(days.filter((day) => isDate(day.date)).map((day, index) => [day.date, { day, index }]));
  const groups = new Map();
  const group = (id, extra) => { if (!groups.has(id)) groups.set(id, { dayId: id, photos: [], ...extra }); return groups.get(id); };
  for (const photo of pool) {
    const hit = photo.taken ? byDate.get(photo.taken.date) : null;
    if (hit) group(hit.day.id, { date: hit.day.date, index: hit.index }).photos.push(photo);
    else group(photo.taken ? 'other' : 'none', {}).photos.push(photo);
  }
  const rank = (entry) => (entry.dayId === 'other' ? 1e6 : entry.dayId === 'none' ? 2e6 : entry.index);
  return [...groups.values()].sort((a, b) => rank(a) - rank(b));
}

/** Image entries of a linked folder from `fs.readdir`, at most 400, newest name order kept. */
export function folderImages(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && !entry.is_dir && typeof entry.uid === 'string' && IMAGE_NAME.test(entry.name ?? ''))
    .slice(0, FOLDER_MAX)
    .map((entry) => ({ uid: entry.uid, name: text(entry.name, 500), path: text(entry.path, 2000) }));
}
