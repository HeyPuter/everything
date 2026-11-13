import { it, expect } from 'vitest';
import { setup, publish, invite, USERS } from './review-helpers.js';

it.each(['role change', 'invite upgrade'])('does not undo removal when an older %s finishes', async (mode) => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  const initial = mode === 'invite upgrade' ? await invite(env, review.id, 'viewer') : token;
  await env.as('bob')('join', { review: review.id, token: initial });
  const workerPuter = env.world.workerPuter;
  let release, ready;
  const entered = new Promise((resolve) => { ready = resolve; });
  const targetRole = mode === 'invite upgrade' ? 'commenter' : 'viewer';
  env.world.workerPuter = (owner) => {
    const p = workerPuter(owner);
    for (const method of ['set', 'update']) {
      if (!p.kv[method]) continue;
      const write = p.kv[method].bind(p.kv);
      p.kv[method] = async (key, value) => {
        if (key.endsWith(`:m:${USERS.bob.uuid}`) && value.role === targetRole && !value.removed) {
          ready();await new Promise((resolve) => { release = resolve; });
        }
        return write(key, value);
      };
    }
    return p;
  };
  env.world.restartWorkers();
  const pending = (mode === 'invite upgrade'
    ? env.as('bob')('join', { review: review.id, token })
    : env.as('alice')('member.role', { review: review.id, uuid: USERS.bob.uuid, role: targetRole }))
    .then(() => 200, (error) => error.status);
  await entered;
  // A different worker instance handles removal; an in-memory lock is insufficient.
  env.world.restartWorkers();
  await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
  release();const outcome = await pending;
  env.world.restartWorkers();
  await expect(env.as('bob')('review.get', { review: review.id })).rejects.toMatchObject({ status: 403 });
  expect((await env.as('alice')('members', { review: review.id })).members).toEqual([]);
  expect(outcome).toBe(mode === 'invite upgrade' ? 403 : 404);
  await expect(env.as('bob')('join', { review: review.id, token })).rejects.toMatchObject({ status: 403 });
  // A genuinely new invite still restores access intentionally.
  env.world.workerPuter = workerPuter;env.world.restartWorkers();env.advance(1000);
  const fresh = await invite(env, review.id, 'viewer');
  expect((await env.as('bob')('join', { review: review.id, token: fresh })).review.role).toBe('viewer');
});
