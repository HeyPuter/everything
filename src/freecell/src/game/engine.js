import { isAlternatingRun, oppositeColor } from './cards.js';
import { dealCascades } from './deal.js';

/**
 * @typedef {'cascade' | 'freecell' | 'foundation'} PileKind
 * @typedef {{ kind: PileKind, index: number }} Loc
 * @typedef {{
 *   dealNumber: number,
 *   freecells: (import('./cards.js').Card | null)[],
 *   foundations: (import('./cards.js').Card | null)[],
 *   cascades: import('./cards.js').Card[][],
 *   won: boolean,
 *   moves: number,
 * }} Game
 */

/**
 * @param {number} [dealNumber=1]
 * @returns {Game}
 */
export function createGame(dealNumber = 1) {
  return {
    dealNumber,
    freecells: [null, null, null, null],
    foundations: [null, null, null, null],
    cascades: dealCascades(dealNumber),
    won: false,
    moves: 0,
  };
}

/** @param {Game} game */
export function cloneGame(game) {
  return {
    dealNumber: game.dealNumber,
    freecells: [...game.freecells],
    foundations: [...game.foundations],
    cascades: game.cascades.map((c) => [...c]),
    won: game.won,
    moves: game.moves,
  };
}

/** @param {Game} game @param {Loc} loc */
export function peek(game, loc) {
  if (loc.kind === 'freecell') return game.freecells[loc.index];
  if (loc.kind === 'foundation') return game.foundations[loc.index];
  const col = game.cascades[loc.index];
  return col.length ? col[col.length - 1] : null;
}

/**
 * Cards that would move from a cascade starting at depth from top (0 = top card).
 * @param {Game} game
 * @param {number} cascadeIndex
 * @param {number} depthFromTop
 */
export function cascadeStack(game, cascadeIndex, depthFromTop = 0) {
  const col = game.cascades[cascadeIndex];
  if (!col.length || depthFromTop < 0 || depthFromTop >= col.length) return [];
  const start = col.length - 1 - depthFromTop;
  const stack = col.slice(start);
  return isAlternatingRun(stack) ? stack : [];
}

/**
 * Empty free cells + empty cascades (optionally excluding destination cascade).
 * Classic supermove: (freeCells + 1) * 2^emptyCascades.
 * @param {Game} game
 * @param {number | null} destCascade
 */
export function maxMoveSize(game, destCascade = null) {
  const free = game.freecells.filter((c) => c == null).length;
  let emptyCascades = 0;
  for (let i = 0; i < 8; i += 1) {
    if (game.cascades[i].length === 0 && i !== destCascade) emptyCascades += 1;
  }
  return (free + 1) * 2 ** emptyCascades;
}

/**
 * @param {Game} game
 * @param {Loc} from
 * @param {Loc} to
 * @param {number} [count=1]
 */
export function canMove(game, from, to, count = 1) {
  if (game.won) return false;
  if (from.kind === to.kind && from.index === to.index) return false;
  if (count < 1) return false;

  /** @type {import('./cards.js').Card[]} */
  let moving = [];

  if (from.kind === 'freecell') {
    if (count !== 1) return false;
    const card = game.freecells[from.index];
    if (!card) return false;
    moving = [card];
  } else if (from.kind === 'foundation') {
    return false;
  } else {
    moving = cascadeStack(game, from.index, count - 1);
    if (moving.length !== count) return false;
  }

  const top = moving[0];

  if (to.kind === 'freecell') {
    if (count !== 1) return false;
    return game.freecells[to.index] == null;
  }

  if (to.kind === 'foundation') {
    if (count !== 1) return false;
    const dest = game.foundations[to.index];
    if (!dest) return top.rank === 1;
    return dest.suit === top.suit && dest.rank + 1 === top.rank;
  }

  // cascade destination
  if (count > maxMoveSize(game, game.cascades[to.index].length === 0 ? to.index : null)) {
    return false;
  }
  const destCol = game.cascades[to.index];
  if (!destCol.length) return true;
  const destTop = destCol[destCol.length - 1];
  return destTop.rank === top.rank + 1 && oppositeColor(destTop, top);
}

