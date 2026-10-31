import { isUuid } from '../src/shared/ids.js';
import { tokenClaims } from '../src/shared/token.js';
import { createCache } from './cache.js';
import { HttpError, fail } from './http.js';
import { sha256Hex, utf8 } from './keys.js';

const PROOF_PATH = /^\/([^/]{1,64})\/AppData\/([^/]{1,128})\/identity\/[0-9a-f]{32}\.json$/;
const BASE64 = /^[A-Za-z0-9+/]{1,200}={0,2}$/;
const PROOF_TTL = 5 * 60_000;
const MAX_SKEW = 5 * 60_000;
const REVALIDATE = 30_000;

export { tokenClaims };

const rejected = () => fail('credential_rejected', 401);

async function publicKey(puter, path) {
  let proof;
  try { proof = JSON.parse(await (await puter.fs.read(path)).text()); } catch { rejected(); }
  const key = proof?.publicKey;
  if (proof?.version !== 1 || !key || key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || Object.hasOwn(key, 'd')) rejected();
  try {
    return await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: key.x, y: key.y }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch { return rejected(); }
}

/**
 * Restricted credential plus signature (architecture §17). `signed` is the exact text the client signed:
 * the raw body for `POST /api`, or `"<METHOD> <pathname>"` for file routes; the signed tuple adds the proof's `at`.
 */
export function createAuth({ now, appUid }) {
  const proofs = createCache({ max: 2048 });
  return async function authenticate(request, user, signed) {
    const token = request.headers.get('puter-auth');
    const header = request.headers.get('x-trips-proof');
    if (!token) fail('auth_required', 401);
    const claims = tokenClaims(token);
    if (claims.type !== 'access-token' || claims.full_access) fail('restricted_credential_required', 401);
    if (!header) fail('auth_required', 401);
    if (!isUuid(claims.user_uid) || (Number.isFinite(claims.exp) && claims.exp * 1000 <= now())) rejected();
    if (header.length > 4096) rejected();
    let proof;
    try { proof = JSON.parse(header); } catch { rejected(); }
    const match = typeof proof?.path === 'string' ? PROOF_PATH.exec(proof.path) : null;
    if (proof?.version !== 2 || !match || typeof proof.signature !== 'string' || !BASE64.test(proof.signature) || !Number.isSafeInteger(proof.at)) rejected();
    // Bounds replays of a captured request; checked before any read so stale proofs cost nothing.
    if (Math.abs(now() - proof.at) > MAX_SKEW) fail('proof_expired', 401, { now: now() });
    // Only the Trips app's own AppData may hold the key, so another app the user runs cannot sign as them.
    if (match[2] !== await appUid()) rejected();
    if (!user?.puter?.fs) fail('auth_required', 401);
    const cacheKey = `${await sha256Hex(token)}|${proof.path}`;
    const time = now();
    let entry = proofs.get(cacheKey);
    if (!entry || entry.expires <= time || entry.checked + REVALIDATE <= time) {
      let file;
      // A strong stat makes Puter validate this exact token now, including expiry and revocation.
      try { file = await user.puter.fs.stat(proof.path, { consistency: 'strong' }); } catch (error) {
        proofs.delete(cacheKey);
        if (error?.status === 402) throw new HttpError('caller_credit', 402);
        rejected();
      }
      // `is_shared` is null for files the caller does not own; an owned, unshared file pins the public key.
      if (file?.is_shared !== false || file.is_dir || !Number.isFinite(file.size) || file.size < 0 || file.size > 4096
        || typeof file.owner?.username !== 'string' || file.owner.username !== match[1]
        || (file.owner.uuid !== undefined && file.owner.uuid !== claims.user_uid)) {
        proofs.delete(cacheKey);
        rejected();
      }
      if (!entry || entry.expires <= time) {
        const key = await publicKey(user.puter, proof.path);
        entry = { key, uuid: claims.user_uid, username: file.owner.username, expires: time + PROOF_TTL, checked: time };
        proofs.set(cacheKey, entry);
      } else entry.checked = time;
    }
    const signature = Uint8Array.from(atob(proof.signature), (char) => char.charCodeAt(0));
    const message = utf8(JSON.stringify([new URL(request.url).origin, proof.path, await sha256Hex(signed), proof.at]));
    let valid = false;
    try { valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, entry.key, signature, message); } catch { valid = false; }
    if (!valid) rejected();
    return { uuid: entry.uuid, username: entry.username };
  };
}
