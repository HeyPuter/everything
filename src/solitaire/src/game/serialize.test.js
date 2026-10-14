import { describe, it, expect } from 'vitest';
import {
  serialize, deserialize, SAVE_VERSION, serializeSpider, deserializeSpider,
} from './serialize.js';
import { createGame } from './state.js';
import { createSpiderGame } from './spider.js';
import { newDeck, newSpiderDeck, SUIT_COLOR } from './deck.js';

const card = (suit, rank, faceUp = true) => ({
  suit, rank, color: SUIT_COLOR[suit], faceUp, id: suit + rank,
});

function stripHistory(game) {
  const { history, ...rest } = game;
  return rest;
}

// deserialize() now rejects any board that isn't exactly 52 distinct cards
// (see the "rejects a save with..." tests below), so a hand-built fixture
// that only cares about a few specific cards still needs the rest of a
// legal deck somewhere. This parks whatever isn't explicitly placed
// elsewhere in the fixture into the stock, face-down, so the board is a
// full 52 cards without the test needing to care where the other 48-ish go.
function restOfDeck(usedIds) {
  const used = new Set(usedIds);
  return newDeck(() => 0.5).filter(c => !used.has(c.id));
}

describe('serialize / deserialize', () => {
  it('round-trips a freshly dealt game', () => {
    const game = createGame(newDeck(() => 0.5));
    const restored = deserialize(serialize(game, 1000));
    expect(stripHistory(restored)).toEqual(stripHistory(game));
  });

  it('round-trips a board with the whole deck parked in the stock', () => {
    const game = {
      kind: 'klondike', draw: 1, scoring: 'standard', score: 0, redeals: 0,
      tableau: [[], [], [], [], [], [], []],
      foundations: [[], [], [], []],
      stock: restOfDeck([]), waste: [], moves: 0, history: [],
    };
    expect(stripHistory(deserialize(serialize(game, 1)))).toEqual(stripHistory(game));
  });

  it('round-trips a nearly-won board', () => {
    const game = {
      tableau: [[], [], [], [], [], [], []],
      foundations: [[card('♠', 'A')], [card('♥', 'A')], [], []],
      stock: restOfDeck(['♠A', '♥A', '♦10']), waste: [card('♦', '10')], moves: 97, history: [],
    };
    const restored = deserialize(serialize(game, 5));
    expect(restored.waste[0].id).toBe('♦10');
    expect(restored.waste[0].rank).toBe('10');
    expect(restored.moves).toBe(97);
  });

  it('preserves face-up and face-down state', () => {
    const game = {
      tableau: [[card('♠', '4', false), card('♥', '9', true)], [], [], [], [], [], []],
      foundations: [[], [], [], []],
      stock: restOfDeck(['♠4', '♥9']), waste: [], moves: 0, history: [],
    };
    const restored = deserialize(serialize(game, 1));
    expect(restored.tableau[0][0].faceUp).toBe(false);
    expect(restored.tableau[0][1].faceUp).toBe(true);
  });

  it('restores the derived color and id fields', () => {
    const game = {
      tableau: [[card('♥', 'K')], [], [], [], [], [], []],
      foundations: [[], [], [], []],
      stock: restOfDeck(['♥K']), waste: [], moves: 0, history: [],
    };
    const c = deserialize(serialize(game, 1)).tableau[0][0];
    expect(c.color).toBe('red');
    expect(c.id).toBe('♥K');
  });

  it('restores an empty history', () => {
    const game = createGame();
    expect(deserialize(serialize(game, 1)).history).toEqual([]);
  });

  it('round-trips a draw-three Vegas game mid-play', () => {
    const game = createGame(newDeck(() => 0.3), { draw: 3, scoring: 'vegas' });
    game.score = -37;
    game.redeals = 1;
    game.moves = 12;
    const restored = deserialize(serialize(game, 1));
    expect(stripHistory(restored)).toEqual(stripHistory(game));
  });

  it('loads a v1 save as draw-one standard Klondike', () => {
    const v2 = serialize(createGame(newDeck(() => 0.5)), 7);
    const v1 = { v: 1, t: v2.t, f: v2.f, s: v2.s, w: v2.w, m: 4, ts: 7 };
    const restored = deserialize(v1);
    expect(restored.kind).toBe('klondike');
    expect(restored.draw).toBe(1);
    expect(restored.scoring).toBe('standard');
    expect(restored.score).toBe(0);
    expect(restored.redeals).toBe(0);
    expect(restored.moves).toBe(4);
  });

  it('rejects unknown draw counts and scoring', () => {
    const save = serialize(createGame(), 1);
    expect(deserialize({ ...save, d: 2 })).toBe(null);
    expect(deserialize({ ...save, sc: 'macau' })).toBe(null);
  });

  it('stamps the version and timestamp', () => {
    const save = serialize(createGame(), 12345);
    expect(save.v).toBe(SAVE_VERSION);
    expect(save.ts).toBe(12345);
  });

  it('stays well under 2 KB for a full board', () => {
    const size = JSON.stringify(serialize(createGame(), 1)).length;
    expect(size).toBeLessThan(2048);
  });

  it('rejects null, a wrong version, and a missing body', () => {
    expect(deserialize(null)).toBe(null);
    expect(deserialize(undefined)).toBe(null);
    expect(deserialize({ v: 999, t: [], f: [], s: '', w: '', m: 0, ts: 0 })).toBe(null);
    expect(deserialize({ v: SAVE_VERSION })).toBe(null);
  });

  it('rejects malformed card data', () => {
    // Seven columns, so these reach decodePile rather than being rejected by
    // the shape check first.
    const withCol = first => ({
      v: SAVE_VERSION, t: [first, '', '', '', '', '', ''],
      f: ['', '', '', ''], s: '', w: '', m: 0, ts: 0,
    });
    expect(deserialize(withCol('ZZ'))).toBe(null);    // no such suit code
    expect(deserialize(withCol('♠K'))).toBe(null);    // suit where a rank belongs
    expect(deserialize(withCol('AS5'))).toBe(null);   // odd length
    expect(deserialize(withCol('XS'))).toBe(null);    // valid suit, no such rank
  });

  it('rejects a tableau that is not seven columns', () => {
    const save = serialize(createGame(), 1);
    save.t = save.t.slice(0, 5);
    expect(deserialize(save)).toBe(null);
  });

  it('rejects a foundations array that is not four piles', () => {
    const save = serialize(createGame(), 1);
    save.f = save.f.slice(0, 2);
    expect(deserialize(save)).toBe(null);
  });

  it('rejects a save with a duplicated card (52 cards, only 51 distinct ids)', () => {
    // Every card here is individually legal — real suit, real rank — so
    // per-card decoding alone would accept this. Overwriting tableau[1]'s
    // first card with a copy of tableau[0]'s single card changes no string
    // length (so the total card count is still 52), but now tableau[0]'s id
    // appears twice and whatever used to sit in that tableau[1] slot is
    // gone — 52 cards, 51 distinct ids.
    const save = serialize(createGame(newDeck(() => 0.5)), 1);
    const dupedCode = save.t[0]; // tableau column 0 always has exactly one card
    save.t[1] = dupedCode + save.t[1].slice(2);
    expect(deserialize(save)).toBe(null);
  });

  it('rejects a save with fewer than 52 cards', () => {
    const save = serialize(createGame(newDeck(() => 0.5)), 1);
    save.t[0] = save.t[0].slice(0, -2); // drop tableau column 0's one card, 51 remain
    expect(deserialize(save)).toBe(null);
  });

  it('rejects a save with more than 52 cards', () => {
    const save = serialize(createGame(newDeck(() => 0.5)), 1);
    save.t[0] = save.t[0] + save.t[6].slice(0, 2); // append a copy of one more card, 53 total
    expect(deserialize(save)).toBe(null);
  });

  it('accepts a full, legitimately dealt 52-card board', () => {
    const game = createGame(newDeck(() => 0.5));
    expect(deserialize(serialize(game, 1))).not.toBe(null);
  });
});

