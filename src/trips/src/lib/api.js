import { invariant } from '../shared/errors.js';
import { isId } from '../shared/ids.js';
import { API_PATH, OPS, validateSpaceRef, workerOrigin } from '../shared/protocol.js';
import { LIMITS } from '../shared/limits.js';

export class ApiError extends Error {
  constructor(status, code, details = {}) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.server = details.server;
    this.op = isId(details.op) ? details.op : undefined;
    this.retryAfter = Number.isFinite(details.retryAfter) && details.retryAfter > 0 ? details.retryAfter : undefined;
    this.serverNow = Number.isSafeInteger(details.now) ? details.now : undefined;
    this.reason = typeof details.reason === 'string' && /^[a-z_]{1,32}$/.test(details.reason) ? details.reason : undefined;
  }
}

async function readChunks(response, limit, signal, onChunk) {
  invariant(response.body, 'invalid_response', 502);
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { cancel(); throw new ApiError(502, 'response_too_large'); }
      chunks.push(value);
      onChunk?.(size);
    }
  } finally { signal?.removeEventListener('abort', cancel); }
  return { chunks, size };
}

async function readBytes(response, limit = 64 * 1024 * 1024, signal) {
  const { chunks, size } = await readChunks(response, limit, signal);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function readJson(response, compressed = false, signal) {
  let data = await readBytes(response, undefined, signal);
  if (compressed && data[0] === 0x1f && data[1] === 0x8b) {
    invariant(typeof DecompressionStream === 'function', 'decompression_unavailable');
    data = await readBytes(new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))), undefined, signal);
  }
  try { return JSON.parse(new TextDecoder().decode(data)); } catch { throw new ApiError(502, 'invalid_response'); }
}

async function errorFrom(response, signal) {
  let data = {};
  try { data = JSON.parse(new TextDecoder().decode(await readBytes(response, 16_384, signal))); } catch { /* A gateway may return HTML. */ }
  if (response.status === 401) return new ApiError(401, data.code === 'proof_expired' ? 'proof_expired' : 'credential_rejected', data.code === 'proof_expired' ? data : {});
  return new ApiError(response.status, typeof data.code === 'string' ? data.code : `http_${response.status}`, data);
}

let streamUploads;
/** Streamed request bodies (Chromium) let uploads report progress; elsewhere the body is sent whole. */
function canStreamUploads() {
  if (streamUploads === undefined) {
    try {
      let duplex = false;
      const typed = new Request('https://trips-probe.invalid/', { method: 'PUT', body: new ReadableStream(), get duplex() { duplex = true; return 'half'; } }).headers.has('Content-Type');
      streamUploads = duplex && !typed;
    } catch { streamUploads = false; }
  }
  return streamUploads;
}

function countingStream(blob, onBytes) {
  const reader = blob.stream().getReader();
  let sent = 0;
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) { controller.close(); return; }
      sent += value.byteLength;
      controller.enqueue(value);
      onBytes(sent);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

const BUILD = /^[0-9a-z]{6,64}$/;
/** `GET /health` without any credential; `x-puter-no-auth` stops the SDK attaching the session. */
export async function fetchHealth(puter, worker, { timeout = 10_000 } = {}) {
  const origin = workerOrigin(worker);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { reject(new ApiError(0, 'timeout')); controller.abort(); }, timeout); });
  const send = async () => {
    const response = await puter.workers.exec(`${origin}/health`, { method: 'GET', headers: { 'x-puter-no-auth': '1' }, signal: controller.signal });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new ApiError(response.status, `http_${response.status}`); }
    const data = JSON.parse(new TextDecoder().decode(await readBytes(response, 16_384, controller.signal)));
    invariant(data && BUILD.test(data.build) && Number.isSafeInteger(data.protocol) && data.protocol >= 1
      && (data.builtAt === undefined || (Number.isSafeInteger(data.builtAt) && data.builtAt >= 0)), 'invalid_health', 502);
    return { build: data.build, builtAt: data.builtAt ?? null, protocol: data.protocol };
  };
  try { return await Promise.race([send(), deadline]); }
  catch (error) {
    if (typeof error.status === 'number') throw error;
    throw new ApiError(0, controller.signal.aborted ? 'timeout' : error instanceof SyntaxError ? 'invalid_health' : 'network');
  } finally { clearTimeout(timer); }
}

