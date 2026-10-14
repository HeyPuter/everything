import { describe, it, expect } from 'vitest';
import {
  createGame, snapshot, undo, getMovingCards, applyMove, drawFromStock, HISTORY_LIMIT,
  redealLimit, VEGAS_ANTE,
} from './state.js';
import { newDeck, SUIT_COLOR } from './deck.js';

const card = (suit, rank, faceUp = true) => ({
  suit, rank, color: SUIT_COLOR[suit], faceUp, id: suit + rank,
});

// A game with hand-placed piles, so tests do not depend on the shuffle.
function rigged(overrides = {}) {
  return {
    tableau: [[], [], [], [], [], [], []],
    foundations: [[], [], [], []],
    stock: [],
    waste: [],
    moves: 0,
    history: [],
    ...overrides,
  };
}

describe('createGame', () => {
  it('deals 1..7 cards into the seven columns', () => {
    const g = createGame();
    g.tableau.forEach((col, i) => expect(col).toHaveLength(i + 1));
  });

  it('leaves exactly the last card of each column face up', () => {
    const g = createGame();
    g.tableau.forEach(col => {
      expect(col[col.length - 1].faceUp).toBe(true);
      expect(col.slice(0, -1).every(c => c.faceUp === false)).toBe(true);
    });
  });

  it('puts the remaining 24 cards in the stock and none in the waste', () => {
    const g = createGame();
    expect(g.stock).toHaveLength(24);
    expect(g.waste).toHaveLength(0);
  });

  it('uses all 52 cards exactly once', () => {
    const g = createGame();
    const ids = [...g.tableau.flat(), ...g.stock].map(c => c.id);
    expect(new Set(ids).size).toBe(52);
  });

  it('starts with no moves and no history', () => {
    const g = createGame();
    expect(g.moves).toBe(0);
    expect(g.history).toHaveLength(0);
  });

  it('accepts an injected deck', () => {
    const deck = newDeck(() => 0);
    const g = createGame(deck);
    expect([...g.tableau.flat(), ...g.stock]).toHaveLength(52);
  });
});

describe('undo', () => {
  it('returns false with empty history', () => {
    expect(undo(rigged())).toBe(false);
  });

  it('restores the exact prior state', () => {
    const g = rigged({ tableau: [[card('♠', 'K')], [], [], [], [], [], []], moves: 3 });
    snapshot(g);
    g.tableau[1].push(card('♥', 'Q'));
    g.moves = 4;
    expect(undo(g)).toBe(true);
    expect(g.tableau[1]).toHaveLength(0);
    expect(g.moves).toBe(3);
  });

  it('does not alias a remaining snapshot after undo', () => {
    const g = rigged({ tableau: [[card('♠', 'K')], [], [], [], [], [], []] });
    snapshot(g); // first snapshot: tableau[0] = [♠K]
    g.tableau[0].push(card('♥', 'Q'));
    snapshot(g); // second snapshot: tableau[0] = [♠K, ♥Q]
    g.tableau[0].push(card('♦', 'J'));
    undo(g); // pops the second snapshot; one snapshot remains in history
    g.tableau[0].push(card('♣', '10'));
    // Mutating the live state after undo must not corrupt the snapshot still in history.
    expect(g.history).toHaveLength(1);
    expect(g.history[0].tableau[0].map(c => c.id)).toEqual(['♠K']);
  });

  it('caps history at HISTORY_LIMIT', () => {
    const g = rigged();
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) snapshot(g);
    expect(g.history).toHaveLength(HISTORY_LIMIT);
  });
});

describe('getMovingCards', () => {
  it('takes a tableau card and everything above it', () => {
    const g = rigged({
      tableau: [[card('♠', 'K'), card('♥', 'Q'), card('♠', 'J')], [], [], [], [], [], []],
    });
    expect(getMovingCards(g, { from: 'tableau', fromIndex: 0, cardIndex: 1 }).map(c => c.id))
      .toEqual(['♥Q', '♠J']);
  });

  it('takes only the top waste card', () => {
    const g = rigged({ waste: [card('♠', '2'), card('♥', '3')] });
    expect(getMovingCards(g, { from: 'waste' }).map(c => c.id)).toEqual(['♥3']);
  });

  it('takes only the top foundation card', () => {
    const g = rigged({ foundations: [[card('♠', 'A'), card('♠', '2')], [], [], []] });
    expect(getMovingCards(g, { from: 'foundation', fromIndex: 0 }).map(c => c.id)).toEqual(['♠2']);
  });
});

