// Vacay keys in the user's own KV (data-model §3.4). Everything is under one shared prefix; shares and grants
// are written with `disableSharing` so holders never see them.
import { isDate } from '../../shared/dates.js';
import { isId } from '../../shared/ids.js';

export const PREFIX = 'vacay:';
export const PLAN = 'vacay:plan';
export const INDEX = 'vacay:idx';
export const SHARES = 'vacay:shares';
export const GRANTS = 'vacay:grants';
export const FIXED_KEYS = Object.freeze([PLAN, INDEX, SHARES, GRANTS]);

const HASH = /^[0-9a-f]{32}$/;
const YEAR = /^\d{4}$/;
/** Index group → key builder and key check. */
export const GROUPS = Object.freeze({
  e: { key: (date) => `vacay:e:${date}`, valid: isDate },
  company: { key: (date) => `vacay:company:${date}`, valid: isDate },
  allow: { key: (year) => `vacay:allow:${year}`, valid: (year) => YEAR.test(String(year)) },
  cal: { key: (id) => `vacay:cal:${id}`, valid: isId },
  inv: { key: (hash) => `vacay:inv:${hash}`, valid: (hash) => HASH.test(hash) },
});

/** A key relative to the shared prefix, as handle reads and events use it. */
export const relative = (key) => key.slice(PREFIX.length);

/** `{group, id}` for an absolute or relative key, or null. */
export function parseKey(key) {
  const rest = key.startsWith(PREFIX) ? relative(key) : key;
  const split = rest.indexOf(':');
  if (split < 0) return null;
  const group = rest.slice(0, split); const id = rest.slice(split + 1);
  return Object.hasOwn(GROUPS, group) && GROUPS[group].valid(id) ? { group, id } : null;
}

/** Every Vacay key the index names, plus the fixed keys, for export and delete. */
export function vacayKeys(index) {
  const keys = new Set(FIXED_KEYS);
  for (const [group, { key, valid }] of Object.entries(GROUPS)) {
    const ids = index && typeof index === 'object' && index[group] && typeof index[group] === 'object' ? Object.keys(index[group]) : [];
    for (const id of ids) if (valid(id)) keys.add(key(id));
  }
  return [...keys];
}

const toHex = (buffer, bytes) => [...new Uint8Array(buffer)].slice(0, bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256 = (text) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

/** Key id for records about a handle, so handle ids never appear in keys other holders can list. */
export async function handleHash(handle) { return toHex(await sha256(`vacay:${handle}`), 16); }

/** Proof that the writer holds `granted` (the handle the reader gave them), bound to the handle it is read through. */
export async function ackFor(granted, through) { return toHex(await sha256(`vacay-ack:${granted}:${through}`), 32); }
