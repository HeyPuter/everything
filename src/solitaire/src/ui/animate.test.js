import { describe, it, expect } from 'vitest';
import { launchOrder } from './animate.js';

describe('launchOrder', () => {
  it('launches kings first, cycling the slots, down to the aces', () => {
    const order = launchOrder(['♥', '♠', '♣', '♦']);
    expect(order).toHaveLength(52);
    expect(order.slice(0, 4)).toEqual([
      { suit: '♥', rank: 'K', slot: 0 }, { suit: '♠', rank: 'K', slot: 1 },
      { suit: '♣', rank: 'K', slot: 2 }, { suit: '♦', rank: 'K', slot: 3 },
    ]);
    expect(order.at(-1)).toEqual({ suit: '♦', rank: 'A', slot: 3 });
  });

  it('launches each card from the slot that holds its suit', () => {
    // The aces went home in an order other than ♠♥♦♣.
    const order = launchOrder(['♦', '♣', '♠', '♥']);
    expect(order.filter(c => c.slot === 0).every(c => c.suit === '♦')).toBe(true);
  });

  it('handles eight slots with repeated suits', () => {
    expect(launchOrder(Array(8).fill('♠'))).toHaveLength(104);
  });
});
