import { describe, it, expect } from 'vitest';
import {
  createSpiderGame, isRun, canPickUp, canDrop, autoTargets, applyMove, dealRow, undo, isWon,
  SPIDER_COLUMNS,
} from './spider.js';
import { newSpiderDeck, SUIT_COLOR, RANKS } from './deck.js';

let nextId = 0;
const card = (suit, rank, faceUp = true) => ({
  suit, rank, color: SUIT_COLOR[suit], faceUp, id: `${suit}${rank}#t${nextId++}`,
});
// Columns default to a lone ♣2, which nothing in these tests can land on.
// K down to `low` in one suit, face up.
const run = (suit, low = 'A') => {
  const ranks = [...RANKS].reverse();
  return ranks.slice(0, ranks.indexOf(low) + 1).map(r => card(suit, r));
};

function rigged(overrides = {}) {
  return {
    kind: 'spider',
    suits: 4,
    tableau: Array.from({ length: SPIDER_COLUMNS }, () => [card('♣', '2')]),
    foundations: [],
    stock: [],
    moves: 0,
    history: [],
    ...overrides,
  };
}
const withCols = cols => rigged({
  tableau: Array.from({ length: SPIDER_COLUMNS }, (_, i) => cols[i] ?? [card('♣', '2')]),
});
const at = (fromIndex, cardIndex) => ({ from: 'tableau', fromIndex, cardIndex });
const col = index => ({ kind: 'tableau', index });

describe('newSpiderDeck', () => {
  it.each([1, 2, 4])('builds 104 cards with unique ids for %i suit(s)', suits => {
    const deck = newSpiderDeck(suits);
    expect(deck).toHaveLength(104);
    expect(new Set(deck.map(c => c.id)).size).toBe(104);
    expect(new Set(deck.map(c => c.suit)).size).toBe(suits);
  });

  it('rejects other suit counts', () => {
    expect(() => newSpiderDeck(3)).toThrow();
  });
});

describe('createSpiderGame', () => {
  it('deals six cards to the first four columns and five to the rest', () => {
    const g = createSpiderGame(newSpiderDeck(1), { suits: 1 });
    expect(g.tableau.map(c => c.length)).toEqual([6, 6, 6, 6, 5, 5, 5, 5, 5, 5]);
    expect(g.stock).toHaveLength(50);
    expect(g.foundations).toEqual([]);
  });

  it('turns up only the last card of each column', () => {
    const g = createSpiderGame(newSpiderDeck(2), { suits: 2 });
    for (const c of g.tableau) {
      expect(c.at(-1).faceUp).toBe(true);
      expect(c.slice(0, -1).some(x => x.faceUp)).toBe(false);
    }
    expect(g.stock.some(c => c.faceUp)).toBe(false);
  });
});

describe('runs', () => {
  it('is a run when one suit descends by one', () => {
    expect(isRun([card('♠', '9'), card('♠', '8'), card('♠', '7')])).toBe(true);
  });

  it('is not a run across suits, gaps, or face-down cards', () => {
    expect(isRun([card('♠', '9'), card('♥', '8')])).toBe(false);
    expect(isRun([card('♠', '9'), card('♠', '7')])).toBe(false);
    expect(isRun([card('♠', '9', false), card('♠', '8')])).toBe(false);
  });

  it('picks up a run but not a mixed-suit sequence', () => {
    const g = withCols({ 0: [card('♠', '9'), card('♥', '8'), card('♥', '7')] });
    expect(canPickUp(g, at(0, 1))).toBe(true);
    expect(canPickUp(g, at(0, 0))).toBe(false);
  });
});

describe('canDrop', () => {
  it('takes any suit one rank higher', () => {
    const g = withCols({ 0: [card('♥', '8')], 1: [card('♠', '9')] });
    expect(canDrop(g, [g.tableau[0][0]], at(0, 0), col(1))).toBe(true);
  });

  it('takes anything in an empty column', () => {
    const g = withCols({ 0: [card('♥', '3')], 1: [] });
    expect(canDrop(g, [g.tableau[0][0]], at(0, 0), col(1))).toBe(true);
  });

  it('refuses the wrong rank, foundations, and the source column', () => {
    const g = withCols({ 0: [card('♥', '8')], 1: [card('♠', '10')] });
    const cards = [g.tableau[0][0]];
    expect(canDrop(g, cards, at(0, 0), col(1))).toBe(false);
    expect(canDrop(g, cards, at(0, 0), { kind: 'foundation', index: 0 })).toBe(false);
    expect(canDrop(g, cards, at(0, 0), col(0))).toBe(false);
  });
});

