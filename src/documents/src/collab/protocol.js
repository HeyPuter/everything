/**
 * Shared definitions of the co-editing protocol, used by the browser and by
 * the room worker: roles, encodings, signatures, links and person colors.
 * The design follows the Whiteboard and Photo Studio apps in this repository.
 */
export const PROTOCOL = 1;
/** Lifetime of a presence entry; sessions check in well before it lapses. */
export const PRESENCE_TTL = 30_000;
/** Largest edit batch a commit carries (base64 characters). */
export const MAX_UPDATE = 8_000_000;
/** Largest base document a room keeps (bytes). */
export const MAX_BASE_BYTES = 12 * 1024 * 1024;
export const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export const HASH = /^[a-f0-9]{64}$/;
const enc = new TextEncoder();

/** Roles, most capable first. Owners manage access; editors change the document; commenters only comment; viewers only read. */
export const ROLES = ['owner', 'editor', 'commenter', 'viewer'];
export const INVITE_ROLES = ['editor', 'commenter', 'viewer'];
export const canEdit = role => role === 'owner' || role === 'editor';
export const canComment = role => canEdit(role) || role === 'commenter';
export const canManage = role => role === 'owner';
export const roleLabel = role => ({ owner: 'Owner', editor: 'Can edit', commenter: 'Can comment', viewer: 'Can view' })[role] ?? role;

export function encode(bytes) {
  let text = '';
  for (let n = 0; n < bytes.length; n += 8192) text += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return btoa(text);
}
export function decode(value, max = Infinity) {
  if (typeof value !== 'string' || value.length > max || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('Invalid collaboration data.');
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}
export async function hash(value) {
  const bytes = typeof value === 'string' ? enc.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
}
export async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey), publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}
const imported = new Map();
function importKey(jwk, usage) {
  const id = usage + JSON.stringify(jwk);
  let key = imported.get(id);
  if (!key) {
    if (imported.size >= 256) imported.delete(imported.keys().next().value);
    key = crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [usage]);
    imported.set(id, key);
    key.catch(() => imported.delete(id));
  }
  return key;
}
export async function sign(key, value) {
  return encode(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(key, 'sign'), enc.encode(JSON.stringify(value)))));
}
export async function verify(key, value, signature) {
  try { return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await importKey(key, 'verify'), decode(signature, 200), enc.encode(JSON.stringify(value))); }
  catch { return false; }
}

/** The origin of a Puter worker; anything else is refused. */
export function workerURL(value) {
  const url = new URL(value);
  const local = /^(127\.0\.0\.1|localhost|[a-z0-9.-]+\.localhost)$/.test(url.hostname) && url.pathname.startsWith('/__collab');
  if (local) return `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.puter\.work$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid collaboration server address.');
  return url.origin;
}

/**
 * A link that opens a shared document. Everything is in the URL's fragment,
 * so an invitation never reaches a server log. `local` rooms live in this
 * browser only (BroadcastChannel; used by the playground and tests).
 */
export function shareLink(base, link) {
  const url = new URL(base);
  const params = new URLSearchParams();
  if (link.local) params.set('collab-local', link.room);
  else { params.set('collab-server', link.server); params.set('collab-room', link.room); }
  if (link.token) params.set('collab-invite', link.token);
  if (link.role) params.set('collab-role', link.role);
  url.hash = params.toString();
  return url.href;
}
export function parseLink(value, base) {
  const url = new URL(value, base);
  const p = new URLSearchParams(url.hash.slice(1));
  const local = p.get('collab-local');
  const room = local || p.get('collab-room');
  if (!room) return null;
  if (!ID.test(room)) throw new Error('Invalid invitation link.');
  const token = p.get('collab-invite') ?? undefined;
  if (token !== undefined && !/^[a-zA-Z0-9-]{8,200}$/.test(token)) throw new Error('Invalid invitation link.');
  const role = p.get('collab-role');
  return { local: !!local, server: local ? null : workerURL(p.get('collab-server') ?? ''), room, token, role: INVITE_ROLES.includes(role) ? role : undefined };
}

/** Colors for people; white text on each meets 4.5:1 (checked by tests). */
export const PERSON_COLORS = ['#b3261e', '#9a420a', '#1d6b3a', '#0b6a73', '#1e5aa8', '#5b3fb5', '#8e2f8a', '#a1214f', '#4d5d12', '#6f4310'];
export function colorFor(id) {
  let h = 2166136261;
  const text = String(id);
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return PERSON_COLORS[(h >>> 0) % PERSON_COLORS.length];
}
export const initials = name => (String(name || '').trim().split(/[\s._@-]+/).filter(Boolean).slice(0, 2).map(w => [...w][0].toUpperCase()).join('') || '?');
export const randomId = (bytes = 12) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(n => n.toString(16).padStart(2, '0')).join('');
