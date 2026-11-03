// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetUnfurlCache } from '../../worker/ops/trip/unfurl.js';
import { USERS, createHarness, expectError } from './harness.js';

const OWNER = USERS.alice.uuid;
const owner = (h) => h.world.counters().byUser[OWNER]?.calls ?? {};
const page = (title) => new Response(`<html><head><title>${title}</title><meta property="og:description" content="About ${title}"></head><body></body></html>`, { headers: { 'content-type': 'text/html' } });

let fetcher;
beforeEach(() => {
  resetUnfurlCache();
  fetcher = vi.fn(async (url) => page(new URL(url).pathname.slice(1) || 'Home'));
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllGlobals(); });

async function setup() {
  const h = await createHarness();
  const space = await h.team({ bob: 'editor', carol: 'viewer' });
  const as = async (name) => (await h.client(name)).in(space);
  return { h, space, alice: await as('alice'), bob: await as('bob'), carol: await as('carol'), dave: await as('dave') };
}

describe('link.unfurl', () => {
  it('previews a public page for any member, viewers included, and refuses others', async () => {
    const { carol, dave, bob } = await setup();
    expect(await carol.call('link.unfurl', { url: 'https://guide.example.org/Lisbon#trams' })).toMatchObject({ preview: { title: 'Lisbon', desc: 'About Lisbon', image: null } });
    expect(fetcher.mock.calls[0][0]).toBe('https://guide.example.org/Lisbon');
    await expectError(dave.call('link.unfurl', { url: 'https://guide.example.org/x' }), 403, 'not_member');
    await expectError(bob.call('link.unfurl', { url: 42 }), 400, 'invalid_url');
    await expectError(bob.call('link.unfurl', { url: `https://a.example.org/${'x'.repeat(2100)}` }), 400, 'invalid_url');
  });

  it('answers null without fetching for blocked addresses', async () => {
    const { bob } = await setup();
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://localhost/', 'ftp://example.org/', 'http://10.0.0.1/']) {
      expect(await bob.call('link.unfurl', { url })).toEqual({ ok: true, preview: null });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('caches per URL across members and spaces: one fetch, then no owner KV writes', async () => {
    const { h, bob, carol } = await setup();
    await bob.call('link.unfurl', { url: 'https://a.example.org/Porto' });
    await h.settle();
    h.world.resetCounters();
    expect((await carol.call('link.unfurl', { url: 'https://a.example.org/Porto' })).preview.title).toBe('Porto');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(owner(h)['kv.set'] ?? 0).toBe(0);
    expect(owner(h)['kv.incr'] ?? 0).toBe(0);
    // A fresh isolate reads the stored entry instead of fetching again.
    resetUnfurlCache();
    h.world.resetCounters();
    expect((await bob.call('link.unfurl', { url: 'https://a.example.org/Porto' })).preview.title).toBe('Porto');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(owner(h)['kv.get']).toBeGreaterThanOrEqual(1);
    expect(owner(h)['kv.set'] ?? 0).toBe(0);
  });

  it('a miss costs one cache read, one budget counter and one cache write', async () => {
    const { h, bob } = await setup();
    await bob.call('link.unfurl', { url: 'https://a.example.org/warm' });
    h.advance(5000);
    await h.settle();
    h.world.resetCounters();
    await bob.call('link.unfurl', { url: 'https://a.example.org/new' });
    await h.settle();
    const calls = owner(h);
    expect(calls['kv.incr']).toBe(1);
    expect(calls['kv.set']).toBe(1);
    expect(calls['kv.get']).toBeLessThanOrEqual(2);
  });

  it('remembers pages without a preview for an hour', async () => {
    const { h, bob } = await setup();
    fetcher.mockImplementation(async () => new Response('nope', { status: 404 }));
    expect((await bob.call('link.unfurl', { url: 'https://gone.example.org/' })).preview).toBeNull();
    expect((await bob.call('link.unfurl', { url: 'https://gone.example.org/' })).preview).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    h.advance(3_600_001);
    fetcher.mockImplementation(async () => page('Back'));
    expect((await bob.call('link.unfurl', { url: 'https://gone.example.org/' })).preview.title).toBe('Back');
  });

  it('limits each member to 60 requests a minute', async () => {
    const { h, bob, carol } = await setup();
    for (let i = 0; i < 60; i++) await bob.call('link.unfurl', { url: 'https://a.example.org/same' });
    const error = await expectError(bob.call('link.unfurl', { url: 'https://a.example.org/same' }), 429, 'rate_limited');
    expect(error.retryAfter ?? error.extra?.retryAfter ?? 1).toBeGreaterThan(0);
    await carol.call('link.unfurl', { url: 'https://a.example.org/same' });
    h.advance(61_000);
    await bob.call('link.unfurl', { url: 'https://a.example.org/same' });
  });

  it('caps page fetches per member per day', async () => {
    const { h, bob } = await setup();
    for (let i = 0; i < 200; i++) {
      if (i && i % 50 === 0) h.advance(61_000);
      await bob.call('link.unfurl', { url: `https://a.example.org/p${i}` });
    }
    h.advance(61_000);
    await expectError(bob.call('link.unfurl', { url: 'https://a.example.org/one-more' }), 429, 'rate_limited');
    expect(fetcher).toHaveBeenCalledTimes(200);
    // Cached pages still answer.
    expect((await bob.call('link.unfurl', { url: 'https://a.example.org/p3' })).preview.title).toBe('p3');
  });
});
