import { WORKER_PATTERN } from '../../../../shared/protocol.js';
import { isId } from '../../../../shared/ids.js';
import { isCurrency } from '../../../../shared/money.js';
import { can } from '../../../../shared/perms.js';
import { permsOf, roleIn } from '../logic.js';

export const TOGGLES = Object.freeze(['plan', 'map', 'bookings', 'codes', 'packing', 'costs', 'chat', 'files']);
/** What a new public link shows: the plan, map and bookings; codes, costs and the rest stay off. */
export const DEFAULT_TOGGLES = Object.freeze({ plan: true, map: true, bookings: true, codes: false, packing: false, costs: false, chat: false, files: false });
export const SHARE_EXPIRY_DAYS = Object.freeze([1, 7, 30, 90]);
const TOKEN = /^[0-9a-f]{32}$/;

/** The trip's share settings with absent fields filled the way the worker reads them. */
export function shareOf(meta) {
  const share = meta?.share && typeof meta.share === 'object' ? meta.share : {};
  return {
    on: share.on === true,
    exp: Number.isSafeInteger(share.exp) ? share.exp : null,
    since: Number.isSafeInteger(share.since) ? share.since : null,
    cur: isCurrency(share.cur) ? share.cur : null,
    ...Object.fromEntries(TOGGLES.map((key) => [key, key === 'map' ? share.map !== false : share[key] === true])),
  };
}

/** Sections a viewer of the link actually sees, in display order. */
export function visibleSections(share) {
  const out = [];
  if (share.plan) out.push('plan');
  if (share.map && (share.plan || share.bookings)) out.push('map');
  if (share.bookings) out.push('bookings');
  if (share.codes && share.bookings) out.push('codes');
  for (const key of ['packing', 'costs', 'chat', 'files']) if (share[key]) out.push(key);
  return out;
}

export const canShare = (space, uid) => can(roleIn(space, uid), 'share.manage', permsOf(space));

/** The link to hand out. Puter launch parameters are dropped; other query parameters stay (the mock's `as`). */
export function publicURL(base, ref, token) {
  if (!WORKER_PATTERN.test(ref?.w) || !isId(ref?.s) || !TOKEN.test(token)) throw new TypeError('invalid_public_link');
  const url = new URL(base);
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('puter.')) url.searchParams.delete(key);
  url.hash = `#/s/${ref.w}/${ref.s}/${token}`;
  return url.href;
}

/** Device-local cache key for the last token this account minted for a trip (only its hash is stored by the worker). */
export const tokenKey = (ref) => `share:${ref.w}:${ref.s}`;

/** The cached token while it is still the trip's current one: the share is on and `since` matches its mint time. */
export function currentToken(record, share) {
  if (!share.on || !share.since || !record || record.since !== share.since || !TOKEN.test(record.token)) return null;
  return record.token;
}

export { expiryAt } from '../logic.js';

/** The fields to send for one toggle. Turning bookings off also turns codes off, so they never return unnoticed. */
export function togglePatch(share, field, value) {
  const patch = { [field]: value };
  if (field === 'bookings' && !value && share.codes) patch.codes = false;
  return patch;
}
