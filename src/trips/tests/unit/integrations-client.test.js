// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createClient, normalizeServerUrl, serverTag, stableHash } from '../../src/lib/integrations/client.js';
import { errorKey } from '../../src/lib/integrations/errors.js';
import { fakeNet } from './helpers/fake-net.js';

describe('server URLs', () => {
  it.each([
    ['immich.example.com', 'https://immich.example.com'],
    ['https://photos.example.com/', 'https://photos.example.com'],
    ['https://photos.example.com/api', 'https://photos.example.com'],
    ['https://example.com/dawarich/api/v1/?x=1#y', 'https://example.com/dawarich'],
    ['http://10.0.0.5:2283', 'http://10.0.0.5:2283'],
    ['  https://air.example.org/base//  ', 'https://air.example.org/base'],
  ])('normalizes %s', (input, output) => expect(normalizeServerUrl(input)).toBe(output));

  it.each(['', 'ftp://x.example', 'javascript:alert(1)', 'https://user:pass@x.example', 'https://exa mple.com', null, 42])('refuses %s', (input) => {
    expect(normalizeServerUrl(input)).toBeNull();
  });

  it('hashes content regardless of key order and tags servers by URL', () => {
    expect(stableHash({ a: 1, b: [1, { c: 2, d: null }] })).toBe(stableHash({ b: [1, { d: null, c: 2 }], a: 1 }));
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
    expect(stableHash('x')).toMatch(/^[0-9a-f]{16}$/);
    expect(serverTag('https://d.example.com/')).toBe(serverTag('d.example.com'));
    expect(serverTag('https://d.example.com')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('requests through puter.net.fetch', () => {
  it('sends the key only to the configured origin and parses JSON', async () => {
    const net = fakeNet({ 'GET /base/api/v1/me': () => ({ json: { ok: true } }) });
    const client = createClient({ puter: net.puter, url: 'https://srv.example.com/base', service: 'airtrail', headers: { authorization: 'Bearer k' } });
    const { data } = await client.request('/api/v1/me', { query: { a: 1, b: undefined } });
    expect(data).toEqual({ ok: true });
    expect(net.calls[0].url.href).toBe('https://srv.example.com/base/api/v1/me?a=1');
    expect(net.calls[0].headers.authorization).toBe('Bearer k');
    for (const path of ['//evil.example/x', '/../x', '/a/../../x', 'relative', '/a/./b']) {
      await expect(client.request(path)).rejects.toMatchObject({ code: 'invalid_url' });
    }
    expect(net.calls).toHaveLength(1);
  });

  it('maps HTTP failures to integration errors', async () => {
    const statuses = { 302: 'redirected', 401: 'unauthorized', 404: 'not_found', 418: 'rejected', 500: 'server_error', 503: 'server_error' };
    for (const [status, code] of Object.entries(statuses)) {
      const net = fakeNet({ 'GET /x': () => ({ status: Number(status), json: { error: 'no' } }) });
      const client = createClient({ puter: net.puter, url: 'https://s.example', service: 'immich' });
      await expect(client.request('/x')).rejects.toMatchObject({ code, httpStatus: Number(status), service: 'immich' });
    }
    const scoped = fakeNet({ 'GET /x': () => ({ status: 403, json: { error: 'scope', code: 'API_SCOPE_FORBIDDEN', required_scope: 'trips' } }) });
    await expect(createClient({ puter: scoped.puter, url: 'https://s.example' }).request('/x')).rejects.toMatchObject({ code: 'scope', scope: 'trips' });
    const plain = fakeNet({ 'GET /x': () => ({ status: 403, json: { error: 'denied' } }) });
    await expect(createClient({ puter: plain.puter, url: 'https://s.example' }).request('/x')).rejects.toMatchObject({ code: 'forbidden' });
    const limited = fakeNet({ 'GET /x': () => ({ status: 429, json: {}, headers: { 'retry-after': '30' } }) });
    await expect(createClient({ puter: limited.puter, url: 'https://s.example' }).request('/x')).rejects.toMatchObject({ code: 'rate_limited', retryAfter: 30_000 });
  });

  it('caps response sizes, declared or streamed', async () => {
    const declared = fakeNet({ 'GET /x': () => ({ body: '{}', headers: { 'content-length': '999999999' } }) });
    await expect(createClient({ puter: declared.puter, url: 'https://s.example' }).request('/x')).rejects.toMatchObject({ code: 'too_large' });
    const streamed = fakeNet({ 'GET /x': () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 4; i += 1) controller.enqueue(new Uint8Array(400)); controller.close(); } })) });
    await expect(createClient({ puter: streamed.puter, url: 'https://s.example' }).request('/x', { binary: true, maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' });
    const small = fakeNet({ 'GET /x': () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } }) });
    const { data } = await createClient({ puter: small.puter, url: 'https://s.example' }).request('/x', { binary: true, maxBytes: 1000 });
    expect(data.type).toBe('image/jpeg');
    expect(data.size).toBe(3);
  });

  it('rejects malformed JSON, timeouts, missing net.fetch and network failures', async () => {
    const bad = fakeNet({ 'GET /x': () => ({ body: '<html>' }) });
    await expect(createClient({ puter: bad.puter, url: 'https://s.example' }).request('/x')).rejects.toMatchObject({ code: 'bad_response' });
    vi.useFakeTimers();
    try {
      const slow = { authToken: 't', net: { fetch: () => new Promise(() => {}) } };
      const pending = createClient({ puter: slow, url: 'https://s.example', timeout: 1000 }).request('/x');
      const check = expect(pending).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(1001);
      await check;
    } finally { vi.useRealTimers(); }
    await expect(createClient({ puter: { authToken: 't' }, url: 'https://s.example' }).request('/x')).rejects.toMatchObject({ code: 'unavailable' });
    const broken = { authToken: 't', net: { fetch: () => Promise.reject(new TypeError('socket closed')) } };
    const error = await createClient({ puter: broken, url: 'https://s.example' }).request('/x').catch((caught) => caught);
    expect(error.code).toBe('unreachable');
    expect(errorKey(error)).toBe('integrations.error.unreachable');
    expect(() => createClient({ puter: broken, url: 'notaurl at all' })).toThrow();
  });
});
