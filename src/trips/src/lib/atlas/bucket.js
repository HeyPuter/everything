// Bucket list: places and countries the user wants to visit. `me:bucket:<id>` holds an item; `me:buckets` indexes
// every item with everything but its notes (one path per item), so the list, the map and data export need no kv.list.
import { invariant } from '../../shared/errors.js';
import { isId, newId } from '../../shared/ids.js';
import { isDate } from '../../shared/dates.js';
import { countryCode } from './countries.js';

export const BUCKET_INDEX = 'me:buckets';
export const BUCKET_LIMITS = Object.freeze({ items: 500, name: 200, notes: 2000 });
export const bucketKey = (id) => { invariant(isId(id), 'invalid_id'); return `me:bucket:${id}`; };

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const blank = (value) => value === undefined || value === null || value === '';
const line = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const multiline = (value, max) => (typeof value === 'string' ? value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max) : '');
const round = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Normalized item `{name, cc?, lat?, lng?, notes?, target?, visitedAt?}`. A name or a country is required; `cc` is an
 * atlas country code; coordinates come in pairs; `target` and `visitedAt` are ISO dates.
 * Throws `bucket_name_required` or `invalid_bucket`.
 */
export function validateBucketItem(input) {
  invariant(plain(input), 'invalid_bucket');
  const name = line(input.name, BUCKET_LIMITS.name);
  const cc = blank(input.cc) ? null : countryCode(input.cc);
  invariant(blank(input.cc) || cc, 'invalid_bucket');
  invariant(name || cc, 'bucket_name_required');
  invariant(blank(input.lat) === blank(input.lng), 'invalid_bucket');
  const out = { name };
  if (cc) out.cc = cc;
  if (!blank(input.lat)) {
    invariant(Number.isFinite(input.lat) && Number.isFinite(input.lng) && Math.abs(input.lat) <= 90 && Math.abs(input.lng) <= 180, 'invalid_bucket');
    out.lat = round(input.lat); out.lng = round(input.lng);
  }
  const notes = multiline(input.notes, BUCKET_LIMITS.notes);
  if (notes) out.notes = notes;
  for (const field of ['target', 'visitedAt']) {
    invariant(blank(input[field]) || isDate(input[field]), 'invalid_bucket');
    if (!blank(input[field])) out[field] = input[field];
  }
  return out;
}

function summary(item, upd) {
  const { notes: _notes, ...rest } = item;
  return { ...rest, upd };
}

/** Index entries as `[{id, name, cc?, lat?, lng?, target?, visitedAt?, upd}]`; invalid entries are left out. */
export function bucketEntries(value) {
  if (!plain(value)) return [];
  return Object.entries(value).flatMap(([id, entry]) => {
    if (!isId(id) || !plain(entry)) return [];
    try { return [{ id, ...validateBucketItem({ ...entry, notes: undefined }), upd: Number.isSafeInteger(entry.upd) ? entry.upd : 0 }]; } catch { return []; }
  });
}

/** Wishes first (by target date, then name), then visited items (most recent first). */
export function sortBucket(entries, locale = 'en') {
  const name = (entry) => entry.name || entry.cc || '';
  return entries.slice().sort((a, b) => {
    if (Boolean(a.visitedAt) !== Boolean(b.visitedAt)) return a.visitedAt ? 1 : -1;
    if (a.visitedAt && b.visitedAt && a.visitedAt !== b.visitedAt) return a.visitedAt < b.visitedAt ? 1 : -1;
    if (!a.visitedAt && (a.target ?? '') !== (b.target ?? '')) return !a.target ? 1 : !b.target ? -1 : a.target < b.target ? -1 : 1;
    return name(a).localeCompare(name(b), locale) || a.id.localeCompare(b.id);
  });
}

/**
 * `personal` is the store from `createPersonalStore`; `puter.kv` writes index paths and deletes. The item is written
 * before its index entry and deleted before it, so an item is never left without an entry.
 */
export function createBucketStore({ personal, puter, makeId = newId, now = Date.now }) {
  const session = puter.authToken;
  // Direct KV calls bypass the personal store, so they check the session themselves.
  const kv = (method, ...args) => { invariant(puter.authToken === session, 'account_changed', 401); return puter.kv[method](...args); };
  const store = {
    async list({ fresh = false } = {}) { return bucketEntries(await personal.get(BUCKET_INDEX, { fresh })); },
    /** The full item, with notes; null when it no longer exists. `fresh: false` may answer from the device cache. */
    async get(id, { fresh = true } = {}) {
      const value = await personal.get(bucketKey(id), { fresh });
      if (value == null) return null;
      return { id, ...validateBucketItem(value), upd: Number.isSafeInteger(value.upd) ? value.upd : 0 };
    },
    async create(item) {
      const clean = validateBucketItem(item);
      invariant((await store.list({ fresh: true })).length < BUCKET_LIMITS.items, 'bucket_full');
      const id = makeId(); const upd = now();
      await personal.set(bucketKey(id), { ...clean, upd });
      // Without its index entry the item is unreachable, so it is deleted again.
      try { await kv('update', BUCKET_INDEX, { [id]: summary(clean, upd) }); }
      catch (error) { await kv('del', bucketKey(id)).catch(() => {}); throw error; }
      await personal.refresh(BUCKET_INDEX);
      return id;
    },
    async save(id, item) {
      const clean = validateBucketItem(item); const upd = now();
      await personal.set(bucketKey(id), { ...clean, upd });
      await kv('update', BUCKET_INDEX, { [id]: summary(clean, upd) });
      await personal.refresh(BUCKET_INDEX);
    },
    async setVisited(id, date) {
      invariant(date === null || isDate(date), 'invalid_bucket');
      const current = await store.get(id);
      invariant(current, 'gone', 404);
      const { id: _id, upd: _upd, ...item } = current;
      await store.save(id, { ...item, visitedAt: date });
    },
    async remove(id) {
      const key = bucketKey(id);
      await kv('del', key);
      await kv('remove', BUCKET_INDEX, id);
      await personal.refresh(BUCKET_INDEX);
      await personal.refresh(key).catch(() => {});
    },
    /** Drops an index entry whose item no longer exists (deleted on another device). */
    async forget(id) { bucketKey(id); await kv('remove', BUCKET_INDEX, id); await personal.refresh(BUCKET_INDEX); },
    subscribe(listener) { return personal.subscribe(BUCKET_INDEX, (value) => listener(bucketEntries(value))); },
  };
  return store;
}
