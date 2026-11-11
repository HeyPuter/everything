/**
 * Share for review: what the app and the owner's review worker agree on.
 * Pure helpers only (no Puter calls), so both sides and the tests import
 * them: roles, limits, ids, hashing and signing, worker addresses, review
 * links, token metadata and comment validation.
 */

export const PROTOCOL = 1;

/** Review roles, most capable first. Owners run the worker; commenters comment and reply; viewers watch. */
export const ROLES = ['owner', 'commenter', 'viewer'];
/** Roles an invite link or the owner can hand out. */
export const GUEST_ROLES = ['commenter', 'viewer'];
export const ROLE_LABELS = { owner: 'Owner', commenter: 'Can comment', viewer: 'Can view' };
export const canComment = (role) => role === 'owner' || role === 'commenter';
export const canResolve = canComment;
export const canManage = (role) => role === 'owner';
export const canView = (role) => ROLES.includes(role);

/** Limits the worker enforces (the app checks the same ones first for quick feedback). */
export const LIMITS = Object.freeze({
  text: 2000,
  title: 120,
  commentsPerMinute: 12,
  // Edits, deletes, resolves and reopens: one person flipping a thread could otherwise use up changesPerReview.
  changesPerMinute: 60,
  changesPerReview: 20000,
  versions: 50,
  members: 200,
  invites: 50,
  syncBatch: 100,
  failedJoins: 10,
  videoBytes: 4 * 1024 ** 3,
  // A pinned range covers at most this long (microseconds).
  rangeUs: 10 * 60 * 1_000_000,
});

/** Invite link lifetimes offered to the owner, in days. */
export const INVITE_DAYS = [1, 7, 30];
export const DAY = 24 * 60 * 60 * 1000;

/** Review, comment, project and client ids: short and URL safe. */
export const ID = /^[A-Za-z0-9_-]{6,64}$/;
/** Invite tokens: 32 random bytes in base64url. */
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const enc = new TextEncoder();

export function base64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random id with a prefix, e.g. randomId('r') -> "r_3kQ...". */
export function randomId(prefix = '', bytes = 12) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return `${prefix ? `${prefix}_` : ''}${base64url(b)}`;
}

/** A fresh invite token (never stored by the worker, only its hash). */
export function inviteToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return base64url(b);
}

/** SHA-256 hex of a string or bytes. */
export async function hash(value) {
  const data = typeof value === 'string' ? enc.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

function encode(bytes) {
  let text = '';
  for (let n = 0; n < bytes.length; n += 8192) text += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return btoa(text);
}

function decode(value, max) {
  if (typeof value !== 'string' || value.length > max || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid signature.');
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

/** A per-device signing key pair (JWK), kept in the person's own app KV. */
export async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
}

const imported = new Map();
function importKey(jwk, usage) {
  const id = usage + JSON.stringify(jwk);
  let key = imported.get(id);
  if (!key) {
    if (imported.size >= 256) imported.delete(imported.keys().next().value);
    key = crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [usage]);
    imported.set(id, key);
    key.catch(() => {
      if (imported.get(id) === key) imported.delete(id);
    });
  }
  return key;
}

export async function sign(jwk, value) {
  const key = await importKey(jwk, 'sign');
  return encode(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(JSON.stringify(value)))));
}

export async function verify(jwk, value, signature) {
  try {
    const key = await importKey(jwk, 'verify');
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, decode(signature, 200), enc.encode(JSON.stringify(value)));
  } catch {
    return false;
  }
}

/**
 * The origin of a review worker. Only https://<name>.puter.work is trusted:
 * a link that names any other host is refused before anything is sent to it.
 */
export function workerURL(value) {
  let url;
  try {
    url = new URL(String(value || '').includes('://') ? value : `https://${value}`);
  } catch {
    throw new Error('This review link points to an unknown server.');
  }
  if (url.protocol !== 'https:' || !/^[a-z0-9-]{1,63}\.puter\.work$/.test(url.hostname) || url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('This review link points to an unknown server.');
  }
  return url.origin;
}