const PUBLIC_TOKEN = /^[0-9a-f]{32}$/;
const PUBLIC_BYTES = 16 * 1024 * 1024;
/** Uncredentialed GET for the public routes: through the SDK when it is loaded (never with the session), else `fetch`. */
async function publicGet(puter, url, { headers = {}, signal, timeout }) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => { reject(new ApiError(0, 'timeout')); controller.abort(); }, timeout); });
  const send = async () => {
    const init = { method: 'GET', headers: { ...headers, 'x-puter-no-auth': '1' }, signal: controller.signal };
    if (typeof puter?.workers?.exec === 'function') return puter.workers.exec(url, init);
    const { 'x-puter-no-auth': _skip, ...plain } = init.headers;
    return globalThis.fetch(url, { ...init, headers: plain, credentials: 'omit', referrerPolicy: 'no-referrer' });
  };
  try {
    const response = await Promise.race([send(), deadline]);
    return { response, controller };
  } catch (error) {
    clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    if (typeof error.status === 'number') throw error;
    throw new ApiError(0, signal?.aborted ? 'aborted' : controller.signal.aborted ? 'timeout' : 'network');
  } finally { clearTimeout(timer); }
}
function publicPath(worker, space, token) {
  invariant(isId(space) && typeof token === 'string' && PUBLIC_TOKEN.test(token), 'invalid_public_link');
  return `${workerOrigin(worker)}/pub/${space}/${token}`;
}

/**
 * The public projection of a shared trip (`GET /pub/<space>/<token>`), without credentials. With `etag` a 304 resolves
 * to `{notModified: true}`; otherwise `{data, etag}`.
 */
export async function fetchPublic(puter, { worker, space, token }, { etag, signal, timeout = 20_000 } = {}) {
  const url = publicPath(worker, space, token);
  const { response, controller } = await publicGet(puter, url, { headers: etag ? { 'If-None-Match': etag } : {}, signal, timeout });
  if (response.status === 304) return { notModified: true, etag };
  if (!response.ok) {
    const error = await errorFrom(response, controller.signal);
    if (!error.retryAfter) error.retryAfter = Number(response.headers.get('retry-after')) || undefined;
    throw error;
  }
  const data = await readJson(response, false, controller.signal);
  invariant(data?.ok === true && Array.isArray(data.ents), 'invalid_response', 502);
  const tag = response.headers.get('etag');
  return { data, etag: typeof tag === 'string' && tag.length <= 128 ? tag : null };
}

/** A file (or with `thumb`, its thumbnail) from a public link (`GET /pub/<space>/<token>/f/<fileId>[/thumb]`) as a Blob typed by the response. */
export async function fetchPublicFile(puter, { worker, space, token }, fileId, { signal, timeout = 60_000, thumb = false } = {}) {
  invariant(isId(fileId), 'invalid_file');
  const { response, controller } = await publicGet(puter, `${publicPath(worker, space, token)}/f/${fileId}${thumb ? '/thumb' : ''}`, { signal, timeout });
  if (!response.ok) throw await errorFrom(response, controller.signal);
  const bytes = await readBytes(response, PUBLIC_BYTES, controller.signal);
  return new Blob([bytes], { type: response.headers.get('content-type') === 'application/octet-stream' ? '' : response.headers.get('content-type') ?? '' });
}

