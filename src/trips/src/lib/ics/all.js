// The "all my trips" calendar from the client side: which trips it should hold and how to bring the user's worker
// up to date. The worker side is worker/ops/feed/all.js.
import { addDays, isDate } from '../../shared/dates.js';
import { WORKER_PATTERN, workerOrigin } from '../../shared/protocol.js';
import { isId } from '../../shared/ids.js';

export const ALL_FEED_DAYS = 90;
export const ALL_FEED_MAX = 100;
const PATH = /^\/feed\/[0-9a-f]{32}\.ics$/;

export const isAllFeedPath = (path) => typeof path === 'string' && PATH.test(path);
const refKey = (ref) => `${ref.w}/${ref.s}`;

/**
 * Trips from `me:spaces` the feed should hold: trips (not collections or journeys) whose cached end is at most 90 days
 * ago, newest first, at most 100. Archived trips are left to the worker, which empties their calendars.
 */
export function feedCandidates(spaces, { today, days = ALL_FEED_DAYS } = {}) {
  const cutoff = isDate(today) ? addDays(today, -days) : null;
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(spaces) ? spaces : []) {
    const ref = entry?.ref;
    if (ref?.k !== 'trip' || !WORKER_PATTERN.test(ref.w ?? '') || !isId(ref.s) || seen.has(refKey(ref))) continue;
    const last = isDate(entry.end) ? entry.end : isDate(entry.start) ? entry.start : null;
    if (cutoff && last && last < cutoff) continue;
    seen.add(refKey(ref));
    out.push(entry);
  }
  return out.sort((a, b) => String(b.start ?? '9999').localeCompare(String(a.start ?? '9999'))).slice(0, ALL_FEED_MAX);
}

/** What to change on the worker: `add` (candidates it lacks) and `remove` (refs it holds that are no longer wanted). */
export function feedChanges(registered, candidates) {
  const held = new Set((registered ?? []).map(refKey));
  const wanted = new Set(candidates.map((entry) => refKey(entry.ref)));
  return {
    add: candidates.filter((entry) => !held.has(refKey(entry.ref))),
    remove: (registered ?? []).filter((item) => !wanted.has(refKey(item))).map(({ w, s }) => ({ w, s })),
  };
}

/** Subscribe links for the merged feed: https, `webcal://` and Google Calendar's "add by URL". */
export function allFeedLinks(worker, path) {
  if (!isAllFeedPath(path)) return null;
  const https = `${workerOrigin(worker)}${path}`;
  const webcal = `webcal://${https.slice('https://'.length)}`;
  return { https, webcal, google: `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}` };
}

/**
 * Asks one trip's worker for the member's "all" feed token: `{token}` when there is one to register, or `{skip:
 * reason}`. A token made on another device cannot be read back, so it is rotated; a worker too old for scoped tokens
 * that already has a member feed is skipped (`outdated`) rather than rotating that feed.
 */
export async function scopedToken(call, ref) {
  let answer = await call(ref, 'feed.set', { scope: 'all' });
  if (answer?.exists && answer.scope === 'all') answer = await call(ref, 'feed.set', { scope: 'all', rotate: true });
  if (typeof answer?.token === 'string' && /^[0-9a-f]{32}$/.test(answer.token)) return { token: answer.token, scoped: answer.scope === 'all', path: answer.path };
  return { skip: answer?.exists ? 'outdated' : 'failed' };
}
