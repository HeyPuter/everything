// The generative layout dialogs (AI Recompose, Remove Reflections, Rotate
// Object) follow window resizes with a quick redraw from their preview-sized
// copies, and rebuild those from the full-size image once, after resizing
// pauses, instead of on every resize event of a window drag.
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/features/retouch/ai', () => ({ ensureSignedIn: async () => {} }));

const { followResize } = await import('../src/features/genai/shared');

describe('followResize', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('redraws quickly on every resize and rebuilds once when resizing pauses', () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    vi.stubGlobal(
      'window',
      Object.assign(target, {
        setTimeout: globalThis.setTimeout,
        clearTimeout: globalThis.clearTimeout,
      }),
    );
    const quick = vi.fn(),
      full = vi.fn();
    const stop = followResize(quick, full, 150);
    for (let i = 0; i < 20; i++) {
      target.dispatchEvent(new Event('resize'));
      vi.advanceTimersByTime(16);
    }
    expect(quick).toHaveBeenCalledTimes(20);
    expect(full).not.toHaveBeenCalled();
    vi.advanceTimersByTime(150);
    expect(full).toHaveBeenCalledTimes(1);
    // Closing the dialog stops both, also a rebuild still waiting.
    target.dispatchEvent(new Event('resize'));
    stop();
    vi.advanceTimersByTime(1000);
    target.dispatchEvent(new Event('resize'));
    expect(quick).toHaveBeenCalledTimes(21);
    expect(full).toHaveBeenCalledTimes(1);
  });
});
