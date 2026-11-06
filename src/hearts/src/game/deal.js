/**
 * Deal and pass-direction helpers for Hearts.
 */

import { cardFromId, sortHand } from './cards.js';

/** @typedef {0 | 1 | 2 | 3} Seat  South=0 (human), West=1, North=2, East=3 */

export const SEATS = /** @type {const} */ ([0, 1, 2, 3]);
export const SEAT_NAMES = ['You', 'West', 'North', 'East'];

/** Pass cycle used by classic Microsoft Hearts (DOCUMENTED). */
export const PASS_DIRS = /** @type {const} */ (['left', 'right', 'across', 'hold']);

/**
 * @param {number} handIndex  0-based hand within a match
 * @returns {'left' | 'right' | 'across' | 'hold'}
 */
export function passDirectionForHand(handIndex) {
  return PASS_DIRS[((handIndex % 4) + 4) % 4];
}

/**
 * Seat that receives cards from `from` under the given pass direction.
 * @param {Seat} from
 * @param {'left' | 'right' | 'across' | 'hold'} dir
 * @returns {Seat | null}
 */
export function passTarget(from, dir) {
  if (dir === 'hold') return null;
  if (dir === 'left') return /** @type {Seat} */ ((from + 1) % 4);
  if (dir === 'right') return /** @type {Seat} */ ((from + 3) % 4);
  return /** @type {Seat} */ ((from + 2) % 4); // across
}

/**
 * Shuffle and deal 13 cards to each of 4 seats.
 * @param {() => number} [random]
 * @returns {import('./cards.js').Card[][]}
 */
export function dealHands(random = Math.random) {
  const ids = Array.from({ length: 52 }, (_, i) => i);
  for (let i = 51; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const tmp = ids[i];
    ids[i] = ids[j];
    ids[j] = tmp;
  }
  /** @type {import('./cards.js').Card[][]} */
  const hands = [[], [], [], []];
  for (let n = 0; n < 52; n += 1) {
    hands[n % 4].push(cardFromId(ids[n]));
  }
  return hands.map(sortHand);
}