describe('autoTargets', () => {
  it('prefers the same suit, then any suit, then an empty column', () => {
    const g = withCols({
      0: [card('♣', '2'), card('♥', '8')],
      1: [], 2: [card('♠', '9')], 3: [card('♥', '9')],
    });
    const cards = [g.tableau[0][1]];
    expect(autoTargets(g, at(0, 1), cards).map(t => t.index)).toEqual([3, 2, 1]);
  });

  it('does not move a whole column into an empty one', () => {
    const g = withCols({ 0: [card('♥', '8')], 1: [] });
    expect(autoTargets(g, at(0, 0), [g.tableau[0][0]])).toEqual([]);
  });
});

describe('applyMove', () => {
  it('moves a run, flips the uncovered card, and counts a move', () => {
    const g = withCols({
      0: [card('♦', '4', false), card('♠', '7'), card('♠', '6')],
      1: [card('♥', '8')],
    });
    const cards = g.tableau[0].slice(1);
    const r = applyMove(g, at(0, 1), col(1), cards);
    expect(r.ok).toBe(true);
    expect(r.flipped).toEqual([g.tableau[0][0].id]);
    expect(g.tableau[0][0].faceUp).toBe(true);
    expect(g.tableau[1].map(c => c.rank)).toEqual(['8', '7', '6']);
    expect(g.moves).toBe(1);
  });

  it('refuses cards that are not what the column holds there', () => {
    const g = withCols({ 0: [card('♠', '7'), card('♠', '6')], 1: [card('♥', '8')] });
    const r = applyMove(g, at(0, 0), col(1), [g.tableau[0][0]]);
    expect(r.ok).toBe(false);
    expect(g.history).toHaveLength(0);
  });

  it('clears a finished King-to-Ace run and flips what it uncovers', () => {
    const base = run('♥', '2');
    const g = withCols({ 0: [card('♣', '5', false), ...base], 1: [card('♥', 'A')] });
    const r = applyMove(g, at(1, 0), col(0), [g.tableau[1][0]]);
    expect(r.ok).toBe(true);
    expect(r.completed).toEqual([base[0].id]);
    expect(g.foundations).toHaveLength(1);
    expect(g.foundations[0].map(c => c.rank).join('')).toBe('KQJ1098765432A');
    expect(g.tableau[0]).toHaveLength(1);
    expect(g.tableau[0][0].faceUp).toBe(true);
    expect(r.flipped).toContain(g.tableau[0][0].id);
  });

  it('leaves a mixed-suit King-to-Ace sequence on the table', () => {
    const g = withCols({ 0: run('♥', '2'), 1: [card('♠', 'A')] });
    const r = applyMove(g, at(1, 0), col(0), [g.tableau[1][0]]);
    expect(r.completed).toEqual([]);
    expect(g.tableau[0]).toHaveLength(13);
  });

  it('undoes a completed run in one step', () => {
    const g = withCols({ 0: run('♥', '2'), 1: [card('♥', 'A')] });
    applyMove(g, at(1, 0), col(0), [g.tableau[1][0]]);
    expect(undo(g)).toBe(true);
    expect(g.foundations).toHaveLength(0);
    expect(g.tableau[0]).toHaveLength(12);
    expect(g.tableau[1]).toHaveLength(1);
    expect(g.moves).toBe(0);
  });
});

describe('dealRow', () => {
  it('deals one card face up onto every column', () => {
    const stock = Array.from({ length: 20 }, () => card('♠', '3', false));
    const g = rigged({ stock });
    const r = dealRow(g);
    expect(r.ok).toBe(true);
    expect(r.drawn).toHaveLength(10);
    expect(g.stock).toHaveLength(10);
    expect(g.tableau.every(c => c.length === 2 && c[1].faceUp)).toBe(true);
    expect(g.moves).toBe(1);
  });

  it('refuses while any column is empty', () => {
    const g = withCols({ 4: [] });
    g.stock = Array.from({ length: 10 }, () => card('♠', '3', false));
    const r = dealRow(g);
    expect(r).toMatchObject({ ok: false, reason: 'empty-column' });
    expect(g.stock).toHaveLength(10);
    expect(g.history).toHaveLength(0);
  });

  it('refuses with an empty stock', () => {
    expect(dealRow(rigged())).toMatchObject({ ok: false, reason: 'empty' });
  });

  it('clears a run the deal completes', () => {
    const g = withCols({ 0: run('♦', '2') });
    g.stock = [...Array.from({ length: 9 }, () => card('♣', '4', false)), card('♦', 'A', false)];
    const r = dealRow(g);
    expect(r.completed).toHaveLength(1);
    expect(g.foundations).toHaveLength(1);
    expect(g.tableau[0]).toHaveLength(0);
  });
});

describe('isWon', () => {
  it('is won with all eight runs home', () => {
    const g = rigged({ tableau: Array.from({ length: 10 }, () => []) });
    expect(isWon(g)).toBe(false);
    g.foundations = Array.from({ length: 8 }, () => run('♠'));
    expect(isWon(g)).toBe(true);
  });
});
