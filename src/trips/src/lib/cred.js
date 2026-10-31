import { invariant } from '../shared/errors.js';
import { trustedWorkerURL } from '../shared/protocol.js';
import { accountIdentity } from './puter.js';
import { lastIdentity } from './identity.js';
import { tokenClaims } from '../shared/token.js';

const bytes = (value) => new TextEncoder().encode(value);
const encode = (value) => btoa(String.fromCharCode(...new Uint8Array(value)));

export async function sha256(value, crypto = globalThis.crypto) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export { tokenClaims };

export async function createCredentialManager({ puter, db, crypto = globalThis.crypto, now = Date.now }) {
  invariant(crypto?.subtle, 'crypto_unavailable');
  const sessionToken = puter.authToken;
  invariant(typeof sessionToken === 'string' && sessionToken, 'signed_out', 401);
  const user = await accountIdentity(puter).catch(async (error) => {
    // Offline cold start: only the identity this device remembered for this exact token.
    const offline = !(error?.status >= 400) && (error instanceof TypeError || error?.code === 'offline' || globalThis.navigator?.onLine === false);
    const remembered = offline ? await lastIdentity(sessionToken) : null;
    if (!remembered) throw error;
    return remembered;
  });
  invariant(user.uuid === db.account && puter.authToken === sessionToken, 'account_changed', 401);
  let pending;
  let lastRefresh = -Infinity;
  // Per worker origin: that worker's clock minus ours, learned from a `proof_expired` answer.
  const offsets = new Map();
  const currentAccount = () => invariant(puter.authToken === sessionToken, 'account_changed', 401);

  async function load({ refresh = false } = {}) {
    currentAccount();
    let saved = await db.get('device:credential');
    currentAccount();
    if (!refresh && saved?.expires > now() + 60_000) {
      const claims = tokenClaims(saved.token);
      invariant(typeof saved.path === 'string' && saved.path.length > 0 && saved.path.length <= 2048
        && saved.token !== sessionToken && claims.type === 'access-token' && !claims.full_access
        && Number.isFinite(claims.exp) && saved.expires <= claims.exp * 1000, 'invalid_restricted_credential');
      return saved;
    }
    invariant(!refresh || now() - lastRefresh >= 60_000, 'credential_rate_limit', 429);
    lastRefresh = now();
    let device = await db.get('device:key');
    currentAccount();
    if (!device) {
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
      const candidate = { privateKey: keys.privateKey, publicKey };
      currentAccount();
      device = await db.update('device:key', (existing) => existing ?? candidate);
    }
    invariant(device.privateKey.extractable === false, 'extractable_private_key');
    const fingerprint = (await sha256(JSON.stringify(device.publicKey), crypto)).slice(0, 32);
    currentAccount();
    const file = await puter.fs.write(`identity/${fingerprint}.json`, JSON.stringify({ version: 1, publicKey: device.publicKey }), {
      overwrite: true, dedupeName: false, createMissingParents: true,
    });
    currentAccount();
    const readURL = new URL(await puter.fs.getReadURL(file.path, '24h'));
    const token = readURL.searchParams.get('token');
    const claims = tokenClaims(token);
    invariant(readURL.origin === new URL(puter.APIOrigin).origin && readURL.pathname === '/token-read'
      && token && token !== sessionToken && claims.type === 'access-token' && !claims.full_access
      && Number.isFinite(claims.exp) && claims.exp * 1000 > now() + 60_000, 'invalid_restricted_credential');
    currentAccount();
    saved = { path: file.path, token, expires: Math.min(now() + 24 * 60 * 60_000, claims.exp * 1000) };
    await db.put('device:credential', saved);
    return saved;
  }

  return {
    async headers(origin, body, { refresh = false, serverNow } = {}) {
      invariant(trustedWorkerURL(origin).origin === origin, 'untrusted_worker');
      currentAccount();
      if (Number.isSafeInteger(serverNow) && serverNow > 0) {
        offsets.delete(origin); offsets.set(origin, serverNow - now());
        if (offsets.size > 100) offsets.delete(offsets.keys().next().value);
      }
      const mint = (options) => { const next = load(options).catch((error) => { if (pending === next) pending = null; throw error; }); pending = next; return next; };
      if (!pending || refresh) mint({ refresh });
      const awaited = pending;
      let credential = await awaited;
      // Share one re-mint between concurrent callers; a failed mint clears `pending` so the next call retries.
      if (credential.expires <= now() + 60_000) credential = await (pending && pending !== awaited ? pending : mint());
      const device = await db.get('device:key');
      invariant(device?.privateKey && !device.privateKey.extractable, 'credential_key_missing');
      const at = Math.round(now() + (offsets.get(origin) ?? 0));
      const signature = encode(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, device.privateKey,
        bytes(JSON.stringify([origin, credential.path, await sha256(body, crypto), at]))));
      currentAccount();
      return {
        'puter-auth': credential.token,
        'x-trips-proof': JSON.stringify({ version: 2, path: credential.path, at, signature }),
      };
    },
  };
}