/** `gate(worker)` runs before any credential is attached, for example the `minBuild` check in deploy.js. */
export function createWorkerClient({ puter, credentials, timeout = 20_000, gate }) {
  async function request(worker, body, { binary = false } = {}) {
    const origin = workerOrigin(worker);
    invariant(typeof body === 'string' && new TextEncoder().encode(body).length <= LIMITS.bodyBytes, 'body_too_large', 413);
    const input = JSON.parse(body);
    invariant(OPS.includes(input.op), 'invalid_operation');
    if (gate) await gate(worker);
    let signing = {};
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers = await credentials.headers(origin, body, signing);
      invariant(headers['puter-auth'] && headers['puter-auth'] !== puter.authToken, 'restricted_credential_required');
      const controller = new AbortController();
      let timer;
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { reject(new ApiError(0, 'timeout')); controller.abort(); }, timeout);
      });
      const send = async () => {
        const response = await puter.workers.exec(`${origin}${API_PATH}`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body, signal: controller.signal,
        });
        if (response.status === 401) {
          let data = {};
          try { data = JSON.parse(new TextDecoder().decode(await readBytes(response, 16_384, controller.signal))); } catch { /* not JSON */ }
          throw new ApiError(401, data.code === 'proof_expired' ? 'proof_expired' : 'credential_rejected', data.code === 'proof_expired' ? data : {});
        }
        if (!response.ok) {
          let data = {};
          try { data = JSON.parse(new TextDecoder().decode(await readBytes(response, 16_384, controller.signal))); } catch { /* A gateway may return HTML. */ }
          const retryAfter = Number.isFinite(data.retryAfter) ? data.retryAfter : Number(response.headers.get('retry-after')) || undefined;
          throw new ApiError(response.status, typeof data.code === 'string' ? data.code : `http_${response.status}`, { ...data, retryAfter });
        }
        if (binary) return readJson(response, true, controller.signal);
        const data = await readJson(response, false, controller.signal);
        invariant(data?.ok === true, 'invalid_response', 502);
        return data;
      };
      try { return await Promise.race([send(), deadline]); }
      catch (error) {
        // A stale signing time re-signs with the worker's clock; anything else refreshes the credential.
        if (error.status === 401 && attempt === 0) { signing = error.code === 'proof_expired' ? { serverNow: error.serverNow } : { refresh: true }; continue; }
        if (typeof error.status === 'number') throw error;
        throw new ApiError(0, controller.signal.aborted ? 'timeout' : 'network');
      } finally { clearTimeout(timer); }
    }
  }
  /**
   * Signed file route `PUT|GET /files/<space>/<fileId>[/thumb]`; the proof signs "<METHOD> <path>". The deadline is
   * an idle timeout that progress resets. `onProgress({loaded, total})` reports bytes sent or received.
   */
  async function transfer(ref, fileId, { method, thumb = false, body, onProgress, signal, idle = 60_000 }) {
    validateSpaceRef(ref);
    invariant(isId(fileId), 'invalid_file');
    invariant(method === 'GET' || body instanceof Blob, 'invalid_body');
    const origin = workerOrigin(ref.w);
    const path = `/files/${ref.s}/${fileId}${thumb ? '/thumb' : ''}`;
    if (gate) await gate(ref.w);
    let signing = {};
    let refreshed = false;
    let stream = method === 'PUT' && typeof onProgress === 'function' && canStreamUploads();
    for (;;) {
      if (signal?.aborted) throw new ApiError(0, 'aborted');
      const headers = await credentials.headers(origin, `${method} ${path}`, signing);
      invariant(headers['puter-auth'] && headers['puter-auth'] !== puter.authToken, 'restricted_credential_required');
      const controller = new AbortController();
      let timer;
      let stop;
      const deadline = new Promise((_, reject) => { stop = reject; });
      const arm = (ms = idle) => { clearTimeout(timer); timer = setTimeout(() => { stop(new ApiError(0, 'timeout')); controller.abort(); }, ms); };
      const cancel = () => { stop(new ApiError(0, 'aborted')); controller.abort(); };
      signal?.addEventListener('abort', cancel, { once: true });
      // Once every byte is sent the worker still stores the file before it answers.
      const progress = (loaded, total) => { arm(method === 'PUT' && loaded >= total ? idle * 2 : idle); onProgress?.({ loaded, total }); };
      const send = async () => {
        // A whole body reports no progress, so allow it time at a slow 50 kB/s.
        arm(method === 'PUT' && !stream ? idle + Math.ceil(body.size / 50) : idle);
        const init = { method, headers, signal: controller.signal };
        if (method === 'PUT') {
          init.headers = { ...headers, 'Content-Type': 'application/octet-stream' };
          if (stream) Object.assign(init, { body: countingStream(body, (sent) => progress(sent, body.size)), duplex: 'half' });
          else init.body = body;
        }
        const response = await puter.workers.exec(`${origin}${path}`, init);
        if (!response.ok) throw await errorFrom(response, controller.signal);
        if (method === 'PUT') {
          const data = await readJson(response, false, controller.signal);
          invariant(data?.ok === true, 'invalid_response', 502);
          return data;
        }
        const total = Number(response.headers.get('content-length')) || 0;
        const { chunks } = await readChunks(response, LIMITS.fileBytes + 1024, controller.signal, (loaded) => progress(loaded, total));
        return new Blob(chunks);
      };
      try { return await Promise.race([send(), deadline]); }
      catch (error) {
        if (error?.status === 401 && !refreshed) { refreshed = true; signing = error.code === 'proof_expired' ? { serverNow: error.serverNow } : { refresh: true }; continue; }
        if (error instanceof ApiError || typeof error?.status === 'number') throw error;
        // Some networks refuse streamed bodies; resend once whole.
        if (stream && !signal?.aborted) { stream = false; streamUploads = false; continue; }
        throw new ApiError(0, signal?.aborted ? 'aborted' : 'network');
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    }
  }
  return {
    request,
    /** Proxied upload (≤50 MB); register it with the `file.put` op. `thumb: true` stores a thumbnail for a registered image. */
    upload(ref, fileId, blob, options = {}) { return transfer(ref, fileId, { ...options, method: 'PUT', body: blob }); },
    /** Resolves to a Blob of the stored bytes (always untyped). */
    download(ref, fileId, options = {}) { return transfer(ref, fileId, { ...options, method: 'GET' }); },
    call(ref, op, input = {}) {
      validateSpaceRef(ref);
      return request(ref.w, JSON.stringify({ ...input, op, space: ref.s }));
    },
    commit(ref, frozenBody) {
      validateSpaceRef(ref);
      const input = JSON.parse(frozenBody);
      invariant(input.op === 'commit' && input.space === ref.s, 'invalid_commit');
      return request(ref.w, frozenBody);
    },
    async snapshot(ref) {
      validateSpaceRef(ref);
      return request(ref.w, JSON.stringify({ op: 'snapshot', space: ref.s }), { binary: true });
    },
  };
}
