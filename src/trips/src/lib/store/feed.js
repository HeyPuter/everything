import { isId, isUuid } from '../../shared/ids.js';

const MAX_ENTRIES = 1000;
const RETENTION = 30 * 24 * 60 * 60_000;
const TYPE = /^[a-z][a-zA-Z0-9]{0,31}$/;
const clamp = (value, max) => typeof value === 'string' ? value.slice(0, max) : '';
const entityId = (value) => isId(value) || isUuid(value) || value === 'meta';
const label = (entity) => clamp(entity?.name ?? entity?.title ?? entity?.question ?? entity?.text ?? '', 200);

export const feedKey = (ref) => `feed:${ref.w}:${ref.s}`;
// Device-local copy of the read marker (`u:<uuid>:seen` or `me:seen:<id>`), so pages without an open space can count.
export const seenKey = (ref) => `seen:${ref.w}:${ref.s}`;

/**
 * One activity entry per change record: `{rev, at, by, items:[{t, id, name, fields, op: add|change|remove}]}`.
 * `previous(key)` is the replica's entity before the record; one learned from our own commit has the record's version.
 */
export function feedEntry(record, previous = () => undefined) {
  const ents = new Map((record.ents ?? []).map((entity) => [`${entity.t}:${entity.id}`, entity]));
  const removed = new Set((record.del ?? []).map((item) => `${item.t}:${item.id}`));
  const summary = Array.isArray(record.sum) ? record.sum
    : [...ents.values(), ...(record.del ?? [])].map((item) => ({ t: item.t, id: item.id, name: label(item), fields: [] }));
  const items = [];
  for (const item of summary.slice(0, 200)) {
    if (!item || !TYPE.test(item.t) || !entityId(item.id)) continue;
    const key = `${item.t}:${item.id}`;
    const entity = ents.get(key);
    const before = previous(key);
    const created = !before || before.deleted || (before.v === entity?.v && entity.cr === entity.upd);
    const op = removed.has(key) ? 'remove' : entity && created ? 'add' : 'change';
    const fields = Array.isArray(item.fields) ? item.fields.filter((field) => typeof field === 'string' && field.length <= 64).slice(0, 50) : [];
    items.push({ t: item.t, id: item.id, name: clamp(item.name, 200) || label(entity), fields, op });
  }
  if (!items.length) return null;
  return { rev: record.rev, at: Number.isSafeInteger(record.at) ? record.at : null, by: isUuid(record.by) ? record.by : null, items };
}

export async function appendFeed(db, ref, entries, now = Date.now) {
  if (!entries.length) return;
  await db.update(feedKey(ref), (current = []) => {
    const last = current.at(-1)?.rev ?? 0;
    const cutoff = now() - RETENTION;
    return [...current, ...entries.filter((entry) => entry.rev > last)].filter((entry) => entry.at === null || entry.at >= cutoff).slice(-MAX_ENTRIES);
  });
}

export async function readFeed(db, ref) { return (await db.get(feedKey(ref))) ?? []; }

/** The local read marker, or null when this device has not recorded one yet. */
export async function readSeen(db, ref) {
  const value = await db.get(seenKey(ref));
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Moves the local read marker forward to `rev` (never back). */
export async function noteSeen(db, ref, rev) {
  if (!Number.isSafeInteger(rev) || rev < 0) return;
  await db.update(seenKey(ref), (current) => (Number.isSafeInteger(current) && current >= rev ? current : rev));
}

/** Entries newer than the read marker and written by someone else. */
export function unreadCount(feed, { seen = 0, uid } = {}) {
  return feed.filter((entry) => entry.rev > seen && entry.by !== uid).length;
}
