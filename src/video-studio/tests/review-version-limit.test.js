import { it, expect } from 'vitest';
import { setup, publish } from './review-helpers.js';
import { ReviewSession } from '../src/review/session.js';
import { LIMITS } from '../src/review/protocol.js';

it('publishes only one version when concurrent requests compete for the last slot', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const key = `vsr:r:${review.id}:vseq`;
  const first = await env.sdk.alice.kv.get(`vsr:r:${review.id}:v:1`);
  for (let n = 2; n < LIMITS.versions; n++) await env.sdk.alice.kv.set(`vsr:r:${review.id}:v:${n}`, { ...first, n });
  await env.sdk.alice.kv.set(key, LIMITS.versions - 1);
  const workerPuter = env.world.workerPuter;
  let entered = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  env.world.workerPuter = (owner) => {
    const p = workerPuter(owner), get = p.kv.get.bind(p.kv);
    p.kv.get = async (k) => {
      const value = await get(k);
      if (k === key && entered < 3) {
        if (++entered === 3) release();
        await gate;
      }
      return value;
    };
    return p;
  };
  env.world.restartWorkers();
  const results = await Promise.allSettled([
    publish(env, { clientId: 'pub_limit001', title: 'Version A' }),
    publish(env, { clientId: 'pub_limit002', title: 'Version B' }),
    publish(env, { clientId: 'pub_limit003', title: 'Version C' }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected').map((r) => r.reason.status)).toEqual([409, 409]);
  expect(await env.sdk.alice.kv.get(key)).toBe(LIMITS.versions);
  const winner = results.find((r) => r.status === 'fulfilled').value;
  expect(winner.version).toBe(LIMITS.versions);
  const current = (await env.as('alice')('review.get', { review: review.id })).review;
  expect(current.versions.map((v) => v.n)).toEqual(Array.from({ length: LIMITS.versions }, (_, i) => i + 1));
  expect(current.title).toBe(winner.review.title);
  const clientId = `pub_limit00${results.findIndex((r) => r.status === 'fulfilled') + 1}`;
  expect((await publish(env, { clientId })).version).toBe(LIMITS.versions);
  expect(await env.sdk.alice.kv.get(`vsr:r:${review.id}:v:${LIMITS.versions + 1}`)).toBeNull();
  const calls = [];
  const session = new ReviewSession({ review: review.id, call: (_p, _s, input) => {
    calls.push(input.op);
    return env.as('alice')(input.op, input);
  } });
  await session.open();
  calls.length = 0;
  await session.sync();await session.sync();
  expect(calls).toEqual(['sync', 'sync']);
  session.dispose();
});
