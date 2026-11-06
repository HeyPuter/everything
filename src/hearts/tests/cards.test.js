import { describe, expect, it } from 'vitest';
import {
  cardFromId,
  isQueenOfSpades,
  isTwoOfClubs,
  orderedDeck,
  penaltyPoints,
  sortHand,
} from '../src/game/cards.js';

describe('cards', () => {
  it('builds a 52-card ordered deck with unique ids', () => {
    const deck = orderedDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((c) => c.id)).size).toBe(52);
  });

  it('encodes 2♣ and Q♠ correctly', () => {
    const twoClubs = cardFromId(0); // C rank 0
    expect(isTwoOfClubs(twoClubs)).toBe(true);
    expect(penaltyPoints(twoClubs)).toBe(0);

    // Spades start at id 26; Q is rank 10 → id 36
    const qos = cardFromId(36);
    expect(isQueenOfSpades(qos)).toBe(true);
    expect(penaltyPoints(qos)).toBe(13);
  });

  it('scores each heart as 1 point', () => {
    const hearts = orderedDeck().filter((c) => c.suit === 'H');
    expect(hearts).toHaveLength(13);
    expect(hearts.reduce((n, c) => n + penaltyPoints(c), 0)).toBe(13);
  });

  it('sorts hands clubs→diamonds→spades→hearts', () => {
    const hand = sortHand([cardFromId(39), cardFromId(0), cardFromId(26), cardFromId(13)]);
    expect(hand.map((c) => c.suit)).toEqual(['C', 'D', 'S', 'H']);
  });
});
