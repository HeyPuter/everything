import { describe, expect, it } from 'vitest';
import { createTimer, elapsedSeconds, formatSeconds } from '../src/game/timer.js';

describe('timer', () => {
  it('accumulates elapsed time from an injected clock', () => {
    let now = 1_000;
    const timer = createTimer({ now: () => now });
    expect(timer.running).toBe(false);
    timer.start();
    now = 1_500;
    expect(timer.elapsedMs).toBe(500);
    timer.pause();
    now = 5_000;
    expect(timer.elapsedMs).toBe(500);
    timer.start();
    now = 5_250;
    expect(timer.elapsedMs).toBe(750);
  });

  it('formats and caps at 999 like the classic display', () => {
    expect(formatSeconds(0)).toBe('000');
    expect(formatSeconds(1_000)).toBe('001');
    expect(formatSeconds(42_000)).toBe('042');
    expect(formatSeconds(999_000)).toBe('999');
    expect(formatSeconds(1_500_000)).toBe('999');
    expect(elapsedSeconds(1_500_000)).toBe(999);
  });
});
