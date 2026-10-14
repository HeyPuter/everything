export const SUITS = ['♠', '♥', '♦', '♣'];

export const SUIT_COLOR = { '♠': 'black', '♣': 'black', '♥': 'red', '♦': 'red' };

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

export const RANK_VAL = Object.fromEntries(RANKS.map((r, i) => [r, i + 1]));

export function newDeck(random = Math.random) {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, color: SUIT_COLOR[suit], faceUp: false, id: suit + rank });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

// Spider's 104 cards are always two full decks' worth, spread over as many
// suits as the difficulty allows: 8 runs of spades for one suit, 4 each of
// spades and hearts for two, 2 of every suit for four. Copies of the same
// card need distinct ids (animations, tilt, and flips all key off card.id),
// so each gets a #n copy number.
export const SPIDER_SUITS = { 1: ['♠'], 2: ['♠', '♥'], 4: SUITS };

export function newSpiderDeck(suitCount = 1, random = Math.random) {
  const suits = SPIDER_SUITS[suitCount];
  if (!suits) throw new Error('bad suit count');
  const copies = 8 / suits.length;
  const deck = [];
  for (const suit of suits) {
    for (let n = 0; n < copies; n++) {
      for (const rank of RANKS) {
        deck.push({ suit, rank, color: SUIT_COLOR[suit], faceUp: false, id: `${suit}${rank}#${n}` });
      }
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
