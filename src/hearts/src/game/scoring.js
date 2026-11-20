/**
 * Hand and match scoring for classic Hearts.
 *
 * DOCUMENTED Microsoft Hearts defaults:
 *   - Each heart = 1 point, Queen of Spades = 13 (26 total per hand)
 *   - Shoot the moon: take all 26 → that player scores 0, others +26
 *   - Match ends when any player reaches or exceeds 100; lowest total wins
 */

import { penaltyPoints } from './cards.js';

/**
 * @param {import('./cards.js').Card[][]} takenBySeat  Cards taken in tricks, per seat
 * @returns {{ handScores: number[], moonShooter: number | null }}
 */
export function scoreHand(takenBySeat) {
  const raw = takenBySeat.map((cards) => cards.reduce((n, c) => n + penaltyPoints(c), 0));
  const moonShooter = raw.findIndex((n) => n === 26);
  if (moonShooter >= 0) {
    const handScores = raw.map((_, i) => (i === moonShooter ? 0 : 26));
    return { handScores, moonShooter };
  }
  return { handScores: raw, moonShooter: null };
}

/**
 * @param {number[]} totals
 * @param {number} [threshold=100]
 */
export function matchOver(totals, threshold = 100) {
  return totals.some((n) => n >= threshold);
}

/**
 * @param {number[]} totals
 * @returns {number[]} Winning seat indices (ties allowed)
 */
export function winners(totals) {
  const best = Math.min(...totals);
  return totals.map((n, i) => (n === best ? i : -1)).filter((i) => i >= 0);
}
