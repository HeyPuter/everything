import { it, expect } from 'vitest';
import { setup, publish, invite, USERS } from './review-helpers.js';

it.each(['role change', 'invite upgrade'])('does not apply an old %s to a newly granted membership', async (mode) => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  const initial = mode === 'invite upgrade' ? await invite(env, review.id, 'viewer') : token;
  await env.as('bob')('join', { review: review.id, token: initial });
  const workerPuter = env.world.workerPuter;
  let release, ready, held = false;
  const entered = new Promise((resolve) => { ready = resolve; });
  env.world.workerPuter = (owner) => {
    const p = workerPuter(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!held && key.endsWith(`:m:${USERS.bob.uuid}`) && Object.entries(fields).some(([field, role]) => (field === 'role' || field.startsWith('role_')) && role === 'commenter')) {
        held = true;ready();await new Promise((resolve) => { release = resolve; });
      }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();
  const pending = (mode === 'invite upgrade'
    ? env.as('bob')('join', { review: review.id, token })
    : env.as('alice')('member.role', { review: review.id, uuid: USERS.bob.uuid, role: 'commenter' }))
    .then(() => 200, (error) => error.status);
  await entered;env.world.restartWorkers();
  await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
  env.advance(1000);
  const fresh = await invite(env, review.id, 'viewer');
  await env.as('bob')('join', { review: review.id, token: fresh });
  release();expect(await pending).toBe(409);env.world.restartWorkers();
  expect((await env.as('bob')('review.get', { review: review.id })).review.role).toBe('viewer');
  expect((await env.as('alice')('members', { review: review.id })).members[0].role).toBe('viewer');
  await expect(env.as('bob')('comment.add', { review: review.id, version: 1, id: 'c_stale001', text: 'Must be refused', t: 0 })).rejects.toMatchObject({ status: 403 });
  await env.as('alice')('member.role', { review: review.id, uuid: USERS.bob.uuid, role: 'commenter' });
  expect((await env.as('bob')('review.get', { review: review.id })).review.role).toBe('commenter');
});
