// KV shares as shipped in Puter (`puter.kv.share` and siblings, `/kv/shares`): levels, consent, labels, limits,
// cascading revokes and the `kv.share.received` notice. Error codes and order follow the platform.
import { MAX_KEY_SIZE, bytes, error, isObject } from './shared.js';

export const LEVELS = ['watch', 'read', 'write'];
export const HANDLE_PREFIX = 'kvh-';
/** The store key limit minus the longest read/write prefix, so holders learn nothing about the prefix length. */
export const HANDLE_KEY_MAX = MAX_KEY_SIZE - 256;
const PERMISSION_MAX = 255;
const SEGMENT = /^[a-z0-9_.-]+$/;
const LABEL_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const LABEL_MARKS = /\p{M}{4,}/u;
const NOTICES_PER_HOUR = 5;
const LIST_DEFAULT = 50;
const LIST_CAP = 200;
// Live handles an account may hold out (paid, free), across apps and per app.
const PER_USER = [512, 200];
const PER_APP = [512, 128];

const seconds = env => Math.floor(env.now() / 1000);
const rank = access => LEVELS.indexOf(access);
const invalidPrefix = message => error('invalid_kv_share_prefix', 400, message);
export const isHandleId = value => typeof value === 'string' && value.startsWith(HANDLE_PREFIX) && value.length > HANDLE_PREFIX.length;
const unknownShare = id => error('subject_does_not_exist', 404, `No such handle: ${id}`);

/** `[segments]` of a share prefix, refused the way `assertShareablePrefix` refuses. */
export function prefixSegments(prefix) {
  if (typeof prefix !== 'string') throw invalidPrefix('`prefix` must be a string');
  if (/[*?]/.test(prefix)) throw invalidPrefix('A share prefix is a key prefix, not a pattern');
  if (prefix.includes('\\')) throw invalidPrefix('A share prefix may not contain a backslash');
  const written = prefix.split(':');
  if (written.at(-1) === '') written.pop();
  if (written.some(segment => segment === '')) throw invalidPrefix('A share prefix may not have an empty key segment');
  if (!written.length) throw invalidPrefix('A share prefix may not be the whole namespace');
  return written;
}

const permissionLength = (owner, appUid, segments, access) => ['kv-share' + (access === 'watch' ? '' : `-${access}`), owner, appUid, ...segments].join(':').length;

export function parseLabel(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw error('kv_share_label_invalid', 400, '`label` must be a string');
  const label = value.trim();
  if (!label) return null;
  if (LABEL_FORBIDDEN.test(label) || LABEL_MARKS.test(label) || [...label].length > 128 || bytes(label) > 512) throw error('kv_share_label_invalid');
  return label;
}

/** A username, `{username}` or `{uid}`; an address is refused before any lookup. */
export function parseRecipient(value) {
  const named = username => {
    if (typeof username !== 'string' || !username.trim()) throw error('invalid_recipient');
    if (username.includes('@')) throw error('invalid_recipient', 400, '`recipient` must be a username, not an email address');
    return { username: username.trim() };
  };
  if (typeof value === 'string') return named(value);
  if (isObject(value)) {
    if (value.username !== undefined) return named(value.username);
    if (typeof value.uid === 'string' && value.uid.trim()) return { uid: value.uid.trim() };
  }
  throw error('invalid_recipient');
}

/** The consent an app needs to share `segments` at `access`: a `kvShare` grant on the same or a wider prefix at that level or higher. */
export function delegated(env, ctx, segments, access) {
  const grants = env.consents.get(`${ctx.uid}|${ctx.appUid}`) ?? [];
  return grants.some(grant => rank(grant.access) >= rank(access) && grant.segments.length <= segments.length && grant.segments.every((segment, i) => segment === segments[i]));
}

