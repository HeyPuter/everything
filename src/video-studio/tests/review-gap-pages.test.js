import { it, expect } from 'vitest';
import { setup, publish } from './review-helpers.js';
import { LOST_CHANGE_MS } from '../worker/service.js';
import { LIMITS } from '../src/review/protocol.js';

it('reaches a committed comment beyond a complete abandoned log page', async () => {
  const env = await setup();
  const { review } = await publish(env);
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:seq`, LIMITS.syncBatch);
  const saved = (await env.as('alice')('comment.add', { review: review.id, version: 1, id: 'c_aftergap01', text: 'After an abandoned page', t: 0 })).comment;
  env.advance(LOST_CHANGE_MS + 1);
  let cursor = 0;
  const seen = [];
  for (let poll = 0; poll < 3; poll++) {
    const response = await env.as('alice')('sync', { review: review.id, since: cursor });
    cursor = response.cursor;seen.push(...response.changes);
    env.advance(LOST_CHANGE_MS + 1);
  }
  expect(seen.map(c => c.id)).toContain(saved.id);
  expect(cursor).toBe(saved.seq);
});

it.each([false, true])('carries an aged observation across empty pages and a missing tail (middle comment: %s)', async middle => {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id, kv = env.sdk.alice.kv;
  const post = id => env.as('alice')('comment.add', { review: rid, version: 1, id, text: id, t: 0 });
  if (middle) {
    await kv.set(`vsr:r:${rid}:seq`, 150);await post('c_middle001');
  }
  await kv.set(`vsr:r:${rid}:seq`, 307);
  const sync = since => env.as('alice')('sync', { review: rid, since });
  expect((await sync(0)).cursor).toBe(0);
  const observation = await kv.get(`vsr:r:${rid}:wait:1`);
  expect(observation.observedThrough).toBe(307);
  env.advance(30_000);await post('c_newer0001');
  expect((await sync(0)).cursor).toBe(0);
  expect((await kv.get(`vsr:r:${rid}:wait:1`)).observedAt).toBe(observation.observedAt);
  env.advance(LOST_CHANGE_MS - 30_000 + 1);
  let cursor = 0;
  const seen = [];
  for (let page = 0; page < 4; page++) {
    const result = await sync(cursor);
    expect(result.cursor).toBeGreaterThan(cursor);
    cursor = result.cursor;seen.push(...result.changes);
  }
  expect(cursor).toBe(308);
  expect(seen.map(c => c.id)).toEqual(middle ? ['c_middle001', 'c_newer0001'] : ['c_newer0001']);
});

it('waits for a fresh observation and eventually clears an entirely empty tail', async () => {
  const env = await setup();
  const { review } = await publish(env);
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:seq`, 1);
  const sync = () => env.as('alice')('sync', { review: review.id, since: 0 });
  expect((await sync()).cursor).toBe(0);
  env.advance(LOST_CHANGE_MS);
  expect((await sync()).cursor).toBe(0);
  env.advance(1);
  expect(await sync()).toMatchObject({ cursor: 1, changes: [], more: false });
});

it('does not overwrite a writer that wins the first-observation race', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id, original = env.world.workerPuter;
  let writerReady, writerRelease, observerReady, observerRelease, writerHeld = false, observerHeld = false;
  const writerEntered = new Promise(resolve => { writerReady = resolve; });
  const observerEntered = new Promise(resolve => { observerReady = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!writerHeld && key === `vsr:r:${rid}:log:1` && fields.comment) {
        writerHeld = true;writerReady();await new Promise(resolve => { writerRelease = resolve; });
      }
      return update(key, fields);
    };
    p.kv.set = async (key, value, options) => {
      if (!observerHeld && key === `vsr:r:${rid}:wait:1` && value.observedThrough) {
        observerHeld = true;observerReady();await new Promise(resolve => { observerRelease = resolve; });
      }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();
  const posting = env.as('alice')('comment.add', { review: rid, version: 1, id: 'c_winner001', text: 'Keep me', t: 0 });
  await writerEntered;env.world.restartWorkers();
  const polling = env.as('alice')('sync', { review: rid, since: 0 });await observerEntered;
  writerRelease();const saved = (await posting).comment;observerRelease();
  expect(await polling).toMatchObject({ cursor: 0, changes: [] });
  expect(await env.as('alice')('sync', { review: rid, since: 0 })).toMatchObject({ cursor: 1, changes: [saved] });
  expect((await env.sdk.alice.kv.get(`vsr:r:${rid}:log:1`)).comment).toEqual(saved);
});

