// HTTP to the user's own servers through `puter.net.fetch`: CORS-free, but it never follows redirects and cannot
// be aborted, so timeouts only stop waiting. Keys go to the configured origin and nowhere else.
import { IntegrationError } from './errors.js';

export const JSON_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TIMEOUT = 20_000;

/**
 * The base URL of a server as typed by the user: http(s) only, no credentials, query or fragment, no trailing
 * slash and no trailing `/api` or `/api/v1` (adapters add their own paths). A bare host gets `https://`. Null when invalid.
 */
export function normalizeServerUrl(input) {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (!text || text.length > 2048 || /\s/.test(text)) return null;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) return null;
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api(?:\/v1)?$/i, '');
  return `${url.origin}${path}`;
}

export const isPlainHttp = (url) => typeof url === 'string' && url.startsWith('http:');

/** Key order independent JSON, so equal content always hashes the same. */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 16 hex characters from two FNV-1a passes; for change detection, not security. */
export function stableHash(value) {
  const text = typeof value === 'string' ? value : stableJson(value);
  let a = 0x811c9dc5; let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x01000193) ^ (b >>> 13);
  }
  return [a, b].map((part) => (part >>> 0).toString(16).padStart(8, '0')).join('');
}

/** 8 hex characters naming a server, for keys that must not collide across servers. */
export const serverTag = (url) => stableHash(normalizeServerUrl(url) ?? '').slice(0, 8);

function joinUrl(base, path, query) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /(^|\/)\.\.?(\/|$)/.test(path)) throw new IntegrationError('invalid_url');
  const url = new URL(`${base}${path}`);
  if (url.origin !== new URL(base).origin) throw new IntegrationError('invalid_url');
  for (const [name, value] of Object.entries(query ?? {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  return url.href;
}

function retryAfter(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.min(3600, seconds)) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.min(3_600_000, at - Date.now())) : undefined;
}

async function readBytes(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new IntegrationError('too_large');
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new IntegrationError('too_large');
    return buffer;
  }
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { void reader.cancel().catch(() => {}); throw new IntegrationError('too_large'); }
      chunks.push(value);
    }
  } finally { try { reader.releaseLock(); } catch { /* Already released. */ } }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function statusError(status, data, headers, service) {
  const details = { httpStatus: status, service };
  if (status >= 300 && status < 400) return new IntegrationError('redirected', details);
  if (status === 401) return new IntegrationError('unauthorized', details);
  if (status === 403) {
    const scope = typeof data?.required_scope === 'string' ? data.required_scope.slice(0, 64) : null;
    return scope || /scope/i.test(String(data?.code ?? data?.error?.code ?? '')) ? new IntegrationError('scope', { ...details, scope }) : new IntegrationError('forbidden', details);
  }
  if (status === 404) return new IntegrationError('not_found', details);
  if (status === 429) return new IntegrationError('rate_limited', { ...details, retryAfter: retryAfter(headers) });
  if (status >= 500) return new IntegrationError('server_error', details);
  return new IntegrationError('rejected', details);
}

function race(promise, { timeout, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new IntegrationError('aborted')); return; }
    const timer = setTimeout(() => reject(new IntegrationError('timeout')), timeout);
    const abort = () => { clearTimeout(timer); reject(new IntegrationError('aborted')); };
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); });
  });
}

/**
 * A client for one server. `headers` and `query` are sent with every request (the service's key). `request(path,
 * options)` resolves `{data, status, headers}`: parsed JSON, or bytes with `binary: true` (a Blob of `type`).
 */
export function createClient({ puter, url, service, headers: baseHeaders = {}, query: baseQuery = {}, timeout = DEFAULT_TIMEOUT }) {
  const base = normalizeServerUrl(url);
  if (!base) throw new IntegrationError('invalid_url', { service });
  async function request(path, { method = 'GET', query, body, binary = false, maxBytes = JSON_BYTES, timeout: limit = timeout, signal, type } = {}) {
    const fetcher = puter?.net?.fetch;
    if (typeof fetcher !== 'function') throw new IntegrationError('unavailable', { service });
    if (globalThis.navigator?.onLine === false) throw new IntegrationError('offline', { service });
    const target = joinUrl(base, path, { ...baseQuery, ...query });
    const headers = { accept: binary ? '*/*' : 'application/json', ...baseHeaders };
    const init = { method, headers };
    if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    let response;
    try { response = await race(Promise.resolve(fetcher.call(puter.net, target, init)), { timeout: limit, signal }); }
    catch (error) {
      if (error instanceof IntegrationError) throw Object.assign(error, { service });
      throw new IntegrationError(globalThis.navigator?.onLine === false ? 'offline' : 'unreachable', { service });
    }
    const status = Number(response?.status) || 0;
    if (!status) throw new IntegrationError('unreachable', { service });
    const ok = status >= 200 && status < 300;
    let bytes;
    try { bytes = await race(readBytes(response, ok ? maxBytes : 64 * 1024), { timeout: limit, signal }); }
    catch (error) {
      if (!ok) throw statusError(status, null, response.headers, service);
      throw error instanceof IntegrationError ? Object.assign(error, { service }) : new IntegrationError('unreachable', { service });
    }
    let data = null;
    if (!binary || !ok) {
      const text = new TextDecoder().decode(bytes);
      try { data = text.trim() ? JSON.parse(text) : null; } catch { if (ok) throw new IntegrationError('bad_response', { service }); }
    }
    if (!ok) throw statusError(status, data, response.headers, service);
    if (binary) data = new Blob([bytes], { type: type ?? response.headers?.get?.('content-type') ?? 'application/octet-stream' });
    return { data, status, headers: response.headers };
  }
  return { base, service, request };
}