describe('Spider saves', () => {
  it.each([1, 2, 4])('round-trips a fresh %i-suit deal', suits => {
    const game = createSpiderGame(newSpiderDeck(suits, () => 0.4), { suits });
    const restored = deserializeSpider(serializeSpider(game, 3));
    const strip = g => ({ ...stripHistory(g), tableau: g.tableau.map(c => c.map(({ id, ...x }) => x)),
      stock: g.stock.map(({ id, ...x }) => x) });
    expect(strip(restored)).toEqual(strip(game));
    const ids = [...restored.tableau.flat(), ...restored.stock].map(c => c.id);
    expect(new Set(ids).size).toBe(104);
  });

  it('round-trips completed runs', () => {
    // One spade of each rank becomes a finished run; the other 91 cards
    // stay on the table.
    const deck = newSpiderDeck(1, () => 0.4);
    const runCards = [];
    for (const rank of ['K', 'Q', 'J', '10', '9', '8', '7', '6', '5', '4', '3', '2', 'A']) {
      const i = deck.findIndex(c => c.rank === rank);
      runCards.push({ ...deck.splice(i, 1)[0], faceUp: true });
    }
    const game = createSpiderGame(deck, { suits: 1 });
    game.foundations = [runCards];
    const restored = deserializeSpider(serializeSpider(game, 1));
    expect(restored.foundations).toHaveLength(1);
    expect(restored.foundations[0].map(c => c.rank).join(' ')).toBe('K Q J 10 9 8 7 6 5 4 3 2 A');
    expect(restored.foundations[0].every(c => c.faceUp && c.suit === '♠')).toBe(true);
  });

  it('stays small', () => {
    const save = serializeSpider(createSpiderGame(newSpiderDeck(4), { suits: 4 }), 1);
    expect(JSON.stringify(save).length).toBeLessThan(2048);
  });

  it('rejects a board that is not exactly two decks for its suit count', () => {
    const save = serializeSpider(createSpiderGame(newSpiderDeck(2, () => 0.4), { suits: 2 }), 1);
    expect(deserializeSpider({ ...save, n: 1 })).toBe(null); // hearts in a one-suit game
    expect(deserializeSpider({ ...save, n: 3 })).toBe(null);
    expect(deserializeSpider({ ...save, s: save.s.slice(2) })).toBe(null); // 103 cards
    expect(deserializeSpider({ ...save, t: save.t.slice(1) })).toBe(null); // nine columns
    expect(deserializeSpider({ ...save, f: 'X' })).toBe(null);
  });

  it('is not loaded as Klondike, nor Klondike as Spider', () => {
    const spiderSave = serializeSpider(createSpiderGame(newSpiderDeck(1), { suits: 1 }), 1);
    expect(deserialize(spiderSave)).toBe(null);
    expect(deserializeSpider(serialize(createGame(), 1))).toBe(null);
  });
});
