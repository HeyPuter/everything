import { CLEANUP_PERMIT, IDENTITY_PERMIT, WORKER_PERMIT, createEvidence, errorStatus, newRunId, requirePermit, requireRunId } from './evidence.js';
import { SPIKE_BUILD, digest } from './worker.js';
import { guardedCall, isAccountChange, pinBrowserAccount } from './account.js';

export const workerName = (runId) => `trips-${requireRunId(runId)}`;
export const workerOrigin = (runId) => `https://${workerName(runId)}.puter.work`;
const encode = (value) => new TextEncoder().encode(value);
async function readBytes(response, limit = 1024 * 1024) {
  if (!response.body) throw new Error('spike_empty_response');
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) { await reader.cancel(); throw new Error('spike_response_limit'); }
    chunks.push(value);
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
  return all;
}
const json = async (response) => JSON.parse(new TextDecoder().decode(await readBytes(response, 16_384)));

/** No sign-in/deploy occurs here. The caller must explicitly own the named spike worker. */
export async function runHealthProbe({ puter, runId, environment, permit, now = () => performance.now() }) {
  requirePermit(permit, WORKER_PERMIT);
  if (!puter?.auth?.isSignedIn()) throw new Error('spike_sign_in_manually');
  const evidence = createEvidence({ runId, environment });
  const started = now();
  try {
    const response = await puter.workers.exec(`${workerOrigin(runId)}/health`, { headers: { 'x-puter-no-auth': '1' }, redirect: 'error', credentials: 'omit' });
    if (!response.ok) { evidence.record('worker.health', 'error', { status: response.status }); }
    else {
      const data = await json(response);
      evidence.record('worker.health', data.ok === true && data.spike === true && data.build === SPIKE_BUILD && data.authHeader === false ? 'pass' : 'fail', { elapsedMs: Math.max(0, now() - started), authenticated: data.authHeader === true });
    }
  } catch (error) { evidence.record('worker.health', 'error', { status: errorStatus(error) }); }
  return evidence.report();
}

