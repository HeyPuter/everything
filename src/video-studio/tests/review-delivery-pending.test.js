import { it, expect, vi } from 'vitest';
import { setup, publish } from './review-helpers.js';
import { ReviewSession } from '../src/review/session.js';
import { COMMENT_DELIVERY_PENDING } from '../src/review/protocol.js';
import { LOST_CHANGE_MS } from '../worker/service.js';

it('does not hide an incomplete-delivery error merely because this author saw the comment in sync', async () => {
  const env = await setup();
  const { review } = await publish(env);
  const rid = review.id, post = { id: 'c_slow0001', version: 1, text: 'Slow post', t: 0 };
  const author = new ReviewSession({ review: rid, call: (_p, _s, input) => env.as('alice')(input.op, input) });
  await author.open();
  const original = env.world.workerPuter;
  let cursor = 0, deliveries = 0, delay = true;
  env.world.workerPuter = owner => {
    const p = original(owner), update = p.kv.update.bind(p.kv);
    p.kv.update = async (key, fields) => {
      if (delay && fields.comment?.id === post.id) {
        deliveries++;env.world.restartWorkers();
        await env.as('alice')('comment.add', { ...post, review: rid, id: `c_later000${deliveries}` });
        env.advance(LOST_CHANGE_MS + 1);
        cursor = (await env.as('alice')('sync', { review: rid, since: cursor })).cursor;
        const saved = await update(key, fields);
        // The author's poll can see the old slot, while another client has passed it.
        await author.sync();
        return saved;
      }
      return update(key, fields);
    };
    return p;
  };
  env.world.restartWorkers();
  await expect(author.addComment(post)).rejects.toMatchObject({ status: 503, code: COMMENT_DELIVERY_PENDING });
  expect(author.comments.get(post.id)?.seq).toBe(1);
  expect((await env.as('alice')('sync', { review: rid, since: cursor })).changes).toEqual([]);
  delay = false;env.world.restartWorkers();
  expect((await author.addComment(post)).seq).toBe(1);
  expect((await env.as('alice')('sync', { review: rid, since: cursor })).changes).toMatchObject([{ id: post.id, seq: 1 }]);
  const count = await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`);
  await author.addComment(post);
  expect(await env.sdk.alice.kv.get(`vsr:r:${rid}:seq`)).toBe(count);
  author.dispose();
});

it.each(['edited', 'deleted'])('keeps a synchronized %s snapshot throughout delivery retries and network errors', async state => {
  let fail;
  const call = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
  const session = new ReviewSession({ review: 'review', call });
  const draft = { id: 'c_pending01', version: 1, text: 'Original', t: 0 };
  const pending = session.addComment(draft);
  const latest = { ...draft, seq: 2, text: state === 'edited' ? 'Newer edit' : '', deleted: state === 'deleted' };
  session.comments.set(draft.id, latest);
  fail(Object.assign(new Error('Delivery not confirmed'), { status: 503, code: COMMENT_DELIVERY_PENDING }));
  await expect(pending).rejects.toMatchObject({ code: COMMENT_DELIVERY_PENDING });
  const seen = [];
  session.on('change', () => seen.push(session.comments.get(draft.id)));
  call.mockReset().mockRejectedValue(new Error('Offline'));
  await expect(session.addComment(draft)).rejects.toThrow('Offline');
  expect(call).toHaveBeenCalledTimes(2);
  expect(session.comments.get(draft.id)).toBe(latest);
  call.mockResolvedValue({ comment: { ...draft, seq: 1 } });
  await session.addComment(draft);
  expect(call).toHaveBeenCalledTimes(3);
  expect(session.comments.get(draft.id)).toBe(latest);
  expect(seen.every(value => value === latest)).toBe(true);
  expect(await session.addComment(draft)).toBe(latest);
  expect(call).toHaveBeenCalledTimes(3);
  session.dispose();
});
