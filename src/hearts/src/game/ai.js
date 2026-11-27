/**
 * Lightweight heuristic AI for the three computer seats.
 * Plays only legal cards; prefers dumping penalties and ducking high leads.
 */

import { isQueenOfSpades, penaltyPoints } from './cards.js';
import { legalPlays } from './rules.js';

/**
 * @param {object} ctx
 * @param {import('./cards.js').Card[]} ctx.hand
 * @param {import('./cards.js').Card[]} ctx.trick
 * @param {import('./cards.js').Card['suit'] | null} ctx.leadSuit
 * @param {boolean} ctx.heartsBroken
 * @param {boolean} ctx.isFirstTrick
 * @returns {import('./cards.js').Card}
 */
export function choosePlay(ctx) {
  const options = legalPlays(ctx);
  if (!options.length) throw new Error('AI has no legal play');
  if (options.length === 1) return options[0];

  const { trick, leadSuit } = ctx;

  if (trick.length === 0) {
    // Lead low non-penalty when possible.
    const safe = options.filter((c) => penaltyPoints(c) === 0);
    const pool = safe.length ? safe : options;
    return pool.reduce((best, c) => (c.rank < best.rank ? c : best));
  }

  const following = leadSuit != null && options.every((c) => c.suit === leadSuit);
  if (following) {
    const leadRank = trick[0].rank;
    const currentWinningRank = trick
      .filter((c) => c.suit === leadSuit)
      .reduce((m, c) => Math.max(m, c.rank), -1);

    if (trick.length < 3) {
      // Duck under current winner when possible.
      const under = options.filter((c) => c.rank < currentWinningRank);
      if (under.length) return under.reduce((b, c) => (c.rank > b.rank ? c : b));
      return options.reduce((b, c) => (c.rank < b.rank ? c : b));
    }

    // Last to play: take cheaply if the trick is clean; else dump.
    const trickPenalty = trick.reduce((n, c) => n + penaltyPoints(c), 0);
    if (trickPenalty === 0) {
      const winners = options.filter((c) => c.rank > currentWinningRank);
      if (winners.length) return winners.reduce((b, c) => (c.rank < b.rank ? c : b));
      return options.reduce((b, c) => (c.rank < b.rank ? c : b));
    }
    // Avoid winning a point trick.
    const under = options.filter((c) => c.rank <= leadRank || c.rank < currentWinningRank);
    const duck = options.filter((c) => c.rank < currentWinningRank);
    if (duck.length) return duck.reduce((b, c) => (c.rank > b.rank ? c : b));
    void under;
    return options.reduce((b, c) => (c.rank < b.rank ? c : b));
  }

  // Void — dump highest penalty first (Q♠, then high hearts), else high junk.
  const q = options.find(isQueenOfSpades);
  if (q) return q;
  const hearts = options.filter((c) => c.suit === 'H');
  if (hearts.length) return hearts.reduce((b, c) => (c.rank > b.rank ? c : b));
  return options.reduce((b, c) => (c.rank > b.rank ? c : b));
}

/**
 * Choose 3 cards to pass: prefer Q♠ / high hearts / high spades / high cards.
 * @param {import('./cards.js').Card[]} hand
 * @returns {import('./cards.js').Card[]}
 */
export function choosePass(hand) {
  const scored = hand.map((card) => {
    let score = card.rank;
    if (isQueenOfSpades(card)) score += 40;
    if (card.suit === 'H') score += 8;
    if (card.suit === 'S' && card.rank >= 10) score += 12;
    if (card.suit === 'S' && card.rank === 12) score += 6; // Ace of spades
    return { card, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.card);
}
