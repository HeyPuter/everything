// Shared definitions of the collaboration protocol, used by the browser and
// by the room worker: roles, encodings, signatures, links and peer topology.
// Adapted from the Whiteboard app's collaboration protocol in this repository.

export const PROTOCOL = 1;
/** Lifetime of a peer ticket; sessions check in well before it lapses. */
export const SESSION_TTL = 90_000;
/** Largest edit batch a commit or peer packet carries (base64 characters). */
export const MAX_UPDATE = 4_000_000;
/** Largest edit carried over a peer link (base64 characters). */
export const MAX_PEER_UPDATE = 48_000;
export const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export const HASH = /^[a-f0-9]{64}$/;
export const enc = new TextEncoder();

/** Roles, most capable first. Owners manage access; editors change the
 * document; commenters only discuss; viewers only look. */
export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';
export const ROLES: Role[] = ['owner', 'editor', 'commenter', 'viewer'];
export const INVITE_ROLES: Role[] = ['editor', 'commenter', 'viewer'];
export const canEdit = (role: string | undefined) => role === 'owner' || role === 'editor';
export const canComment = (role: string | undefined) => canEdit(role) || role === 'commenter';
export const canManage = (role: string | undefined) => role === 'owner';
export const roleLabel = (role: string) => ({ owner: 'Owner', editor: 'Can edit', commenter: 'Can comment', viewer: 'Can view' })[role] ?? role;

export type Jwk = JsonWebKey;
export type KeyPair = { privateKey: Jwk; publicKey: Jwk };

export function encode(bytes: Uint8Array) {
  let text = '';
  for (let n = 0; n < bytes.length; n += 8192) text += String.fromCharCode(...bytes.subarray(n, n + 8192));
  return btoa(text);
}
export function decode(value: unknown, max = Infinity): Uint8Array {
  if (typeof value !== 'string' || value.length > max || value.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value))
    throw new Error('Invalid collaboration data.');
  const text = atob(value);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}
export async function hash(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? enc.encode(value) : value;
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, '0')).join('');
}
export async function keyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  return {
    privateKey: await crypto.subtle.exportKey('jwk', pair.privateKey),
    publicKey: await crypto.subtle.exportKey('jwk', pair.publicKey),
  };
}
// Imported keys by JWK: peers sign and verify every packet with a few keys.
const imported = new Map<string, Promise<CryptoKey>>();
function importKey(jwk: Jwk, usage: 'sign' | 'verify') {
  const id = usage + JSON.stringify(jwk);
  let key = imported.get(id);
  if (!key) {
    if (imported.size >= 1024) imported.delete(imported.keys().next().value!);
    key = crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, [usage]);
    imported.set(id, key);
    const k = key;
    key.catch(() => {
      if (imported.get(id) === k) imported.delete(id);
    });
  }
  return key;
}
export async function sign(key: Jwk, value: unknown) {
  const k = await importKey(key, 'sign');
  return encode(new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, enc.encode(JSON.stringify(value)))));
}
export async function verify(key: Jwk, value: unknown, signature: unknown) {
  try {
    const k = await importKey(key, 'verify');
    return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, decode(signature, 200) as Uint8Array<ArrayBuffer>, enc.encode(JSON.stringify(value)));
  } catch {
    return false;
  }
}
/** The origin of a Puter worker; anything else is refused. */
export function workerURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !/^[a-z0-9-]+\.puter\.work$/.test(url.hostname) || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Invalid collaboration server address.');
  return url.origin;
}

/** A link that opens a shared document: in the URL hash, so it never reaches
 * a server log. `review` links open the lightweight review view. */
export type RoomLink = { server: string; room: string; token?: string; review?: boolean };
export function shareLink(base: string, link: RoomLink) {
  const url = new URL(base);
  url.hash = new URLSearchParams({
    'ps-server': workerURL(link.server),
    'ps-room': link.room,
    ...(link.token ? { 'ps-invite': link.token } : {}),
    ...(link.review ? { 'ps-review': '1' } : {}),
  }).toString();
  return url.href;
}
export function parseLink(value: string, base?: string): RoomLink | null {
  const url = new URL(value, base);
  const p = new URLSearchParams(url.hash.slice(1));
  const room = p.get('ps-room');
  if (!room) return null;
  if (!ID.test(room)) throw new Error('Invalid invitation link.');
  const token = p.get('ps-invite') ?? undefined;
  if (token !== undefined && !/^[a-zA-Z0-9-]{8,200}$/.test(token)) throw new Error('Invalid invitation link.');
  return { server: workerURL(p.get('ps-server') ?? ''), room, token, review: p.get('ps-review') === '1' };
}

/** Peer links for a roster: up to eight sessions link to each other; larger
 * rooms form groups of up to 32 whose two relays link to every member and
 * to all other relays (sessions in ID order, so every client agrees). */
export const PEER_GROUP = 32;
export function topology(roster: { session: string }[]) {
  const ids = roster.map((p) => p.session).sort();
  const edges = new Map(ids.map((id) => [id, new Set<string>()]));
  const relays: string[] = [];
  const link = (a: string, b: string) => {
    if (a && b && a !== b) {
      edges.get(a)!.add(b);
      edges.get(b)!.add(a);
    }
  };
  if (ids.length <= 8) {
    for (const a of ids) for (const b of ids) link(a, b);
    return { edges, relays: new Set(ids) };
  }
  for (let i = 0; i < ids.length; i += PEER_GROUP) {
    const group = ids.slice(i, i + PEER_GROUP),
      heads = group.slice(0, 2);
    relays.push(...heads);
    for (const member of group) for (const head of heads) link(member, head);
  }
  for (const a of relays) for (const b of relays) link(a, b);
  return { edges, relays: new Set(relays) };
}

/** A stable color for a person, from their account ID. */
export function colorFor(id: string) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return PERSON_COLORS[(h >>> 0) % PERSON_COLORS.length];
}
/** Colors for people: white text on each meets 4.5:1 (checked by tests). */
export const PERSON_COLORS = ['#b3261e', '#9a420a', '#1d6b3a', '#0b6a73', '#1e5aa8', '#5b3fb5', '#8e2f8a', '#a1214f', '#4d5d12', '#6f4310'];
export const initials = (name: string) =>
  (name.trim().split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?');
