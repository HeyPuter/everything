// "All my trips" calendar (spec §9 [3]), served by the user's own worker. The worker owner registers the "all" feed
// token of each of their trips (on this worker or on other people's), and `GET /feed/<token>.ics` merges those
// calendars. Trips on this worker are built from their snapshots; others are fetched from their workers' public
// `/ics` route, which leaves out archived trips and trips that ended long ago (`recent`).
import { isId, isUuid } from '../../../src/shared/ids.js';
import { pool } from '../../../src/shared/pool.js';
import { WORKER_PATTERN } from '../../../src/shared/protocol.js';
import { mergeCalendars } from '../../../src/lib/ics/merge.js';
import { readTextBounded } from '../../../src/services/core.js';
import { CORS, check, fail } from '../../http.js';
import { HEX32, K, randomHex, safeEqual, sha256Hex } from '../../keys.js';
import { HOUR, throttle } from '../../engine/limits.js';
import { etagMatches, memberCalendar } from '../../engine/public.js';

export const ALL_FEED_MAX = 100;
export const ALL_FEED_DAYS = 90;
const RECORD_TTL = 60_000;
const BODY_TTL = 10 * 60_000;
const REMOTE_TTL = 15 * 60_000;
const REMOTE_TIMEOUT = 8000;
const REMOTE_BYTES = 2 * 1024 * 1024;
const CONCURRENCY = 6;
const CALENDAR_NAME = 'All my trips';
const remote = new Map();

const refKey = (item) => `${item.w}/${item.s}`;

function cleanFeed(item, owner) {
  check(item && typeof item === 'object' && !Array.isArray(item), 'invalid_feed');
  check(typeof item.w === 'string' && WORKER_PATTERN.test(item.w) && isId(item.s) && isUuid(item.uuid) && item.uuid === owner, 'invalid_feed');
  check(typeof item.token === 'string' && HEX32.test(item.token), 'invalid_feed');
  check(item.title === undefined || (typeof item.title === 'string' && item.title.length <= 500), 'invalid_feed');
  return { w: item.w, s: item.s, uuid: item.uuid, token: item.token, ...(item.title ? { title: item.title } : {}) };
}

const listView = (record) => (record?.feeds ?? []).map(({ w, s, title }) => ({ w, s, ...(title ? { title } : {}) }));

/**
 * `feed.all` (worker owner only): `{add?: [{w, s, uuid, token, title?}], remove?: [{w, s}], rotate?, revoke?}` →
 * `{exists, feeds: [{w, s, title?}], token?, path?}`. The token comes back once, when created or rotated; it is created
 * with the first `add`.
 */
export async function feedAll(w, ident, input) {
  const owner = await w.owner();
  if (ident.uuid !== owner.uuid) fail('forbidden', 403);
  throttle(w, `feedall:${ident.uuid}`, 60, HOUR);
  const record = (await w.kv.get(K.allFeed)) ?? null;
  w.feeds.delete('allfeed');
  if (record?.tokenHash) w.projections.delete(`allfeed:${record.tokenHash}`);
  if (input.revoke === true) {
    if (record) await w.kv.del(K.allFeed);
    return { revoked: true, exists: false, feeds: [] };
  }
  let feeds = Array.isArray(record?.feeds) ? record.feeds : [];
  let changed = false;
  if (input.remove !== undefined) {
    check(Array.isArray(input.remove) && input.remove.length <= ALL_FEED_MAX * 2, 'invalid_feed');
    const drop = new Set(input.remove.filter((item) => item && typeof item.w === 'string' && isId(item.s)).map(refKey));
    const next = feeds.filter((item) => !drop.has(refKey(item)));
    changed ||= next.length !== feeds.length;
    feeds = next;
  }
  if (input.add !== undefined) {
    check(Array.isArray(input.add) && input.add.length <= ALL_FEED_MAX, 'invalid_feed');
    for (const raw of input.add) {
      const item = cleanFeed(raw, owner.uuid);
      feeds = [...feeds.filter((other) => refKey(other) !== refKey(item)), item];
      changed = true;
    }
  }
  check(feeds.length <= ALL_FEED_MAX, 'too_many_feeds', 413);
  let token = null;
  let tokenHash = record?.tokenHash ?? null;
  if (input.rotate === true || (!tokenHash && feeds.length)) {
    token = randomHex(16);
    tokenHash = await sha256Hex(token);
    changed = true;
  }
  if (changed && tokenHash) await w.kv.set(K.allFeed, { tokenHash, created: token ? w.now() : record?.created ?? w.now(), feeds });
  const next = { tokenHash, feeds };
  return { exists: Boolean(tokenHash), feeds: listView(next), ...(token ? { token, path: `/feed/${token}.ics` } : {}) };
}

