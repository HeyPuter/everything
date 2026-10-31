// Journey spaces through the session: listing, creating (blank or from a trip), opening, leaving and errors.
// The generic session helpers are shared with collections (views/collections/spaces.js).
import { fileBlob, uploadCover } from '../../lib/files/index.js';
import { newId } from '../../shared/ids.js';
import { validateSpaceRef, spaceRoute } from '../../shared/protocol.js';
import { browserTimeZone, zonedParts } from '../../shared/dates.js';
import { t } from '../../lib/i18n/index.js';
import { ensureWorker, listSpaces, openRouteSpace, peek, personalOf, sameRef, uidOf, withSpace, queued } from '../collections/spaces.js';
import { journeyMetaFromTrip, lastOrders, suggestionsFromTrip } from './model.js';

export { listSpaces, peek, personalOf, sameRef, uidOf, withSpace, queued };

export const journeyHash = (ref, tab = 'timeline') => `${spaceRoute(ref)}/${tab}`;
export const today = (now = Date.now()) => zonedParts(now, browserTimeZone()).date;

export function deployProgress(stage) {
  return t({ preparing: 'journey.deployPreparing', creating: 'journey.deployCreating', updating: 'journey.deployUpdating', starting: 'journey.deployStarting' }[stage] ?? 'journey.deployPreparing');
}

/** Creates a journey on this account's worker (deploying it first). A retry with the same `space` id is idempotent. */
export async function createJourney(context, meta, { space = newId(), onProgress } = {}) {
  const { session } = context;
  const worker = await ensureWorker(session, { onProgress });
  const created = await session.api.request(worker.name, JSON.stringify({ op: 'space.create', kind: 'journey', meta, space }));
  const ref = validateSpaceRef({ w: worker.name, s: created.space ?? space, k: 'journey' });
  await personalOf(context)?.spaces.upsert({ ref, role: 'owner', title: meta.title, opened: Date.now() }).catch(() => {});
  return ref;
}

/** Days, visits and places of a trip from its replica (pulled once when this device has none). */
export async function readTrip(context, ref, { open = [] } = {}) {
  const { value } = await withSpace(context, ref, (space) => ({
    meta: space.get('meta', 'meta') ?? null,
    days: space.select.day.all(), visits: space.select.visit.all(), places: space.select.place.all(),
  }), { pull: false, open });
  return { ref, ...value };
}

/**
 * Adds suggestion entries for every linked trip this member can read. Returns `{added, unreadable}`: trips that
 * could not be opened (not a member, offline without a replica) are counted, not fatal.
 */
export async function importSuggestions(context, space, trips, { open = [] } = {}) {
  let added = 0;
  let unreadable = 0;
  for (const ref of trips) {
    let trip;
    try { trip = await readTrip(context, ref, { open }); } catch { unreadable += 1; continue; }
    const entries = space.select.entry.all();
    const orders = lastOrders(entries);
    const items = suggestionsFromTrip(trip, entries, { after: (date) => orders.get(date) ?? null });
    for (let at = 0; at < items.length; at += 100) {
      const ops = items.slice(at, at + 100).map((fields) => space.ops.create('entry', fields));
      await space.apply(ops, { history: t('journey.historySuggestions') });
    }
    added += items.length;
  }
  return { added, unreadable };
}

/** The trip's uploaded cover image as a File, or null (web covers are copied as links by `journeyMetaFromTrip`). */
async function tripCover(context, tripRef, cover) {
  if (typeof cover !== 'string') return null;
  try {
    const { value } = await withSpace(context, tripRef, async (space) => {
      const entity = space.get('file', cover);
      if (!entity || !/^image\/(jpeg|png|webp|gif)$/.test(entity.mime ?? '')) return null;
      return new File([await fileBlob(space, cover, { api: context.session.api })], entity.name, { type: entity.mime });
    });
    return value;
  } catch { return null; }
}

/** A new journey linked to a trip, with the trip's visits as suggestions and its cover. Resolves to the journey ref. */
export async function createFromTrip(context, tripRef, { onProgress } = {}) {
  const trip = await readTrip(context, tripRef);
  const meta = journeyMetaFromTrip(trip.meta, tripRef, today());
  const ref = await createJourney(context, meta, { onProgress });
  const cover = await tripCover(context, tripRef, trip.meta?.cover);
  await withSpace(context, ref, async (space) => {
    const items = suggestionsFromTrip(trip, []);
    for (let at = 0; at < items.length; at += 100) await space.apply(items.slice(at, at + 100).map((fields) => space.ops.create('entry', fields)));
    // The journey works without it; a failed copy only loses the cover.
    if (cover) await uploadCover(space, cover, { api: context.session.api }).catch(() => {});
  }, { pull: true });
  return ref;
}

/** The trips in `me:spaces`, newest first, for linking and "from a trip". */
export async function tripChoices(context) {
  const trips = await listSpaces(context, 'trip');
  return trips.sort((a, b) => (b.start ?? '').localeCompare(a.start ?? '') || (b.opened ?? 0) - (a.opened ?? 0));
}

/** The open space for a journey route; see `openRouteSpace`. */
export const openJourney = (context, ref, options) => openRouteSpace(context, ref, { ...options, view: 'journey' });

export async function deleteJourney(context, ref) {
  await context.session.api.call(ref, 'space.delete');
  await personalOf(context)?.spaces.remove(ref).catch(() => {});
}

export async function leaveJourney(context, ref) {
  try { await context.session.api.call(ref, 'leave'); } catch (error) { if (error?.code !== 'not_member') throw error; }
  await personalOf(context)?.spaces.remove(ref).catch(() => {});
}

/** A translated message for a failed journey action (402, 403, 409, offline and the rest). */
export function errorText(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number.isInteger(error?.status) ? error.status : null;
  if (code === 'email_unverified') return t('journey.errEmail');
  if (code === 'owner_credit') return t('journey.errOwnerCredit');
  if (status === 402 || code === 'caller_credit' || code === 'insufficient_funds') return t('journey.errCredit');
  if (['worker_starting', 'worker_missing', 'worker_stale', 'worker_lost'].includes(code)) return t('journey.errStarting');
  if (code === 'worker_outdated' || status === 426) return t('journey.errOutdated');
  if (code === 'space_not_found' || code === 'gone' || status === 404) return t('journey.errGone');
  if (code === 'account_changed' || status === 401) return t('journey.errAccount');
  if (status === 403 || code === 'forbidden' || code === 'not_member') return t('journey.errForbidden');
  if (status === 409) return t('journey.errConflict');
  if (status === 429 || code === 'rate_limited') return t('journey.errRateLimited');
  if (status === 413 || code === 'space_full') return t('journey.errFull');
  if (globalThis.navigator?.onLine === false || status === 0 || code === 'network' || code === 'timeout') return t('journey.errOffline');
  return t('journey.errGeneric');
}