/** `puter.perms.request('kvShare', {prefix, access})` validation, as the SDK does it before prompting. */
export function consentRequest(ctx, details) {
  const invalid = message => error('invalid_argument', 400, message);
  if (!isObject(details) || Object.keys(details).some(key => !['prefix', 'access'].includes(key))) throw invalid('kvShare takes { prefix, access }');
  const access = details.access ?? 'watch';
  if (!LEVELS.includes(access)) throw invalid('access must be one of: watch, read, write');
  let segments;
  try { segments = prefixSegments(details.prefix); } catch (cause) { throw invalid(cause.message); }
  if (segments.some(segment => !SEGMENT.test(segment))) throw invalid('`prefix` may only contain lowercase letters (a-z), digits, `_`, `.` and `-` between its `:` separators');
  if (!ctx.appUid) throw invalid('only an app can ask to share the data it keeps');
  if (permissionLength(ctx.uid, ctx.appUid, segments, access) + 'manage:'.length > PERMISSION_MAX) throw invalid('`prefix` is too long');
  return { segments, access };
}

/** The deprecated permission-string form, `manage:kv-share[-read|-write]:<uuid>:<appUid>:<segments>`. */
export function consentFromPermission(ctx, permission) {
  const match = typeof permission === 'string' ? /^manage:kv-share(?:-(read|write))?:([^:]+):([^:]+):(.+)$/.exec(permission) : null;
  if (!match || match[2] !== ctx.uid || match[3] !== ctx.appUid) return null;
  return consentRequest(ctx, { prefix: match[4], access: match[1] ?? 'watch' });
}

export function grantConsent(env, ctx, { segments, access }) {
  const key = `${ctx.uid}|${ctx.appUid}`;
  const grants = (env.consents.get(key) ?? []).filter(grant => !(grant.segments.join(':') === segments.join(':')));
  grants.push({ segments, access });
  env.consents.set(key, grants);
}

const live = (env, handle) => handle.revokedAt === null && !env.removedUsers.has(handle.uid) && !env.removedUsers.has(handle.holder) && !env.removedApps.has(handle.appUid);

function view(env, handle) {
  return { handle: handle.handle, prefix: handle.prefix, access: handle.access, appUid: handle.appUid, holder: env.users.get(handle.holder)?.username ?? null, label: handle.label, createdAt: handle.createdAt };
}

function notifyReceived(env, handle) {
  if (!handle.appUid) return;
  const key = `${handle.uid}|${handle.holder}`;
  const times = (env.shareNotices.get(key) ?? []).filter(at => at > env.now() - 3_600_000);
  if (times.length >= NOTICES_PER_HOUR) return;
  times.push(env.now()); env.shareNotices.set(key, times);
  env.notify?.(handle.holder, { type: 'kv.share.received', handle: handle.handle, access: handle.access, label: handle.label, createdAt: handle.createdAt }, handle.appUid);
}

