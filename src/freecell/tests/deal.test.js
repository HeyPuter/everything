import { describe, expect, it } from 'vitest';
import { cardLabelAscii } from '../src/game/cards.js';
import { dealCards, dealCascades } from '../src/game/deal.js';

describe('Microsoft FreeCell deal RNG', () => {
  it('rejects invalid deal numbers', () => {
    expect(() => dealCards(0)).toThrow(/dealNumber/);
    expect(() => dealCards(1.5)).toThrow(/dealNumber/);
  });

  it('deals 52 unique cards', () => {
    const cards = dealCards(1);
    expect(cards).toHaveLength(52);
    expect(new Set(cards.map((c) => c.id)).size).toBe(52);
  });

  it('matches published deal #1 top-of-cascade order (Rosetta / FreeCell FAQ)', () => {
    // DOCUMENTED: Rosetta Code “Deal cards for FreeCell” Game #1 first row.
    const cascades = dealCascades(1);
    const tops = cascades.map((c) => cardLabelAscii(c[0]));
    expect(tops).toEqual(['JD', '2D', '9H', 'JC', '5D', '7H', '7C', '5H']);
  });

  it('deal #11982 is the famous hard deal with 52 cards', () => {
    const cards = dealCards(11982);
    expect(cards).toHaveLength(52);
    expect(dealCascades(11982).map((c) => c.length)).toEqual([7, 7, 7, 7, 6, 6, 6, 6]);
  });
});
