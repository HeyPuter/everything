import { invariant } from '../../../shared/errors.js';
import { isId, newId } from '../../../shared/ids.js';
import { isDate } from '../../../shared/dates.js';

/**
 * Travel documents in `me:vault`, written with `disableSharing` and never cached on the device. With a passphrase the
 * documents are encrypted in the browser (AES-GCM, key from PBKDF2-SHA256); the passphrase and key stay in memory.
 */
export const VAULT_KEY = 'me:vault';
export const DOC_TYPES = Object.freeze(['passport', 'id', 'license', 'visa', 'loyalty', 'insurance', 'other']);
export const VAULT_LIMITS = Object.freeze({ docs: 100, label: 100, number: 100, holder: 100, country: 60, notes: 2000, passphrase: 8 });
export const VAULT_ITERATIONS = 600_000;
const MAX_ITERATIONS = 10_000_000;
const DOC_FIELDS = ['id', 'type', 'label', 'number', 'holder', 'country', 'expires', 'notes'];
const AAD = new TextEncoder().encode('trips:vault:1');
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max) => (typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, max) : '');
const normalize = (passphrase) => String(passphrase ?? '').normalize('NFKC');
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer); let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
const fromBase64 = (value) => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
// KV need not keep object key order, so stored values are compared by a key-sorted form.
function fingerprint(value) {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(',')}]`;
  if (plain(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${fingerprint(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}

export function validateDoc(input) {
  invariant(plain(input) && isId(input.id) && DOC_TYPES.includes(input.type), 'invalid_document');
  const label = text(input.label, VAULT_LIMITS.label);
  invariant(label, 'document_label_required');
  const doc = { id: input.id, type: input.type, label, number: text(input.number, VAULT_LIMITS.number) };
  for (const [field, max] of [['holder', VAULT_LIMITS.holder], ['country', VAULT_LIMITS.country], ['notes', VAULT_LIMITS.notes]]) {
    const value = text(input[field], max); if (value) doc[field] = value;
  }
  if (input.expires != null && input.expires !== '') { invariant(isDate(input.expires), 'invalid_document'); doc.expires = input.expires; }
  return doc;
}
/** The documents this build can show; stores keep the other entries as they are. */
export function readDocs(value) {
  return (Array.isArray(value) ? value : []).flatMap((entry) => { try { return [validateDoc(entry)]; } catch { return []; } }).slice(0, VAULT_LIMITS.docs);
}
function encrypted(value) {
  const enc = value?.enc;
  return plain(enc) && enc.alg === 'AES-GCM' && enc.kdf === 'PBKDF2-SHA256' && Number.isSafeInteger(enc.iter) && enc.iter >= 1000 && enc.iter <= MAX_ITERATIONS
    && [enc.salt, enc.iv, enc.data].every((part) => typeof part === 'string' && part.length > 0) ? enc : null;
}
/** `empty`, `plain` with its entries, `sealed` with its envelope, or `unreadable` (written by a newer build or damaged). */
function classify(value) {
  if (value == null) return { kind: 'empty', entries: [] };
  if (!plain(value) || value.v !== 1) return { kind: 'unreadable' };
  if (value.enc !== undefined) { const enc = encrypted(value); return enc ? { kind: 'sealed', enc } : { kind: 'unreadable' }; }
  return Array.isArray(value.docs) ? { kind: 'plain', entries: value.docs } : { kind: 'unreadable' };
}
const envelopeId = (enc) => `${enc.salt}:${enc.iter}`;
// Fields a newer build added to a document survive an edit here.
const merge = (raw, doc) => ({ ...Object.fromEntries(Object.entries(plain(raw) ? raw : {}).filter(([field]) => !DOC_FIELDS.includes(field))), ...doc });

export async function deriveKey(passphrase, salt, iterations, subtle = globalThis.crypto.subtle) {
  const material = await subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function sealDocs(docs, { key, salt, iterations }, crypto = globalThis.crypto) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify({ docs })));
  return { v: 1, enc: { alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter: iterations, salt: toBase64(salt), iv: toBase64(iv), data: toBase64(data) } };
}
async function openEntries(enc, key, subtle) {
  let bytes;
  try { bytes = await subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(enc.iv), additionalData: AAD }, key, fromBase64(enc.data)); }
  catch { invariant(false, 'wrong_passphrase'); }
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(bytes)); } catch { payload = null; }
  invariant(Array.isArray(payload?.docs), 'vault_unreadable', 409);
  return payload.docs;
}

/**
 * `load()` answers `{state: 'empty'|'plain'|'locked'|'unlocked'|'unreadable', docs}`; writes keep the current protection.
 * Every change re-reads the stored vault first and fails with `vault_changed` (409) when another session changed it,
 * after taking in the new value. An `unreadable` vault only allows `clear()`.
 */
export function createVaultStore({ puter, crypto = globalThis.crypto, iterations = VAULT_ITERATIONS, makeId = newId }) {
  const session = puter.authToken;
  let base = fingerprint(null); // the stored value as last read or written here
  let kind = 'empty';
  let sealed = null; // the stored envelope when encrypted
  let secret = null; // {key, salt, iterations, id} while unlocked
  let entries = []; // stored entries, including ones this build cannot show
  let generation = 0; // bumped by lock() so an in-flight change cannot unlock again
  let queue = Promise.resolve();
  const serial = (task) => { const run = queue.then(task); queue = run.catch(() => {}); return run; };
  // These calls bypass the personal store, so they check the session themselves.
  const guard = () => invariant(puter.authToken === session, 'account_changed', 401);
  const state = () => (kind === 'unreadable' ? 'unreadable' : kind === 'sealed' ? (secret ? 'unlocked' : 'locked') : readDocs(entries).length ? 'plain' : 'empty');
  const snapshot = () => ({ state: state(), docs: ['locked', 'unreadable'].includes(state()) ? [] : readDocs(entries) });
  const writable = () => { invariant(kind !== 'unreadable', 'vault_unreadable', 409); invariant(kind !== 'sealed' || secret, 'vault_locked'); };

  async function read() { guard(); const value = await puter.kv.get(VAULT_KEY); guard(); return value; }
  async function absorb(value) {
    const found = classify(value);
    const at = generation; const held = secret;
    let opened = null;
    if (found.kind === 'sealed' && held?.id === envelopeId(found.enc)) {
      try { opened = await openEntries(found.enc, held.key, crypto.subtle); } catch { /* Locked again. */ }
    }
    base = fingerprint(value); kind = found.kind; sealed = found.enc ?? null;
    secret = opened && at === generation ? held : null;
    entries = found.kind === 'plain' ? found.entries : secret ? opened : [];
  }
  async function unchanged() {
    const value = await read();
    if (fingerprint(value) !== base) { await absorb(value); invariant(false, 'vault_changed', 409); }
  }
  async function write(next, key) {
    const at = generation;
    const value = key ? await sealDocs(next, key, crypto) : { v: 1, docs: next };
    guard();
    await puter.kv.set(VAULT_KEY, value, { disableSharing: true });
    base = fingerprint(value); kind = key ? 'sealed' : 'plain'; sealed = key ? value.enc : null;
    secret = key && at === generation ? key : null;
    entries = !key || secret ? next : [];
  }
  async function newSecret(passphrase, count = iterations) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return { key: await deriveKey(passphrase, salt, count, crypto.subtle), salt, iterations: count, id: `${toBase64(salt)}:${count}` };
  }

  return {
    get state() { return state(); },
    snapshot,
    load() { return serial(async () => { await absorb(await read()); return snapshot(); }); },
    unlock(passphrase) { return serial(async () => {
      invariant(kind === 'sealed', 'not_locked');
      const enc = sealed; const words = normalize(passphrase); const at = generation;
      const salt = fromBase64(enc.salt);
      const key = await deriveKey(words, salt, enc.iter, crypto.subtle);
      const opened = await openEntries(enc, key, crypto.subtle);
      if (at !== generation) return snapshot();
      entries = opened; secret = { key, salt, iterations: enc.iter, id: envelopeId(enc) };
      // Envelopes with fewer iterations than the current count are re-encrypted; a failure is retried on the next unlock.
      if (enc.iter < iterations) { try { await unchanged(); await write(entries, await newSecret(words)); } catch { /* Kept as stored. */ } }
      return snapshot();
    }); },
    lock() { generation += 1; if (kind === 'sealed') { secret = null; entries = []; } return snapshot(); },
    saveDoc(input) { return serial(async () => {
      writable();
      const doc = validateDoc({ ...input, id: input.id ?? makeId() });
      await unchanged();
      const index = entries.findIndex((entry) => plain(entry) && entry.id === doc.id);
      invariant(index !== -1 || entries.length < VAULT_LIMITS.docs, 'too_many_documents');
      await write(index === -1 ? [...entries, doc] : entries.map((entry, i) => (i === index ? merge(entry, doc) : entry)), secret);
      return snapshot();
    }); },
    removeDoc(id) { return serial(async () => {
      writable();
      await unchanged();
      await write(entries.filter((entry) => !(plain(entry) && entry.id === id)), secret);
      return snapshot();
    }); },
    /** Sets or changes the passphrase and re-encrypts with a new salt. */
    setPassphrase(passphrase) { return serial(async () => {
      writable();
      const words = typeof passphrase === 'string' ? normalize(passphrase) : '';
      invariant(words.length >= VAULT_LIMITS.passphrase, 'passphrase_too_short');
      await unchanged();
      await write(entries, await newSecret(words));
      return snapshot();
    }); },
    removePassphrase() { return serial(async () => {
      invariant(kind === 'sealed' && secret, 'vault_locked');
      await unchanged();
      await write(entries, null);
      return snapshot();
    }); },
    /** Deletes every document, including a vault whose passphrase is lost or that this build cannot read. */
    clear() { return serial(async () => {
      guard();
      await puter.kv.del(VAULT_KEY);
      base = fingerprint(null); kind = 'empty'; sealed = null; secret = null; entries = [];
      return snapshot();
    }); },
  };
}
