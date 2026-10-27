import { cardFromIndex } from './cards.js';

/**
 * Microsoft FreeCell deal RNG (Jim Horne / Win32 FreeCell).
 * Seeded linear congruential generator; cards swapped from the end of the pack.
 *
 * DOCUMENTED: https://rosettacode.org/wiki/Deal_cards_for_FreeCell
 * and the classic FreeCell FAQ deal algorithm — not a LIVE dump of Windows binaries.
 *
 * @param {number} dealNumber integer in 1..2^31-1 (classic UI uses 1..32000)
 * @returns {import('./cards.js').Card[]} 52 cards, deal order (first card → cascade 0 top)
 */
export function dealCards(dealNumber) {
  const game = Number(dealNumber);
  if (!Number.isInteger(game) || game < 1 || game > 0x7fffffff) {
    throw new RangeError('dealNumber must be an integer from 1 to 2147483647');
  }

  /** @type {number[]} */
  const deck = Array.from({ length: 52 }, (_, i) => i);
  let seed = game >>> 0;

  for (let i = 0; i < 52; i += 1) {
    seed = (Math.imul(seed, 214013) + 2531011) >>> 0;
    const r = ((seed >>> 16) & 0x7fff) % (52 - i);
    const last = 51 - i;
    const tmp = deck[r];
    deck[r] = deck[last];
    deck[last] = tmp;
  }

  // After shuffle, cards are dealt left-to-right into 8 cascades (deck[51] first).
  const order = [];
  for (let i = 51; i >= 0; i -= 1) order.push(cardFromIndex(deck[i]));
  return order;
}

/**
 * Deal into 8 cascades (7,7,7,7,6,6,6,6).
 * @param {number} dealNumber
 * @returns {import('./cards.js').Card[][]}
 */
export function dealCascades(dealNumber) {
  const cards = dealCards(dealNumber);
  /** @type {import('./cards.js').Card[][]} */
  const cascades = Array.from({ length: 8 }, () => []);
  cards.forEach((card, i) => {
    cascades[i % 8].push(card);
  });
  return cascades;
}

export const CLASSIC_DEAL_MAX = 32000;
