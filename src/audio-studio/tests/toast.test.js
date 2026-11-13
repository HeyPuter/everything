// Toasts stay while the user reaches them (WCAG 2.2.1).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { toast, ACTION_TIMEOUT, MAX_TOASTS } from '../src/ui/toast.js';

afterEach(() => vi.useRealTimers());

describe('toast timing', () => {
  it('gives toasts with an action a longer time on screen', () => {
    vi.useFakeTimers();
    const plain = toast('Saved');
    const withAction = toast('Deleted', { action: { label: 'Undo', run: () => {} } });
    expect(ACTION_TIMEOUT).toBeGreaterThanOrEqual(8000);
    vi.advanceTimersByTime(4000);
    expect(plain.isConnected).toBe(false);
    expect(withAction.isConnected).toBe(true);
    vi.advanceTimersByTime(ACTION_TIMEOUT);
    expect(withAction.isConnected).toBe(false);
  });

  it('pauses while hovered or focused and resumes with the time left', () => {
    vi.useFakeTimers();
    const el = toast('Deleted', { action: { label: 'Undo', run: () => {} } });
    vi.advanceTimersByTime(ACTION_TIMEOUT - 1000);
    el.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(60000);
    expect(el.isConnected).toBe(true);
    el.dispatchEvent(new Event('pointerleave'));
    // Focus moves to the button: still paused.
    el.querySelector('button').focus();
    vi.advanceTimersByTime(60000);
    expect(el.isConnected).toBe(true);
    el.querySelector('button').blur();
    vi.advanceTimersByTime(500);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(600);
    expect(el.isConnected).toBe(false);
  });
});

describe('toast stacking', () => {
  afterEach(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));

  it('replaces a toast showing the same message instead of stacking another', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 30; i++)
      toast('Playback is not available in this browser.', { error: true });
    expect(document.querySelectorAll('.toast')).toHaveLength(1);
    toast('Playback is not available in this browser.');
    expect(document.querySelectorAll('.toast')).toHaveLength(2);
    vi.runAllTimers();
  });

  it(`keeps at most ${MAX_TOASTS} toasts on screen, dropping the oldest`, () => {
    vi.useFakeTimers();
    for (let i = 0; i < 12; i++) toast(`Message ${i}`);
    const shown = [...document.querySelectorAll('.toast')].map((t) => t.textContent);
    expect(shown).toEqual(
      Array.from({ length: MAX_TOASTS }, (_, i) => `Message ${12 - MAX_TOASTS + i}`),
    );
    vi.runAllTimers();
  });

  it('keeps a toast that holds focus', () => {
    vi.useFakeTimers();
    const first = toast('Deleted', { action: { label: 'Undo', run: () => {} } });
    first.querySelector('button').focus();
    for (let i = 0; i < 8; i++) toast(`Message ${i}`);
    expect(first.isConnected).toBe(true);
    first.querySelector('button').blur();
    vi.runAllTimers();
  });
});
