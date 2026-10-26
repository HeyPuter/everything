// Immich: the user's photo library on their own server (`x-api-key`). Photos are searched by capture date and
// copied into the trip as ordinary trip files.
import { LIMITS } from '../../shared/limits.js';
import { addDays, isDate, isTime } from '../../shared/dates.js';
import { createClient } from './client.js';
import { IntegrationError } from './errors.js';

const SERVICE = 'immich';
export const IMMICH_PAGE = 100;
export const THUMB_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9-]{1,64}$/;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

export function immichClient(puter, config) {
  if (!config?.url || !config?.key) throw new IntegrationError('not_configured', { service: SERVICE });
  return createClient({ puter, url: config.url, service: SERVICE, headers: { 'x-api-key': config.key } });
}

/** Checks the URL and key: `{user: {id, name}}`. */
export async function verifyImmich(client, { signal } = {}) {
  const { data } = await client.request('/api/users/me', { signal });
  if (!plain(data) || typeof data.id !== 'string') throw new IntegrationError('bad_response', { service: SERVICE });
  return { user: { id: data.id, name: String(data.name ?? data.email ?? '').slice(0, 200) } };
}

const cleanName = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim().slice(-200);

/**
 * A photo from an asset: `{id, name, mime, takenAt, date, time, lat, lng, size, video}`, or null for unusable assets.
 * `date` and `time` are the local capture wall clock (Immich's `localDateTime` writes it as UTC).
 */
export function photoFromAsset(asset) {
  if (!plain(asset) || typeof asset.id !== 'string' || !ID.test(asset.id) || asset.isTrashed === true) return null;
  const exif = plain(asset.exifInfo) ? asset.exifInfo : {};
  const takenAt = [exif.dateTimeOriginal, asset.localDateTime, asset.fileCreatedAt].find((value) => typeof value === 'string' && Number.isFinite(Date.parse(value))) ?? null;
  const lat = finite(exif.latitude); const lng = finite(exif.longitude);
  const located = lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
  const size = Number.isSafeInteger(exif.fileSizeInByte) && exif.fileSizeInByte >= 0 ? exif.fileSizeInByte : null;
  const wall = String(asset.localDateTime ?? takenAt ?? '');
  const local = wall.slice(0, 10);
  const clock = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2})/.exec(wall)?.[1];
  return {
    id: asset.id, name: cleanName(asset.originalFileName) || `${asset.id}.jpg`, mime: typeof asset.originalMimeType === 'string' ? asset.originalMimeType.slice(0, 100) : '',
    takenAt, date: isDate(local) ? local : null, time: isTime(clock) ? clock : null, lat: located ? lat : null, lng: located ? lng : null, size, video: asset.type === 'VIDEO',
  };
}

/**
 * One page of photos taken from `from` to `to` (dates, inclusive; a day of slack each side for time zones).
 * `{photos, next}`: `next` is the page to ask for next, or null.
 */
export async function searchPhotos(client, { from, to, page = 1, size = IMMICH_PAGE, videos = false, signal } = {}) {
  if (!isDate(from) || !isDate(to) || to < from) throw new IntegrationError('rejected', { service: SERVICE });
  const body = {
    takenAfter: `${addDays(from, -1)}T00:00:00.000Z`, takenBefore: `${addDays(to, 2)}T00:00:00.000Z`,
    page, size, withExif: true, order: 'asc', ...(videos ? {} : { type: 'IMAGE' }),
  };
  const { data } = await client.request('/api/search/metadata', { method: 'POST', body, signal });
  const assets = data?.assets;
  if (!plain(assets) || !Array.isArray(assets.items)) throw new IntegrationError('bad_response', { service: SERVICE });
  const next = assets.nextPage == null || assets.nextPage === '' ? null : Number(assets.nextPage);
  return { photos: assets.items.map(photoFromAsset).filter(Boolean), next: Number.isSafeInteger(next) && next > page ? next : null };
}

const assetPath = (id, tail) => {
  if (!ID.test(String(id))) throw new IntegrationError('rejected', { service: SERVICE });
  return `/api/assets/${encodeURIComponent(id)}/${tail}`;
};

/** A small preview as a Blob, for the picker grid. */
export async function photoThumbnail(client, id, { signal } = {}) {
  const { data } = await client.request(assetPath(id, 'thumbnail'), { query: { size: 'thumbnail' }, binary: true, maxBytes: THUMB_BYTES, signal });
  return data;
}

/** The original file as a `File`, capped at the trip file limit. */
export async function photoOriginal(client, photo, { signal } = {}) {
  if (photo.size != null && photo.size > LIMITS.fileBytes) throw new IntegrationError('too_large', { service: SERVICE });
  const { data } = await client.request(assetPath(photo.id, 'original'), { binary: true, maxBytes: LIMITS.fileBytes, timeout: 180_000, signal, type: photo.mime || undefined });
  return new File([data], photo.name, { type: data.type || photo.mime || '' });
}
