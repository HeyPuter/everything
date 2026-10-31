import { serializeCalendar, tripData, tripEvents } from '../../src/lib/ics/index.js';
import { addDays, isDate } from '../../src/shared/dates.js';
import { isCurrency } from '../../src/shared/money.js';
import { CORS, bytesResponse, check, fail } from '../http.js';
import { HEX32, K, fileIdOf, randomHex, safeEqual, sha256Hex, spaceId, uuidOf } from '../keys.js';
import { WORKER_PATTERN } from '../../src/shared/protocol.js';
import { isId } from '../../src/shared/ids.js';
import { workerChange } from './commit.js';
import { MIN_METERED, RASTER, filePath, readStored, sniff, storageName } from './files.js';
import { DAY, HOUR, kvBudget, throttle } from './limits.js';
import { rebuildWait, snapshotJson } from './snapshot.js';
import { project } from './projection.js';
import { keepsLocation, stripLocation } from './exif.js';
import { thumbPath } from '../ops/trip/file.js';
import { kindOf, loadMember, loadRecords, loadSpace, requireCan, roleOf, titleOf } from './space.js';

const SHARE_FIELDS = Object.freeze({
  trip: ['on', 'plan', 'map', 'bookings', 'codes', 'packing', 'costs', 'chat', 'files', 'road'],
  collection: ['on'],
  journey: ['on', 'timeline', 'gallery', 'map', 'newestFirst'],
});
const HAS_EXP = new Set(['trip', 'collection', 'journey']);
// Kinds whose meta records when the current token was minted, so a device can tell whether its cached token is current.
const HAS_SINCE = new Set(['trip', 'journey']);
const PROJECTION_TTL = 30_000;
/** A journey's public link as stored in the trip's secrets, or null. */
export const journeyLinkOf = (value) => (value && typeof value === 'object' && WORKER_PATTERN.test(value.w ?? '') && isId(value.s) && HEX32.test(value.token ?? '')
  ? { w: value.w, s: value.s, token: value.token } : null);