describe('applyMove', () => {
  it('rejects an invalid tableau placement and leaves state untouched', () => {
    const g = rigged({ tableau: [[card('♠', 'K')], [card('♠', 'Q')], [], [], [], [], []] });
    const result = applyMove(g, { from: 'tableau', fromIndex: 1, cardIndex: 0 },
      { kind: 'tableau', index: 0 }, [card('♠', 'Q')]);
    expect(result.ok).toBe(false);
    expect(g.tableau[1]).toHaveLength(1);
    expect(g.moves).toBe(0);
    expect(g.history).toHaveLength(0);
  });

  it('rejects a multi-card move to a foundation', () => {
    const g = rigged({ foundations: [[card('♠', 'A')], [], [], []] });
    const result = applyMove(g, { from: 'tableau', fromIndex: 0, cardIndex: 0 },
      { kind: 'foundation', index: 0 }, [card('♠', '2'), card('♠', '3')]);
    expect(result.ok).toBe(false);
  });

  it('rejects a move onto the pile it came from', () => {
    const g = rigged({ tableau: [[card('♠', 'K')], [], [], [], [], [], []] });
    const result = applyMove(g, { from: 'tableau', fromIndex: 0, cardIndex: 0 },
      { kind: 'tableau', index: 0 }, [card('♠', 'K')]);
    expect(result.ok).toBe(false);
  });

  it('rejects moving a foundation Ace to another empty foundation', () => {
    const g = rigged({ foundations: [[card('♠', 'A')], [], [], []] });
    const result = applyMove(g, { from: 'foundation', fromIndex: 0 },
      { kind: 'foundation', index: 1 }, [card('♠', 'A')]);
    expect(result.ok).toBe(false);
    expect(g.foundations[0].map(c => c.id)).toEqual(['♠A']);
    expect(g.foundations[1]).toHaveLength(0);
    expect(g.moves).toBe(0);
    expect(g.history).toHaveLength(0);
  });

  it('moves a valid stack and increments moves', () => {
    const g = rigged({ tableau: [[card('♠', 'K')], [card('♥', 'Q')], [], [], [], [], []] });
    const result = applyMove(g, { from: 'tableau', fromIndex: 1, cardIndex: 0 },
      { kind: 'tableau', index: 0 }, [card('♥', 'Q')]);
    expect(result.ok).toBe(true);
    expect(result.flipped).toBe(null);
    expect(g.tableau[0].map(c => c.id)).toEqual(['♠K', '♥Q']);
    expect(g.tableau[1]).toHaveLength(0);
    expect(g.moves).toBe(1);
    expect(g.history).toHaveLength(1);
  });

  it('flips the newly exposed card and reports its id', () => {
    const g = rigged({
      tableau: [[card('♠', 'K')], [card('♦', '7', false), card('♥', 'Q')], [], [], [], [], []],
    });
    const result = applyMove(g, { from: 'tableau', fromIndex: 1, cardIndex: 1 },
      { kind: 'tableau', index: 0 }, [card('♥', 'Q')]);
    expect(result.ok).toBe(true);
    expect(result.flipped).toBe('♦7');
    expect(g.tableau[1][0].faceUp).toBe(true);
  });

  it('reports no flip when the exposed card was already face up', () => {
    const g = rigged({
      tableau: [[card('♠', 'K')], [card('♠', 'K'), card('♥', 'Q')], [], [], [], [], []],
    });
    const result = applyMove(g, { from: 'tableau', fromIndex: 1, cardIndex: 1 },
      { kind: 'tableau', index: 0 }, [card('♥', 'Q')]);
    expect(result.flipped).toBe(null);
  });

  it('moves a waste card to a foundation', () => {
    const g = rigged({ waste: [card('♠', 'A')] });
    const result = applyMove(g, { from: 'waste' }, { kind: 'foundation', index: 0 }, [card('♠', 'A')]);
    expect(result.ok).toBe(true);
    expect(g.waste).toHaveLength(0);
    expect(g.foundations[0].map(c => c.id)).toEqual(['♠A']);
  });
});

describe('drawFromStock', () => {
  it('does nothing when stock and waste are both empty', () => {
    const g = rigged();
    expect(drawFromStock(g).ok).toBe(false);
    expect(g.moves).toBe(0);
  });

  it('moves one card face up to the waste', () => {
    const g = rigged({ stock: [card('♠', '2', false), card('♥', '3', false)] });
    const result = drawFromStock(g);
    expect(result.ok).toBe(true);
    expect(result.drawn).toEqual(['♥3']);
    expect(result.recycled).toBe(false);
    expect(g.waste.map(c => c.id)).toEqual(['♥3']);
    expect(g.waste[0].faceUp).toBe(true);
    expect(g.stock).toHaveLength(1);
    expect(g.moves).toBe(1);
  });

  it('recycles the waste back into the stock face down and in reverse', () => {
    const g = rigged({ stock: [], waste: [card('♠', '2'), card('♥', '3'), card('♦', '4')] });
    const result = drawFromStock(g);
    expect(result.ok).toBe(true);
    expect(result.recycled).toBe(true);
    expect(result.drawn).toEqual([]);
    expect(g.waste).toHaveLength(0);
    expect(g.stock.map(c => c.id)).toEqual(['♦4', '♥3', '♠2']);
    expect(g.stock.every(c => c.faceUp === false)).toBe(true);
    expect(g.moves).toBe(1);
    expect(g.history).toHaveLength(1);
  });
});

