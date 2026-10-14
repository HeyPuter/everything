import { SUIT_COLOR, RANKS } from './deck.js';

// v2 added the game options (draw count, Vegas scoring and its running
// score, redeals used). A v1 save is a draw-one, standard-scoring Klondike
// game, which was the only game there was, so it still loads.
export const SAVE_VERSION = 2;

const SUIT_CODE = { '♠': 'S', '♥': 'H', '♦': 'D', '♣': 'C' };
const CODE_SUIT = { S: '♠', H: '♥', D: '♦', C: '♣' };

// '10' is the only two-character rank; 'T' keeps every card exactly two chars.
const rankToCode = rank => (rank === '10' ? 'T' : rank);
const codeToRank = code => (code === 'T' ? '10' : code);

function encodePile(pile) {
  return pile.map(c => {
    const s = SUIT_CODE[c.suit];
    return rankToCode(c.rank) + (c.faceUp ? s : s.toLowerCase());
  }).join('');
}

function decodePile(str) {
  if (typeof str !== 'string' || str.length % 2 !== 0) throw new Error('bad pile');
  const out = [];
  for (let i = 0; i < str.length; i += 2) {
    const rankCode = str[i];
    const suitCode = str[i + 1];
    const rank = codeToRank(rankCode);
    const suit = CODE_SUIT[suitCode.toUpperCase()];
    if (!suit || !RANKS.includes(rank)) throw new Error('bad card');
    // An uppercase suit letter means face up.
    const faceUp = suitCode === suitCode.toUpperCase();
    out.push({ suit, rank, color: SUIT_COLOR[suit], faceUp, id: suit + rank });
  }
  return out;
}

export function serialize(game, now) {
  return {
    v: SAVE_VERSION,
    g: 'klondike',
    d: game.draw === 3 ? 3 : 1,
    sc: game.scoring === 'vegas' ? 'vegas' : 'standard',
    t: game.tableau.map(encodePile),
    f: game.foundations.map(encodePile),
    s: encodePile(game.stock),
    w: encodePile(game.waste),
    m: game.moves,
    $: game.score || 0,
    r: game.redeals || 0,
    ts: now,
  };
}

export function deserialize(save) {
  if (!save || (save.v !== 1 && save.v !== SAVE_VERSION)) return null;
  if (save.v === SAVE_VERSION && save.g !== 'klondike') return null;
  const draw = save.v === 1 ? 1 : save.d;
  const scoring = save.v === 1 ? 'standard' : save.sc;
  if (draw !== 1 && draw !== 3) return null;
  if (scoring !== 'standard' && scoring !== 'vegas') return null;
  if (!Array.isArray(save.t) || save.t.length !== 7) return null;
  if (!Array.isArray(save.f) || save.f.length !== 4) return null;
  try {
    const tableau = save.t.map(decodePile);
    const foundations = save.f.map(decodePile);
    const stock = decodePile(save.s);
    const waste = decodePile(save.w);

    // Per-card decoding above only checks that each card is individually
    // legal (a real suit, a real rank). It says nothing about the board as
    // a whole — a corrupted save could still restore duplicate cards (two
    // aces of spades) or drop cards entirely (51 cards total), and the game
    // would continue into a board that can never be won. A standard deck
    // has exactly 52 cards with 52 distinct ids; reject anything else.
    const all = [...tableau.flat(), ...foundations.flat(), ...stock, ...waste];
    if (all.length !== 52) return null;
    if (new Set(all.map(c => c.id)).size !== 52) return null;

    return {
      kind: 'klondike',
      draw,
      scoring,
      tableau,
      foundations,
      stock,
      waste,
      moves: Number(save.m) || 0, // deliberately lenient: non-numeric m coerces to 0 rather than rejecting the save
      score: scoring === 'vegas' ? Number(save.$) || 0 : 0,
      redeals: Math.max(0, Math.floor(Number(save.r) || 0)),
      history: [],
    };
  } catch {
    return null;
  }
}
