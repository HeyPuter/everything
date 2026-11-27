/** @typedef {{ id: number, suit: number, rank: number }} Card */

export const SUITS = Object.freeze({
  CLUBS: 0,
  DIAMONDS: 1,
  HEARTS: 2,
  SPADES: 3,
});

export const SUIT_NAMES = Object.freeze(['clubs', 'diamonds', 'hearts', 'spades']);
export const SUIT_SYMBOLS = Object.freeze(['♣', '♦', '♥', '♠']);
export const RANK_LABELS = Object.freeze([
  '',
  'A',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '10',
  'J',
  'Q',
  'K',
]);

/**
 * Microsoft FreeCell card index 0..51 → suit = n % 4, rank = floor(n / 4) + 1.
 * Suit order: clubs, diamonds, hearts, spades.
 * @param {number} n
 * @returns {Card}
 */
export function cardFromIndex(n) {
  const suit = n % 4;
  const rank = Math.floor(n / 4) + 1;
  return { id: n, suit, rank };
}

/** @param {Card} card */
export function isRed(card) {
  return card.suit === SUITS.DIAMONDS || card.suit === SUITS.HEARTS;
}

/** @param {Card} a @param {Card} b */
export function oppositeColor(a, b) {
  return isRed(a) !== isRed(b);
}

const SUIT_LETTERS = Object.freeze(['C', 'D', 'H', 'S']);

/** @param {Card} card */
export function cardLabel(card) {
  return `${RANK_LABELS[card.rank]}${SUIT_SYMBOLS[card.suit]}`;
}

/** ASCII label used by FreeCell FAQ / Rosetta (e.g. JD, 5C). @param {Card} card */
export function cardLabelAscii(card) {
  return `${RANK_LABELS[card.rank]}${SUIT_LETTERS[card.suit]}`;
}

/**
 * Descending alternating-color build (cascade stack legality).
 * @param {Card[]} cards
 */
export function isAlternatingRun(cards) {
  for (let i = 1; i < cards.length; i += 1) {
    const a = cards[i - 1];
    const b = cards[i];
    if (a.rank !== b.rank + 1 || !oppositeColor(a, b)) return false;
  }
  return true;
}
