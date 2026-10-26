// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createConfigLoader, createMemoryCache, createPersistentCache, createServiceContext } from '../../src/services/core.js';
const config = { providers: { test: ['first', 'second'] }, disabled: [] };
const context = opts => createServiceContext({ userId: 'alice', cache: createMemoryCache(), config, retries: 0, sleep: async () => {}, ...opts });

describe('provider infrastructure', () => {
  it('deduplicates requests and returns detached normalized results', async () => {
    const ctx = context(); const load = vi.fn(async () => ({ data: { a: 1 }, attribution: [] }));
    const results = await Promise.all([ctx.run('test', { q: 'a' }, { first: load }), ctx.run('test', { q: 'a' }, { first: load })]);
    expect(load).toHaveBeenCalledOnce(); results[0].data.a = 2; expect(results[1].data.a).toBe(1);
    expect((await ctx.run('test', { q: 'a' }, { first: load })).cached).toBe(true);
  });
  it('falls back on errors, skips disabled providers and returns offline null', async () => {
    const first = vi.fn(async () => { throw new Error('down'); }); const second = vi.fn(async () => ({ data: 2 }));
    expect((await context().run('test', {}, { first, second })).provider).toBe('second');
    expect((await context({ config: { ...config, disabled: ['first'] } }).run('test', {}, { first, second })).data).toBe(2); expect(first).toHaveBeenCalledOnce();
    expect(await context({ online: () => false }).run('test', {}, { first, second })).toBeNull();
  });
  it('serves expired cache offline and keeps accounts separate even with an injected cache', async () => {
    let now = 0; let online = true; const cache = createMemoryCache(); const options = { cache, now: () => now, online: () => online };
    const alice = context(options), bob = context({ ...options, userId: 'bob' }); const loader = vi.fn(async () => ({ data: 1 }));
    await alice.run('test', {}, { first: loader }, { ttl: 10 }); now = 11; online = false;
    expect(await alice.run('test', {}, { first: loader })).toMatchObject({ data: 1, cached: true, stale: true });
    expect(await bob.run('test', {}, { first: loader })).toBeNull(); expect(loader).toHaveBeenCalledOnce();
  });
  it('aborts the underlying fetch only after every consumer cancels', async () => {
    let complete; const fetcher = vi.fn((_url, init) => new Promise((resolve, reject) => { complete = () => resolve(Response.json({ x: 1 })); init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))); }));
    const ctx = context({ fetch: fetcher }); const handler = async (_cfg, opts) => ({ data: (await ctx.json('https://example.com/', { provider: 'test', ...opts })).data });
    const a = new AbortController(), b = new AbortController(); const one = ctx.run('test', {}, { first: handler }, { signal: a.signal }), two = ctx.run('test', {}, { first: handler }, { signal: b.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce()); a.abort(); await expect(one).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher.mock.calls[0][1].signal.aborted).toBe(false);
    complete(); expect((await two).data).toEqual({ x: 1 });
    const canceled = new AbortController(); const next = ctx.run('test', { q: 'b' }, { first: handler }, { signal: canceled.signal }); await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2)); canceled.abort(); await expect(next).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
  });
  it('throttles, omits credentials and retries only transient responses', async () => {
    const sleep = vi.fn(async () => {}); const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(Response.json({ ok: true }));
    const ctx = context({ fetch: fetcher, retries: 1, now: () => 0, sleep });
    expect((await ctx.json('https://example.com', { provider: 'test' })).data).toEqual({ ok: true }); expect(sleep).toHaveBeenCalledWith(2000, undefined); expect(fetcher.mock.calls[0][1].credentials).toBe('omit');
    const bad = vi.fn(async () => new Response('', { status: 403 })); await expect(context({ fetch: bad, retries: 2 }).json('https://example.com', { provider: 'test' })).rejects.toThrow('403'); expect(bad).toHaveBeenCalledOnce();
  });
  it('refuses prohibited endpoints, oversized payloads and pre-aborted requests', async () => {
    const fetcher = vi.fn(async () => Response.json({})); const ctx = context({ fetch: fetcher });
    for (const url of ['https://overpass-api.de/api', 'https://router.project-osrm.org/route', 'https://tile.openstreetmap.org/0/0/0', 'http://example.com']) await expect(ctx.json(url)).rejects.toThrow();
    const controller = new AbortController(); controller.abort(); await expect(ctx.run('test', {}, {}, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' }); expect(fetcher).not.toHaveBeenCalled();
    await expect(context({ fetch: async () => new Response('{}', { headers: { 'content-length': '3000000' } }) }).json('https://example.com')).rejects.toThrow('too large');
  });
  it('loads no-cache config for one hour and strips unsafe geo worker targets', async () => {
    let now = 0; const fetcher = vi.fn(async () => Response.json({ providers: { route: ['straight'] }, geoWorker: 'https://evil.example', disabled: [] })); const loader = createConfigLoader({ fetch: fetcher, now: () => now });
    expect((await loader()).geoWorker).toBeNull(); await loader(); expect(fetcher).toHaveBeenCalledOnce(); now = 3_600_001; await loader(); expect(fetcher).toHaveBeenCalledTimes(2); expect(fetcher.mock.calls[0][1].cache).toBe('no-cache');
  });
  it('uses bounded fallback cache when IndexedDB is unavailable', async () => {
    expect(() => createPersistentCache('')).toThrow(); const cache = createPersistentCache('alice', { indexedDB: null, limit: 1 }); await cache.set('a', { x: 1 }); await cache.set('b', { x: 2 }); expect(await cache.get('a')).toBeNull(); expect(await cache.get('b')).toEqual({ x: 2 }); await cache.clear(); expect(await cache.get('b')).toBeNull();
  });
});

