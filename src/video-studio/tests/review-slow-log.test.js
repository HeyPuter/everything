import { it, expect } from 'vitest';
import { setup, publish } from './review-helpers.js';
import { applyChanges } from '../src/review/comments.js';
import { ReviewSession } from '../src/review/session.js';
import { LOST_CHANGE_MS, LOG_DELIVERY_ATTEMPTS } from '../worker/service.js';

it('delivers a successful slow write after another client advanced past its missing slot', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const original = env.world.workerPuter;
  let held = false, ready, release;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner);
    for (const method of ['set', 'update']) {
      const write = p.kv[method].bind(p.kv);
      p.kv[method] = async (key, value, ...rest) => {
        if (!held && key === `vsr:r:${review.id}:log:1` && value.comment) {
          held = true;ready();await new Promise(resolve => { release = resolve; });
        }
        return write(key, value, ...rest);
      };
    }
    return p;
  };
  env.world.restartWorkers();
  const post = { review: review.id, version: 1, id: 'c_slow0001', text: 'Slow successful post', t: 0 };
  const pending = env.as('alice')('comment.add', post);
  await entered;env.world.restartWorkers();
  await env.as('alice')('comment.add', { ...post, id: 'c_fast0001', text: 'Fast post' });
  env.advance(LOST_CHANGE_MS + 1000);
  const before = await env.as('alice')('sync', { review: review.id, since: 0 });
  expect(before.cursor).toBe(2);
  expect(before.changes.map(c => c.id)).toEqual(['c_fast0001']);
  release();expect((await pending).comment.id).toBe(post.id);
  const after = await env.as('alice')('sync', { review: review.id, since: before.cursor });
  expect(after.changes.map(c => c.id)).toContain(post.id);
});

async function slowEnv() {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id, post = { review: rid, version: 1, id: 'c_slow0001', text: 'Slow successful post', t: 0 };
  return { env, rid, post, add: () => env.as('alice')('comment.add', post), sync: (since = 0) => env.as('alice')('sync', { review: rid, since }) };
}

it.each(['before write', 'after write'])('includes or redelivers a snapshot that finishes while the skip marker waits %s', async timing => {
  const { env, rid, post, add, sync } = await slowEnv();
  const original = env.world.workerPuter;
  let releaseWriter, readyWriter, releaseMarker, readyMarker, writerHeld = false, markerHeld = false;
  const writerEntered = new Promise(resolve => { readyWriter = resolve; });
  const markerEntered = new Promise(resolve => { readyMarker = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!writerHeld && key === `vsr:r:${rid}:log:1` && fields.comment) {
        writerHeld = true;readyWriter();await new Promise(resolve => { releaseWriter = resolve; });
      }
      if (!markerHeld && key === `vsr:r:${rid}:log:1` && fields.skip && !fields.recovered) {
        markerHeld = true;
        const saved = timing === 'after write' ? await update(key, fields) : null;
        readyMarker();await new Promise(resolve => { releaseMarker = resolve; });
        return saved || update(key, fields);
      }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();
  const pending = add();await writerEntered;env.world.restartWorkers();
  await env.as('alice')('comment.add', { ...post, id: 'c_fast0001' });env.advance(LOST_CHANGE_MS + 1);
  const polling = sync();await markerEntered;
  releaseWriter();expect((await pending).comment.seq).toBe(1);
  releaseMarker();const first = await polling;
  const comments = new Map();applyChanges(comments, first.changes);
  applyChanges(comments, (await sync(first.cursor)).changes);
  expect(comments.size).toBe(2);
  expect(comments.get(post.id)?.seq).toBe(1);
  if (timing === 'before write') expect(first.changes.map(c => c.id)).toContain(post.id);
});

it.each(['before', 'after'])('does not advance a session when the skip marker fails %s writing', async timing => {
  const { env, rid, post, add } = await slowEnv();
  const session = new ReviewSession({ review: rid, call: (_p, _s, input) => env.as('alice')(input.op, input) });
  await session.open();
  const original = env.world.workerPuter;
  let release, ready, held = false, failed = false;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!held && key === `vsr:r:${rid}:log:1` && fields.comment) {
        held = true;ready();await new Promise(resolve => { release = resolve; });
      }
      if (!failed && key === `vsr:r:${rid}:log:1` && fields.skip && !fields.recovered) {
        failed = true;
        if (timing === 'after') await update(key, fields);
        throw new Error('Marker unavailable');
      }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();const pending = add();await entered;env.world.restartWorkers();
  await env.as('alice')('comment.add', { ...post, id: 'c_fast0001' });env.advance(LOST_CHANGE_MS + 1);
  await expect(session.sync()).rejects.toMatchObject({ status: 500 });
  expect(session.cursor).toBe(0);
  release();await pending;await session.sync();
  expect(session.comments.size).toBe(2);
  expect(session.comments.get(post.id)?.text).toBe(post.text);
  session.dispose();
});

it.each(['edit', 'delete'])('preserves a newer %s when an original slow write is redelivered', async mode => {
  const { env, rid, post, add, sync } = await slowEnv();
  const original = env.world.workerPuter;
  let release, ready, held = false;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!held && key === `vsr:r:${rid}:log:1` && fields.comment) {
        held = true;ready();await new Promise(resolve => { release = resolve; });
      }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();const pending = add();await entered;env.world.restartWorkers();
  const newest = (await env.as('alice')(`comment.${mode}`, { review: rid, id: post.id, text: 'Newer edit' })).comment;
  env.advance(LOST_CHANGE_MS + 1);const before = await sync();
  const comments = new Map();applyChanges(comments, before.changes);
  expect(comments.get(post.id)).toEqual(newest);
  release();await pending;applyChanges(comments, (await sync(before.cursor)).changes);
  expect(comments.get(post.id)).toEqual(newest);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:c:${post.id}`)).toEqual({ ...newest, ...(mode === 'delete' ? { deletedSeq: newest.seq, deletedAt: newest.edited } : {}) });
});

it.each(['post', 'recovery'])('bounds repeatedly skipped %s deliveries and allows a later retry', async mode => {
  const { env, rid, post, add, sync } = await slowEnv();
  const original = env.world.workerPuter;
  let deliveries = 0, delay = true, cursor = 0, initialFailure = mode === 'recovery';
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (fields.comment?.id === post.id) {
        if (initialFailure) { initialFailure = false;throw new Error('Initial log failure'); }
        if (delay) {
          deliveries++;env.world.restartWorkers();
          await env.as('alice')('comment.add', { ...post, id: `c_later000${deliveries}`, text: 'Later post' });
          env.advance(LOST_CHANGE_MS + 1);
          cursor = (await sync(cursor)).cursor;
        }
      }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();
  if (mode === 'recovery') {
    await expect(add()).rejects.toMatchObject({ status: 500 });cursor = (await sync()).cursor;
  }
  await expect(add()).rejects.toMatchObject({ status: 503 });
  expect(deliveries).toBe(LOG_DELIVERY_ATTEMPTS);
  expect((await env.sdk.alice.kv.get(`vsr:r:${rid}:log:1`)).recovered).toBeUndefined();
  delay = false;env.world.restartWorkers();
  expect((await add()).comment.seq).toBe(1);
  expect((await sync(cursor)).changes).toMatchObject([{ id: post.id, seq: 1 }]);
});
