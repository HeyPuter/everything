import { describe, expect, it } from 'vitest';
import { cardFromId, orderedDeck } from '../src/game/cards.js';
import { matchOver, scoreHand, winners } from '../src/game/scoring.js';

describe('scoring', () => {
  it('tallies hearts and the queen of spades', () => {
    const taken = [
      [cardFromId(39), cardFromId(40)], // 2 points
      [cardFromId(36)], // Q♠ = 13
      [],
      [],
    ];
    expect(scoreHand(taken)).toEqual({ handScores: [2, 13, 0, 0], moonShooter: null });
  });

  it('applies shoot-the-moon when one seat takes all 26', () => {
    const allPoints = orderedDeck().filter(
      (c) => c.suit === 'H' || (c.suit === 'S' && c.rank === 10),
    );
    expect(allPoints).toHaveLength(14);
    const { handScores, moonShooter } = scoreHand([allPoints, [], [], []]);
    expect(moonShooter).toBe(0);
    expect(handScores).toEqual([0, 26, 26, 26]);
  });

  it('ends the match at 100 and picks the lowest total', () => {
    expect(matchOver([10, 20, 100, 40])).toBe(true);
    expect(matchOver([10, 20, 99, 40])).toBe(false);
    expect(winners([40, 12, 55, 12])).toEqual([1, 3]);
  });
});
