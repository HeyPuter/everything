import { it, expect } from 'vitest';
import { setup, publish, USERS } from './review-helpers.js';
import { applyChanges } from '../src/review/comments.js';
import { LIMITS } from '../src/review/protocol.js';

async function reviewEnv() {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id;
  const post = { review: rid, version: 1, id: 'c_recovery001', text: 'Keep this comment', t: 0 };
  return { env, rid, post, add: () => env.as('alice')('comment.add', post), sync: (since = 0) => env.as('alice')('sync', { review: rid, since }) };
}

function fault(env, match, { after = false } = {}) {
  const original = env.world.workerPuter;
  let fired = false;
  env.world.workerPuter = owner => {
    const p = original(owner);
    for (const method of ['set', 'update']) {
      const write = p.kv[method].bind(p.kv);
      p.kv[method] = async (key, value, ...rest) => {
        if (!fired && match(key, value, method)) {
          fired = true;
          if (after) await write(key, value, ...rest);
          throw new Error('Injected storage failure');
        }
        return write(key, value, ...rest);
      };
    }
    return p;
  };
  env.world.restartWorkers();
}

it.each(['before snapshot', 'after snapshot', 'before log', 'after log'])('delivers a retried comment after failure %s, including past an advanced cursor', async stage => {
  const { env, rid, post, add, sync } = await reviewEnv();
  fault(env, (key, value) => stage.endsWith('snapshot') ? key.endsWith(`:c:${post.id}`) : key.endsWith(':log:1') && value.comment, { after: stage.startsWith('after') });
  await expect(add()).rejects.toMatchObject({ status: 500 });
  await env.as('alice')('comment.add', { ...post, id: 'c_other0001', text: 'Another comment' });
  const before = await sync();
  expect(before.cursor).toBe(2);
  const comments = new Map();applyChanges(comments, before.changes);
  env.world.restartWorkers();
  const retried = (await add()).comment;
  applyChanges(comments, (await sync(before.cursor)).changes);
  expect(comments.get(post.id)?.text).toBe(post.text);
  expect(comments.get(post.id)?.seq).toBe(retried.seq);
  expect(comments.size).toBe(2);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:c:${post.id}`)).toEqual(retried);
  const count = await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`);
  expect((await add()).comment).toEqual(retried);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`)).toBe(count);
});

it.each(['edit', 'delete', 'resolve'])('delivers a saved %s when an unchanged retry follows a failed log write', async mode => {
  const { env, rid, post, add, sync } = await reviewEnv();
  await add();
  fault(env, (key, value) => key.endsWith(':log:2') && value.comment);
  const request = { review: rid, id: post.id, ...(mode === 'edit' ? { text: 'Edited comment' } : { resolved: true }) };
  const send = () => env.as('alice')(`comment.${mode}`, request);
  await expect(send()).rejects.toMatchObject({ status: 500 });
  const before = await sync();expect(before.cursor).toBe(2);
  const comments = new Map();applyChanges(comments, before.changes);
  env.world.restartWorkers();
  const retried = (await send()).comment;
  const after = await sync(before.cursor);applyChanges(comments, after.changes);
  expect(comments.get(post.id)).toEqual(retried);
  expect(after.cursor).toBeGreaterThan(before.cursor);
  expect(retried.seq).toBe(2);
});

it.each(['edit', 'delete'])('does not replace a newer %s when recovery arrives afterward', async mode => {
  const { env, rid, post, add, sync } = await reviewEnv();
  fault(env, (key, value) => key.endsWith(':log:1') && value.comment);
  await expect(add()).rejects.toMatchObject({ status: 500 });
  const original = env.world.workerPuter;
  let ready, release, held = false;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), get = p.kv.get.bind(p.kv);
    p.kv.get = async key => {
      const value = await get(key);
      if (!held && key === `vsr:r:${rid}:log:1`) {
        held = true;ready();await new Promise(resolve => { release = resolve; });
      }
      return value;
    };
    return p;
  };
  env.world.restartWorkers();
  const recovering = add();
  await entered;env.world.restartWorkers();
  const newest = (await env.as('alice')(`comment.${mode}`, { review: rid, id: post.id, text: 'Newer edit' })).comment;
  const before = await sync();expect(before.cursor).toBe(2);
  const comments = new Map();applyChanges(comments, before.changes);
  expect(comments.get(post.id)).toEqual(newest);
  release();expect((await recovering).comment.seq).toBe(1);
  const recovered = await sync(before.cursor);
  expect(recovered).toMatchObject({ cursor: 3, changes: [{ id: post.id, seq: 1 }] });
  applyChanges(comments, recovered.changes);
  expect(comments.get(post.id)).toEqual(newest);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:c:${post.id}`)).toEqual({ ...newest, ...(mode === 'delete' ? { deletedSeq: newest.seq, deletedAt: newest.edited } : {}) });
  const fresh = new Map();applyChanges(fresh, (await sync()).changes);
  expect(fresh.get(post.id)).toEqual(newest);
});

