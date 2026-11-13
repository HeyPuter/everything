import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewSession } from '../src/review/session.js';

afterEach(() => vi.useRealTimers());

describe('review metadata refresh', () => {
  it.each(['success', 'failure'])('ignores an obsolete refresh %s after a newer snapshot', async (outcome) => {
    let finish, fail;
    const latest = { title: 'Latest cut', role: 'viewer', versions: [{ n: 1 }, { n: 2 }] };
    const call = vi.fn().mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve;fail = reject; })).mockResolvedValue({ review: latest });
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    const changed = vi.fn();session.on('review', changed);
    const old = session.refreshReview();
    await session.refreshReview();
    const settled = expect(old).resolves.toBeUndefined();
    if (outcome === 'success') finish({ review: { title: 'Old cut', role: 'commenter', versions: [{ n: 1 }] } });
    else fail(new Error('Old error'));
    await settled;
    expect(session.review).toBe(latest);
    expect(session.role).toBe('viewer');
    expect(session.latest).toBe(2);
    expect(changed).toHaveBeenCalledTimes(1);
    session.dispose();
  });

  it('reports a current refresh failure and allows a later retry', async () => {
    const latest = { role: 'commenter', versions: [{ n: 1 }] };
    const call = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue({ review: latest });
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    await expect(session.refreshReview()).rejects.toThrow('Offline');
    await session.refreshReview();
    expect(session.review).toBe(latest);
    session.dispose();
  });
});

describe('review session polling', () => {
  it('keeps one poll loop when stopped and restarted during a sync', async () => {
    vi.useFakeTimers();
    let finish;
    const response = { changes: [], cursor: 0, more: false };
    const call = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue(response);
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call, interval: 100 });
    try {
      session.start();
      vi.advanceTimersByTime(100);
      expect(call).toHaveBeenCalledTimes(1);
      session.stop();session.start();
      finish(response);await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(call).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(1);
      session.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(call).toHaveBeenCalledTimes(2);
    } finally { session.dispose(); }
  });

  it('does not resume polling when a stopped sync fails', async () => {
    vi.useFakeTimers();
    let fail;
    const call = vi.fn(() => new Promise((_, reject) => { fail = reject; }));
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call, interval: 100 });
    session.start();vi.advanceTimersByTime(100);session.stop();
    fail(new Error('Offline'));await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(session.polling).toBe(false);
    session.dispose();
  });
});

describe('review video links', () => {
  it('does not replace a refreshed cached link with an older response', async () => {
    let finishOld;
    const current = { url: 'https://example.test/current.mp4', expires: Date.now() + 3600000 };
    const old = { url: 'https://example.test/old.mp4', expires: current.expires };
    const call = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockResolvedValue(current);
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    const pending = session.videoLink(1);
    expect(await session.videoLink(1, { fresh: true })).toBe(current);
    finishOld(old);await pending;
    expect(await session.videoLink(1)).toBe(current);
    expect(call).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it('does not cache an obsolete link after a newer refresh failed', async () => {
    let finishOld;
    const current = { url: 'https://example.test/current.mp4', expires: Date.now() + 3600000 };
    const call = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(current);
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    const old = session.videoLink(1);
    await expect(session.videoLink(1, { fresh: true })).rejects.toThrow('Offline');
    finishOld({ url: 'https://example.test/old.mp4', expires: current.expires });await old;
    expect(await session.videoLink(1)).toBe(current);
    expect(call).toHaveBeenCalledTimes(3);
    session.dispose();
  });

  it('keeps independent version caches and refreshes links near expiry', async () => {
    vi.useFakeTimers();
    const call = vi.fn(async (_, __, { version }) => ({ url: `https://example.test/${version}.mp4`, expires: Date.now() + 3600000 }));
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    const [one, two] = await Promise.all([session.videoLink(1), session.videoLink(2)]);
    expect(await session.videoLink(1)).toBe(one);
    expect(await session.videoLink(2)).toBe(two);
    expect(call).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(55 * 60_000);
    expect(await session.videoLink(1)).not.toBe(one);
    expect(call).toHaveBeenCalledTimes(3);
    session.dispose();
  });
});

describe('review comment acknowledgements', () => {
  it('accepts a synchronized post on manual retry without replacing its newer snapshot', async () => {
    const call = vi.fn().mockRejectedValue(new Error('Offline'));
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    const draft = { id: 'c_retry001', version: 1, text: 'Original', t: 0 };
    await expect(session.addComment(draft)).rejects.toThrow('Offline');
    const confirmed = { ...draft, text: 'Edited elsewhere', seq: 2, pending: false };
    session.comments.set(draft.id, confirmed);
    expect(await session.addComment(draft)).toBe(confirmed);
    expect(session.comments.get(draft.id)).toBe(confirmed);
    expect(call).toHaveBeenCalledTimes(2);
    session.dispose();
  });

  it.each(['edited', 'deleted'])('preserves a synchronized %s comment when an older post acknowledgement arrives', async (state) => {
    let finish, latest;
    const call = vi.fn((_, __, { op }) => op === 'comment.add'
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ changes: [latest], cursor: 2, more: false }));
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    const posting = session.addComment({ version: 1, text: 'Original', t: 0 });
    const original = { ...[...session.comments.values()][0], pending: false, seq: 1 };
    latest = { ...original, seq: 2, text: state === 'edited' ? 'Corrected' : '', deleted: state === 'deleted' };
    await session.sync();
    finish({ comment: original });await posting;
    expect(session.comments.get(original.id)).toBe(latest);
    expect(session.cursor).toBe(2);
    session.dispose();
  });

  it('accepts a post already confirmed by sync when its request later fails', async () => {
    let fail, confirmed;
    const call = vi.fn((_, __, { op }) => op === 'comment.add'
      ? new Promise((_, reject) => { fail = reject; })
      : Promise.resolve({ changes: [confirmed], cursor: 1, more: false }));
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    const posting = session.addComment({ version: 1, text: 'Posted', t: 0 });
    confirmed = { ...[...session.comments.values()][0], pending: false, seq: 1 };
    await session.sync();
    const result = expect(posting).resolves.toBe(confirmed);
    fail(Object.assign(new Error('Lost response'), { status: 503 }));
    await result;
    expect(session.comments.get(confirmed.id)).toBe(confirmed);
    session.dispose();
  });

  it('removes an unconfirmed failed post and reports its error', async () => {
    const error = Object.assign(new Error('Forbidden'), { status: 403 });
    const call = vi.fn().mockRejectedValue(error);
    const session = new ReviewSession({ puter: {}, server: 'https://example.test', review: 'review', call });
    await expect(session.addComment({ version: 1, text: 'Not posted', t: 0 })).rejects.toBe(error);
    expect(session.comments.size).toBe(0);
    expect(call).toHaveBeenCalledTimes(1);
    session.dispose();
  });
});
