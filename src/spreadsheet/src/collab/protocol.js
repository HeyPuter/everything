/**
 * Shared definitions of the co-authoring protocol, used by the browser and by the room worker: roles,
 * encodings, signatures, invitation links, peer topology and people's colors. Adapted from the Whiteboard
 * app's collaboration protocol in this repository (by way of Photo Studio's port of it).
 */

export const PROTOCOL = 1;
/** Lifetime of a peer ticket; sessions check in well before it lapses. */
export const SESSION_TTL = 90_000;
/** Largest workbook state a checkpoint or a new room carries (characters of compressed base64). */
export const MAX_STATE = 16_000_000;
/** Largest change carried over a peer link (characters of JSON). */
export const MAX_PEER_CHANGE = 48_000;
export const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const enc = new TextEncoder();

/** Roles, most capable first. Owners manage access; editors change the workbook; viewers only look. */
export const ROLES = ['owner', 'editor', 'viewer'];
export const INVITE_ROLES = ['editor', 'viewer'];
export const canEdit = (role) => role === 'owner' || role === 'editor';
export const canManage = (role) => role === 'owner';
export const roleLabel = (role) => ({ owner: 'Owner', editor: 'Can edit', viewer: 'Can view' })[role] ?? role;

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
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** Bytes through a (de)compression stream. */
async function through(bytes, stream) {
  const out = new Response(new Response(bytes).body.pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** A workbook's JSON, gzipped and base64-encoded: how states travel and are kept. */
export async function packState(state) {
  return encode(await through(enc.encode(JSON.stringify(state)), new CompressionStream('gzip')));
}

/** The JSON a packed state holds; `limit` bounds the inflated size. */
export async function unpackState(text, limit = 200_000_000) {
  const bytes = await through(decode(text, MAX_STATE), new DecompressionStream('gzip'));
  if (bytes.length > limit) throw new Error('This workbook is too large to share.');
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function keyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey), publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}

// Imported keys by JWK: peers sign and verify every packet with a few keys.
const imported = new Map();
function importKey(jwk, usage) {
  const id = usage + JSON.stringify(jwk);
  let key = imported.get(id);
  if (!key) {
    if (imported.size >= 1024) imported.delete(imported.keys().next().value);
    key = crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [usage]);
    imported.set(id, key);
    key.catch(() => { if (imported.get(id) === key) imported.delete(id); });
  }
  return key;
}

export async function sign(key, value) {
  const k = await importKey(key, 'sign');
  return encode(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, enc.encode(JSON.stringify(value)))));
}

export async function verify(key, value, signature) {
  try {
    const k = await importKey(key, 'verify');
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, decode(signature, 200), enc.encode(JSON.stringify(value)));
  } catch {
    return false;
  }
}

/** The origin of a Puter worker; anything else is refused. */
export function workerURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.puter\.work$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Invalid collaboration server address.');
  }
  return url.origin;
}

/**
 * The address that opens a shared workbook: #/live/<room>?server=…&invite=…, in the hash, so it never
 * reaches a server log. Without an invitation it opens the workbook for people who are members already.
 */
export function shareLink(base, { server, room, token }) {
  const url = new URL(base);
  const params = new URLSearchParams({ server: workerURL(server), ...(token ? { invite: token } : {}) });
  url.hash = `#/live/${encodeURIComponent(room)}?${params}`;
  return url.href;
}

/** The room a #/live/ hash names, or null for another address; a malformed one throws. */
export function parseLiveHash(hash) {
  const h = String(hash || '').replace(/^#\/?/, '');
  if (!h.startsWith('live/')) return null;
  const q = h.indexOf('?');
  const room = decodeURIComponent(h.slice(5, q < 0 ? undefined : q));
  const params = new URLSearchParams(q < 0 ? '' : h.slice(q + 1));
  if (!ID.test(room)) throw new Error('Invalid invitation link.');
  const token = params.get('invite') ?? undefined;
  if (token !== undefined && !/^[a-zA-Z0-9-]{8,200}$/.test(token)) throw new Error('Invalid invitation link.');
  return { server: workerURL(params.get('server') ?? ''), room, token };
}

/**
 * Peer links for a roster: up to eight sessions link to each other; larger rooms form groups of up to 32
 * whose two relays link to every member and to all other relays (sessions in ID order, so all agree).
 */
export const PEER_GROUP = 32;
export function topology(roster) {
  const ids = roster.map((p) => p.session).sort();
  const edges = new Map(ids.map((id) => [id, new Set()]));
  const relays = [];
  const link = (a, b) => { if (a && b && a !== b) { edges.get(a).add(b); edges.get(b).add(a); } };
  if (ids.length <= 8) {
    for (const a of ids) for (const b of ids) link(a, b);
    return { edges, relays: new Set(ids) };
  }
  for (let i = 0; i < ids.length; i += PEER_GROUP) {
    const group = ids.slice(i, i + PEER_GROUP), heads = group.slice(0, 2);
    relays.push(...heads);
    for (const member of group) for (const head of heads) link(member, head);
  }
  for (const a of relays) for (const b of relays) link(a, b);
  return { edges, relays: new Set(relays) };
}

/** Colors for people, far apart in hue and none of them the green of this person's own selection; white text on each meets 4.5:1 (checked by tests). */
export const PERSON_COLORS = ['#c62828', '#1d4ed8', '#b45309', '#6d28d9', '#0e7490', '#be185d', '#475569', '#a21caf', '#7c2d12'];

const colorSlot = (id) => {
  let h = 2166136261;
  for (let i = 0; i < String(id).length; i++) h = Math.imul(h ^ String(id).charCodeAt(i), 16777619);
  return (h >>> 0) % PERSON_COLORS.length;
};

/** A stable color for a person, from their account ID. */
export const colorFor = (id) => PERSON_COLORS[colorSlot(id)];

/**
 * Colors for the people present together: each keeps their own color unless someone already has it, then takes
 * the next free one, so two people side by side on the grid never share a color while the palette lasts. The
 * order is by account ID, so every browser in the room hands out the same colors.
 */
export function colorsFor(ids) {
  const out = new Map(), taken = new Set();
  for (const id of [...new Set(ids)].sort()) {
    let slot = colorSlot(id);
    for (let step = 0; step < PERSON_COLORS.length && taken.has(slot); step++) slot = (slot + 1) % PERSON_COLORS.length;
    taken.add(slot);
    out.set(id, PERSON_COLORS[slot]);
  }
  return out;
}

export const initials = (name) => String(name || '').trim().split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