describe('draw three', () => {
  it('turns over three cards, last one on top', () => {
    const g = rigged({
      draw: 3,
      stock: [card('♠', '2', false), card('♥', '3', false), card('♦', '4', false), card('♣', '5', false)],
    });
    const result = drawFromStock(g);
    expect(result.drawn).toEqual(['♣5', '♦4', '♥3']);
    expect(g.waste.map(c => c.id)).toEqual(['♣5', '♦4', '♥3']);
    expect(g.waste.every(c => c.faceUp)).toBe(true);
    expect(g.stock.map(c => c.id)).toEqual(['♠2']);
    expect(g.moves).toBe(1);
  });

  it('turns over what is left when fewer than three remain', () => {
    const g = rigged({ draw: 3, stock: [card('♠', '2', false)] });
    expect(drawFromStock(g).drawn).toEqual(['♠2']);
    expect(g.stock).toHaveLength(0);
  });

  it('undoes a three-card draw in one step', () => {
    const g = rigged({
      draw: 3,
      stock: [card('♠', '2', false), card('♥', '3', false), card('♦', '4', false)],
    });
    drawFromStock(g);
    undo(g);
    expect(g.waste).toHaveLength(0);
    expect(g.stock).toHaveLength(3);
  });

  it('only lets the top waste card move', () => {
    const g = rigged({ draw: 3, waste: [card('♠', '2'), card('♥', '3'), card('♦', '4')] });
    expect(getMovingCards(g, { from: 'waste' }).map(c => c.id)).toEqual(['♦4']);
  });
});

describe('Vegas', () => {
  const vegas = (overrides = {}) => rigged({ scoring: 'vegas', draw: 1, score: -VEGAS_ANTE, redeals: 0, ...overrides });

  it('deals a game that already owes the $52 ante', () => {
    const g = createGame(newDeck(), { scoring: 'vegas', draw: 3 });
    expect(g.score).toBe(-52);
    expect(g.draw).toBe(3);
    expect(g.scoring).toBe('vegas');
  });

  it('scores nothing in a standard game', () => {
    const g = rigged({ waste: [card('♠', 'A')], scoring: 'standard', score: 0 });
    applyMove(g, { from: 'waste' }, { kind: 'foundation', index: 0 }, [card('♠', 'A')]);
    expect(g.score).toBe(0);
  });

  it('pays $5 for a card played to a foundation', () => {
    const g = vegas({ waste: [card('♠', 'A')] });
    applyMove(g, { from: 'waste' }, { kind: 'foundation', index: 0 }, [card('♠', 'A')]);
    expect(g.score).toBe(-47);
  });

  it('takes the $5 back when a card leaves a foundation', () => {
    const g = vegas({
      tableau: [[card('♥', '3')], [], [], [], [], [], []],
      foundations: [[card('♠', 'A'), card('♠', '2')], [], [], []],
      score: -42,
    });
    const r = applyMove(g, { from: 'foundation', fromIndex: 0 }, { kind: 'tableau', index: 0 }, [card('♠', '2')]);
    expect(r.ok).toBe(true);
    expect(g.score).toBe(-47);
  });

  it('restores the score on undo', () => {
    const g = vegas({ waste: [card('♠', 'A')] });
    applyMove(g, { from: 'waste' }, { kind: 'foundation', index: 0 }, [card('♠', 'A')]);
    undo(g);
    expect(g.score).toBe(-52);
  });

  it('allows one pass when drawing one', () => {
    const g = vegas({ waste: [card('♠', '2'), card('♥', '3')] });
    expect(redealLimit(g)).toBe(0);
    const r = drawFromStock(g);
    expect(r.ok).toBe(false);
    expect(g.waste).toHaveLength(2);
    expect(g.moves).toBe(0);
    expect(g.history).toHaveLength(0);
  });

  it('allows three passes (two redeals) when drawing three', () => {
    const g = vegas({ draw: 3, waste: [card('♠', '2')] });
    expect(drawFromStock(g).recycled).toBe(true);
    drawFromStock(g);
    expect(drawFromStock(g).recycled).toBe(true);
    drawFromStock(g);
    expect(drawFromStock(g).ok).toBe(false);
    expect(g.redeals).toBe(2);
  });

  it('gives back a redeal on undo', () => {
    const g = vegas({ draw: 3, redeals: 1, waste: [card('♠', '2')] });
    drawFromStock(g);
    expect(g.redeals).toBe(2);
    undo(g);
    expect(g.redeals).toBe(1);
  });

  it('never limits redeals in a standard game', () => {
    const g = rigged({ waste: [card('♠', '2')], redeals: 500 });
    expect(drawFromStock(g).recycled).toBe(true);
  });
});