/** `POST /kv/shares` (default `read`) and the legacy `POST /events/kv-handles` (default `watch`). */
export function mintHandle(env, ctx, args, defaultAccess) {
  const access = args.access ?? defaultAccess;
  if (!LEVELS.includes(access)) throw error('kv_share_access_invalid', 400, '`access` must be `watch`, `read` or `write`');
  if (!env.flags.shareHandles) throw access === 'watch' ? error('events_kv_handles_disabled', 403) : error('kv_handles_disabled', 403);
  if (ctx.restricted || !ctx.uid) throw error('events_kv_handle_owner_only', 403);
  const owner = env.users.get(ctx.uid);
  if (owner?.email_confirmed === false) throw error('account_is_not_verified', 400);
  const segments = prefixSegments(args.prefix);
  const prefix = `${segments.join(':')}:`;
  const label = parseLabel(args.label);
  if (args.appUuid != null && args.appUuid !== '' && args.appUuid !== ctx.appUid) throw error('events_kv_handle_outside_namespace', 403);
  const appUid = ctx.appUid;
  if (permissionLength(ctx.uid, appUid, segments, access) > PERMISSION_MAX || (access !== 'watch' && bytes(prefix) > 256)) throw invalidPrefix(`With \`${access}\` access, this share prefix is too long`);
  if (appUid && !delegated(env, ctx, segments, access)) throw error('events_kv_handle_not_delegated', 403);
  const wanted = parseRecipient(args.recipient);
  const target = wanted.uid ? env.users.get(wanted.uid) : [...env.users.values()].find(u => u.username.toLowerCase() === wanted.username.toLowerCase());
  if (!target || env.removedUsers.has(target.uuid)) throw error('subject_does_not_exist', 404, 'user_does_not_exist');
  if (owner?.temporary) throw error('events_kv_handle_requires_account', 403);
  const refuses = () => target.refusesShares === true || (target.blocks ?? []).some(who => who === ctx.uid || who === owner?.username);
  const existing = [...env.handles.values()].find(h => live(env, h) && h.uid === ctx.uid && h.holder === target.uuid && h.appUid === appUid && h.prefix === prefix);
  if (existing) {
    const raises = rank(access) > rank(existing.access);
    const relabels = label !== undefined && label !== null && label !== existing.label;
    if ((raises || relabels) && refuses()) throw error('recipient_not_accepting_shares', 403);
    existing.access = access;
    if (label !== undefined) existing.label = label;
    return view(env, existing);
  }
  if (segments.some(segment => !SEGMENT.test(segment))) throw invalidPrefix('A share prefix may only contain lowercase letters (a-z), digits, `_`, `.` and `-` between its `:` separators');
  if ([...env.handles.values()].some(h => live(env, h) && h.uid === ctx.uid && h.holder === target.uuid && h.appUid === appUid && h.prefix.toLowerCase() === prefix.toLowerCase())) throw invalidPrefix('This user already has a share of a prefix that differs from this one only in letter case');
  if (refuses()) throw error('recipient_not_accepting_shares', 403);
  if (target.uuid === ctx.uid) throw error('bad_request', 400, 'You cannot share with yourself');
  const paid = owner?.paid ? 0 : 1;
  const held = [...env.handles.values()].filter(h => live(env, h) && h.uid === ctx.uid);
  if (held.length >= PER_USER[paid]) throw error('events_kv_handle_limit_reached', 409);
  if (held.filter(h => h.appUid === appUid).length >= (env.options.maxHandles ?? PER_APP[paid])) throw error('events_kv_handle_limit_reached', 409);
  const handle = { handle: `${HANDLE_PREFIX}${env.uuid()}`, seq: env.handles.size + 1, uid: ctx.uid, appUid, prefix, holder: target.uuid, access, label: label ?? null, createdAt: seconds(env), revokedAt: null, revokedBy: null };
  env.handles.set(handle.handle, handle);
  notifyReceived(env, handle);
  return view(env, handle);
}

/** Retires `handle` and every live handle of the same owner and holder inside its prefix. */
function retire(env, handle, by) {
  const at = seconds(env);
  for (const other of env.handles.values()) {
    if (other === handle || !live(env, other) || other.uid !== handle.uid || other.holder !== handle.holder || other.appUid !== handle.appUid || !other.prefix.startsWith(handle.prefix)) continue;
    other.revokedAt = at; other.revokedBy = by;
  }
  handle.revokedAt = at; handle.revokedBy = by;
  return { handle: handle.handle, revokedAt: at };
}

