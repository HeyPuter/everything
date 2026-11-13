import { it, expect } from 'vitest';
import { setup, publish, invite, USERS } from './review-helpers.js';

it.each(['before directory', 'after directory', 'before membership', 'after membership'])('recovers a first join when storage fails %s', async (stage) => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  const original = env.world.workerPuter;
  let failed = false;
  env.world.workerPuter = (owner) => {
    const p = original(owner);
    for (const method of ['set', 'update']) {
      const write = p.kv[method].bind(p.kv);
      p.kv[method] = async (key, ...args) => {
        const target = stage.endsWith('directory') ? key.endsWith(':mdir') : key.endsWith(`:m:${USERS.bob.uuid}`);
        if (!failed && target) {
          failed = true;
          if (stage.startsWith('after')) await write(key, ...args);
          throw new Error('Storage unavailable');
        }
        return write(key, ...args);
      };
    }
    return p;
  };
  env.world.restartWorkers();
  await expect(env.as('bob')('join', { review: review.id, token })).rejects.toMatchObject({ status: 500 });
  const visible = (await env.as('alice')('members', { review: review.id })).members;
  const access = await env.as('bob')('review.get', { review: review.id }).then(() => true, () => false);
  expect(access).toBe(stage === 'after membership');
  expect(visible.map(m => m.uuid)).toEqual(access ? [USERS.bob.uuid] : []);
  env.world.restartWorkers();
  expect((await env.as('bob')('join', { review: review.id, token })).review.role).toBe('commenter');
  expect((await env.as('alice')('members', { review: review.id })).members.map(m => m.uuid)).toEqual([USERS.bob.uuid]);
  expect(Object.values(await env.sdk.alice.kv.get(`vsr:r:${review.id}:mdir`))).toEqual([USERS.bob.uuid]);
});

it.each([false, true])('repairs an older unlisted member without undoing concurrent removal: %s', async (remove) => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  // State left by an old worker: member persisted; list-index write failed.
  await env.as('bob')('join', { review: review.id, token });
  const key = `vsr:r:${review.id}:m:${USERS.bob.uuid}`;
  const member = await env.sdk.alice.kv.get(key);
  delete member.indexed;
  await env.sdk.alice.kv.set(key, member);
  await env.sdk.alice.kv.del(`vsr:r:${review.id}:mdir`);
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:mseq`, 1);
  const original = env.world.workerPuter;
  let held = false, ready, release;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (k, fields) => {
      if (!held && k === key && fields.indexed) {
        held = true;ready();await new Promise(resolve => { release = resolve; });
      }
      return update(k, fields);
    };
    return p;
  };
  env.world.restartWorkers();
  const pending = env.as('bob')('join', { review: review.id, token }).then(() => 200, e => e.status);
  await entered;env.world.restartWorkers();
  expect((await env.as('alice')('members', { review: review.id })).members.map(m => m.uuid)).toEqual([USERS.bob.uuid]);
  if (remove) await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
  release();expect(await pending).toBe(remove ? 403 : 200);
  const list = await env.as('alice')('members', { review: review.id });
  expect(list.members.map(m => m.uuid)).toEqual(remove ? [] : [USERS.bob.uuid]);
});

it('keeps legacy numbered members without duplicating their directory entries', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:m:${USERS.bob.uuid}`, { uuid: USERS.bob.uuid, username: 'bob', role: 'commenter', joined: 1 });
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:mseq`, 1);
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:mi:1`, USERS.bob.uuid);
  await env.as('bob')('join', { review: review.id, token });
  await env.as('carol')('join', { review: review.id, token });
  expect((await env.as('alice')('members', { review: review.id })).members.map(m => m.uuid)).toEqual([USERS.bob.uuid, USERS.carol.uuid]);
  expect(Object.values(await env.sdk.alice.kv.get(`vsr:r:${review.id}:mdir`))).toEqual([USERS.carol.uuid]);
});

it('repairs an older unlisted member who returns without an invite token', async () => {
  const env = await setup();
  const { review } = await publish(env);
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:m:${USERS.bob.uuid}`, { uuid: USERS.bob.uuid, username: 'bob', role: 'viewer', joined: 1 });
  await env.sdk.alice.kv.set(`vsr:r:${review.id}:mseq`, 1);
  expect((await env.as('bob')('review.get', { review: review.id })).review.role).toBe('viewer');
  expect((await env.as('alice')('members', { review: review.id })).members.map(m => m.uuid)).toEqual([USERS.bob.uuid]);
});

it('keeps the first-join list order after someone rejoins', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const token = await invite(env, review.id);
  await env.as('bob')('join', { review: review.id, token });env.advance(1000);
  await env.as('carol')('join', { review: review.id, token });env.advance(1000);
  await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });env.advance(1000);
  await env.as('bob')('join', { review: review.id, token: await invite(env, review.id) });
  expect((await env.as('alice')('members', { review: review.id })).members.map(m => m.uuid)).toEqual([USERS.bob.uuid, USERS.carol.uuid]);
});
