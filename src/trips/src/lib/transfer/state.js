// What an ownership transfer looks like from one member's side, read from the trip meta (data-model §3.1).
import { isId, isUuid } from '../../shared/ids.js';
import { WORKER_PATTERN } from '../../shared/protocol.js';

const DAY = 86_400_000;
/** A moved trip's old copy stays as a stub this long; then its old owner's app deletes it. */
export const GRACE = 30 * DAY;

/**
 * `{phase, transfer, movedTo, mine, expired}` where phase is `none`, `offered`, `moving` or `moved`.
 * `mine` is true when the offer names `uid`. An expired offer reads as `none` (with `expired`).
 */
export function transferState(meta, uid, { now = Date.now() } = {}) {
  const moved = meta?.movedTo;
  if (moved && WORKER_PATTERN.test(moved.w ?? '') && isId(moved.s)) {
    return { phase: 'moved', transfer: null, movedTo: { w: moved.w, s: moved.s, at: Number(moved.at) || 0, name: moved.name ?? '' }, mine: false, expired: false };
  }
  const transfer = meta?.transfer;
  if (!transfer || !isUuid(transfer.to)) return { phase: 'none', transfer: null, movedTo: null, mine: false, expired: false };
  const mine = transfer.to === uid;
  if (transfer.state === 'moving') return { phase: 'moving', transfer, movedTo: null, mine, expired: false };
  if (!(transfer.exp > now)) return { phase: 'none', transfer, movedTo: null, mine, expired: true };
  return { phase: 'offered', transfer, movedTo: null, mine, expired: false };
}

/** The new trip's ref for a moved trip. */
export const movedRef = (movedTo, kind = 'trip') => ({ w: movedTo.w, s: movedTo.s, k: kind });

/** When the old copy may be deleted, in ms. */
export const graceEnd = (movedTo) => (Number(movedTo?.at) || 0) + GRACE;

/** Editors and viewers the owner can offer the trip to: `[{uid, name, role}]`. */
export function candidates(members, ownerUid) {
  return members.filter((member) => member.uid !== ownerUid && (member.role === 'editor' || member.role === 'viewer'))
    .map((member) => ({ uid: member.uid, name: member.name, role: member.role }));
}
