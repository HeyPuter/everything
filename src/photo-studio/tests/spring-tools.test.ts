import { describe, expect, it } from 'vitest';
import { HOLD_MS, SpringTools } from '../src/app/spring-tools';

describe('spring-loaded tool keys', () => {
  it('keeps the tool after a quick tap', () => {
    const s = new SpringTools();
    s.press('KeyB', 'move', 'brush', 1000);
    expect(s.release('KeyB', 1000 + HOLD_MS - 50)).toBeUndefined();
    expect(s.holding).toBe(false);
  });
  it('returns to the previous tool after a hold', () => {
    const s = new SpringTools();
    s.press('KeyB', 'move', 'brush', 1000);
    expect(s.repeat('KeyB')).toBe(true);
    expect(s.repeat('KeyE')).toBe(false);
    expect(s.release('KeyB', 1000 + HOLD_MS)).toBe('move');
  });
  it('returns after the tool was used, however short the hold', () => {
    const s = new SpringTools();
    s.press('KeyE', 'brush', 'eraser', 0);
    s.use();
    expect(s.release('KeyE', 10)).toBe('brush');
  });
  it('ignores other keys coming up and presses that change nothing', () => {
    const s = new SpringTools();
    s.press('KeyB', 'move', 'brush', 0);
    expect(s.release('KeyE', 1000)).toBeUndefined();
    expect(s.holding).toBe(true);
    s.press('KeyB', 'brush', 'brush', 0);
    expect(s.holding).toBe(false);
    expect(s.release('KeyB', 1000)).toBeUndefined();
  });
  it('forgets the hold when cancelled', () => {
    const s = new SpringTools();
    s.press('KeyB', 'move', 'brush', 0);
    s.cancel();
    expect(s.release('KeyB', 1000)).toBeUndefined();
  });
});
