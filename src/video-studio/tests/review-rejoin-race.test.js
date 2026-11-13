import { it, expect } from 'vitest';
import { setup, publish, invite, USERS } from './review-helpers.js';
import { hash, LIMITS } from '../src/review/protocol.js';
import { ReviewService } from '../worker/service.js';

it('keeps legacy invites and memberships usable while preserving later removals', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const old = await invite(env, review.id);
  await env.as('bob')('join', { review: review.id, token: old });
  const key = `vsr:r:${review.id}:m:${USERS.bob.uuid}`;
  const legacy = await env.sdk.alice.kv.get(key);
  delete legacy.inviteN;legacy.removed = env.now();
  await env.sdk.alice.kv.set(key, legacy);
  env.advance(1000);
  const fresh = await invite(env, review.id, 'viewer');
  const inviteKey = `vsr:invite:${await hash(fresh)}`;
  const legacyInvite = await env.sdk.alice.kv.get(inviteKey);
  delete legacyInvite.n;await env.sdk.alice.kv.set(inviteKey, legacyInvite);
  expect((await env.as('bob')('join', { review: review.id, token: fresh })).review.role).toBe('viewer');
  expect((await env.as('alice')('members', { review: review.id })).members[0].role).toBe('viewer');
  await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
  await expect(env.as('bob')('join', { review: review.id, token: fresh })).rejects.toMatchObject({ status: 403 });
  // A new invite has a later ordinal even when the wall clock hasn't advanced.
  const newest = await invite(env, review.id, 'viewer');
  expect((await env.as('bob')('join', { review: review.id, token: newest })).review.role).toBe('viewer');
  // An old commenter link must not raise the new viewer grant again.
  expect((await env.as('bob')('join', { review: review.id, token: old })).review.role).toBe('viewer');
});

it('keeps normal polling reads unchanged and retires old grant payloads', async () => {
  const env = await setup();
  const { review } = await publish(env);
  await env.as('bob')('join', { review: review.id, token: await invite(env, review.id) });
  const p = env.world.workerPuter(USERS.alice), get = p.kv.get.bind(p.kv), reads = [];
  p.kv.get = async (key) => { reads.push(key);return get(key); };
  const service = new ReviewService(p, { now: env.now });
  await service.call(USERS.bob, { op: 'sync', review: review.id, since: 0 });
  const baseline = reads.splice(0);
  for (let n = 1; n < LIMITS.invites; n++) {
    await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
    env.advance(1);
    await env.as('bob')('join', { review: review.id, token: await invite(env, review.id) });
  }
  expect((await service.call(USERS.bob, { op: 'sync', review: review.id, since: 0 })).role).toBe('commenter');
  expect(reads).toEqual(baseline);
  const record = await env.sdk.alice.kv.get(`vsr:r:${review.id}:m:${USERS.bob.uuid}`);
  expect(Object.entries(record).filter(([key, value]) => key.startsWith('grant_') && value)).toHaveLength(1);
  expect(JSON.stringify(record).length).toBeLessThan(5000);
});

it.each(['removed', 'removed unseen invite', 'role changed', 'new grant'])('does not overwrite a rejoined membership that was later %s', async (change) => {
  const env = await setup();
  const { review } = await publish(env);
  await env.as('bob')('join', { review: review.id, token: await invite(env, review.id) });
  await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
  env.advance(1000);
  const fastToken = await invite(env, review.id);
  const token = change === 'removed unseen invite' ? await invite(env, review.id) : fastToken;
  const workerPuter = env.world.workerPuter;
  let release, ready, held = false;
  const entered = new Promise((resolve) => { ready = resolve; });
  env.world.workerPuter = (owner) => {
    const p = workerPuter(owner);
    for (const method of ['set', 'update']) {
      const write = p.kv[method].bind(p.kv);
      p.kv[method] = async (key, fields, ...rest) => {
        const grant = fields?.invite || Object.keys(fields || {}).some((field) => field.startsWith('grant_'));
        if (!held && key.endsWith(`:m:${USERS.bob.uuid}`) && grant) {
          held = true;ready();await new Promise((resolve) => { release = resolve; });
        }
        return write(key, fields, ...rest);
      };
    }
    return p;
  };
  env.world.restartWorkers();
  const pending = env.as('bob')('join', { review: review.id, token }).then(() => 200, (error) => error.status);
  await entered;env.world.restartWorkers();
  await env.as('bob')('join', { review: review.id, token: fastToken });
  if (change.startsWith('removed')) await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
  else if (change === 'new grant') {
    await env.as('alice')('member.remove', { review: review.id, uuid: USERS.bob.uuid });
    env.advance(1000);
    await env.as('bob')('join', { review: review.id, token: await invite(env, review.id, 'viewer') });
  } else {
    await env.as('alice')('member.role', { review: review.id, uuid: USERS.bob.uuid, role: 'viewer' });
    const links = await env.as('alice')('invite.list', { review: review.id });
    await env.as('alice')('invite.revoke', { review: review.id, invite: links.invites[0].id });
  }
  release();await pending;env.world.restartWorkers();
  if (change.startsWith('removed')) {
    await expect(env.as('bob')('review.get', { review: review.id })).rejects.toMatchObject({ status: 403 });
    expect((await env.as('alice')('members', { review: review.id })).members).toHaveLength(0);
  }
  else expect((await env.as('bob')('review.get', { review: review.id })).review.role).toBe('viewer');
});

