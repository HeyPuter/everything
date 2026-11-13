import { it, expect } from 'vitest';
import { setup, publish, invite, USERS } from './review-helpers.js';

it.each(['removed', 'role changed', 'unchanged'])('does not overwrite a membership %s after another tab completed the first join', async (change) => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  const workerPuter = env.world.workerPuter;
  let release, ready;
  const entered = new Promise((resolve) => { ready = resolve; });
  let held = false;
  env.world.workerPuter = (owner) => {
    const p = workerPuter(owner), write = p.kv.set.bind(p.kv);
    p.kv.set = async (key, ...args) => {
      if (!held && key.endsWith(`:m:${USERS.bob.uuid}`)) {
        held = true;ready();await new Promise((resolve) => { release = resolve; });
      }
      return write(key, ...args);
    };
    return p;
  };
  env.world.restartWorkers();
  const late = env.as('bob')('join', { review: review.id, token }).then(() => 200, (error) => error.status);
  await entered;env.world.restartWorkers();
  await env.as('bob')('join', { review: review.id, token });
  if (change === 'removed') await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
  else if (change === 'role changed') {
    await env.as('alice')('member.role', { review: review.id, uuid: USERS.bob.uuid, role: 'viewer' });
    // A revoked commenter invite cannot raise the viewer again.
    const links = await env.as('alice')('invite.list', { review: review.id });
    await env.as('alice')('invite.revoke', { review: review.id, invite: links.invites[0].id });
  }
  release();await late;env.world.restartWorkers();
  if (change === 'removed') await expect(env.as('bob')('review.get', { review: review.id })).rejects.toMatchObject({ status: 403 });
  else expect((await env.as('bob')('review.get', { review: review.id })).review.role).toBe(change === 'role changed' ? 'viewer' : 'commenter');
  expect(await env.sdk.alice.kv.get(`vsr:r:${review.id}:mseq`)).toBe(1);
});

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
        const role = value.role ?? Object.entries(value).find(([field]) => field.startsWith('role_'))?.[1];
        if (key.endsWith(`:m:${USERS.bob.uuid}`) && role === targetRole && !value.removed) {
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