const FEED_TTL = 60_000;
const FEED_REFRESH_MINUTES = 60;
const PUBLIC_FILE_BYTES = 10 * 1024 * 1024;
const PUBLIC_DAY_BYTES = 1024 ** 3;
const THUMB_TYPES = Object.freeze({ webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' });

export async function shareSet(w, ident, input) {
  const sid = spaceId(input.space);
  const { s, role } = await loadMember(w, ident, sid, { meta: true, fresh: true });
  requireCan(s, role, 'share.manage');
  throttle(w, `share:${sid}:${ident.uuid}`, 30, HOUR);
  const kind = kindOf(s);
  const set = {};
  for (const field of SHARE_FIELDS[kind]) if (Object.hasOwn(input, field)) { check(typeof input[field] === 'boolean', 'invalid_share'); set[`share.${field}`] = input[field]; }
  if (kind === 'trip' && Object.hasOwn(input, 'cur')) { check(input.cur === null || isCurrency(input.cur), 'invalid_share'); set['share.cur'] = input.cur; }
  let journeyLink;
  if (kind === 'trip' && Object.hasOwn(input, 'journey')) {
    journeyLink = input.journey === null ? null : journeyLinkOf(input.journey);
    check(input.journey === null || journeyLink, 'invalid_share');
    set['share.journey'] = Boolean(journeyLink);
  }
  if (Object.hasOwn(input, 'exp')) {
    check(input.exp === null || (Number.isSafeInteger(input.exp) && input.exp > w.now()), 'invalid_expiry');
    if (HAS_EXP.has(kind)) set['share.exp'] = input.exp;
  }
  const secrets = (await w.kv.get(K.secrets(sid))) ?? {};
  const update = {};
  let token;
  if (input.revoke === true) {
    set['share.on'] = false;
    Object.assign(update, { shareTokenHash: null, shareExp: null });
  } else if (input.rotate === true || (input.on === true && !secrets.shareTokenHash)) {
    token = randomHex(16);
    update.shareTokenHash = await sha256Hex(token);
    if (HAS_SINCE.has(kind)) set['share.since'] = w.now();
  }
  if (Object.hasOwn(input, 'exp') && input.revoke !== true) update.shareExp = input.exp;
  if (journeyLink !== undefined) update.journeyLink = journeyLink;
  if (Object.keys(update).length) await w.kv.update(K.secrets(sid), update);
  const result = Object.keys(set).length
    ? await workerChange(w, sid, ident.uuid, [{ t: 'meta', id: 'meta', set }], { kind })
    : null;
  for (const key of [...w.projections.keys()]) if (key.startsWith(`${sid}:`)) w.projections.delete(key);
  w.publicState.delete(sid);
  const meta = result?.ents.find((entity) => entity.t === 'meta') ?? s.meta;
  return { share: meta?.share ?? {}, rev: result?.rev ?? s.rev ?? 0, ...(token ? { token } : {}) };
}

/**
 * Per-member ICS feed token. Returns the token only when created or rotated. `scope: 'all'` manages a second token
 * that only the member's own "all my trips" feed uses, so subscribing there never rotates the trip's own link.
 */
export async function feedSet(w, ident, input) {
  const sid = spaceId(input.space);
  await loadMember(w, ident, sid);
  throttle(w, `feed:${sid}:${ident.uuid}`, 10, HOUR);
  check(input.scope === undefined || input.scope === 'all', 'invalid_scope');
  const all = input.scope === 'all';
  const key = all ? K.feedAll(sid, ident.uuid) : K.feed(sid, ident.uuid);
  const scope = all ? { scope: 'all' } : {};
  w.feeds.delete(`${sid}:${ident.uuid}`);
  if (input.revoke === true) { await w.kv.del(key); return { revoked: true, ...scope }; }
  if (input.rotate !== true && (await w.kv.get(key))) return { exists: true, ...scope };
  const token = randomHex(16);
  await w.kv.set(key, { tokenHash: await sha256Hex(token), created: w.now() });
  return { token, path: `/ics/${sid}/${ident.uuid}/${token}.ics`, ...scope };
}

/** Token checks shared by `/pub` routes; never touches the ACL or member records. */
async function publicAccess(w, sid, token) {
  if (typeof token !== 'string' || !HEX32.test(token)) fail('not_found', 404);
  throttle(w, `pub:${sid}:${token}`, 60, 60_000);
  // Spaces this worker does not host cost no reads.
  if (!Object.hasOwn(await w.hosted([sid]), sid)) fail('not_found', 404);
  const hash = await sha256Hex(token);
  const cacheKey = `${sid}:${hash}`;
  const cached = w.projections.get(cacheKey);
  if (cached && w.now() - cached.at < PROJECTION_TTL && !(cached.value.exp !== null && cached.value.exp <= w.now())) return cached.value;
  // Token-check inputs are cached too, so guessed tokens cost the owner no reads.
  let state = w.publicState.get(sid);
  if (!state || w.now() - state.at >= PROJECTION_TTL) {
    // Failed tokens can hold back a state refresh, but never one for the token the last state accepted.
    const known = typeof state?.secrets?.shareTokenHash === 'string' && safeEqual(hash, state.secrets.shareTokenHash);
    if (!known && !w.limiter.check(`pubbad:${sid}`, 600, 60_000)) fail('rate_limited', 429, { retryAfter: 60 });
    const [secretsValue, metaValue, revValue, scrubbed] = await w.kv.getMany([K.secrets(sid), K.entity(sid, 'meta', 'meta'), K.rev(sid), K.scrub(sid)]);
    state = { at: w.now(), secrets: secretsValue, meta: metaValue, rev: revValue, clean: scrubbed };
    w.publicState.set(sid, state);
  }
  const { secrets, meta, rev, clean } = state;
  const kind = secrets?.k;
  const expiry = Math.min(secrets?.shareExp || Infinity, meta?.share?.exp || Infinity);
  if (!secrets?.shareTokenHash || !safeEqual(hash, secrets.shareTokenHash) || !meta?.share?.on || !kind || expiry <= w.now()) {
    w.limiter.take(`pubbad:${sid}`, 600, 60_000);
    fail('not_found', 404);
  }
  await kvBudget(w, sid, 'pub', hash.slice(0, 32), { windowMs: HOUR, limit: 600 });
  const snapshot = await snapshotJson(w, sid, kind, { rev: rev ?? 0, clean });
  if (!snapshot) fail('snapshot_pending', 503, { retryAfter: Math.min(10, rebuildWait(w)) });
  const exp = Number.isFinite(expiry) ? expiry : null;
  const projection = project(snapshot, kind, meta.share, { meta, exp });
  // The attached journey's own public link, so this one link covers both.
  const journey = kind === 'trip' && meta.share.journey === true ? journeyLinkOf(secrets.journeyLink) : null;
  const body = JSON.stringify({ ok: true, ...projection, ...(journey ? { journey } : {}) });
  // Without the map, served images lose their embedded location too.
  const value = { body, etag: `"${(await sha256Hex(body)).slice(0, 32)}"`, files: new Set(projection.files), exp, hash, strip: projection.share.map !== true };
  w.projections.set(cacheKey, { at: w.now(), value, weight: body.length });
  return value;
}

/** Seconds a response may be cached: `limit`, cut short by the link's expiry. */
const maxAge = (w, exp, limit) => (exp === null ? limit : Math.max(0, Math.min(limit, Math.floor((exp - w.now()) / 1000))));

/** True when an `If-None-Match` header names `etag` (weak comparison, as for GET). */
export function etagMatches(header, etag) {
  if (typeof header !== 'string' || !header) return false;
  const bare = etag.replace(/^W\//, '');
  return header.split(',').some((item) => { const tag = item.trim(); return tag === '*' || tag.replace(/^W\//, '') === bare; });
}

export async function publicView(w, params, request) {
  const sid = spaceId(params.space);
  const { body, etag, exp } = await publicAccess(w, sid, params.token);
  const headers = {
    ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, max-age=${maxAge(w, exp, 30)}`,
    ETag: etag, 'X-Content-Type-Options': 'nosniff',
  };
  if (etagMatches(request?.headers?.get('if-none-match'), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}

/** Raster images inline; anything else as a download. Never renders SVG or HTML. */
export async function publicFile(w, params) {
  const sid = spaceId(params.space);
  const fileId = fileIdOf(params.fileId);
  const { files, hash, exp, strip } = await publicAccess(w, sid, params.token);
  if (!files.has(fileId)) fail('not_found', 404);
  const entity = await w.kv.get(K.entity(sid, 'file', fileId));
  if (!entity || entity.deleted || entity.trashed) fail('not_found', 404);
  if (!(entity.size <= PUBLIC_FILE_BYTES)) fail('file_too_large', 413);
  await kvBudget(w, sid, 'pubb', hash.slice(0, 32), { windowMs: DAY, limit: PUBLIC_DAY_BYTES, amount: Math.max(MIN_METERED, entity.size) });
  const blob = await readStored(w, filePath(sid, fileId, entity));
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const raster = Object.hasOwn(RASTER, entity.mime) && sniff(bytes.subarray(0, 4096)) === RASTER[entity.mime];
  if (strip && !raster && keepsLocation(entity.mime)) fail('not_found', 404);
  const served = raster && strip ? stripLocation(bytes, entity.mime) : bytes;
  if (!served) fail('image_unreadable', 415);
  const filename = storageName(entity.name).replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_');
  return bytesResponse(served, {
    type: raster ? entity.mime : 'application/octet-stream',
    headers: {
      'Cache-Control': `public, max-age=${maxAge(w, exp, 300)}`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      ...(raster ? {} : { 'Content-Disposition': `attachment; filename="${filename}"` }),
    },
  });
}

/** The browser-made thumbnail of a servable image. Thumbnails are re-encoded on upload, so they carry no metadata. */
export async function publicThumb(w, params) {
  const sid = spaceId(params.space);
  const fileId = fileIdOf(params.fileId);
  const { files, hash, exp } = await publicAccess(w, sid, params.token);
  if (!files.has(fileId)) fail('not_found', 404);
  const entity = await w.kv.get(K.entity(sid, 'file', fileId));
  if (!entity || entity.deleted || entity.trashed || !entity.thumb) fail('not_found', 404);
  await kvBudget(w, sid, 'pubb', hash.slice(0, 32), { windowMs: DAY, limit: PUBLIC_DAY_BYTES, amount: MIN_METERED });
  const bytes = new Uint8Array(await (await readStored(w, thumbPath(sid, fileId))).arrayBuffer());
  const type = THUMB_TYPES[sniff(bytes.subarray(0, 4096))];
  if (!type) fail('not_found', 404);
  return bytesResponse(bytes, {
    type, headers: { 'Cache-Control': `public, max-age=${maxAge(w, exp, 300)}`, 'Content-Security-Policy': "default-src 'none'; sandbox" },
  });
}

/** Per-member calendar of a space. Trips add their plan, bookings, stays and the member's open to-dos. */
export function calendar(sid, kind, meta, stamp, { ents = [], member = null, days = true, alarms = true } = {}) {
  const data = kind === 'trip' ? { ...tripData(ents), meta: meta ?? {} } : { meta: meta ?? {} };
  const events = tripEvents(data, { space: sid, member, days, alarms });
  return serializeCalendar({ name: titleOf(kind, meta) ?? '', events, stamp, refresh: FEED_REFRESH_MINUTES });
}

/** True for an archived trip, or one whose last day is more than `days` days before `now`. */
export function endedLongAgo(meta, now, days) {
  if (meta?.archived === true) return true;
  const last = isDate(meta?.end) ? meta.end : isDate(meta?.start) ? addDays(meta.start, Math.max(0, (Number.isSafeInteger(meta.dayCount) ? meta.dayCount : 1) - 1)) : null;
  return Boolean(last) && addDays(last, days) < new Date(now).toISOString().slice(0, 10);
}

/**
 * One member's calendar of a space, `{body, etag}`, built from the snapshot and cached per snapshot and options, or
 * null when the uuid is not an active member. `recent` (days) empties the calendar of an archived or long-ended trip.
 */
export async function memberCalendar(w, sid, uuid, { days = true, alarms = true, recent = 0 } = {}) {
  const s = await loadSpace(w, sid, { meta: true, rev: true });
  await loadRecords(w, sid, [uuid]);
  if (!roleOf(s, uuid)) return null;
  const kind = kindOf(s);
  // A partial calendar would make subscribers drop events, so wait for the snapshot instead.
  const snapshot = await snapshotJson(w, sid, kind, { rev: s.rev ?? 0 });
  if (!snapshot) fail('snapshot_pending', 503, { retryAfter: 60 });
  const meta = snapshot.ents?.find((entity) => entity.t === 'meta') ?? s.meta;
  const stale = recent > 0 && endedLongAgo(meta, w.now(), recent);
  const key = `ics:${sid}:${uuid}:${snapshot.rev}:${snapshot.at}:${days ? 1 : 0}${alarms ? 1 : 0}${stale ? ':x' : ''}`;
  let feed = w.projections.get(key)?.value;
  if (!feed) {
    const body = stale
      ? serializeCalendar({ name: titleOf(kind, meta) ?? '', events: [], stamp: snapshot.at, refresh: FEED_REFRESH_MINUTES })
      : calendar(sid, kind, meta, snapshot.at, { ents: snapshot.ents, member: uuid, days, alarms });
    feed = { body, etag: `"${(await sha256Hex(body)).slice(0, 32)}"` };
    w.projections.set(key, { at: w.now(), value: feed, weight: body.length });
  }
  return feed;
}

/**
 * Feed token records, cached so failed tokens hold back only uncached lookups, never a feed already checked here
 * nor the refresh of one whose token (`hash`) the cached records accepted.
 */
async function feedRecords(w, sid, uuid, hash) {
  const feedKey = `${sid}:${uuid}`;
  let cached = w.feeds.get(feedKey);
  if (!cached || w.now() - cached.at >= FEED_TTL) {
    const known = cached?.value?.some((record) => safeEqual(hash, record.tokenHash));
    if (!known && !w.limiter.check(`icsbad:${sid}`, 300, 60_000)) fail('rate_limited', 429, { retryAfter: 60 });
    const [own, all] = await w.kv.getMany([K.feed(sid, uuid), K.feedAll(sid, uuid)]);
    cached = { at: w.now(), value: [own, all].filter((record) => typeof record?.tokenHash === 'string') };
    w.feeds.set(feedKey, cached);
  }
  return cached.value;
}

/**
 * `GET /ics/<space>/<uuid>/<token>.ics[?days=0&alarms=0&recent=<days>]`, built from the snapshot and revalidated by
 * ETag. The token is the member's own feed token or their "all my trips" one.
 */
export async function icsFeed(w, params, request) {
  const sid = spaceId(params.space);
  const uuid = uuidOf(params.uuid);
  const match = /^([0-9a-f]{32})\.ics$/.exec(params.file ?? '');
  if (!match) fail('not_found', 404);
  throttle(w, `ics:${sid}:${uuid}`, 30, 60_000);
  if (!Object.hasOwn(await w.hosted([sid]), sid)) fail('not_found', 404);
  const hash = await sha256Hex(match[1]);
  const records = await feedRecords(w, sid, uuid, hash);
  if (!records.some((record) => safeEqual(hash, record.tokenHash))) { w.limiter.take(`icsbad:${sid}`, 300, 60_000); fail('not_found', 404); }
  const query = new URL(request?.url ?? 'https://feed.invalid/').searchParams;
  const recent = Number(query.get('recent'));
  const feed = await memberCalendar(w, sid, uuid, {
    days: query.get('days') !== '0', alarms: query.get('alarms') !== '0', recent: Number.isSafeInteger(recent) && recent > 0 && recent <= 3650 ? recent : 0,
  });
  if (!feed) fail('not_found', 404);
  const headers = { ...CORS, 'Cache-Control': 'max-age=900', ETag: feed.etag, 'X-Content-Type-Options': 'nosniff' };
  const known = request?.headers?.get('if-none-match') ?? '';
  if (known.split(',').some((tag) => tag.trim().replace(/^W\//, '') === feed.etag)) return new Response(null, { status: 304, headers });
  return new Response(feed.body, { status: 200, headers: { ...headers, 'Content-Type': 'text/calendar; charset=utf-8' } });
}
