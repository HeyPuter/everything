// Collection spaces through the session: the index in `me:spaces`, creating, opening and short-lived access.
// Journeys share the generic helpers (views/journey/spaces.js).
import { openSpace } from '../../lib/store/index.js';
import { newId } from '../../shared/ids.js';
import { validateSpaceRef } from '../../shared/protocol.js';
import { t } from '../../lib/i18n/index.js';
import { orderCollections } from './model.js';

export const ORDER_KEY = 'me:collections';
export const sameRef = (a, b) => Boolean(a && b && a.w === b.w && a.s === b.s);
export const personalOf = (context) => context.session?.personal ?? context.personal ?? null;
export const uidOf = (context) => context.account?.uuid ?? context.session?.account?.uuid ?? '';
export const canWrite = (role) => role === 'owner' || role === 'editor';

export const ownWorker = (session) => session.ownWorker().catch(() => null);
export const ensureWorker = async (session, { onProgress } = {}) => (await session.ensureWorker({ onProgress })).worker;

/** Index entries for the given kind (`collection` or `trip`), with the owner's role filled in for their own worker. */
export async function listSpaces(context, kind) {
  const personal = personalOf(context);
  if (!personal?.spaces) return [];
  const [entries, own] = await Promise.all([personal.spaces.list(), ownWorker(context.session)]);
  return entries.filter((entry) => entry.ref?.k === kind).map((entry) => ({ ...entry, role: own && entry.ref.w === own ? 'owner' : entry.role }));
}

export async function readOrder(personal) {
  try {
    const value = await personal.get(ORDER_KEY);
    return Array.isArray(value?.order) ? value.order.filter((id) => typeof id === 'string').slice(0, 1000) : [];
  } catch { return []; }
}
export const saveOrder = (personal, order) => personal.set(ORDER_KEY, { order: order.slice(0, 1000) });

export async function listCollections(context) {
  const personal = personalOf(context);
  const [entries, order] = await Promise.all([listSpaces(context, 'collection'), personal ? readOrder(personal) : []]);
  return orderCollections(entries, order);
}

/** Creates a collection on this account's worker (deploying it first). Retries with the same `space` id stay idempotent. */
export async function createCollection(context, meta, { space = newId(), onProgress } = {}) {
  const { session } = context;
  const worker = await ensureWorker(session, { onProgress });
  const created = await session.api.request(worker.name, JSON.stringify({ op: 'space.create', kind: 'collection', meta, space }));
  const ref = validateSpaceRef({ w: worker.name, s: created.space ?? space, k: 'collection' });
  await personalOf(context)?.spaces.upsert({ ref, role: 'owner', title: meta.name, opened: Date.now() }).catch(() => {});
  return ref;
}

async function entryFor(context, ref) {
  try { return (await personalOf(context)?.spaces.list())?.find((item) => sameRef(item.ref, ref)) ?? null; } catch { return null; }
}

/**
 * The open space for a collection or journey route: the shell's `context.space` when it is this ref, else the session's
 * one open space. `owned` tells the caller to reflect sync state and close it.
 */
export async function openRouteSpace(context, ref, { view, onError, onFlush } = {}) {
  const { session } = context;
  if (context.space && sameRef(context.space.ref ?? context.ref, ref)) return { space: context.space, owned: false, close() {} };
  const handle = session.openTrip(ref, { view });
  const off = handle.on((kind, value) => (kind === 'error' ? onError?.(value) : onFlush?.(value)));
  const space = await handle.ready;
  return { space, owned: true, close() { off(); if (sameRef(session.trip?.ref, ref)) void session.closeTrip(); } };
}
export const openCollection = (context, ref, options) => openRouteSpace(context, ref, { ...options, view: 'collection' });

/**
 * Runs `fn(space)` on another space and flushes. `open` maps refs already open in this view to their spaces, so the
 * same space is never opened twice in one tab. Resolves `{value, flush}`.
 */
export async function withSpace(context, ref, fn, { pull = false, open = [] } = {}) {
  const current = open.find((space) => sameRef(space?.ref, ref));
  if (current) { const value = await fn(current); return { value, flush: await current.flush() }; }
  return context.session.withSpace(ref, fn, { pull });
}

/** `read(space)` on the local replica only (no network); null when it cannot be opened. */
export async function peek(context, ref, read) {
  const { session } = context;
  if (session.trip?.space && sameRef(session.trip.ref, ref)) return read(session.trip.space);
  let space;
  try {
    const [entry, own] = await Promise.all([entryFor(context, ref), ownWorker(session)]);
    space = await openSpace({
      ref, db: session.db, api: session.api, puter: context.puter, personal: personalOf(context), handles: entry?.handles ?? null,
      role: entry?.role ?? (own && own === ref.w ? 'owner' : null), ownWorker: own, autoStart: false, open: false,
    });
  } catch { return null; }
  try { return read(space); } finally { space.close(); }
}

/** Meta and place counts from replicas (no network), keyed by space id; at most `limit` spaces, four at a time. */
export async function peekMeta(context, entries, { limit = 60 } = {}) {
  const out = new Map();
  const queue = entries.slice(0, limit);
  async function next() {
    for (let entry = queue.shift(); entry; entry = queue.shift()) {
      const info = await peek(context, entry.ref, (space) => ({ meta: space.get('meta', 'meta') ?? null, count: space.select.saved.all().length })).catch(() => null);
      if (info) out.set(entry.ref.s, info);
    }
  }
  await Promise.all([next(), next(), next(), next()]);
  return out;
}

export async function deleteCollection(context, ref) {
  await context.session.api.call(ref, 'space.delete');
  await personalOf(context)?.spaces.remove(ref).catch(() => {});
}

export async function leaveCollection(context, ref) {
  try { await context.session.api.call(ref, 'leave'); } catch (error) { if (error?.code !== 'not_member') throw error; }
  await personalOf(context)?.spaces.remove(ref).catch(() => {});
}

/** A translated message for a failed collection action. */
export function errorText(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (code === 'email_unverified') return t('collections.errEmail');
  if (code === 'owner_credit') return t('collections.errOwnerCredit');
  if (status === 402 || code === 'caller_credit' || code === 'insufficient_funds') return t('collections.errCredit');
  if (['worker_starting', 'worker_missing', 'worker_stale', 'worker_lost'].includes(code)) return t('collections.errStarting');
  if (code === 'worker_outdated' || status === 426) return t('collections.errOutdated');
  if (code === 'space_not_found' || code === 'gone' || status === 404) return t('collections.errGone');
  if (code === 'account_changed' || status === 401) return t('collections.errAccount');
  if (status === 403 || code === 'forbidden' || code === 'not_member') return t('collections.errForbidden');
  if (status === 409) return t('collections.errConflict');
  if (status === 429 || code === 'rate_limited') return t('collections.errRateLimited');
  if (code === 'import_unreadable') return t('collections.importUnreadable');
  if (globalThis.navigator?.onLine === false || status === 0 || code === 'network' || code === 'timeout') return t('collections.errOffline');
  return t('collections.errGeneric');
}

/** `flush` results from `apply` + `flush`: true when the change waits for a connection. */
export const queued = (flush) => flush?.status === 'queued' || flush?.retry === true;
