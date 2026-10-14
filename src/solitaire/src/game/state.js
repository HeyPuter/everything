import { newDeck } from './deck.js';
import { canPlaceOnTableau, canPlaceOnFoundation } from './rules.js';

export const HISTORY_LIMIT = 200;

// Vegas scoring: the deal costs $52 and every card played to a foundation
// pays $5 back, so a full clear nets $208. Taking a card back off a
// foundation refunds the $5, or bouncing one card up and down would print
// money.
export const VEGAS_ANTE = 52;
export const VEGAS_PER_CARD = 5;

// Times the waste may be turned back into the stock. Standard Klondike is
// unlimited; Vegas allows one pass through the deck when drawing one card
// at a time, and three passes (two redeals) when drawing three.
export function redealLimit(game) {
  if (game.scoring !== 'vegas') return Infinity;
  return game.draw === 3 ? 2 : 0;
}

export function canRedeal(game) {
  return (game.redeals || 0) < redealLimit(game);
}

// A Vegas deal's id is what the bank remembers it by, so the same game can
// only ever be paid into the bank once (see recordVegasResult).
export function newGameId(random = Math.random) {
  return random().toString(36).slice(2, 12) + Date.now().toString(36);
}

export function createGame(deck = newDeck(), { draw = 1, scoring = 'standard' } = {}) {
  const cards = deck.slice();
  const tableau = [[], [], [], [], [], [], []];
  for (let i = 0; i < 7; i++) {
    for (let j = i; j < 7; j++) {
      const c = cards.pop();
      if (j === i) c.faceUp = true;
      tableau[j].push(c);
    }
  }
  const game = {
    kind: 'klondike',
    draw,
    scoring,
    tableau,
    foundations: [[], [], [], []],
    stock: cards,
    waste: [],
    moves: 0,
    score: scoring === 'vegas' ? -VEGAS_ANTE : 0,
    redeals: 0,
    history: [],
  };
  if (scoring === 'vegas') game.id = newGameId();
  return game;
}

export function snapshot(game) {
  game.history.push(JSON.parse(JSON.stringify({
    tableau: game.tableau,
    foundations: game.foundations,
    stock: game.stock,
    waste: game.waste,
    moves: game.moves,
    score: game.score,
    redeals: game.redeals,
  })));
  if (game.history.length > HISTORY_LIMIT) game.history.shift();
}

export function undo(game) {
  if (!game.history.length) return false;
  const prev = game.history.pop();
  game.tableau = prev.tableau;
  game.foundations = prev.foundations;
  game.stock = prev.stock;
  game.waste = prev.waste;
  game.moves = prev.moves;
  game.score = prev.score;
  game.redeals = prev.redeals;
  return true;
}

export function getMovingCards(game, from) {
  if (from.from === 'tableau') return game.tableau[from.fromIndex].slice(from.cardIndex);
  if (from.from === 'waste') return game.waste.slice(-1);
  if (from.from === 'foundation') return game.foundations[from.fromIndex].slice(-1);
  return [];
}

export function applyMove(game, from, to, cards) {
  if (to.kind === 'foundation') {
    if (cards.length !== 1) return { ok: false, flipped: null };
    if (!canPlaceOnFoundation(cards[0], game.foundations[to.index])) {
      return { ok: false, flipped: null };
    }
  } else if (to.kind === 'tableau') {
    if (!canPlaceOnTableau(cards[0], game.tableau[to.index])) {
      return { ok: false, flipped: null };
    }
  } else {
    return { ok: false, flipped: null };
  }

  if (from.from === to.kind && from.fromIndex === to.index) {
    return { ok: false, flipped: null };
  }
  // Foundation-to-foundation can only shuffle an Ace between empty slots: never
  // a real move, but a tap on a foundation Ace would otherwise autoMove it there.
  if (from.from === 'foundation' && to.kind === 'foundation') {
    return { ok: false, flipped: null };
  }

  snapshot(game);

  let flipped = null;
  if (from.from === 'tableau') {
    game.tableau[from.fromIndex].splice(from.cardIndex);
    const col = game.tableau[from.fromIndex];
    if (col.length && !col[col.length - 1].faceUp) {
      col[col.length - 1].faceUp = true;
      flipped = col[col.length - 1].id;
    }
  } else if (from.from === 'waste') {
    game.waste.pop();
  } else if (from.from === 'foundation') {
    game.foundations[from.fromIndex].pop();
  }

  if (to.kind === 'foundation') game.foundations[to.index].push(cards[0]);
  else game.tableau[to.index].push(...cards);

  if (game.scoring === 'vegas') {
    if (to.kind === 'foundation') game.score += VEGAS_PER_CARD;
    if (from.from === 'foundation') game.score -= VEGAS_PER_CARD;
  }

  game.moves++;
  return { ok: true, flipped };
}

// Turns over one card, or three when the game draws three (fewer if the
// stock runs short), or turns the waste back over once the stock is empty
// and the game still allows a redeal. `drawn` lists the turned card ids in
// the order they landed on the waste.
export function drawFromStock(game) {
  if (!game.stock.length && (!game.waste.length || !canRedeal(game))) {
    const reason = game.waste.length ? 'no-redeals' : 'empty';
    return { ok: false, drawn: [], recycled: false, reason };
  }
  snapshot(game);
  const drawn = [];
  let recycled = false;
  if (!game.stock.length) {
    game.stock = game.waste.reverse().map(c => ({ ...c, faceUp: false }));
    game.waste = [];
    game.redeals = (game.redeals || 0) + 1;
    recycled = true;
  } else {
    const n = Math.min(game.draw === 3 ? 3 : 1, game.stock.length);
    for (let i = 0; i < n; i++) {
      const c = game.stock.pop();
      c.faceUp = true;
      game.waste.push(c);
      drawn.push(c.id);
    }
  }
  game.moves++;
  return { ok: true, drawn, recycled };
}
