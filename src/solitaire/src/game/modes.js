import { newDeck, newSpiderDeck } from './deck.js';
import {
  createGame, getMovingCards, applyMove, drawFromStock, undo, canRedeal,
} from './state.js';
import { canPlaceOnTableau, canPlaceOnFoundation, isWon } from './rules.js';
import {
  serialize as serializeKlondike, deserialize as deserializeKlondike,
  serializeSpider, deserializeSpider,
} from './serialize.js';
import * as spider from './spider.js';

// Every game the menu offers. `key` is what stats and the remembered choice
// are filed under; klondike-1 is the original game and the default.
export const MODES = [
  { key: 'klondike-1', group: 'Klondike', label: 'Draw 1', game: 'klondike', opts: { draw: 1, scoring: 'standard' } },
  { key: 'klondike-3', group: 'Klondike', label: 'Draw 3', game: 'klondike', opts: { draw: 3, scoring: 'standard' } },
  { key: 'vegas-1', group: 'Vegas', label: 'Draw 1', game: 'klondike', opts: { draw: 1, scoring: 'vegas' } },
  { key: 'vegas-3', group: 'Vegas', label: 'Draw 3', game: 'klondike', opts: { draw: 3, scoring: 'vegas' } },
  { key: 'spider-1', group: 'Spider', label: '1 suit', game: 'spider', opts: { suits: 1 } },
  { key: 'spider-2', group: 'Spider', label: '2 suits', game: 'spider', opts: { suits: 2 } },
  { key: 'spider-4', group: 'Spider', label: '4 suits', game: 'spider', opts: { suits: 4 } },
];

export const DEFAULT_MODE = 'klondike-1';

export function findMode(key) {
  return MODES.find(m => m.key === key) || null;
}

export function modeOf(game) {
  if (game.kind === 'spider') return `spider-${game.suits}`;
  return (game.scoring === 'vegas' ? 'vegas-' : 'klondike-') + (game.draw === 3 ? 3 : 1);
}

export function dealMode(key, random = Math.random) {
  const mode = findMode(key) || findMode(DEFAULT_MODE);
  if (mode.game === 'spider') {
    return spider.createSpiderGame(newSpiderDeck(mode.opts.suits, random), mode.opts);
  }
  return createGame(newDeck(random), mode.opts);
}

// The one interface the board, drag, and main.js use, so none of them has
// to know which game is on the table. `to` is { kind, index }; `from` is
// the drag info board.js attaches to a card.
const klondike = {
  columns: 7,
  getMovingCards,
  canPickUp(game, from) {
    const cards = getMovingCards(game, from);
    return cards.length > 0 && cards[0].faceUp;
  },
  canDrop(game, cards, from, to) {
    if (to.kind === 'foundation') {
      return cards.length === 1 && canPlaceOnFoundation(cards[0], game.foundations[to.index]);
    }
    if (to.kind === 'tableau') {
      if (from.from === 'tableau' && from.fromIndex === to.index) return false;
      return canPlaceOnTableau(cards[0], game.tableau[to.index]);
    }
    return false;
  },
  // Where a tap sends the cards, best first: a single card goes home to a
  // foundation if it can, otherwise anything goes to the first column that
  // takes it.
  autoTargets(game, from, cards) {
    const out = [];
    if (cards.length === 1) {
      for (let i = 0; i < 4; i++) out.push({ kind: 'foundation', index: i });
    }
    for (let i = 0; i < 7; i++) out.push({ kind: 'tableau', index: i });
    return out.filter(to => klondike.canDrop(game, cards, from, to));
  },
  applyMove,
  draw: drawFromStock,
  canDraw: game => game.stock.length > 0 || (game.waste.length > 0 && canRedeal(game)),
  undo,
  isWon,
  serialize: serializeKlondike,
};

const spiderRules = {
  columns: spider.SPIDER_COLUMNS,
  getMovingCards: spider.getMovingCards,
  canPickUp: spider.canPickUp,
  canDrop: spider.canDrop,
  autoTargets: spider.autoTargets,
  applyMove: spider.applyMove,
  draw: spider.dealRow,
  canDraw: game => game.stock.length > 0,
  undo: spider.undo,
  isWon: spider.isWon,
  serialize: serializeSpider,
};

export function rulesFor(game) {
  return game.kind === 'spider' ? spiderRules : klondike;
}

export function serialize(game, now) {
  return rulesFor(game).serialize(game, now);
}

export function deserialize(save) {
  return save?.g === 'spider' ? deserializeSpider(save) : deserializeKlondike(save);
}
