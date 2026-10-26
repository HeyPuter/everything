// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createFakePuter } from '../../dev/fake-puter/index.js';
import {
  DAWARICH_KEY, REVIEW_MAX, dawarichClient, dayTrail, listStays, readReview, reviewKey, trailFromPoints, verifyDawarich, writeReview,
} from '../../src/lib/integrations/dawarich.js';
import { fakeNet, fixture } from './helpers/fake-net.js';

const config = { url: 'https://where.example.com', key: 'dw-key' };

describe('Dawarich adapter', () => {
  it('lists stays in the range, dropping declined and broken visits', async () => {
    const net = fakeNet({ 'GET /api/v1/visits': () => ({ json: fixture('dawarich-visits.json') }) });
    const stays = await listStays(dawarichClient(net.puter, config), { from: '2026-05-02', to: '2026-05-09' });
    expect(net.calls[0].url.searchParams.get('start_at')).toBe('2026-05-01T00:00:00Z');
    expect(net.calls[0].url.searchParams.get('end_at')).toBe('2026-05-11T00:00:00Z');
    expect(net.calls[0].headers.authorization).toBe('Bearer dw-key');
    expect(net.calls[0].url.searchParams.has('api_key')).toBe(false);
    expect(stays).toEqual([
      { id: '9001', name: 'The Metropolitan Museum of Art', status: 'suggested', start: Date.parse('2026-05-03T13:05:00.000Z'), end: Date.parse('2026-05-03T15:35:00.000Z'), minutes: 150, lat: 40.7794, lng: -73.9632, city: 'New York', country: 'United States' },
      { id: '9002', name: "Joe's Pizza", status: 'confirmed', start: Date.parse('2026-05-04T00:30:00.000Z'), end: Date.parse('2026-05-04T02:00:00.000Z'), minutes: 90, lat: 40.7306, lng: -73.9895, city: null, country: null },
    ]);
  });

  it('retries with the key in the query only after a 401', async () => {
    const net = fakeNet({ 'GET /api/v1/users/me': (url) => (url.searchParams.get('api_key') === 'dw-key' ? { json: { user: { id: 3, email: 'a@example.com' } } } : { status: 401, json: {} }) });
    expect(await verifyDawarich(dawarichClient(net.puter, config))).toEqual({ user: { id: '3', email: 'a@example.com' } });
    expect(net.calls.map((call) => call.url.searchParams.has('api_key'))).toEqual([false, true]);
  });

  it('turns recorded points into a thinned trail split at gaps', () => {
    const trail = trailFromPoints(fixture('dawarich-points.json'));
    expect(trail.segments).toEqual([
      [[-73.9855, 40.758], [-73.9776, 40.7614], [-73.9632, 40.7794]],
      [[-73.9895, 40.7306], [-73.9905, 40.7316]],
    ]);
    expect(trail.count).toBe(5);
    const many = Array.from({ length: 12_000 }, (_, i) => ({ latitude: 40 + i * 0.001, longitude: -73, timestamp: 1_777_896_000 + i }));
    expect(trailFromPoints(many).count).toBeLessThanOrEqual(5001);
  });

  it('reads a local day of points page by page', async () => {
    const net = fakeNet({ 'GET /api/v1/points': (url) => ({ json: url.searchParams.get('page') === '1' ? fixture('dawarich-points.json') : [], headers: { 'x-total-pages': '1' } }) });
    const trail = await dayTrail(dawarichClient(net.puter, config), { date: '2026-05-04', zone: 'America/New_York' });
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].url.searchParams.get('start_at')).toBe('2026-05-04T04:00:00.000Z');
    expect(net.calls[0].url.searchParams.get('end_at')).toBe('2026-05-05T04:00:00.000Z');
    expect(trail).toMatchObject({ count: 5, truncated: false });
  });

  it('keeps review decisions in me:dawarich with path writes and a cap', async () => {
    const runtime = createFakePuter({ now: 1_000_000 });
    const puter = runtime.client('alice');
    const key = reviewKey(config.url, '9001');
    expect(key).toMatch(/^[0-9a-f]{8}_9001$/);
    expect(reviewKey(config.url, 'a.b')).toBeNull();
    let review = await writeReview(puter, [{ key, state: 'dismissed' }], { now: 5 });
    review = await writeReview(puter, [{ key: reviewKey(config.url, '9002'), state: 'accepted', trip: 'trip1' }], { current: review, now: 6 });
    const stored = readReview(await puter.kv.get(DAWARICH_KEY));
    expect([...stored.entries()]).toEqual([[key, { s: 'dismissed', at: 5 }], [reviewKey(config.url, '9002'), { s: 'accepted', at: 6, trip: 'trip1' }]]);
    review = await writeReview(puter, [{ key, state: null }], { current: review });
    expect(readReview(await puter.kv.get(DAWARICH_KEY)).has(key)).toBe(false);
    await expect(writeReview(puter, [{ key: 'bad key', state: 'accepted' }])).rejects.toMatchObject({ code: 'rejected' });

    const full = new Map(Array.from({ length: REVIEW_MAX }, (_, i) => [reviewKey(config.url, `x${i}`), { s: 'dismissed', at: 100 + i }]));
    const next = await writeReview(puter, [{ key: reviewKey(config.url, 'new'), state: 'dismissed' }], { current: full, now: 10_000 });
    expect(next.size).toBe(REVIEW_MAX);
    expect(next.has(reviewKey(config.url, 'x0'))).toBe(false);
    expect(next.has(reviewKey(config.url, 'new'))).toBe(true);
  });
});
