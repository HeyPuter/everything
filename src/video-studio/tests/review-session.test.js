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