/** True when value names a trusted worker origin. */
export function trustedServer(value) {
  try {
    workerURL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The link a reviewer opens: this app with #review=<id>&server=<host>[&invite=<token>].
 * The host is written without https:// to keep links short.
 */
export function reviewLink(base, server, review, token) {
  const url = new URL(base);
  const params = new URLSearchParams({ review, server: new URL(workerURL(server)).host });
  if (token) params.set('invite', token);
  url.hash = params.toString();
  return url.href;
}

/** Parse a review hash route; null when the hash is not one. Throws for a malformed review link. */
export function parseReviewHash(hashText) {
  const raw = String(hashText || '').replace(/^#/, '');
  if (!/(^|&)review=/.test(raw)) return null;
  const p = new URLSearchParams(raw);
  const review = p.get('review');
  if (!review || !ID.test(review)) throw new Error('This review link is not complete. Ask for a new link.');
  const server = workerURL(p.get('server'));
  const token = p.get('invite');
  if (token !== null && !TOKEN.test(token)) throw new Error('This invite link is not complete. Ask for a new link.');
  return { review, server, token: token || null };
}

/**
 * Metadata of a Puter token (JWT payload), for routing decisions only.
 * Puter compresses some claim names on the wire; both spellings are read.
 * Nothing here is trusted until Puter itself accepts the token.
 */
export function tokenClaims(token) {
  try {
    const part = String(token).split('.')[1];
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return {};
    if ((claims.t !== undefined && claims.type !== undefined) || (claims.uu !== undefined && claims.user_uid !== undefined)) return {};
    const type = claims.t === undefined ? claims.type : { t: 'access-token', au: 'app-under-user', s: 'session' }[claims.t];
    const subject = claims.uu ?? claims.user_uid;
    let userUid;
    const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
    if (typeof subject === 'string') {
      if (uuid.test(subject)) userUid = subject.toLowerCase();
      else if (claims.uu !== undefined) {
        const packed = atob(subject.replace(/-/g, '+').replace(/_/g, '/'));
        if (packed.length === 16) {
          const hex = [...packed].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
          userUid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
      }
    }
    return { ...claims, type, user_uid: userUid };
  } catch {
    return {};
  }
}

/** Comment text as stored: control characters (other than newlines and tabs) removed, trimmed. */
export function cleanText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f‪-‮⁦-⁩]/g, '')
    .trim();
}

/** Title as stored: one line, at most LIMITS.title characters. */
export function cleanTitle(text, fallback = 'Untitled') {
  // eslint-disable-next-line no-control-regex
  const s = String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMITS.title);
  return s || fallback;
}

/** Problem with comment text, or null when it is fine. */
export function textProblem(text) {
  const t = cleanText(text);
  if (!t) return 'Write something first.';
  if (t.length > LIMITS.text) return `Comments can be at most ${LIMITS.text} characters.`;
  return null;
}

/**
 * Validate a new comment against its version. Returns { ok, error?, value? }
 * where value holds the cleaned fields: { id, version, parent, text, t, end }.
 * Replies inherit their thread's time, so their t/end are ignored.
 */
export function validateComment(input, version) {
  const fail = (error) => ({ ok: false, error });
  if (!input || typeof input !== 'object') return fail('Invalid comment.');
  if (typeof input.id !== 'string' || !ID.test(input.id)) return fail('Invalid comment id.');
  const problem = textProblem(input.text);
  if (problem) return fail(problem);
  const text = cleanText(input.text);
  const parent = input.parent ?? null;
  if (parent !== null && (typeof parent !== 'string' || !ID.test(parent))) return fail('Invalid reply.');
  if (!version) return fail('That version does not exist.');
  if (parent) return { ok: true, value: { id: input.id, version: version.n, parent, text, t: null, end: null } };
  const duration = Math.max(0, Math.round(Number(version.duration) || 0));
  const t = Number(input.t);
  if (!Number.isInteger(t) || t < 0 || t > duration) return fail('The comment time is outside the video.');
  let end = input.end ?? null;
  if (end !== null) {
    end = Number(end);
    if (!Number.isInteger(end) || end <= t || end > duration) return fail('The comment range is outside the video.');
    if (end - t > LIMITS.rangeUs) return fail('A comment range can be at most 10 minutes.');
  }
  return { ok: true, value: { id: input.id, version: version.n, parent: null, text, t, end } };
}

/** Invite lifetime in days, defaulting to 7 for anything not offered. */
export function inviteDays(value) {
  const n = Number(value);
  return INVITE_DAYS.includes(n) ? n : 7;
}
