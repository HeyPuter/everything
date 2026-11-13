import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReviewSession } from '../src/review/session.js';

afterEach(() => vi.useRealTimers());

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
