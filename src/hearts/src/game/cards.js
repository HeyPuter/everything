/**
 * Standard 52-card deck helpers for Hearts.
 *
 * Suit order used for encoding: clubs, diamonds, spades, hearts (C D S H) —
 * matching common Hearts lead/sort conventions (not FreeCell's C D H S).
 */

/** @typedef {'C' | 'D' | 'S' | 'H'} Suit */
/** @typedef {'black' | 'red'} Color */

export const SUITS = /** @type {const} */ (['C', 'D', 'S', 'H']);
export const SUIT_GLYPHS = { C: '♣', D: '♦', S: '♠', H: '♥' };
export const RANKS = /** @type {const} */ ([
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
  'A',
]);

/**
 * @typedef {object} Card
 * @property {number} id    0..51
 * @property {number} rank  0=2 … 12=Ace
 * @property {Suit} suit
 * @property {Color} color
 */

/**
 * @param {number} id
 * @returns {Card}
 */
export function cardFromId(id) {
  if (!Number.isInteger(id) || id < 0 || id > 51) {
    throw new RangeError(`card id out of range: ${id}`);
  }
  const suit = SUITS[Math.floor(id / 13)];
  const rank = id % 13;
  return {
    id,
    rank,
    suit,
    color: suit === 'C' || suit === 'S' ? 'black' : 'red',
  };
}

export function orderedDeck() {
  return Array.from({ length: 52 }, (_, id) => cardFromId(id));
}

/** @param {Card} card */
export function shortLabel(card) {
  return `${RANKS[card.rank]}${SUIT_GLYPHS[card.suit]}`;
}

/** Two of clubs — leads the first trick of every hand (DOCUMENTED MS Hearts). */
export function isTwoOfClubs(card) {
  return card.suit === 'C' && card.rank === 0;
}

/** Queen of spades — 13 penalty points. */
export function isQueenOfSpades(card) {
  return card.suit === 'S' && card.rank === 10;
}

/** @param {Card} card */
export function penaltyPoints(card) {
  if (isQueenOfSpades(card)) return 13;
  if (card.suit === 'H') return 1;
  return 0;
}

/**
 * Sort for display: clubs, diamonds, spades, hearts; low→high within suit.
 * @param {Card[]} cards
 */
export function sortHand(cards) {
  const suitOrder = { C: 0, D: 1, S: 2, H: 3 };
  return cards.slice().sort((a, b) => {
    const s = suitOrder[a.suit] - suitOrder[b.suit];
    return s !== 0 ? s : a.rank - b.rank;
  });
}

/**
 * Compare two cards of the same suit for trick-taking (higher rank wins).
 * @param {Card} a
 * @param {Card} b
 */
export function higherInSuit(a, b) {
  return a.rank > b.rank ? a : b;
}