/** `DELETE /kv/shares/:handle`: the owner revokes, the holder gives it up, anyone else is told it does not exist. Not gated on any flag. */
export function removeShare(env, ctx, id) {
  if (ctx.restricted || !ctx.uid) throw unknownShare(id);
  const handle = typeof id === 'string' ? env.handles.get(id) : undefined;
  if (handle?.uid === ctx.uid) {
    if (handle.appUid !== ctx.appUid) throw error('events_kv_handle_owner_only', 403);
    if (handle.appUid && !delegated(env, ctx, prefixSegments(handle.prefix), handle.access)) throw error('events_kv_handle_not_delegated', 403);
    if (handle.revokedAt !== null) return { handle: handle.handle, revokedAt: handle.revokedAt };
    return retire(env, handle, 'owner');
  }
  if (handle?.holder === ctx.uid && handle.appUid === ctx.appUid) {
    if (handle.revokedAt !== null) return { handle: handle.handle, revokedAt: handle.revokedAt };
    return retire(env, handle, 'holder');
  }
  throw unknownShare(id);
}

/** The legacy `DELETE /events/kv-handles/:handle`: owner only. */
export function revokeHandle(env, ctx, id) {
  const handle = typeof id === 'string' ? env.handles.get(id) : undefined;
  if (!handle || handle.uid !== ctx.uid) throw unknownShare(id);
  return removeShare(env, ctx, id);
}

/** Retires every live handle in a deleted app's namespace as the platform's. */
export function retireApp(env, appUid) {
  const at = seconds(env);
  for (const handle of env.handles.values()) if (handle.appUid === appUid && handle.revokedAt === null) { handle.revokedAt = at; handle.revokedBy = 'system'; }
}

function page(items, options) {
  if (!isObject(options)) options = {};
  let limit = LIST_DEFAULT;
  if (options.limit !== undefined && options.limit !== null) {
    const parsed = Number(options.limit);
    if (!Number.isFinite(parsed) || parsed <= 0) throw error('bad_request', 400, 'limit must be a positive number');
    limit = Math.min(Math.floor(parsed), LIST_CAP);
  }
  let start = 0;
  if (options.cursor != null && options.cursor !== '') {
    const match = typeof options.cursor === 'string' ? /^s(\d+)$/.exec(options.cursor) : null;
    if (!match) throw error('bad_request', 400, 'invalid cursor');
    start = Number(match[1]);
  }
  const sorted = items.sort((a, b) => a.seq - b.seq);
  const rest = sorted.filter(item => item.seq > start);
  const chosen = rest.slice(0, limit);
  return { chosen, cursor: rest.length > limit ? `s${chosen.at(-1).seq}` : undefined, total: options.includeTotal === true ? sorted.length : undefined };
}

const shaped = ({ chosen, cursor, total }, map) => ({ items: chosen.map(map), ...(cursor ? { cursor } : {}), ...(total !== undefined ? { total } : {}) });

/** `GET /kv/shares/with-me`: live shares in this app, never the owner or prefix. */
export function listHeld(env, ctx, options) {
  if (ctx.restricted || !ctx.uid) return { items: [] };
  const held = [...env.handles.values()].filter(h => h.holder === ctx.uid && h.appUid === ctx.appUid && live(env, h));
  return shaped(page(held, options), ({ handle, access, appUid, label, createdAt }) => ({ handle, access, appUid, label, createdAt }));
}

/** `GET /kv/shares`: everything this account shared in this app, stopped shares included. */
export function listGranted(env, ctx, options) {
  if (ctx.restricted || !ctx.uid) throw error('events_kv_handle_owner_only', 403);
  const granted = [...env.handles.values()].filter(h => h.uid === ctx.uid && h.appUid === ctx.appUid && !env.removedUsers.has(h.holder));
  return shaped(page(granted, options), handle => ({ ...view(env, handle), revokedAt: handle.revokedAt, revokedBy: handle.revokedBy }));
}

/** A live handle usable by `uid` (its holder or owner) in `appUid`, or undefined. */
export function usableHandle(env, id, uid, appUid) {
  const handle = isHandleId(id) ? env.handles.get(id) : undefined;
  if (!handle || !live(env, handle) || handle.appUid !== appUid || ![handle.uid, handle.holder].includes(uid)) return undefined;
  return handle;
}
