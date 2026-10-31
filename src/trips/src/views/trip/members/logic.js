import { PERMISSIONS, can } from '../../../shared/perms.js';
import { WORKER_PATTERN } from '../../../shared/protocol.js';
import { isId } from '../../../shared/ids.js';

export const RANK = Object.freeze({ viewer: 0, editor: 1, owner: 2 });
export const DAY = 86_400_000;
export const EXPIRY_DAYS = Object.freeze([1, 7, 14, 30, 90]);
export const DEFAULT_EXPIRY_DAYS = 14;
export const MAX_USES = Object.freeze([2, 5, 10, 25, 50]);
export const DEFAULT_MAX_USES = 50;
export const LABEL_CHARS = 80;
export const GUEST_COLORS = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
const TOKEN = /^[0-9a-f]{32}$/;

export const isRole = (value) => typeof value === 'string' && Object.hasOwn(RANK, value);

/** The caller's member entity is fresher than the role cached when the space opened. */
export function roleIn(space, uid) {
  const entity = space.get('member', uid);
  if (entity && !entity.deleted && isRole(entity.role)) return entity.role;
  return isRole(space.role) ? space.role : null;
}

export function permsOf(space) {
  const perms = space.get('meta', 'meta')?.perms;
  return perms && typeof perms === 'object' && !Array.isArray(perms) ? perms : {};
}

/** Role, overrides and the derived abilities for the current user. */
export function access(space, uid) {
  const role = roleIn(space, uid);
  const perms = permsOf(space);
  return {
    uid, role, perms,
    manage: can(role, 'members.manage', perms),
    planEdit: can(role, 'plan.edit', perms),
    permsEdit: can(role, 'perms.edit', perms),
  };
}

/** Roles strictly below the caller's: what they may grant in invites and role changes. */
export const grantable = (role) => ['editor', 'viewer'].filter((item) => RANK[item] < (isRole(role) ? RANK[role] : -1));

/** The worker only lets a manager act on members below their own role, never on themselves. */
export function canManage(me, target) {
  return Boolean(target && isRole(target.role) && target.uid !== me.uid && me.manage && RANK[target.role] < RANK[me.role]);
}
export const canRevoke = (me, invite) => Boolean(me.manage && isRole(invite?.role) && RANK[invite.role] < RANK[me.role]);

/** Every action except ownership transfer, which has no choice. */
export const PERM_ACTIONS = Object.freeze(Object.keys(PERMISSIONS).filter((action) => action !== 'transfer'));

export function minimumFor(perms, action) {
  const rule = PERMISSIONS[action];
  return Object.hasOwn(perms, action) && rule.allowed.includes(perms[action]) ? perms[action] : rule.default;
}

/** Overrides after setting `action` to `minimum`: defaults are dropped, and `null` means none remain. */
export function nextPerms(perms, action, minimum) {
  const next = {};
  for (const [key, value] of Object.entries(perms)) {
    if (Object.hasOwn(PERMISSIONS, key) && PERMISSIONS[key].allowed.includes(value) && value !== PERMISSIONS[key].default) next[key] = value;
  }
  if (action) {
    if (!Object.hasOwn(PERMISSIONS, action) || !PERMISSIONS[action].allowed.includes(minimum)) throw new TypeError('invalid_permission');
    if (minimum === PERMISSIONS[action].default) delete next[action]; else next[action] = minimum;
  }
  return Object.keys(next).length ? next : null;
}

/** Members first by role, then by name; the caller first within their role. */
export function sortMembers(members, uid) {
  return [...members].sort((a, b) => (RANK[b.role] ?? -1) - (RANK[a.role] ?? -1) || (b.uid === uid) - (a.uid === uid)
    || String(a.name).localeCompare(String(b.name)));
}

export function cleanLabel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { error: 'required' };
  if ([...text].length > LABEL_CHARS || /[\u0000-\u001f\u007f]/.test(text)) return { error: 'tooLong' };
  return { value: text };
}

export const looksLikeEmail = (value) => typeof value === 'string' && value.length <= 254 && /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/.test(value);

/** `exp` for an invite: the 90-day maximum keeps an hour of slack for clock skew against the worker. */
export function expiryAt(days, now = Date.now()) {
  return now + days * DAY - (days >= 90 ? 3_600_000 : 0);
}

/** The shareable link. Puter's own launch parameters are dropped; other query parameters stay (the mock's `as`). */
export function inviteURL(base, ref, token) {
  if (!WORKER_PATTERN.test(ref?.w) || !isId(ref?.s) || !TOKEN.test(token)) throw new TypeError('invalid_invite_link');
  const url = new URL(base);
  for (const key of [...url.searchParams.keys()]) if (key.startsWith('puter.')) url.searchParams.delete(key);
  url.hash = `#/join/${ref.w}/${ref.s}/${token}`;
  return url.href;
}

export function mailtoURL(email, subject, body) {
  const address = encodeURIComponent(email).replace(/%40/g, '@');
  return `mailto:${address}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** The next guest color nobody uses yet, cycling when all are taken. */
export function nextGuestColor(guests) {
  const used = new Map(GUEST_COLORS.map((color) => [color, 0]));
  for (const guest of guests) if (used.has(guest.color)) used.set(guest.color, used.get(guest.color) + 1);
  return [...used].sort((a, b) => a[1] - b[1] || a[0] - b[0])[0][0];
}
