// Dashboard model: the `me:spaces` index, each trip's local replica (meta, members, places, bookings, unread
// activity) and fresh heads from the workers.
import { loadHeads } from '../../lib/heads.js';
import { readFeed, readSeen, unreadCount } from '../../lib/store/feed.js';
import { isDate } from '../../shared/dates.js';
import { plainObject } from '../../shared/schema/dsl.js';

export const TRANSPORT = new Set(['flight', 'train', 'bus', 'car', 'taxi', 'bike', 'cruise', 'ferry', 'transit', 'transport']);
const sameRef = (a, b) => a?.w === b?.w && a?.s === b?.s;

function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) { if (!plainObject(node[part])) node[part] = {}; node = node[part]; }
  if (value === undefined) delete node[parts.at(-1)]; else node[parts.at(-1)] = value;
}

/**
 * A read-only summary of a trip's replica in this account's database (the record `openSpace` keeps), with queued
 * meta edits applied so offline changes show. Null when the trip was never opened on this device.
 */
export async function readReplica(db, ref) {
  const record = await db.get(`space:${ref.w}:${ref.s}`);
  if (!plainObject(record?.confirmed)) return null;
  const out = { rev: Number.isSafeInteger(record.rev) ? record.rev : 0, meta: null, members: [], places: 0, days: 0, res: [], tz: new Map() };
  for (const [key, entity] of Object.entries(record.confirmed)) {
    if (!plainObject(entity) || entity.deleted) continue;
    const type = key.slice(0, key.indexOf(':'));
    if (type === 'meta') out.meta = structuredClone(entity);
    else if (type === 'member') out.members.push({ id: entity.id, name: entity.name, role: entity.role, color: entity.color });
    else if (type === 'place') { out.places += 1; if (typeof entity.tz === 'string') out.tz.set(entity.tz, (out.tz.get(entity.tz) ?? 0) + 1); }
    else if (type === 'day') out.days += 1;
    else if (type === 'res' && entity.status !== 'cancelled') out.res.push(entity);
  }
  for (const entry of Array.isArray(record.pending) ? record.pending : []) {
    const op = entry?.op;
    if (!out.meta || op?.t !== 'meta' || op.id !== 'meta') continue;
    for (const [path, value] of Object.entries(op.set ?? {})) setPath(out.meta, path, structuredClone(value));
    for (const path of op.unset ?? []) setPath(out.meta, path, undefined);
  }
  return out;
}

/**
 * Activity by others in this device's copy of the trip feed since the local read marker; null when the trip has not
 * been opened here since read markers were recorded.
 */
export async function tripUnread(db, ref, uid) {
  const [feed, seen] = await Promise.all([readFeed(db, ref), readSeen(db, ref)]);
  return seen === null ? null : unreadCount(feed, { seen, uid });
}

/**
 * One dashboard trip. `meta` merges the index entry, the replica and (later) heads. `unread` counts local feed
 * entries; `ahead` is set once heads show changes this device has not pulled.
 */
function tripModel(entry, replica, unread = null) {
  const meta = replica?.meta ?? {};
  return {
    ref: entry.ref, role: entry.role, entry,
    title: meta.title || entry.title || '', start: meta.start ?? entry.start ?? null, end: meta.end ?? entry.end ?? null, dayCount: meta.dayCount ?? null,
    cover: meta.cover ?? entry.cover ?? null, archived: Boolean(meta.archived), tags: Array.isArray(meta.tags) ? meta.tags : [],
    currency: meta.currency ?? null, perms: plainObject(meta.perms) ? meta.perms : {}, description: meta.description ?? '',
    members: replica?.members ?? [], places: replica?.places ?? null, res: replica?.res ?? [], tz: replica?.tz ?? new Map(),
    rev: replica?.meta ? replica.rev : null, cached: Boolean(replica?.meta), unavailable: false, stale: false, unread, ahead: false,
  };
}

