import { it, expect } from 'vitest';
import { setup, publish } from './review-helpers.js';

it('keeps concurrent first publishes in the same project review', async () => {
  const env = await setup(), projectId = 'proj_concurrent_first', original = env.world.workerPuter;
  let arrived = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), get = p.kv.get.bind(p.kv);
    p.kv.get = async key => {
      const value = await get(key);
      if (key === `vsr:project:${projectId}` && arrived < 3) {
        if (++arrived === 3) release();
        await gate;
      }
      return value;
    };
    return p;
  };
  env.world.restartWorkers();
  const saved = await Promise.all([1, 2, 3].map(n => publish(env, { projectId, title: `Cut ${n}`, clientId: `pub_initial${n}` })));
  expect(new Set(saved.map(r => r.review.id)).size).toBe(1);
  expect(saved.map(r => r.version).sort()).toEqual([1, 2, 3]);
  const found = (await env.as('alice')('review.find', { projectId })).review;
  expect(found.id).toBe(saved[0].review.id);
  expect(found.versions.map(v => v.n)).toEqual([1, 2, 3]);
  for (let n = 1; n <= 3; n++) {
    const retry = await publish(env, { projectId, clientId: `pub_initial${n}` });
    expect(retry.review.id).toBe(found.id);
    expect(retry.version).toBe(saved[n - 1].version);
  }
});

it.each(['before pointer', 'after pointer', 'before metadata', 'after metadata'])('reuses the project review after initialization fails %s', async stage => {
  const env = await setup(), projectId = 'proj_failed_initial', original = env.world.workerPuter;
  let failed = false;
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      const target = stage.endsWith('pointer') ? key === `vsr:project:${projectId}` : /^vsr:r:[^:]+$/.test(key);
      if (!failed && target) {
        failed = true;if (stage.startsWith('after')) await set(key, value, options);
        throw new Error('Injected initialization failure');
      }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();
  await expect(publish(env, { projectId, clientId: 'pub_initialize' })).rejects.toMatchObject({ status: 500 });
  expect(failed).toBe(true);
  const selected = await env.sdk.alice.kv.get(`vsr:project:${projectId}`);
  const before = (await env.as('alice')('review.find', { projectId })).review;
  if (before) expect(before.id).toBe(selected);
  env.world.restartWorkers();
  const saved = await publish(env, { projectId, clientId: 'pub_initialize' });
  if (selected) expect(saved.review.id).toBe(selected);
  expect(saved.version).toBe(1);
  expect(saved.review.versions.map(v => v.n)).toEqual([1]);
  expect((await env.as('alice')('review.find', { projectId })).review.id).toBe(saved.review.id);
  expect((await publish(env, { projectId, clientId: 'pub_initialize' })).version).toBe(1);
  const records = (await env.world.storage.keys('kv')).filter(key => /:vsr:r:[^:]+$/.test(key));
  expect(records).toHaveLength(1);
});

it.each([false, true])('allows another publisher to finish initialization while its first metadata write waits (existing pointer %s)', async dangling => {
  const env = await setup(), projectId = 'proj_held_initial', original = env.world.workerPuter;
  if (dangling) await env.sdk.alice.kv.set(`vsr:project:${projectId}`, 'r_partial001');
  let held = false, ready, release;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (key, value, options) => {
      if (!held && /^vsr:r:[^:]+$/.test(key)) { held = true;ready();await new Promise(resolve => { release = resolve; }); }
      return set(key, value, options);
    };
    return p;
  };
  env.world.restartWorkers();
  const first = publish(env, { projectId, title: 'First request', clientId: 'pub_firstheld' });
  await entered;
  const selected = await env.sdk.alice.kv.get(`vsr:project:${projectId}`);
  expect((await env.as('alice')('review.find', { projectId })).review).toBeNull();
  env.advance(1000);env.world.restartWorkers();
  const second = await publish(env, { projectId, title: 'Second request', clientId: 'pub_secondheld' });
  const created = second.review.created;
  release();const late = await first;
  expect(late.review.id).toBe(second.review.id);
  expect(late.review.id).toBe(selected);
  if (dangling) expect(late.review.id).toBe('r_partial001');
  expect(second.version).toBe(1);expect(late.version).toBe(2);
  expect(late.review.created).toBe(created);
  const found = (await env.as('alice')('review.find', { projectId })).review;
  expect(found.versions.map(v => v.n)).toEqual([1, 2]);
  expect(found.id).toBe(selected);
});

it('keeps different projects in separate reviews', async () => {
  const env = await setup();
  const saved = await Promise.all([1, 2, 3].map(n => publish(env, { projectId: `proj_independent${n}`, clientId: `pub_independent${n}` })));
  expect(new Set(saved.map(r => r.review.id)).size).toBe(3);
  expect(saved.map(r => r.version)).toEqual([1, 1, 1]);
  for (let n = 1; n <= 3; n++) expect((await env.as('alice')('review.find', { projectId: `proj_independent${n}`, clientId: `pub_independent${n}` })).review.id).toBe(saved[n - 1].review.id);
});
