import { KV_PERMIT, RUN_PATTERN, errorStatus } from './evidence.js';
import { runKvProbes } from './kv.js';
import { pinWorkerAccount } from './account.js';

export const SPIKE_BUILD = 'f0-harness-v1';
const encode = (value) => new TextEncoder().encode(value);
export async function digest(text, crypto = globalThis.crypto) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function spikeOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || !/^trips-f0-[a-f0-9]{16}\.puter\.work$/.test(url.hostname)) throw new Error('spike_untrusted_origin');
  return url.origin;
}
function claimsOf(token) {
  if (typeof token !== 'string' || token.length > 16_384 || token.split('.').length !== 3) throw new Error('auth_invalid');
  const claims = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) || (Object.hasOwn(claims, 't') && Object.hasOwn(claims, 'type'))) throw new Error('auth_invalid');
  if ((claims.t === 't' ? 'access-token' : claims.type) !== 'access-token' || claims.full_access || typeof claims.user_uid !== 'string' || !Number.isFinite(claims.exp)) throw new Error('auth_invalid');
  return claims;
}
async function bodyText(request, limit = 2048) {
  const reader = request.body?.getReader();
  if (!reader) throw Object.assign(new Error('invalid_body'), { status: 400 });
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw Object.assign(new Error('body_too_large'), { status: 413 }); }
    chunks.push(value);
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder('utf-8', { fatal: true }).decode(all);
}
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, puter-auth, x-trips-proof, x-puter-no-auth',
  'Access-Control-Expose-Headers': 'x-spike-entities, x-spike-json-bytes, x-spike-prepare-ms',
  'Cache-Control': 'no-store',
};
const json = (value, status = 200) => Response.json(value, { status, headers: cors });

/** Spike only. Owner checks are pinned from me, never from the first request. */
export function createSpikeHandler({ me, crypto = globalThis.crypto, environment, now = Date.now, monotonic = () => performance.now(), wait } = {}) {
  if (!me?.puter || !crypto?.subtle || !['fake', 'live'].includes(environment)) throw new Error('spike_configuration_required');
  let ownerPromise;
  let windowStart = 0;
  let attempts = 0;
  let completed = 0;
  let busy = false;
  const usedKvRuns = new Set();

  async function authenticate(request, user, body, origin) {
    try {
      const claims = claimsOf(request.headers.get('puter-auth'));
      if (claims.exp * 1000 <= now()) throw new Error('expired');
      const raw = request.headers.get('x-trips-proof');
      if (!raw || raw.length > 4096) throw new Error('proof_invalid');
      const proof = JSON.parse(raw);
      if (proof?.version !== 1 || typeof proof.path !== 'string' || proof.path.length > 2048 || typeof proof.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(proof.signature)) throw new Error('proof_invalid');
      const runId = origin.slice('https://trips-'.length, -'.puter.work'.length);
      if (!RUN_PATTERN.test(runId)) throw new Error('proof_invalid');
      ownerPromise ??= me.puter.auth.getUser().catch(() => { ownerPromise = null; throw new Error('owner_unavailable'); });
      const owner = await ownerPromise;
      if (!owner?.uuid || typeof owner.app_name !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(owner.app_name) || claims.user_uid !== owner.uuid) throw new Error('owner_required');
      const match = /^\/[^/]+\/AppData\/([^/]+)\/dev\/spike\/(f0-[a-f0-9]{16})\/identity\.json$/.exec(proof.path);
      if (!match || match[1] !== owner.app_name || match[2] !== runId) throw new Error('proof_invalid');
      if (!user?.puter?.fs) throw new Error('auth_invalid');
      const stat = await user.puter.fs.stat(proof.path);
      if (stat.owner?.uuid !== owner.uuid || stat.path !== proof.path || stat.is_dir || !Number.isInteger(stat.size) || stat.size < 1 || stat.size > 2048) throw new Error('proof_invalid');
      const file = await user.puter.fs.read(proof.path);
      if (!(file instanceof Blob) || file.size > 2048) throw new Error('proof_invalid');
      const identity = JSON.parse(await file.text());
      const key = identity?.publicKey;
      if (identity?.version !== 1 || key?.kty !== 'EC' || key.crv !== 'P-256' || Object.hasOwn(key, 'd') || !/^[A-Za-z0-9_-]{43}$/.test(key.x) || !/^[A-Za-z0-9_-]{43}$/.test(key.y)) throw new Error('proof_invalid');
      const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const signature = Uint8Array.from(atob(proof.signature), (char) => char.charCodeAt(0));
      const valid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, signature, encode(JSON.stringify([origin, proof.path, await digest(body, crypto)])));
      if (!valid) throw new Error('auth_invalid');
      return { runId, owner };
    } catch { throw Object.assign(new Error('auth_invalid'), { status: 401 }); }
  }

  return async function handle({ request, user }) {
    try {
      const url = new URL(request.url);
      const origin = spikeOrigin(request.url);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (request.method === 'GET' && url.pathname === '/health') return json({ ok: true, spike: true, build: SPIKE_BUILD, authHeader: request.headers.has('puter-auth') });
      if (request.method !== 'POST' || url.pathname !== '/probe') return json({ code: 'not_found' }, 404);
      if (!request.headers.get('content-type')?.startsWith('application/json')) return json({ code: 'invalid_body' }, 400);
      if (now() - windowStart >= 60_000) { windowStart = now(); attempts = 0; }
      if (++attempts > 12 || completed >= 8 || busy) return json({ code: 'spike_budget' }, 429);
      busy = true;
      try {
        const body = await bodyText(request);
        let input;
        try { input = JSON.parse(body); } catch { return json({ code: 'invalid_body' }, 400); }
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !['auth', 'compress', 'kv'].includes(input.probe)) return json({ code: 'invalid_probe' }, 400);
        const { runId, owner } = await authenticate(request, user, body, origin);
        completed++;
        if (input.probe === 'auth') return json({ ok: true, spike: true, restricted: true, owner: true });
        if (input.probe === 'kv') {
          if (usedKvRuns.has(runId)) return json({ code: 'spike_already_run' }, 409);
          usedKvRuns.add(runId);
          return json({ ok: true, spike: true, report: await runKvProbes({ puter: me.puter, runId, environment, permit: KV_PERMIT, account: pinWorkerAccount(me, owner), wait }) });
        }
        if (typeof CompressionStream !== 'function') return json({ code: 'compression_unavailable' }, 501);
        const started = monotonic();
        const entities = Array.from({ length: 5000 }, (_, index) => ({ id: `fixture-${index}`, t: 'place', name: `Synthetic place ${index}`, lat: 49.25, lng: -123.1, rev: index + 1 }));
        const bytes = encode(JSON.stringify({ spike: true, entities }));
        const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
        return new Response(stream, { headers: {
          ...cors, 'Content-Type': 'application/gzip',
          'x-spike-entities': '5000', 'x-spike-json-bytes': String(bytes.byteLength),
          'x-spike-prepare-ms': String(Math.max(0, monotonic() - started)),
        } });
      } finally { busy = false; }
    } catch (error) {
      const status = errorStatus(error);
      return json({ code: status === 401 ? 'auth_invalid' : status === 413 ? 'body_too_large' : 'spike_failed' }, [401, 413].includes(status) ? status : 500);
    }
  };
}