it.each(['before', 'after'])('retries recovery when its delivery fails %s writing', async when => {
  const { env, post, add, sync } = await reviewEnv();
  fault(env, (key, value) => key.endsWith(':log:1') && value.comment);
  await expect(add()).rejects.toMatchObject({ status: 500 });
  const before = await sync();
  fault(env, (key, value) => key.endsWith(':log:2') && value.comment, { after: when === 'after' });
  await expect(add()).rejects.toMatchObject({ status: 500 });
  env.world.restartWorkers();
  expect((await add()).comment.seq).toBe(1);
  const comments = new Map();applyChanges(comments, (await sync(before.cursor)).changes);
  expect(comments.size).toBe(1);
  expect(comments.get(post.id)?.text).toBe(post.text);
});

it.each(['before', 'after'])('keeps durable recovery when its receipt fails %s writing', async when => {
  const { env, rid, post, add, sync } = await reviewEnv();
  fault(env, (key, value) => key.endsWith(':log:1') && value.comment);
  await expect(add()).rejects.toMatchObject({ status: 500 });
  fault(env, (key, value) => key.endsWith(':log:1') && value.recovered, { after: when === 'after' });
  expect((await add()).comment.seq).toBe(1);
  const before = await sync();
  expect(before.changes.map(c => c.id)).toContain(post.id);
  env.world.restartWorkers();await add();
  const comments = new Map();applyChanges(comments, (await sync()).changes);
  expect(comments.size).toBe(1);
  const count = await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`);
  await add();expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`)).toBe(count);
});

it('deduplicates simultaneous recovery and keeps subsequent retries free of new deliveries', async () => {
  const { env, rid, post, add, sync } = await reviewEnv();
  fault(env, (key, value) => key.endsWith(':log:1') && value.comment);
  await expect(add()).rejects.toMatchObject({ status: 500 });
  const original = env.world.workerPuter;
  let entered = 0, release;
  const gate = new Promise(resolve => { release = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), get = p.kv.get.bind(p.kv);
    p.kv.get = async key => {
      const value = await get(key);
      if (key === `vsr:r:${rid}:log:1` && entered < 2) {
        if (++entered === 2) release();
        await gate;
      }
      return value;
    };
    return p;
  };
  env.world.restartWorkers();
  await Promise.all([add(), add()]);
  const comments = new Map();applyChanges(comments, (await sync()).changes);
  expect(comments.size).toBe(1);
  expect(comments.get(post.id)?.seq).toBe(1);
  const count = await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`);
  expect(count).toBe(3);
  await add();expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`)).toBe(count);
});

it('recovers the last accepted change even when the review is full', async () => {
  const { env, rid, post, add, sync } = await reviewEnv();
  await env.sdk.alice.kv.set(`vsr:r:${rid}:seq`, LIMITS.changesPerReview - 1);
  fault(env, (key, value) => key.endsWith(`:log:${LIMITS.changesPerReview}`) && value.comment);
  await expect(add()).rejects.toMatchObject({ status: 500 });
  const before = await sync(LIMITS.changesPerReview - 1);
  expect(before.cursor).toBe(LIMITS.changesPerReview);
  expect((await add()).comment.seq).toBe(LIMITS.changesPerReview);
  expect((await sync(before.cursor)).changes).toMatchObject([{ id: post.id, seq: LIMITS.changesPerReview }]);
  await expect(env.as('alice')('comment.add', { ...post, id: 'c_overfull01' })).rejects.toMatchObject({ status: 409 });
});

it('bounds repeated recovery writes when receipts cannot be stored, without consuming the edit budget', async () => {
  const { env, rid, post, add, sync } = await reviewEnv();
  fault(env, (key, value) => key.endsWith(':log:1') && value.comment);
  await expect(add()).rejects.toMatchObject({ status: 500 });
  fault(env, (key, value) => key.endsWith(':log:1') && value.recovered);
  const minute = Math.floor(env.now() / 60_000);
  const budget = `vsr:rrate:${rid}:${USERS.alice.uuid}:${minute}`;
  await env.sdk.alice.kv.set(`vsr:wrate:${rid}:${USERS.alice.uuid}:${minute}`, LIMITS.changesPerMinute);
  await env.sdk.alice.kv.set(budget, LIMITS.changesPerMinute - 1);
  expect((await add()).comment.seq).toBe(1);
  expect((await sync()).changes.map(c => c.id)).toContain(post.id);
  const count = await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`);
  await expect(add()).rejects.toMatchObject({ status: 429 });
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`)).toBe(count);
  env.advance(60_000);
  expect((await add()).comment.seq).toBe(1);
});
