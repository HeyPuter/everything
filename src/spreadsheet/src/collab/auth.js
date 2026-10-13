/**
 * Signed requests to a room worker. The browser never sends its app session credential to a worker someone
 * else deployed: it mints a restricted Puter access token that can only read a small identity file holding a
 * public signing key, and signs every request (destination, identity file, body digest) with the matching
 * private key. The worker validates the token with Puter, reads the key from the file and checks the
 * signature. Adapted from the Whiteboard app's collaboration credentials in this repository.
 */

import { hash, keyPair, sign } from './protocol.js';

const credentials = new WeakMap();
const LIFETIME = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const PROOF_HEADER = 'x-spreadsheet-proof';

async function loadCredential(puter, parent, refused) {
  // App KV is private to this account; credentials survive reloads, as minting is rate limited.
  const context = await hash(parent);
  const key = `spreadsheet-collab-auth-v1:${context}`;
  const saved = await puter.kv.get(key);
  if (saved && saved.expires > Date.now() + 60_000 && (!refused || saved.token !== refused.token)) return saved;
  const keys = saved?.keys ?? (await keyPair());
  const fingerprint = (await hash(JSON.stringify(keys.publicKey))).slice(0, 32);
  const file = await puter.fs.write(`spreadsheet/identity/${context}-${fingerprint}.json`, JSON.stringify({ version: 1, publicKey: keys.publicKey }), {
    overwrite: true, dedupeName: false, createMissingParents: true,
  });
  const issued = Date.now();
  const url = new URL(await puter.fs.getReadURL(file.path, '24h'));
  const token = url.searchParams.get('token');
  const claims = tokenClaims(token);
  if (url.origin !== new URL(puter.APIOrigin).origin || url.pathname !== '/token-read' || !token || token === parent
    || claims.type !== 'access-token' || claims.full_access || !Number.isFinite(claims.exp)) {
    throw new Error('Could not create a restricted collaboration credential.');
  }
  const credential = { keys, path: file.path, token, expires: Math.min(issued + LIFETIME, claims.exp * 1000) };
  if (puter.authToken !== parent) throw new Error('Your Puter account changed. Open the shared workbook again.');
  await puter.kv.set(key, credential, { disableSharing: true });
  return credential;
}

/** Decode (not verify) a Puter token's claims, including the compressed form. */
export function tokenClaims(token) {
  try {
    const claims = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
    if (!claims || typeof claims !== 'object' || Array.isArray(claims) || (claims.t !== undefined && claims.type !== undefined) || (claims.uu !== undefined && claims.user_uid !== undefined)) return {};
    const type = claims.t === undefined ? claims.type : claims.t === 't' ? 'access-token' : claims.t === 'au' ? 'app-under-user' : claims.t === 's' ? 'session' : undefined;
    const subject = claims.uu ?? claims.user_uid;
    let user_uid;
    if (typeof subject === 'string') {
      if (UUID.test(subject)) user_uid = subject.toLowerCase();
      else if (claims.uu !== undefined) {
        const packed = atob(subject.replaceAll('-', '+').replaceAll('_', '/'));
        if (packed.length === 16) {
          const hex = [...packed].map((b) => b.charCodeAt(0).toString(16).padStart(2, '0')).join('');
          user_uid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        }
      }
    }
    return { ...claims, type, user_uid };
  } catch {
    return {};
  }
}

const replaced = new WeakMap();
/** A credential the worker refused is replaced (at most once a minute). */
export function refuseCredential(puter, headers) {
  const entry = credentials.get(puter), value = entry?.value;
  if (entry && (entry.stale || !value || value.token !== headers['puter-auth'])) return true;
  if (!value) return false;
  if (Date.now() - (replaced.get(puter) ?? 0) < 60_000) return false;
  replaced.set(puter, Date.now());
  credentials.set(puter, { parent: entry.parent, stale: true, refused: value });
  return true;
}

export async function authorize(puter, server, body) {
  const parent = puter.authToken;
  if (!parent) throw new Error('Sign in with Puter to continue.');
  let entry = credentials.get(puter);
  if (entry?.parent !== parent || entry.stale || (entry.value && entry.value.expires <= Date.now() + 60_000)) {
    const refused = entry?.stale && entry.parent === parent ? entry.refused : undefined;
    const next = { parent };
    credentials.set(puter, next);
    next.pending = loadCredential(puter, parent, refused).then(
      (value) => (next.value = value),
      (error) => { if (credentials.get(puter) === next) credentials.delete(puter); throw error; },
    );
    entry = next;
  }
  const credential = await entry.pending;
  const signature = await sign(credential.keys.privateKey, [server, credential.path, await hash(body)]);
  if (puter.authToken !== parent) throw new Error('Your Puter account changed. Open the shared workbook again.');
  return { 'puter-auth': credential.token, [PROOF_HEADER]: JSON.stringify({ version: 1, path: credential.path, signature }) };
}
