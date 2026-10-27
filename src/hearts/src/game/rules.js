/**
 * Legal-play rules for a Hearts trick (DOCUMENTED classic Microsoft Hearts).
 */

import { isTwoOfClubs } from './cards.js';

/**
 * @param {object} opts
 * @param {import('./cards.js').Card[]} opts.hand
 * @param {import('./cards.js').Card[]} opts.trick   Cards already played this trick (in order)
 * @param {import('./cards.js').Card['suit'] | null} opts.leadSuit
 * @param {boolean} opts.heartsBroken
 * @param {boolean} opts.isFirstTrick
 * @returns {import('./cards.js').Card[]}
 */
export function legalPlays({ hand, trick, leadSuit, heartsBroken, isFirstTrick }) {
  if (!hand.length) return [];

  // Opening lead of the hand: must play the 2♣.
  if (trick.length === 0 && isFirstTrick) {
    const two = hand.find(isTwoOfClubs);
    return two ? [two] : [];
  }

  if (trick.length === 0) {
    // Leading a later trick.
    if (!heartsBroken) {
      const nonHearts = hand.filter((c) => c.suit !== 'H');
      if (nonHearts.length) return nonHearts;
    }
    return hand.slice();
  }

  // Must follow suit if able.
  const suit = leadSuit;
  const followers = hand.filter((c) => c.suit === suit);
  if (followers.length) return followers;

  // Void in lead suit.
  if (isFirstTrick) {
    // First trick: cannot dump hearts or the Queen of Spades (DOCUMENTED).
    const safe = hand.filter((c) => c.suit !== 'H' && !(c.suit === 'S' && c.rank === 10));
    return safe.length ? safe : hand.slice();
  }

  return hand.slice();
}

/**
 * @param {import('./cards.js').Card[]} trick
 * @param {number} leaderSeat
 * @returns {number} Seat index that wins the trick
 */
export function trickWinner(trick, leaderSeat) {
  if (trick.length !== 4) throw new Error('trick must have 4 cards');
  const lead = trick[0].suit;
  let bestIdx = 0;
  for (let i = 1; i < 4; i += 1) {
    const card = trick[i];
    if (card.suit === lead && card.rank > trick[bestIdx].rank) bestIdx = i;
  }
  return (leaderSeat + bestIdx) % 4;
}

/**
 * Whether playing `card` breaks hearts (first heart of the hand hits the table).
 * @param {import('./cards.js').Card} card
 * @param {boolean} heartsBroken
 */
export function breaksHearts(card, heartsBroken) {
  return !heartsBroken && card.suit === 'H';
}