it.each(['before', 'after'])('can retry an observation that failed %s writing', async timing => {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id;
  await env.sdk.alice.kv.set(`vsr:r:${rid}:seq`, 3);
  const original = env.world.workerPuter;
  let failed = false;
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, fields, options) => {
      if (!failed && key === `vsr:r:${rid}:wait:1` && fields.observedThrough) {
        failed = true;
        if (timing === 'after') await set(key, fields, options);
        throw new Error('Observation unavailable');
      }
      return set(key, fields, options);
    };
    return p;
  };
  env.world.restartWorkers();
  const sync = () => env.as('alice')('sync', { review: rid, since: 0 });
  await expect(sync()).rejects.toMatchObject({ status: 500 });
  expect((await sync()).cursor).toBe(0);
  env.advance(LOST_CHANGE_MS + 1);
  expect(await sync()).toMatchObject({ cursor: 3, more: false, changes: [] });
});

it('redelivers a late tail writer after its observation has expired', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id, original = env.world.workerPuter;
  let ready, release, held = false;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!held && key === `vsr:r:${rid}:log:1` && fields.comment) {
        held = true;ready();await new Promise(resolve => { release = resolve; });
      }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();
  const pending = env.as('alice')('comment.add', { review: rid, version: 1, id: 'c_tail00001', text: 'Late tail', t: 0 });
  await entered;env.world.restartWorkers();
  const sync = since => env.as('alice')('sync', { review: rid, since });
  expect((await sync(0)).cursor).toBe(0);
  env.advance(LOST_CHANGE_MS + 1);
  expect((await sync(0)).cursor).toBe(1);
  release();expect((await pending).comment.seq).toBe(1);
  expect(await sync(1)).toMatchObject({ cursor: 2, changes: [{ id: 'c_tail00001', seq: 1 }] });
});

it('bounds gap discovery and marking to one page without scanning the entire log', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id;
  await env.sdk.alice.kv.set(`vsr:r:${rid}:seq`, 10_000);
  const original = env.world.workerPuter, calls = [];
  env.world.workerPuter = owner => {
    const p = original(owner);
    for (const method of ['get', 'set', 'update']) {
      const call = p.kv[method].bind(p.kv);
      p.kv[method] = async (...args) => { calls.push({ method, keys: Array.isArray(args[0]) ? args[0] : [args[0]] });return call(...args); };
    }
    return p;
  };
  env.world.restartWorkers();
  const sync = () => env.as('alice')('sync', { review: rid, since: 0 });
  expect((await sync()).cursor).toBe(0);
  expect(calls.filter(c => c.method === 'get').length).toBeLessThanOrEqual(6);
  expect(calls.filter(c => c.method === 'set')).toHaveLength(1);
  expect(calls.some(c => c.keys.length > LIMITS.syncBatch)).toBe(false);
  calls.length = 0;env.advance(LOST_CHANGE_MS + 1);
  expect(await sync()).toMatchObject({ cursor: LIMITS.syncBatch, more: true });
  expect(calls.filter(c => c.method === 'update')).toHaveLength(LIMITS.syncBatch);
  expect(calls.filter(c => c.method === 'get').length).toBeLessThanOrEqual(6);
});

it('does not reset the first observation when concurrent observers finish out of order', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id, firstAt = env.now();
  await env.sdk.alice.kv.set(`vsr:r:${rid}:seq`, 1);
  const original = env.world.workerPuter;
  const releases = [], ready = [];
  const entered = [0, 1].map(i => new Promise(resolve => { ready[i] = resolve; }));
  let writes = 0;
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      if (key === `vsr:r:${rid}:wait:1` && writes < 2) {
        const index = writes++;ready[index]();await new Promise(resolve => { releases[index] = resolve; });
      }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();
  const sync = () => env.as('alice')('sync', { review: rid, since: 0 });
  const first = sync();await entered[0];env.advance(30_000);env.world.restartWorkers();
  const second = sync();await entered[1];releases[0]();await first;releases[1]();await second;
  expect((await env.sdk.alice.kv.get(`vsr:r:${rid}:wait:1`)).observedAt).toBe(firstAt);
  env.advance(LOST_CHANGE_MS - 30_000 + 1);
  expect((await sync()).cursor).toBe(1);
});
