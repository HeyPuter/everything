import { isId, isUuid } from '../src/shared/ids.js';
import { entityKey } from '../src/shared/protocol.js';
import { check } from './http.js';

export const HEX32 = /^[0-9a-f]{32}$/;
export const HEX64 = /^[0-9a-f]{64}$/;

export const spaceId = (value) => { check(isId(value), 'invalid_space'); return value; };
export const uuidOf = (value) => { check(isUuid(value), 'invalid_uuid'); return value; };
export const fileIdOf = (value) => { check(isId(value), 'invalid_file'); return value; };

/** Every KV key the worker writes. `sp:` is worker-only; `shared:` is readable by members. */
export const K = Object.freeze({
  cfg: 'cfg',
  idx: 'idx',
  acl: (s) => `sp:${s}:acl`,
  member: (s, u) => `sp:${s}:m:${u}`,
  filesMode: (s) => `sp:${s}:fm`,
  purge: 'purge',
  secrets: (s) => `sp:${s}:secrets`,
  inv: (s, hash) => `sp:${s}:inv:${hash}`,
  invc: (s, hash) => `sp:${s}:invc:${hash}`,
  invs: (s) => `sp:${s}:invs`,
  rev: (s) => `sp:${s}:rev`,
  count: (s) => `sp:${s}:n`,
  feed: (s, u) => `sp:${s}:feed:${u}`,
  feedAll: (s, u) => `sp:${s}:feeda:${u}`,
  allFeed: 'allfeed',
  pres: (s) => `sp:${s}:pres`,
  handles: (s, u) => `sp:${s}:h:${u}`,
  opdone: (s, op) => `sp:${s}:opdone:${op}`,
  author: (s, t, id) => `sp:${s}:author:${t}:${id}`,
  pollvoted: (s, id) => `sp:${s}:pollvoted:${id}`,
  snapclaim: (s, now) => `sp:${s}:snapclaim:${Math.floor(now / 120_000)}`,
  maint: (s, now) => `sp:${s}:maint:${Math.floor(now / 3_600_000)}`,
  rl: (s, bucket, who, window) => `sp:${s}:rl:${bucket}:${who}:${window}`,
  fail: (s, u, now) => `sp:${s}:fail:${u}:${Math.floor(now / 600_000)}`,
  pending: (s) => `sp:${s}:pending`,
  scrub: (s) => `sp:${s}:scrub`,
  xin: (s) => `sp:${s}:xin`,
  seat: (s, u) => `sp:${s}:xseat:${u}`,
  entity: (s, t, id) => entityKey(s, t, id),
  ch: (s, rev, n) => `shared:${s}:ch:${rev}:${n}`,
  snap: (s) => `shared:${s}:snap`,
  sig: (s) => `shared:${s}:sig`,
  shared: (s) => `shared:${s}:`,
  region: (s, u) => `shared:${s}:u:${u}:`,
  stubPrefix: (invite) => `shared:inv:${invite}:`,
  stub: (invite) => `shared:inv:${invite}:info`,
});

export const P = Object.freeze({
  snapshot: (s) => `spaces/${s}/state/snapshot.json.gz`,
  files: (s) => `spaces/${s}/files`,
  file: (s, f) => `spaces/${s}/files/${f}`,
  inbox: (s) => `spaces/${s}/inbox`,
  inboxOf: (s, u) => `spaces/${s}/inbox/${u}`,
  space: (s) => `spaces/${s}`,
});

const encoder = new TextEncoder();
export const utf8 = (value) => encoder.encode(value);
export const byteLength = (value) => encoder.encode(typeof value === 'string' ? value : JSON.stringify(value)).length;

export async function sha256Hex(value) {
  const data = typeof value === 'string' ? utf8(value) : value;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const own = (object, key) => object != null && typeof object === 'object' && Object.hasOwn(object, key) ? object[key] : undefined;
