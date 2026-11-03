// Trip lifecycle actions shared by the dashboard and the trip settings tab.
import { DomainError } from '../../../shared/errors.js';
import { newId } from '../../../shared/ids.js';
import { addDays, dateRange, daysBetween, isDate } from '../../../shared/dates.js';
import { orderKeys } from '../../../shared/order.js';
import { crossRate, rateString } from '../../../services/fx.js';
import { copyEntities } from './copy.js';
import { DEFAULT_DAYS, isDated } from './meta.js';

const sameRef = (a, b) => a?.w === b?.w && a?.s === b?.s;
const META_FIELDS = ['title', 'description', 'start', 'end', 'dayCount', 'currency', 'cover', 'tags', 'archived', 'reminderDays', 'settings'];

/** Meta for `space.create`: empty optional fields are left out. */
export function cleanMeta(fields) {
  const meta = {};
  for (const key of META_FIELDS) {
    const value = fields[key];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
    meta[key] = value;
  }
  if (!isDated(meta)) meta.dayCount = fields.dayCount ?? DEFAULT_DAYS;
  return meta;
}

/** The days a new trip starts with: one per date, or `dayCount` undated days. */
export function initialDays(meta) {
  const dates = isDated(meta) ? dateRange(meta.start, meta.end) : Array.from({ length: meta.dayCount ?? DEFAULT_DAYS }, () => null);
  const keys = orderKeys(dates.length);
  return dates.map((date, index) => ({ date, order: keys[index] }));
}

/** i18n key for a failed trip action. */
export function errorKey(error) {
  const code = error?.code;
  if (code === 'email_unverified') return 'trip.errorEmail';
  if (error?.status === 402 || ['insufficient_funds', 'owner_credit', 'caller_credit'].includes(code)) return code === 'owner_credit' ? 'trip.errorOwnerCredit' : 'trip.errorCredit';
  if (code === 'worker_lost') return 'trip.errorWorkerLost';
  if (['worker_starting', 'worker_missing', 'worker_stale'].includes(code)) return 'trip.errorStarting';
  if (code === 'fx_unavailable') return 'trip.errorFx';
  if (code === 'currency_needs_costs') return 'trip.errorCurrencyCosts';
  if (code === 'trip_unavailable') return 'trip.errorUnavailable';
  if (code === 'account_changed') return 'trip.errorAccount';
  if (code === 'owner_cannot_leave') return 'trip.errorOwnerLeave';
  if (code === 'worker_outdated') return 'trip.errorOutdated';
  if (error?.status === 0 || code === 'network' || code === 'timeout' || globalThis.navigator?.onLine === false) return 'trip.errorOffline';
  if (error?.status === 403 || code === 'forbidden' || code === 'not_member') return 'trip.errorForbidden';
  if (error?.status === 409) return 'trip.errorConflict';
  if (error?.status === 429) return 'trip.errorRateLimited';
  return 'trip.errorGeneric';
}

/**
 * Creates a trip on this account's worker (deploying it first, `onProgress(stage)`) and lays out its days, or
 * `entities(space)`; `layout: false` skips that. Never replaces the session's open trip. Retry with the same `space`
 * id so a lost answer does not duplicate the trip.
 */
export async function createTrip(session, fields, { space: sid = newId(), onProgress, entities, layout = true } = {}) {
  const { worker } = await (session.ensureWorker?.({ onProgress }) ?? session.deployer.ensure());
  const meta = cleanMeta(fields);
  const created = await session.api.request(worker.name, JSON.stringify({ op: 'space.create', kind: 'trip', meta, space: sid }));
  const ref = { w: worker.name, s: created?.space ?? sid, k: 'trip' };
  // The index is a cache; the trip route re-adds a missing entry once the meta loads.
  await session.personal?.spaces?.upsert({ ref, role: 'owner', title: meta.title, ...(meta.start ? { start: meta.start } : {}), ...(meta.end ? { end: meta.end } : {}), ...(meta.cover ? { cover: meta.cover } : {}), opened: Date.now() }).catch(() => {});
  if (!layout) return ref;
  await session.withSpace(ref, async (space) => {
    if (space.select.day.all().length) return;
    const ops = entities ? entities(space) : initialDays(meta).map((day) => space.ops.create('day', day));
    if (ops.length) await space.apply(ops);
  });
  return ref;
}

const COPY_TYPES = ['guest', 'day', 'place', 'cat', 'res', 'visit', 'dayNote', 'bag', 'pack', 'listMeta', 'todo', 'note', 'link'];

