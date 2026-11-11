import { describe, expect, it } from 'vitest';
import {
  dealHands,
  passDirectionForHand,
  passTarget,
} from '../src/game/deal.js';

describe('deal and pass', () => {
  it('deals 13 unique cards to each of 4 seats', () => {
    const hands = dealHands(() => 0.5);
    expect(hands).toHaveLength(4);
    hands.forEach((h) => expect(h).toHaveLength(13));
    const ids = hands.flat().map((c) => c.id);
    expect(new Set(ids).size).toBe(52);
  });

  it('cycles pass directions left → right → across → hold', () => {
    expect([0, 1, 2, 3, 4].map(passDirectionForHand)).toEqual([
      'left',
      'right',
      'across',
      'hold',
      'left',
    ]);
  });

  it('maps pass targets for seat 0', () => {
    expect(passTarget(0, 'left')).toBe(1);
    expect(passTarget(0, 'right')).toBe(3);
    expect(passTarget(0, 'across')).toBe(2);
    expect(passTarget(0, 'hold')).toBeNull();
  });
});