/**
 * @param {Game} game
 * @param {Loc} from
 * @param {Loc} to
 * @param {number} [count=1]
 * @returns {Game | null}
 */
export function move(game, from, to, count = 1) {
  if (!canMove(game, from, to, count)) return null;
  const next = cloneGame(game);

  /** @type {import('./cards.js').Card[]} */
  let moving;
  if (from.kind === 'freecell') {
    moving = [next.freecells[from.index]];
    next.freecells[from.index] = null;
  } else {
    moving = next.cascades[from.index].splice(next.cascades[from.index].length - count, count);
  }

  if (to.kind === 'freecell') {
    next.freecells[to.index] = moving[0];
  } else if (to.kind === 'foundation') {
    next.foundations[to.index] = moving[0];
  } else {
    next.cascades[to.index].push(...moving);
  }

  next.moves += 1;
  next.won = isWon(next);
  return next;
}

/** @param {Game} game */
export function isWon(game) {
  return game.foundations.every((c) => c && c.rank === 13);
}

/**
 * Find a single-card destination for a card (prefer foundation, then freecell, then cascade).
 * Used for double-click / helper.
 * @param {Game} game
 * @param {Loc} from
 * @returns {Loc | null}
 */
export function autoDestination(game, from) {
  const card = peek(game, from);
  if (!card) return null;

  for (let i = 0; i < 4; i += 1) {
    const to = { kind: /** @type {const} */ ('foundation'), index: i };
    if (canMove(game, from, to, 1)) return to;
  }
  for (let i = 0; i < 4; i += 1) {
    const to = { kind: /** @type {const} */ ('freecell'), index: i };
    if (canMove(game, from, to, 1)) return to;
  }
  for (let i = 0; i < 8; i += 1) {
    const to = { kind: /** @type {const} */ ('cascade'), index: i };
    if (canMove(game, from, to, 1)) return to;
  }
  return null;
}

/**
 * Safe auto-foundation: next foundation card when both lower opposite-color cards
 * are already home (or the card is an Ace / Two with classic FreeCell heuristic).
 * @param {Game} game
 * @returns {Game}
 */
export function autoFoundationPass(game) {
  let current = game;
  let progressed = true;
  while (progressed) {
    progressed = false;
    const sources = [];
    for (let i = 0; i < 4; i += 1) {
      if (current.freecells[i]) sources.push({ kind: /** @type {const} */ ('freecell'), index: i });
    }
    for (let i = 0; i < 8; i += 1) {
      if (current.cascades[i].length) sources.push({ kind: /** @type {const} */ ('cascade'), index: i });
    }
    for (const from of sources) {
      const card = peek(current, from);
      if (!card || !isSafeToFoundation(current, card)) continue;
      for (let f = 0; f < 4; f += 1) {
        const to = { kind: /** @type {const} */ ('foundation'), index: f };
        const moved = move(current, from, to, 1);
        if (moved) {
          current = moved;
          progressed = true;
          break;
        }
      }
      if (progressed) break;
    }
  }
  return current;
}

/**
 * @param {Game} game
 * @param {import('./cards.js').Card} card
 */
export function isSafeToFoundation(game, card) {
  if (card.rank <= 2) return true;
  // Need both opposite-color cards of rank-1 on foundations.
  const need = card.rank - 1;
  let found = 0;
  for (const top of game.foundations) {
    if (!top) continue;
    if (oppositeColor(top, card) && top.rank >= need) found += 1;
  }
  return found >= 2;
}

/** Cards still not on foundations (for status). @param {Game} game */
export function cardsHome(game) {
  return game.foundations.reduce((n, c) => n + (c ? c.rank : 0), 0);
}
