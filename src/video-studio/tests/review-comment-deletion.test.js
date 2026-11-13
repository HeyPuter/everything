import { it, expect } from 'vitest';
import { setup, publish, invite } from './review-helpers.js';
import { applyChanges } from '../src/review/comments.js';

it.each(['edit', 'resolve', 'add'].flatMap(mode => ['reservation', 'snapshot'].map(stage => [mode, stage])))('keeps an owner deletion when an older author %s waits at %s', async (mode, stage) => {
  const env = await setup();
  const { review } = await publish(env), rid = review.id;
  await env.as('bob')('join', { review: rid, token: await invite(env, rid) });
  const post = { review: rid, version: 1, id: 'c_deletion001', text: 'Original', t: 0 };
  if (mode !== 'add') await env.as('bob')('comment.add', post);
  const key = `vsr:r:${rid}:c:${post.id}`, original = env.world.workerPuter;
  let ready, release, held = false;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner);
    for (const method of ['incr', 'set', 'update']) {
      const write = p.kv[method].bind(p.kv);
      p.kv[method] = async (k, value, ...rest) => {
        if (!held && (stage === 'snapshot' ? k === key && method !== 'incr' : k === `vsr:r:${rid}:seq` && method === 'incr')) {
          held = true;ready();await new Promise(resolve => { release = resolve; });
        }
        return write(k, value, ...rest);
      };
    }
    return p;
  };
  env.world.restartWorkers();
  const editing = env.as('bob')(`comment.${mode}`, { ...post, text: 'Delayed edit', resolved: true });
  await entered;env.world.restartWorkers();
  if (mode === 'add') await env.as('bob')('comment.add', post);
  env.advance(1000);
  const deleted = (await env.as('alice')('comment.delete', { review: rid, id: post.id })).comment;
  expect(deleted.deleted).toBe(true);
  const before = await env.as('alice')('sync', { review: rid, since: 0 });
  const existing = new Map();applyChanges(existing, before.changes);
  release();const late = (await editing).comment;
  expect(late).toMatchObject({ deleted: true, text: '', edited: deleted.edited });
  expect(late.seq).toBeGreaterThanOrEqual(deleted.seq);
  expect(late).not.toHaveProperty('deletedSeq');
  expect(late).not.toHaveProperty('deletedAt');
  applyChanges(existing, (await env.as('alice')('sync', { review: rid, since: before.cursor })).changes);
  expect(existing.get(post.id)).toMatchObject({ deleted: true, text: '' });
  await expect(env.as('bob')('comment.edit', { review: rid, id: post.id, text: 'Resurrected' })).rejects.toMatchObject({ status: 409 });
  const comments = new Map();applyChanges(comments, (await env.as('alice')('sync', { review: rid, since: 0 })).changes);
  expect(comments.get(post.id)).toMatchObject({ deleted: true, text: '' });
  expect((await env.as('bob')('comment.add', post)).comment).toMatchObject({ deleted: true, text: '' });
  expect((await env.as('alice')('comment.resolve', { review: rid, id: post.id, resolved: mode !== 'resolve' })).comment).toMatchObject({ deleted: true, text: '', edited: deleted.edited });
});

it('rejects a concurrent initial post from a different author without replacing the winning comment', async () => {
  const env = await setup();
  const { review } = await publish(env), rid = review.id;
  await env.as('bob')('join', { review: rid, token: await invite(env, rid) });
  const post = { review: rid, version: 1, id: 'c_collision01', text: 'Bob original', t: 0 };
  const original = env.world.workerPuter, key = `vsr:r:${rid}:c:${post.id}`;
  let ready, release, held = false;
  const entered = new Promise(resolve => { ready = resolve; });
  env.world.workerPuter = owner => {
    const p = original(owner), set = p.kv.set.bind(p.kv);
    p.kv.set = async (k, value, options) => {
      if (!held && k === key) { held = true;ready();await new Promise(resolve => { release = resolve; }); }
      return set(k, value, options);
    };
    return p;
  };
  env.world.restartWorkers();
  const delayed = env.as('bob')('comment.add', post);
  await entered;env.world.restartWorkers();
  const winner = (await env.as('alice')('comment.add', { ...post, text: 'Alice winner' })).comment;
  const rejected = expect(delayed).rejects.toMatchObject({ status: 409 });release();await rejected;
  expect(await env.sdk.alice.kv.get(key)).toEqual(winner);
  const sync = await env.as('alice')('sync', { review: rid, since: 0 });
  expect(sync.changes).toEqual([winner]);expect(sync.cursor).toBe(2);
});

it.each(['before snapshot', 'after snapshot', 'before log', 'after log'])('recovers a deletion after failure %s without restoring its text', async stage => {
  const env = await setup();
  const { review } = await publish(env), rid = review.id;
  const post = { review: rid, version: 1, id: 'c_deletefail1', text: 'Original', t: 0 };
  await env.as('alice')('comment.add', post);
  const original = env.world.workerPuter;
  let failed = false;
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (!failed && key === `vsr:r:${rid}:${stage.endsWith('snapshot') ? `c:${post.id}` : 'log:2'}` && (fields.deleted || fields.comment)) {
        failed = true;
        if (stage.startsWith('after')) await update(key, fields);
        throw new Error('Injected deletion failure');
      }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();
  const erase = () => env.as('alice')('comment.delete', { review: rid, id: post.id });
  await expect(erase()).rejects.toMatchObject({ status: 500 });
  const before = await env.as('alice')('sync', { review: rid, since: 0 });
  const comments = new Map();applyChanges(comments, before.changes);
  env.world.restartWorkers();
  const saved = (await erase()).comment;
  applyChanges(comments, (await env.as('alice')('sync', { review: rid, since: before.cursor })).changes);
  expect(comments.get(post.id)).toEqual(saved);
  expect(saved).toMatchObject({ deleted: true, text: '' });
  await expect(env.as('alice')('comment.edit', { review: rid, id: post.id, text: 'Restore' })).rejects.toMatchObject({ status: 409 });
});

it('preserves legacy deletions without tombstone metadata on resolve and retry', async () => {
  const env = await setup();
  const { review } = await publish(env), rid = review.id;
  const post = { review: rid, version: 1, id: 'c_legacydel1', text: 'Original', t: 0 };
  const saved = (await env.as('alice')('comment.add', post)).comment;
  await env.sdk.alice.kv.set(`vsr:r:${rid}:c:${post.id}`, { ...saved, deleted: true, text: '', edited: env.now() });
  const resolved = (await env.as('alice')('comment.resolve', { review: rid, id: post.id })).comment;
  expect(resolved).toMatchObject({ deleted: true, text: '', resolved: true });
  expect((await env.as('alice')('comment.add', post)).comment).toEqual(resolved);
  await expect(env.as('alice')('comment.edit', { review: rid, id: post.id, text: 'Restore' })).rejects.toMatchObject({ status: 409 });
});
