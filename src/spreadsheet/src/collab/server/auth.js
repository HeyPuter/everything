/**
 * Identity of a request to the room worker: a restricted Puter access token that only reads the caller's
 * identity file, validated with Puter itself, and a signature over this worker's origin, that file and the
 * request body made with the private key matching the public key in the file. Adapted from the Whiteboard
 * app's worker authentication in this repository.
 */

import { hash, verify } from '../protocol.js';
import { tokenClaims, PROOF_HEADER } from '../auth.js';

const proofs = new Map();
// How long Puter's validation of a restricted token is reused.
const VALIDATED = 30_000;
const denied = () => Object.assign(new Error('Could not verify this collaboration request.'), { status: 401 });

async function publicKey(puter, path) {
  const proof = JSON.parse(await (await puter.fs.read(path)).text());
  if (proof.version !== 1 || !proof.publicKey || proof.publicKey.d) throw denied();
  return proof.publicKey;
}

/** The caller of `request` ({ uuid, username }), proven; throws a 401 otherwise. `puter` is the caller's own Puter (user.puter). */
export async function authenticate(request, puter, input, now = Date.now) {
  const token = request.headers.get('puter-auth');
  const claims = tokenClaims(token);
  // The owner's own app session (deployment checks) is accepted as is.
  if (claims.type === 'session' || claims.type === 'app-under-user') return puter.auth.getUser();
  if (claims.type !== 'access-token' || !claims.user_uid) throw denied();
  try {
    const header = request.headers.get(PROOF_HEADER);
    if (!header || header.length > 4096) throw denied();
    const proof = JSON.parse(header);
    if (proof.version !== 1 || typeof proof.path !== 'string' || !proof.path || proof.path.length > 2048) throw denied();
    if (Number.isFinite(claims.exp) && claims.exp * 1000 <= now()) throw denied();
    const key = `${token}|${proof.path}|${claims.user_uid}`;
    let cached = proofs.get(key);
    if (!cached || cached.expires <= now() || cached.checked + VALIDATED <= now()) {
      // A strong stat validates the token with Puter, including revocation; only an unshared file the caller owns can supply their key.
      const file = await puter.fs.stat(proof.path, { consistency: 'strong' });
      if (file.is_shared !== false || typeof file.owner?.username !== 'string' || !file.owner.username || file.is_dir || !Number.isFinite(file.size) || file.size < 0 || file.size > 4096) throw denied();
      if (cached && cached.expires > now()) {
        cached.checked = now();
        cached.username = file.owner.username;
      } else {
        if (proofs.size >= 2048) proofs.delete(proofs.keys().next().value);
        const entry = { expires: now() + 5 * 60_000, checked: now(), username: file.owner.username, pending: publicKey(puter, proof.path) };
        proofs.set(key, entry);
        entry.pending.catch(() => { if (proofs.get(key) === entry) proofs.delete(key); });
        cached = entry;
      }
    }
    const identity = { uuid: claims.user_uid, username: cached.username };
    if (!(await verify(await cached.pending, [new URL(request.url).origin, proof.path, await hash(JSON.stringify(input))], proof.signature))) throw denied();
    return identity;
  } catch {
    throw denied();
  }
}
