import { readTextBounded } from '../src/services/core.js';
import { TTL, invalid, normalizeRequest } from './normalize.js';
import { cacheKey, createGeoCache } from './cache.js';
import { createKvLimiter } from './limiter.js';
import { PROVIDERS, createRemoteConfig } from './remote.js';

export { createKvLimiter } from './limiter.js';
export const IDENTIFICATION = 'PuterTrips/1.0 (+https://trips.puter.com)';
const allowedOrigins = new Set(['https://trips.puter.com']);
const POST_PATHS = new Set(['/route', '/matrix', '/valhalla']);
const UPSTREAM_TIMEOUT = 10_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const NEGATIVE_TTL = 86_400;

/**
 * `enabled` is the code-level allowlist; `geo:config` in KV adds the region count for the limiter and a kill switch.
 * Cached answers are served even when upstream calls are off or killed.
 */
export function createGeoHandler({ kv, fetch: fetcher = globalThis.fetch, limiter, remoteConfig, now = Date.now, maxMemoryEntries = 128, origins = allowedOrigins, enabled = [], maxRequestsPerSecond = 10, maxPerAddress = 30, timeout = UPSTREAM_TIMEOUT } = {}) {
  if (!kv) throw new TypeError('Geo worker requires KV');
  const cache = createGeoCache({ kv, now, memoryEntries: maxMemoryEntries });
  limiter ??= createKvLimiter(kv, { now });
  remoteConfig ??= createRemoteConfig({ kv, now });
  let requestWindow = -1; let requestCount = 0;
  // Per caller address and 10 s window, checked before anything that costs a KV call.
  let addressWindow = -1; const addresses = new Map();
  const overAddress = request => {
    const address = request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
    if (!address) return false;
    const window = Math.floor(now() / 10_000);
    if (addressWindow !== window || addresses.size > 10_000) { addressWindow = window; addresses.clear(); }
    const count = (addresses.get(address) ?? 0) + 1;
    addresses.set(address, count);
    return count > maxPerAddress;
  };
  const reply = (data, status = 200, origin, headers = {}) => Response.json(data, { status, headers: { ...(origin && origins.has(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}), 'Cache-Control': 'no-store', ...headers } });
  const active = (provider, remote) => enabled.includes(provider) && !remote.killed && !remote.disabled.includes(provider);
  return async request => {
    const origin = request.headers.get('origin');
    if (origin && !origins.has(origin)) return reply({ code: 'origin_denied' }, 403);
    if (request.headers.has('puter-auth') || request.headers.has('authorization')) return reply({ code: 'credentials_forbidden' }, 400, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}), 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' } });
    const url = new URL(request.url);
    try {
      if (request.method === 'GET' && url.pathname === '/config') {
        const remote = await remoteConfig();
        return reply({ enabled: PROVIDERS.filter(provider => active(provider, remote)), limiter: remote.regions ? 'declared' : 'unverified' }, 200, origin);
      }
      let body;
      if (request.method === 'POST' && POST_PATHS.has(url.pathname)) {
        if (Number(request.headers.get('content-length')) > 16_384) throw invalid('body_too_large', 413);
        let raw; try { raw = await readTextBounded(request, 16_384); } catch { throw invalid('body_too_large', 413); }
        try { body = JSON.parse(raw); } catch { throw invalid('invalid_json'); }
      }
      const call = normalizeRequest({ method: request.method, pathname: url.pathname, params: url.searchParams, body });
      if (!call) return reply({ code: 'not_found' }, 404, origin);
      const key = await cacheKey(call.provider, call.key);
      const warm = cache.peek(key);
      if (warm) return reply(warm.data, 200, origin, { 'X-Cache': warm.layer });
      if (overAddress(request)) return reply({ code: 'request_budget' }, 429, origin, { 'Retry-After': '10' });
      const window = Math.floor(now() / 1000);
      if (requestWindow !== window) { requestWindow = window; requestCount = 0; }
      if (++requestCount > maxRequestsPerSecond) return reply({ code: 'request_budget' }, 429, origin, { 'Retry-After': '1' });
      const hit = await cache.get(key);
      if (hit) return reply(hit.data, 200, origin, { 'X-Cache': hit.layer });
      const remote = await remoteConfig();
      if (!active(call.provider, remote)) return reply({ code: 'provider_disabled' }, 503, origin, { 'Retry-After': '300' });
      const verdict = await limiter(call.provider, { regions: remote.regions, limit: remote.limits[call.provider] });
      if (verdict !== true && !verdict?.ok) return reply({ code: 'rate_limited' }, 429, origin, { 'Retry-After': String(verdict?.retryAfter ?? 1) });
      const signal = AbortSignal.any ? AbortSignal.any([request.signal, AbortSignal.timeout(timeout)].filter(Boolean)) : request.signal;
      let response;
      try {
        response = await fetcher(call.upstream.url, { method: call.upstream.method, body: call.upstream.body, headers: { 'User-Agent': IDENTIFICATION, Accept: 'application/json', ...(call.upstream.body ? { 'Content-Type': 'application/json' } : {}) }, redirect: 'error', signal });
      } catch { throw invalid('upstream_unavailable', 502); }
      if (!response.ok) { try { response.body?.cancel()?.catch(() => {}); } catch { /* Body already consumed. */ } return reply({ code: 'upstream_unavailable' }, response.status === 429 ? 429 : 502, origin, response.status === 429 ? { 'Retry-After': '1' } : {}); }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw invalid('response_too_large', 502);
      let raw; try { raw = await readTextBounded(response, MAX_RESPONSE_BYTES); } catch { throw invalid('response_too_large', 502); }
      let data; try { data = JSON.parse(raw); } catch { throw invalid('invalid_upstream', 502); }
      if (!call.accept(data)) throw invalid('invalid_upstream', 502);
      // Bodies over the cache cap are served but not stored.
      const stored = await cache.set(key, data, call.negative?.(data) ? NEGATIVE_TTL : TTL[call.provider]);
      return reply(data, 200, origin, { 'X-Cache': stored ? 'miss' : 'bypass' });
    } catch (cause) {
      return reply({ code: cause.code ?? (cause instanceof RangeError ? 'invalid_request' : 'upstream_unavailable') }, cause.status ?? (cause instanceof RangeError ? 400 : 502), origin);
    }
  };
}
