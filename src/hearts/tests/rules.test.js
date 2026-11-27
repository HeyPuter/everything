import { describe, expect, it } from 'vitest';
import { cardFromId } from '../src/game/cards.js';
import { breaksHearts, legalPlays, trickWinner } from '../src/game/rules.js';

const c = (id) => cardFromId(id);

describe('legal plays', () => {
  it('requires 2♣ on the opening lead of the first trick', () => {
    const hand = [c(0), c(12), c(39)]; // 2♣, A♣, 2♥
    const legal = legalPlays({
      hand,
      trick: [],
      leadSuit: null,
      heartsBroken: false,
      isFirstTrick: true,
    });
    expect(legal).toEqual([c(0)]);
  });

  it('forbids leading hearts before they are broken when alternatives exist', () => {
    const hand = [c(12), c(39)]; // A♣, 2♥
    const legal = legalPlays({
      hand,
      trick: [],
      leadSuit: null,
      heartsBroken: false,
      isFirstTrick: false,
    });
    expect(legal.map((x) => x.id)).toEqual([12]);
  });

  it('must follow suit when able', () => {
    const hand = [c(5), c(39), c(36)]; // 7♣, 2♥, Q♠
    const legal = legalPlays({
      hand,
      trick: [c(2)],
      leadSuit: 'C',
      heartsBroken: false,
      isFirstTrick: false,
    });
    expect(legal.map((x) => x.id)).toEqual([5]);
  });

  it('blocks dumping hearts or Q♠ on the first trick when void', () => {
    const hand = [c(39), c(36), c(14)]; // 2♥, Q♠, 3♦
    const legal = legalPlays({
      hand,
      trick: [c(2)],
      leadSuit: 'C',
      heartsBroken: false,
      isFirstTrick: true,
    });
    expect(legal.map((x) => x.id)).toEqual([14]);
  });

  it('allows leading hearts once broken', () => {
    const hand = [c(39), c(40)];
    const legal = legalPlays({
      hand,
      trick: [],
      leadSuit: null,
      heartsBroken: true,
      isFirstTrick: false,
    });
    expect(legal).toHaveLength(2);
  });
});

describe('tricks', () => {
  it('awards the trick to the highest card of the lead suit', () => {
    const trick = [c(2), c(39), c(10), c(5)]; // 4♣, 2♥, Q♣, 7♣
    expect(trickWinner(trick, 1)).toBe(3); // seat 1+2 = 3 played Q♣
  });

  it('detects the first heart as breaking hearts', () => {
    expect(breaksHearts(c(39), false)).toBe(true);
    expect(breaksHearts(c(39), true)).toBe(false);
    expect(breaksHearts(c(0), false)).toBe(false);
  });
});
