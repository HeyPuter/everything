import { it, expect } from 'vitest';
import { setup, publish } from './review-helpers.js';
import { LIMITS } from '../src/review/protocol.js';
import { LOST_CHANGE_MS } from '../worker/service.js';

function holdReservations(env, rid, count) {
  const original = env.world.workerPuter;
  let arrived = 0, ready, release;
  const entered = new Promise(resolve => { ready = resolve; }), gate = new Promise(resolve => { release = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), incr = p.kv.incr.bind(p.kv);
    p.kv.incr = async (key, ...args) => {
      if (key === `vsr:r:${rid}:seq` && arrived < count) {
        if (++arrived === count) ready();
        await gate;
      }
      return incr(key, ...args);
    };
    return p;
  };
  env.world.restartWorkers();
  return { entered, release };
}

it.each(['add', 'edit', 'delete', 'resolve'])('admits only one concurrent %s into the final change slot and retires rejected cursors', async mode => {
  const env = await setup();
  const { review } = await publish(env), rid = review.id;
  const posts = [1, 2, 3].map(n => ({ review: rid, version: 1, id: `c_limit000${n}`, text: 'Original', t: 0 }));
  const initial = [];
  if (mode !== 'add') for (const post of posts) initial.push((await env.as('alice')('comment.add', post)).comment);
  await env.sdk.alice.kv.set(`vsr:r:${rid}:seq`, LIMITS.changesPerReview - 1);
  const gate = holdReservations(env, rid, 3);
  const send = post => env.as('alice')(`comment.${mode}`, { ...post, text: 'Final change', resolved: true });
  const pending = posts.map(send), settled = Promise.allSettled(pending);
  await gate.entered;gate.release();
  const results = await settled;
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter(r => r.status === 'rejected').map(r => r.reason.status)).toEqual([409, 409]);
  for (let n = 0; n < results.length; n++) {
    const stored = await env.sdk.alice.kv.get(`vsr:r:${rid}:c:${posts[n].id}`);
    if (results[n].status === 'fulfilled') {
      expect(results[n].value.comment.seq).toBe(LIMITS.changesPerReview);
      expect((await send(posts[n])).comment).toEqual(results[n].value.comment);
    } else {
      expect(stored).toEqual(initial[n] || null);
      await expect(send(posts[n])).rejects.toMatchObject({ status: 409 });
    }
  }
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`)).toBe(LIMITS.changesPerReview + 2);
  const synced = await env.as('alice')('sync', { review: rid, since: LIMITS.changesPerReview - 1 });
  expect(synced.changes).toHaveLength(1);
  expect(synced).toMatchObject({ cursor: LIMITS.changesPerReview + 2, more: false });
});

it('returns the winning first post when a delayed duplicate reserves beyond the limit', async () => {
  const env = await setup();
  const { review } = await publish(env), rid = review.id;
  const post = { review: rid, version: 1, id: 'c_lastretry1', text: 'Original', t: 0 };
  await env.sdk.alice.kv.set(`vsr:r:${rid}:seq`, LIMITS.changesPerReview - 1);
  const gate = holdReservations(env, rid, 1);
  const delayed = env.as('alice')('comment.add', post);
  await gate.entered;env.world.restartWorkers();
  const winner = (await env.as('alice')('comment.add', post)).comment;
  gate.release();expect((await delayed).comment).toEqual(winner);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:c:${post.id}`)).toEqual(winner);
  const synced = await env.as('alice')('sync', { review: rid, since: LIMITS.changesPerReview - 1 });
  expect(synced.changes).toEqual([winner]);
  expect(synced.cursor).toBe(LIMITS.changesPerReview + 1);
});

it('keeps recovery deliveries beyond the quota while rejecting a new mutation whose reservation lost to recovery', async () => {
  const env = await setup();
  const { review } = await publish(env), rid = review.id;
  const original = env.world.workerPuter;
  let failed = false;
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!failed && key === `vsr:r:${rid}:log:1` && fields.comment) { failed = true;throw new Error('Lost log'); }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();
  const post = { review: rid, version: 1, id: 'c_lastrepair', text: 'Original', t: 0 };
  await expect(env.as('alice')('comment.add', post)).rejects.toMatchObject({ status: 500 });
  await env.sdk.alice.kv.set(`vsr:r:${rid}:seq`, LIMITS.changesPerReview - 1);
  const gate = holdReservations(env, rid, 1);
  const pending = env.as('alice')('comment.add', { ...post, id: 'c_lastnew001' });
  await gate.entered;env.world.restartWorkers();
  expect((await env.as('alice')('comment.add', post)).comment.seq).toBe(1);
  const rejected = expect(pending).rejects.toMatchObject({ status: 409 });gate.release();await rejected;
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:c:c_lastnew001`)).toBeNull();
  // Force another recovery after the delivery cursor exceeded the normal quota.
  await env.sdk.alice.kv.update(`vsr:r:${rid}:log:1`, { recovered: null });
  expect((await env.as('alice')('comment.add', post)).comment.seq).toBe(1);
  const synced = await env.as('alice')('sync', { review: rid, since: LIMITS.changesPerReview - 1 });
  expect(synced.changes.map(c => c.id)).toEqual([post.id, post.id]);
  expect(synced.cursor).toBe(LIMITS.changesPerReview + 2);
});

it.each(['before', 'after'])('does not commit an overflow mutation if its skip marker fails %s writing', async timing => {
  const env = await setup();
  const { review } = await publish(env), rid = review.id;
  await env.sdk.alice.kv.set(`vsr:r:${rid}:seq`, LIMITS.changesPerReview - 1);
  const original = env.world.workerPuter;
  let failed = false;
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!failed && key === `vsr:r:${rid}:log:${LIMITS.changesPerReview + 1}` && fields.skip) {
        failed = true;if (timing === 'after') await update(key, fields);throw new Error('Lost marker');
      }
      return update(key, fields);
    };
    return p;
  };
  const gate = holdReservations(env, rid, 2);
  const posts = [1, 2].map(n => ({ review: rid, version: 1, id: `c_skiplimit${n}`, text: 'Original', t: 0 }));
  const settled = Promise.allSettled(posts.map(post => env.as('alice')('comment.add', post)));
  await gate.entered;gate.release();const results = await settled;
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason.status).toBe(409);
  expect(failed).toBe(true);
  const rejected = results.findIndex(r => r.status === 'rejected');
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:c:${posts[rejected].id}`)).toBeNull();
  await env.as('alice')('sync', { review: rid, since: LIMITS.changesPerReview - 1 });
  env.advance(LOST_CHANGE_MS + 1);
  const synced = await env.as('alice')('sync', { review: rid, since: LIMITS.changesPerReview - 1 });
  expect(synced.changes).toHaveLength(1);
  expect(synced.cursor).toBe(LIMITS.changesPerReview + 1);
});
