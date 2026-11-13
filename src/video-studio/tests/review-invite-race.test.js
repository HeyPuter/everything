import { it, expect } from 'vitest';
import { setup, publish, invite } from './review-helpers.js';

it('counts concurrent joins without losing a use', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  const workerPuter = env.world.workerPuter;
  let writes = 0, release, ready;
  const gate = new Promise((resolve) => { release = resolve; });
  const entered = new Promise((resolve) => { ready = resolve; });
  env.world.workerPuter = (owner) => {
    const p = workerPuter(owner);
    for (const method of ['set', 'incr']) {
      const write = p.kv[method].bind(p.kv);
      p.kv[method] = async (key, fields, ...rest) => {
        if (key.startsWith('vsr:invite:') && fields?.uses === 1) {
          if (++writes === 2) ready();
          await gate;
        }
        return write(key, fields, ...rest);
      };
    }
    return p;
  };
  env.world.restartWorkers();
  const pending = Promise.all(['bob', 'carol'].map((who) => env.as(who)('join', { review: review.id, token })));
  await entered;release();await pending;
  expect((await env.as('alice')('invite.list', { review: review.id })).invites[0].uses).toBe(2);
});

it.each(['join', 'revocation'])('preserves invite revocation and usage when the %s write arrives last', async (lateWrite) => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  const link = (await env.as('alice')('invite.list', { review: review.id })).invites[0];
  const workerPuter = env.world.workerPuter;
  let release, ready, held = false;
  const entered = new Promise((resolve) => { ready = resolve; });
  env.world.workerPuter = (owner) => {
    const p = workerPuter(owner);
    for (const method of ['set', 'update', 'incr']) {
      const write = p.kv[method].bind(p.kv);
      p.kv[method] = async (key, fields, ...rest) => {
        const matches = lateWrite === 'join' ? fields?.uses === 1 && !fields.revoked : fields?.revoked === true;
        if (!held && key.startsWith('vsr:invite:') && matches) {
          held = true;ready();await new Promise((resolve) => { release = resolve; });
        }
        return write(key, fields, ...rest);
      };
    }
    return p;
  };
  env.world.restartWorkers();
  const join = () => env.as('bob')('join', { review: review.id, token });
  const revoke = () => env.as('alice')('invite.revoke', { review: review.id, invite: link.id });
  const pending = lateWrite === 'join' ? join() : revoke();
  await entered;env.world.restartWorkers();
  await (lateWrite === 'join' ? revoke() : join());
  release();await pending;env.world.restartWorkers();
  const saved = (await env.as('alice')('invite.list', { review: review.id })).invites[0];
  expect(saved.revoked).toBe(true);
  expect(saved.uses).toBe(1);
  await expect(env.as('carol')('join', { review: review.id, token })).rejects.toMatchObject({ status: 403 });
  // Revoking an invite does not remove someone who has already joined.
  expect((await env.as('bob')('review.get', { review: review.id })).review.role).toBe('commenter');
});