/** A remote member feed, reusing the last copy for 15 minutes and revalidating it by ETag after that. */
async function remoteCalendar(w, feed) {
  const key = `${feed.w}/${feed.s}/${feed.token}`;
  const known = remote.get(key);
  if (known && w.now() - known.at < REMOTE_TTL) return known.body;
  const url = `https://${feed.w}.puter.work/ics/${feed.s}/${feed.uuid}/${feed.token}.ics?recent=${ALL_FEED_DAYS}`;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), REMOTE_TIMEOUT);
  try {
    const response = await globalThis.fetch(url, { redirect: 'error', signal: controller?.signal, headers: { accept: 'text/calendar', ...(known?.etag ? { 'if-none-match': known.etag } : {}) } });
    if (response.status === 304 && known) { remote.set(key, { ...known, at: w.now() }); return known.body; }
    if (response.status !== 200) return known?.body ?? null;
    // Read with a cap, so a feed without a length can't make the worker buffer an endless body.
    const body = await readTextBounded(response, REMOTE_BYTES, controller ? { signal: controller.signal } : {});
    if (remote.size > 500) remote.delete(remote.keys().next().value);
    remote.set(key, { body, etag: response.headers.get('etag') ?? null, at: w.now() });
    return body;
  } catch { return known?.body ?? null; } finally { clearTimeout(timer); }
}

async function localCalendar(w, feed) {
  try { return (await memberCalendar(w, feed.s, feed.uuid, { recent: ALL_FEED_DAYS }))?.body ?? null; } catch { return null; }
}

/** `GET /feed/<token>.ics`: the merged calendar, cached per isolate for ten minutes and revalidated by ETag. */
export async function allFeedRoute(w, params, request) {
  const match = /^([0-9a-f]{32})\.ics$/.exec(params.file ?? '');
  if (!match) fail('not_found', 404);
  throttle(w, `allfeed:${match[1].slice(0, 8)}`, 30, 60_000);
  const hash = await sha256Hex(match[1]);
  let cached = w.feeds.get('allfeed');
  if (!cached || w.now() - cached.at >= RECORD_TTL) {
    // Failed tokens never hold back the refresh for the token the cached record accepted.
    const known = typeof cached?.value?.tokenHash === 'string' && safeEqual(hash, cached.value.tokenHash);
    if (!known && !w.limiter.check('allfeedbad', 300, 60_000)) fail('rate_limited', 429, { retryAfter: 60 });
    cached = { at: w.now(), value: (await w.kv.get(K.allFeed)) ?? null };
    w.feeds.set('allfeed', cached);
  }
  const record = cached.value;
  if (!record?.tokenHash || !safeEqual(hash, record.tokenHash)) { w.limiter.take('allfeedbad', 300, 60_000); fail('not_found', 404); }
  const bodyKey = `allfeed:${hash}`;
  let feed = w.projections.get(bodyKey);
  if (!feed || w.now() - feed.at >= BODY_TTL) {
    const feeds = Array.isArray(record.feeds) ? record.feeds.slice(0, ALL_FEED_MAX) : [];
    const texts = await pool(feeds, CONCURRENCY, (item) => (item.w === w.workerName ? localCalendar(w, item) : remoteCalendar(w, item)));
    const { text } = mergeCalendars(texts.filter(Boolean), { name: CALENDAR_NAME, refresh: 60 });
    feed = { at: w.now(), value: { body: text, etag: `"${(await sha256Hex(text)).slice(0, 32)}"` }, weight: text.length };
    w.projections.set(bodyKey, feed);
  }
  const { body, etag } = feed.value;
  const headers = { ...CORS, 'Cache-Control': 'max-age=900', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
  if (etagMatches(request?.headers?.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers: { ...headers, 'Content-Type': 'text/calendar; charset=utf-8' } });
}

/** Test hook: forgets remote copies. */
export const resetAllFeedCache = () => remote.clear();