/** Copies `groups` of a trip into a new one titled `title`, starting on `start` when given (dates keep their spacing). */
export async function copyTrip(session, source, { title, start = null, groups = [] }, { onProgress, space } = {}) {
  let snapshot = null;
  // Read everything inside the callback: a short-lived space closes when it returns.
  await session.withSpace(source, (opened) => {
    const copied = Object.fromEntries(COPY_TYPES.map((type) => [type, opened.query(type).map((item) => structuredClone(item))]));
    snapshot = { meta: structuredClone(opened.get('meta', 'meta')), entities: (type) => copied[type] ?? [] };
  }, { pull: true });
  const meta = snapshot?.meta;
  if (!meta) throw new DomainError('trip_unavailable', 404);
  const delta = start && isDate(meta.start) ? daysBetween(meta.start, start) : 0;
  const fields = {
    title, description: meta.description, currency: meta.currency, tags: meta.tags, reminderDays: meta.reminderDays, settings: meta.settings,
    cover: typeof meta.cover === 'object' ? meta.cover : undefined,
    start: isDate(meta.start) ? addDays(meta.start, delta) : start, end: isDate(meta.end) ? addDays(meta.end, delta) : null, dayCount: meta.dayCount,
  };
  const copied = copyEntities(snapshot.entities, groups, { uid: session.account.uuid, delta, makeId: newId });
  return createTrip(session, fields, {
    onProgress, space,
    entities: (target) => [
      ...(copied.some((item) => item.t === 'day') ? [] : initialDays(cleanMeta(fields)).map((day) => target.ops.create('day', day))),
      ...copied.map((item) => target.ops.create(item.t, item.put, { id: item.id })),
    ],
  });
}

/** Meta patch through the outbox (optimistic, kept while offline). */
export function patchMeta(space, set = {}, unset = []) {
  if (!Object.keys(set).length && !unset.length) return Promise.resolve();
  return space.apply([space.ops.patch('meta', 'meta', { set, unset })]);
}

export async function setArchived(session, ref, archived) {
  const { flush } = await session.withSpace(ref, (space) => patchMeta(space, { archived }));
  return flush;
}

async function forget(session, ref) {
  if (sameRef(session.trip?.ref, ref)) await session.closeTrip();
  await session.personal.spaces.remove(ref);
  // The replica record of the closed space store.
  await session.db.remove(`space:${ref.w}:${ref.s}`).catch(() => {});
}

/** Owner only: deletes the trip for everyone. */
export async function deleteTrip(session, ref) {
  await session.api.call(ref, 'space.delete');
  await forget(session, ref);
}

/** Members only (the owner cannot leave). */
export async function leaveTrip(session, ref) {
  await session.api.call(ref, 'leave');
  await forget(session, ref);
}

/**
 * Changing the trip currency re-bases expenses and settlements (data-model §3.1): one old→new rate is fetched and
 * pinned, frozen rates are multiplied by it, amounts in the old currency get it, amounts in the new one lose theirs
 * and pending rates stay pending. Returns the ops to apply with the meta change; private expenses are patched directly.
 */
export async function currencyOps(space, services, from, to) {
  const shared = [...space.query('exp').map((item) => ['exp', item]), ...space.query('settle').map((item) => ['settle', item])];
  const own = space.privateItems ? space.query('exp', { includePrivate: true }).filter((item) => item.private) : [];
  if (from === to || (!shared.length && !own.length)) return { ops: [], privatePatches: [] };
  // The meta change alone would leave every shared rate pointing at the old currency.
  if (shared.length && !space.can('costs.edit')) throw new DomainError('currency_needs_costs', 403);
  let rate = null;
  try { rate = crossRate((await services.fx.rates(from))?.data, from, to); } catch { rate = null; }
  if (!rate) throw new DomainError('fx_unavailable', 503);
  const next = (item) => {
    if (item.currency === to) return item.rate === undefined ? undefined : null;
    if (item.currency === from) return rateString(rate);
    return typeof item.rate === 'string' ? rateString(Number(item.rate) * rate) : undefined;
  };
  const ops = [];
  const privatePatches = [];
  for (const [type, item] of shared) {
    const value = next(item);
    if (value !== undefined) ops.push(space.ops.patch(type, item.id, value === null ? { unset: ['rate'] } : { set: { rate: value } }));
  }
  for (const item of own) {
    const value = next(item);
    if (value !== undefined) privatePatches.push({ id: item.id, rate: value ?? undefined });
  }
  return { ops, privatePatches };
}
