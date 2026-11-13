import { it, expect } from 'vitest';
import { setup, publish, invite } from './review-helpers.js';
import { LIMITS } from '../src/review/protocol.js';

it('does not publish two invites when concurrent requests compete for the last slot', async () => {
  const env = await setup();
  const { review } = await publish(env);
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:iseq`, LIMITS.invites - 1);
  const workerPuter = env.world.workerPuter;
  let entered = 0, release;
  const gate = new Promise((resolve) => { release = resolve; });
  env.world.workerPuter = (owner) => {
    const p = workerPuter(owner), get = p.kv.get.bind(p.kv);
    p.kv.get = async (key) => {
      const value = await get(key);
      if (key === `vsr:r:${review.id}:iseq` && entered < 2) {
        if (++entered === 2) release();
        await gate;
      }
      return value;
    };
    return p;
  };
  env.world.restartWorkers();
  const results = await Promise.allSettled([invite(env, review.id), invite(env, review.id)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected').reason.status).toBe(409);
  expect((await env.as('alice')('invite.list', { review: review.id })).invites).toHaveLength(1);
});