/** The non-extractable private key and restricted token stay in this closure only. */
export async function createSpikeSession({ puter, environment, permit, runId = newRunId(), crypto = globalThis.crypto, now = Date.now }) {
  requirePermit(permit, IDENTITY_PERMIT);
  createEvidence({ runId, environment });
  const account = await pinBrowserAccount(puter);
  const sameAccount = account.check;
  const sessionToken = puter.authToken;
  let privateKey;
  const directory = `dev/spike/${runId}`;
  let token;
  let path;
  let expires;
  let closed = false;
  let busy = false;
  let created = false;
  let mutationStarted = false;
  async function cleanup({ permit: cleanupPermit } = {}) {
    requirePermit(cleanupPermit, CLEANUP_PERMIT);
    if (busy) throw new Error('spike_request_in_flight');
    const evidence = createEvidence({ runId, environment });
    closed = true; token = null; privateKey = null;
    try {
      sameAccount();
      if (created) {
        await guardedCall(account, () => puter.fs.delete(directory, { recursive: true }));
        created = false;
      }
      evidence.record('cleanup.identity', 'pass', { cleanupRequired: false, originalAccountRequired: false });
    }
    catch (error) { evidence.record('cleanup.identity', 'error', { status: errorStatus(error), cleanupRequired: created || (isAccountChange(error) && mutationStarted), originalAccountRequired: isAccountChange(error) && mutationStarted }); }
    return evidence.report();
  }
  try {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
    sameAccount();
    privateKey = keys.privateKey;
    const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
    sameAccount();
    mutationStarted = true;
    await puter.fs.mkdir(directory, { createMissingParents: true, dedupeName: false });
    created = true;
    sameAccount();
    const file = await guardedCall(account, () => puter.fs.write(`${directory}/identity.json`, JSON.stringify({ version: 1, publicKey }), { overwrite: false, dedupeName: false, createMissingParents: true }));
    path = file.path;
    if (!account.owns(file.owner?.uuid) || typeof path !== 'string' || !path.endsWith(`/AppData/${account.appName}/dev/spike/${runId}/identity.json`)) throw new Error('spike_identity_invalid');
    const readURL = new URL(await guardedCall(account, () => puter.fs.getReadURL(path, '15m')));
    token = readURL.searchParams.get('token');
    if (readURL.origin !== new URL(puter.APIOrigin).origin || readURL.pathname !== '/token-read' || !token || token === sessionToken) throw new Error('spike_restricted_token_required');
    const claims = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/')));
    if ((claims.t === 't' ? 'access-token' : claims.type) !== 'access-token' || claims.full_access || !account.owns(claims.user_uid) || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now()) throw new Error('spike_restricted_token_required');
    expires = claims.exp * 1000;
    sameAccount();
  } catch {
    const result = await cleanup({ permit: CLEANUP_PERMIT });
    const measurements = result.results[0].measurements;
    throw Object.assign(new Error(measurements.originalAccountRequired ? 'spike_identity_setup_failed_cleanup_required_original_account' : measurements.cleanupRequired ? 'spike_identity_setup_failed_cleanup_required' : 'spike_identity_setup_failed'), { runId, cleanupRequired: measurements.cleanupRequired, originalAccountRequired: measurements.originalAccountRequired });
  }

  return {
    runId, workerName: workerName(runId),
    async request(probe, { permit: requestPermit } = {}) {
      requirePermit(requestPermit, WORKER_PERMIT);
      sameAccount();
      if (!['auth', 'compress', 'kv'].includes(probe)) throw new Error('spike_invalid_probe');
      if (closed || expires <= now()) throw new Error('spike_session_expired');
      if (busy) throw new Error('spike_request_in_flight');
      const evidence = createEvidence({ runId, environment });
      const id = probe === 'compress' ? 'worker.compression' : probe === 'auth' ? 'worker.auth' : 'kv.batch';
      busy = true;
      try {
        const body = JSON.stringify({ probe });
        const signature = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, encode(JSON.stringify([workerOrigin(runId), path, await digest(body, crypto)]))))));
        sameAccount();
        const started = performance.now();
        const response = await guardedCall(account, () => puter.workers.exec(`${workerOrigin(runId)}/probe`, {
          method: 'POST', redirect: 'error', credentials: 'omit', headers: {
            'Content-Type': 'application/json', 'puter-auth': token,
            'x-trips-proof': JSON.stringify({ version: 1, path, signature }),
          }, body,
        }));
        if (!response.ok) evidence.record(id, 'error', { status: response.status });
        else if (probe === 'compress') {
          const compressed = await readBytes(response);
          const decompressed = await readBytes(new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))));
          const data = JSON.parse(new TextDecoder().decode(decompressed));
          sameAccount();
          const valid = data.spike === true && Array.isArray(data.entities) && data.entities.length === 5000 && data.entities.every((item, index) => item.id === `fixture-${index}` && item.name === `Synthetic place ${index}`);
          evidence.record(id, valid ? 'pass' : 'fail', {
            entities: valid ? 5000 : 0, jsonBytes: decompressed.byteLength, gzipBytes: compressed.byteLength,
            prepareMs: Math.max(0, Number(response.headers.get('x-spike-prepare-ms')) || 0), elapsedMs: Math.max(0, performance.now() - started), streamed: Boolean(response.body),
          });
        } else {
          const data = await json(response);
          sameAccount();
          if (probe === 'kv') {
            if (data.ok !== true || data.spike !== true || data.report?.runId !== runId || data.report?.environment !== environment || !Array.isArray(data.report?.results) || data.report.results.length > 12) throw new Error('spike_invalid_response');
            for (const result of data.report.results) evidence.record(result.probe, result.outcome, result.measurements);
          } else evidence.record(id, data.ok === true && data.spike === true && data.restricted === true && data.owner === true ? 'pass' : 'fail', { restricted: data.restricted === true, owner: data.owner === true });
        }
      } catch (error) { evidence.record(id, 'error', { status: errorStatus(error), ...(isAccountChange(error) ? { cleanupRequired: created, originalAccountRequired: created } : {}) }); }
      finally { busy = false; }
      return evidence.report();
    },
    cleanup,
  };
}