/** The index plus replicas; fast and local. */
export async function loadTrips({ personal, db, account }) {
  const entries = (await personal.spaces.list()).filter((entry) => entry.ref.k === 'trip');
  const [replicas, unread] = await Promise.all([
    Promise.all(entries.map((entry) => readReplica(db, entry.ref).catch(() => null))),
    Promise.all(entries.map((entry) => (account?.uuid ? tripUnread(db, entry.ref, account.uuid).catch(() => null) : null))),
  ]);
  return entries.map((entry, index) => tripModel(entry, replicas[index], unread[index]));
}

/**
 * Title, dates and role from each worker (batched `heads`), used when the worker is ahead of the local replica.
 * Trips a worker no longer reports, or whose worker no longer exists, are marked `unavailable`; trips on an
 * unreachable worker are marked `stale`. Newer titles and dates are written back to the index.
 */
export async function refreshHeads(trips, { api, personal, signal }) {
  if (!trips.length) return trips;
  const { heads, missing, errors } = await loadHeads(trips.map((trip) => trip.ref), { api, signal });
  const failed = new Set(errors.map((error) => error.worker));
  // A 404 from the host rather than the worker (no Trips error body): the worker was deleted, as by "Delete my data".
  const deleted = new Set(errors.filter((error) => error.status === 404 && ['http_404', 'worker_not_found'].includes(error.code)).map((error) => error.worker));
  const updates = [];
  const next = trips.map((trip) => {
    const head = heads.find((item) => sameRef(item.ref, trip.ref));
    if (head && trip.rev !== null && head.rev <= trip.rev) return { ...trip, role: head.role, unavailable: false, stale: false };
    if (head) {
      const changed = head.title !== trip.entry.title || (head.start ?? null) !== (trip.entry.start ?? null) || (head.end ?? null) !== (trip.entry.end ?? null) || head.role !== trip.entry.role;
      if (changed) updates.push({ ...trip.entry, title: head.title, role: head.role, start: head.start ?? undefined, end: head.end ?? undefined });
      return { ...trip, title: head.title, start: head.start, end: head.end, role: head.role, unavailable: false, stale: false, ahead: trip.rev !== null };
    }
    if (missing.some((ref) => sameRef(ref, trip.ref)) || deleted.has(trip.ref.w)) return { ...trip, unavailable: true };
    return failed.has(trip.ref.w) ? { ...trip, stale: true } : trip;
  });
  for (const entry of updates) {
    const clean = Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined && value !== null));
    await personal.spaces.upsert(clean).catch(() => {});
  }
  return next;
}

/** The date a booking starts on, for sorting and the upcoming list. */
export function resStart(item) {
  const leg = Array.isArray(item.legs) ? item.legs[0] : null;
  const date = item.start?.date ?? leg?.dep?.date ?? null;
  const time = item.start?.time ?? leg?.dep?.time ?? null;
  return isDate(date) ? { date, time, tz: item.start?.tz ?? leg?.from?.tz ?? null } : null;
}

/** Upcoming bookings across trips from `day` on, soonest first. */
export function upcomingBookings(trips, day, limit = 6) {
  const list = [];
  for (const trip of trips) {
    if (trip.archived || trip.unavailable) continue;
    for (const item of trip.res) {
      const when = resStart(item);
      if (when && when.date >= day) list.push({ trip, item, when });
    }
  }
  return list.sort((a, b) => `${a.when.date} ${a.when.time ?? ''}`.localeCompare(`${b.when.date} ${b.when.time ?? ''}`)).slice(0, limit);
}

/** The next transport booking of a trip from `day` on, for the spotlight's boarding pass. */
export function nextTransport(trip, day) {
  return upcomingBookings([trip], day, 50).find(({ item }) => TRANSPORT.has(item.type)) ?? null;
}

/** Time zones a trip touches: its places' most common zones, then booking endpoints. */
export function tripZones(trip) {
  const zones = [...trip.tz.entries()].sort((a, b) => b[1] - a[1]).map(([zone]) => zone);
  for (const item of trip.res) {
    for (const zone of [item.start?.tz, item.end?.tz, ...(item.legs ?? []).flatMap((leg) => [leg.to?.tz, leg.from?.tz])]) {
      if (typeof zone === 'string' && !zones.includes(zone)) zones.push(zone);
    }
  }
  return zones;
}