it('bounds streamed bytes and times out unresponsive providers', async () => {
  const streamed = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2_000_001)); controller.close(); } });
  await expect(context({ fetch: async () => new Response(streamed) }).json('https://example.com')).rejects.toThrow('too large');
  const fetcher = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
  await expect(context({ fetch: fetcher, timeout: 5 }).json('https://example.com')).rejects.toMatchObject({ name: 'TimeoutError' });
});

it('rejects a deadline even when fetch ignores its abort signal and cleans up a late body', async () => {
  let finish;
  const canceled = vi.fn();
  const fetcher = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const ctx = context({ fetch: fetcher, timeout: 5 });
  await expect(ctx.json('https://example.com')).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
  finish(new Response(new ReadableStream({ cancel: canceled })));
  await vi.waitFor(() => expect(canceled).toHaveBeenCalledOnce());
});

it('rejects stalled body reads and never waits for a stalled cancel hook', async () => {
  const canceled = vi.fn(() => new Promise(() => {}));
  const body = new ReadableStream({ pull() {}, cancel: canceled });
  const ctx = context({ fetch: async () => new Response(body), timeout: 5 });
  await expect(ctx.json('https://example.com')).rejects.toMatchObject({ name: 'TimeoutError' });
  expect(canceled).toHaveBeenCalledOnce();
});

it('cancels oversized Content-Length and all failed response bodies before retry/final error', async () => {
  const oversizedCancel = vi.fn(() => new Promise(() => {}));
  const oversized = new Response(new ReadableStream({ cancel: oversizedCancel }), { headers: { 'content-length': '3000000' } });
  await expect(context({ fetch: async () => oversized, timeout: 20 }).json('https://example.com')).rejects.toThrow('too large');
  expect(oversizedCancel).toHaveBeenCalledOnce();
  const retryCancel = vi.fn(() => new Promise(() => {})), finalCancel = vi.fn(() => new Promise(() => {}));
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: retryCancel }), { status: 503 }))
    .mockResolvedValueOnce(new Response(new ReadableStream({ cancel: finalCancel }), { status: 403 }));
  await expect(context({ fetch: fetcher, retries: 1 }).json('https://example.com')).rejects.toThrow('403');
  expect(fetcher).toHaveBeenCalledTimes(2); expect(retryCancel).toHaveBeenCalledOnce(); expect(finalCancel).toHaveBeenCalledOnce();
});

it('uses last settings offline without starting or awaiting a stalled configuration fetch', async () => {
  let connected = true;
  const fetcher = vi.fn(async () => Response.json(config));
  const loader = createConfigLoader({ fetch: fetcher, timeout: 5 });
  const cache = createMemoryCache();
  const ctx = context({ cache, config: loader, online: () => connected, configTimeout: 10 });
  await ctx.run('test', {}, { first: async () => ({ data: 'warm' }) });
  fetcher.mockImplementation(() => new Promise(() => {}));
  const pending = loader({ refresh: true });
  connected = false;
  expect(await ctx.run('test', {}, {})).toBeNull();
  expect((await ctx.run('test', {}, { first: async () => ({ data: 'unused' }) })).data).toBe('warm');
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect((await pending).providers.test).toEqual(['first', 'second']);
  const offline = createConfigLoader({ fetch: fetcher, online: () => false });
  expect((await offline()).providers.geocode).toContain('photon'); expect(fetcher).toHaveBeenCalledTimes(2);
});

it('bounds online configuration fetch/body deadlines, including an injected loader', async () => {
  const stalled = vi.fn(() => new Promise(() => {}));
  expect((await createConfigLoader({ fetch: stalled, timeout: 5 })()).providers.fx).toContain('frankfurter');
  const canceled = vi.fn(() => new Promise(() => {}));
  const loader = createConfigLoader({ fetch: async () => new Response(new ReadableStream({ cancel: canceled })), timeout: 5 });
  expect((await loader()).providers.fx).toContain('frankfurter'); expect(canceled).toHaveBeenCalledOnce();
  const ctx = context({ config: stalled, configTimeout: 5 });
  expect(await ctx.run('test', {}, { first: async () => ({ data: 'never' }) })).toBeNull();
});

it('sanitizes provider arrays and refuses inherited handler/config keys', async () => {
  const dirty = JSON.parse('{"providers":{"test":["first","first",null,"constructor","__proto__",{}],"fx":"frankfurter","constructor":["first"]},"disabled":"first"}');
  const own = vi.fn(async () => ({ data: 'own' }));
  const ctx = context({ config: dirty }); expect((await ctx.loadConfig()).providers.test).toEqual(['first']); expect((await ctx.loadConfig()).providers.fx).toEqual([]);
  const inherited = Object.create({ first: own }); expect(await ctx.run('test', {}, inherited)).toBeNull(); expect(own).not.toHaveBeenCalled();
  expect((await ctx.run('test', {}, { first: own })).data).toBe('own');
  expect(await ctx.run('constructor', {}, { first: own })).toBeNull();
});
