import { newSpiderDeck, RANK_VAL } from './deck.js';
import { HISTORY_LIMIT } from './state.js';

// Spider: 104 cards in ten columns. Any card may go on a card one rank
// higher whatever its suit, but only a run of one suit moves as a unit, and
// a full King-to-Ace run of one suit leaves the table by itself. Clearing
// all eight runs wins.
export const SPIDER_COLUMNS = 10;
export const SPIDER_RUNS = 8;

// The first four columns get six cards and the rest five (54 in all), each
// with only its last card face up. The other 50 are five deals of ten.
export function createSpiderGame(deck, { suits = 1 } = {}) {
  const cards = (deck || newSpiderDeck(suits)).slice();
  const tableau = Array.from({ length: SPIDER_COLUMNS }, () => []);
  for (let i = 0; i < 54; i++) tableau[i % SPIDER_COLUMNS].push(cards.pop());
  for (const col of tableau) col[col.length - 1].faceUp = true;
  return {
    kind: 'spider',
    suits,
    tableau,
    foundations: [], // completed runs, each K..A
    stock: cards,
    moves: 0,
    history: [],
  };
}

function snapshot(game) {
  game.history.push(JSON.parse(JSON.stringify({
    tableau: game.tableau,
    foundations: game.foundations,
    stock: game.stock,
    moves: game.moves,
  })));
  if (game.history.length > HISTORY_LIMIT) game.history.shift();
}

export function undo(game) {
  if (!game.history.length) return false;
  const prev = game.history.pop();
  game.tableau = prev.tableau;
  game.foundations = prev.foundations;
  game.stock = prev.stock;
  game.moves = prev.moves;
  return true;
}

// Face up, one suit, each card one rank below the last.
export function isRun(cards) {
  if (!cards.length || !cards.every(c => c.faceUp)) return false;
  for (let i = 1; i < cards.length; i++) {
    if (cards[i].suit !== cards[0].suit) return false;
    if (RANK_VAL[cards[i - 1].rank] !== RANK_VAL[cards[i].rank] + 1) return false;
  }
  return true;
}

export function getMovingCards(game, from) {
  if (from.from !== 'tableau') return [];
  return game.tableau[from.fromIndex].slice(from.cardIndex);
}

export function canPickUp(game, from) {
  return isRun(getMovingCards(game, from));
}

export function canPlaceOnSpider(card, target) {
  if (!target.length) return true;
  const top = target[target.length - 1];
  return top.faceUp && RANK_VAL[top.rank] === RANK_VAL[card.rank] + 1;
}

export function canDrop(game, cards, from, to) {
  if (to.kind !== 'tableau') return false;
  if (from.from === 'tableau' && from.fromIndex === to.index) return false;
  return isRun(cards) && canPlaceOnSpider(cards[0], game.tableau[to.index]);
}

// Where a tap sends a run, best first: onto the same suit (which lengthens
// the run), then onto any suit, then into an empty column. An empty column
// is skipped when the run already is the whole column, since moving it
// there changes nothing.
export function autoTargets(game, from, cards) {
  if (!isRun(cards)) return [];
  const sameSuit = [];
  const anySuit = [];
  const empty = [];
  game.tableau.forEach((col, i) => {
    const to = { kind: 'tableau', index: i };
    if (!canDrop(game, cards, from, to)) return;
    if (!col.length) {
      if (from.cardIndex > 0) empty.push(to);
    } else if (col[col.length - 1].suit === cards[0].suit) {
      sameSuit.push(to);
    } else {
      anySuit.push(to);
    }
  });
  return [...sameSuit, ...anySuit, ...empty];
}

function flipTop(col) {
  const top = col[col.length - 1];
  if (top && !top.faceUp) {
    top.faceUp = true;
    return top.id;
  }
  return null;
}

// Lifts a finished King-to-Ace run off the end of column i, if there is
// one, and turns over whatever it uncovers. Returns the run's King id.
function collectRun(game, i, flipped) {
  const col = game.tableau[i];
  if (col.length < 13) return null;
  const tail = col.slice(-13);
  if (tail[0].rank !== 'K' || !isRun(tail)) return null;
  col.splice(-13);
  game.foundations.push(tail);
  const f = flipTop(col);
  if (f) flipped.push(f);
  return tail[0].id;
}

export function applyMove(game, from, to, cards) {
  if (!canDrop(game, cards, from, to)) return { ok: false, flipped: [], completed: [] };
  const src = game.tableau[from.fromIndex];
  // The caller's cards must be exactly what is being lifted.
  if (src.length - from.cardIndex !== cards.length
    || src[from.cardIndex]?.id !== cards[0].id) {
    return { ok: false, flipped: [], completed: [] };
  }

  snapshot(game);
  src.splice(from.cardIndex);
  game.tableau[to.index].push(...cards);
  const flipped = [];
  const f = flipTop(src);
  if (f) flipped.push(f);
  const completed = [];
  const run = collectRun(game, to.index, flipped);
  if (run) completed.push(run);
  game.moves++;
  return { ok: true, flipped, completed };
}

// Deals one card face up onto every column. Not allowed while any column
// is empty, as in the classic game: a deal must cover every column.
export function dealRow(game) {
  if (!game.stock.length) return { ok: false, drawn: [], reason: 'empty' };
  if (game.tableau.some(col => !col.length)) {
    return { ok: false, drawn: [], reason: 'empty-column' };
  }
  snapshot(game);
  const drawn = [];
  for (const col of game.tableau) {
    const c = game.stock.pop();
    c.faceUp = true;
    col.push(c);
    drawn.push(c.id);
  }
  const flipped = [];
  const completed = [];
  game.tableau.forEach((_, i) => {
    const run = collectRun(game, i, flipped);
    if (run) completed.push(run);
  });
  game.moves++;
  return { ok: true, drawn, flipped, completed };
}

export function isWon(game) {
  return game.foundations.length === SPIDER_RUNS;
}
