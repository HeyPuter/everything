/**
 * Hearts match engine: deal → pass → tricks → score → next hand / match end.
 */

import { isTwoOfClubs, sortHand } from './cards.js';
import { choosePass, choosePlay } from './ai.js';
import {
  dealHands,
  passDirectionForHand,
  passTarget,
  SEAT_NAMES,
} from './deal.js';
import { breaksHearts, legalPlays, trickWinner } from './rules.js';
import { matchOver, scoreHand, winners } from './scoring.js';

/** @typedef {0 | 1 | 2 | 3} Seat */
/** @typedef {'passing' | 'play' | 'trick_end' | 'hand_end' | 'match_end'} Phase */

/**
 * @typedef {object} Game
 * @property {import('./cards.js').Card[][]} hands
 * @property {import('./cards.js').Card[][]} taken
 * @property {number[]} totals
 * @property {number} handIndex
 * @property {'left' | 'right' | 'across' | 'hold'} passDir
 * @property {(import('./cards.js').Card[] | null)[]} passSelections
 * @property {boolean} passResolved
 * @property {Phase} phase
 * @property {import('./cards.js').Card[]} trick
 * @property {Seat[]} trickSeats
 * @property {Seat} leader
 * @property {Seat} toPlay
 * @property {boolean} heartsBroken
 * @property {boolean} isFirstTrick
 * @property {number} tricksPlayed
 * @property {number[] | null} lastHandScores
 * @property {number | null} moonShooter
 * @property {number[] | null} matchWinners
 * @property {number} threshold
 */

/**
 * @param {{ random?: () => number, threshold?: number }} [opts]
 * @returns {Game}
 */
export function createMatch(opts = {}) {
  const game = {
    hands: [[], [], [], []],
    taken: [[], [], [], []],
    totals: [0, 0, 0, 0],
    handIndex: 0,
    passDir: 'left',
    passSelections: [null, null, null, null],
    passResolved: false,
    phase: /** @type {Phase} */ ('passing'),
    trick: [],
    trickSeats: [],
    leader: /** @type {Seat} */ (0),
    toPlay: /** @type {Seat} */ (0),
    heartsBroken: false,
    isFirstTrick: true,
    tricksPlayed: 0,
    lastHandScores: null,
    moonShooter: null,
    matchWinners: null,
    threshold: opts.threshold ?? 100,
  };
  startHand(game, opts.random);
  return game;
}

/**
 * @param {Game} game
 * @param {() => number} [random]
 */
export function startHand(game, random = Math.random) {
  game.hands = dealHands(random);
  game.taken = [[], [], [], []];
  game.passDir = passDirectionForHand(game.handIndex);
  game.passSelections = [null, null, null, null];
  game.passResolved = false;
  game.trick = [];
  game.trickSeats = [];
  game.heartsBroken = false;
  game.isFirstTrick = true;
  game.tricksPlayed = 0;
  game.lastHandScores = null;
  game.moonShooter = null;
  game.matchWinners = null;

  if (game.passDir === 'hold') {
    game.passResolved = true;
    beginPlay(game);
  } else {
    game.phase = 'passing';
    // AI seats choose passes immediately.
    for (let seat = 1; seat < 4; seat += 1) {
      game.passSelections[seat] = choosePass(game.hands[seat]);
    }
  }
}

/** @param {Game} game */
function beginPlay(game) {
  game.phase = 'play';
  const starter = /** @type {Seat} */ (
    game.hands.findIndex((hand) => hand.some(isTwoOfClubs))
  );
  if (starter < 0) throw new Error('2♣ missing from deal');
  game.leader = starter;
  game.toPlay = starter;
  game.trick = [];
  game.trickSeats = [];
}

/**
 * Human selects exactly 3 cards to pass.
 * @param {Game} game
 * @param {number[]} cardIds
 */
export function selectHumanPass(game, cardIds) {
  if (game.phase !== 'passing' || game.passDir === 'hold') return false;
  if (cardIds.length !== 3) return false;
  const hand = game.hands[0];
  const cards = cardIds.map((id) => hand.find((c) => c.id === id));
  if (cards.some((c) => !c)) return false;
  if (new Set(cardIds).size !== 3) return false;
  game.passSelections[0] = /** @type {import('./cards.js').Card[]} */ (cards);
  return resolvePassIfReady(game);
}

/** @param {Game} game */
export function resolvePassIfReady(game) {
  if (game.passDir === 'hold') {
    game.passResolved = true;
    beginPlay(game);
    return true;
  }
  if (game.passSelections.some((s) => !s || s.length !== 3)) return false;

  /** @type {import('./cards.js').Card[][]} */
  const outgoing = game.passSelections.map((s) => /** @type {import('./cards.js').Card[]} */ (s.slice()));

  // Remove passed cards from each hand.
  for (let seat = 0; seat < 4; seat += 1) {
    const ids = new Set(outgoing[seat].map((c) => c.id));
    game.hands[seat] = game.hands[seat].filter((c) => !ids.has(c.id));
  }

  // Deliver to targets.
  for (let seat = 0; seat < 4; seat += 1) {
    const target = passTarget(/** @type {Seat} */ (seat), game.passDir);
    if (target == null) continue;
    game.hands[target].push(...outgoing[seat]);
  }

  game.hands = game.hands.map(sortHand);
  game.passResolved = true;
  beginPlay(game);
  return true;
}

/**
 * @param {Game} game
 * @param {Seat} seat
 */
export function legalCardsFor(game, seat) {
  if (game.phase !== 'play' || game.toPlay !== seat) return [];
  return legalPlays({
    hand: game.hands[seat],
    trick: game.trick,
    leadSuit: game.trick.length ? game.trick[0].suit : null,
    heartsBroken: game.heartsBroken,
    isFirstTrick: game.isFirstTrick,
  });
}

/**
 * @param {Game} game
 * @param {number} cardId
 * @param {Seat} [seat=0]
 */
export function playCard(game, cardId, seat = /** @type {Seat} */ (0)) {
  if (game.phase !== 'play' || game.toPlay !== seat) return false;
  const legal = legalCardsFor(game, seat);
  const card = legal.find((c) => c.id === cardId);
  if (!card) return false;

  game.hands[seat] = game.hands[seat].filter((c) => c.id !== cardId);
  game.trick.push(card);
  game.trickSeats.push(seat);
  if (breaksHearts(card, game.heartsBroken)) game.heartsBroken = true;

  if (game.trick.length < 4) {
    game.toPlay = /** @type {Seat} */ ((seat + 1) % 4);
    return true;
  }

  // Trick complete.
  const winner = /** @type {Seat} */ (trickWinner(game.trick, game.leader));
  game.taken[winner].push(...game.trick);
  game.tricksPlayed += 1;
  game.phase = 'trick_end';
  game.leader = winner;
  game.toPlay = winner;
  game.isFirstTrick = false;
  return true;
}

/** Advance after trick_end display / AI pacing. */
export function acknowledgeTrick(game) {
  if (game.phase !== 'trick_end') return false;
  game.trick = [];
  game.trickSeats = [];

  if (game.tricksPlayed >= 13) {
    finishHand(game);
    return true;
  }
  game.phase = 'play';
  return true;
}

/** @param {Game} game */
function finishHand(game) {
  const { handScores, moonShooter } = scoreHand(game.taken);
  game.lastHandScores = handScores;
  game.moonShooter = moonShooter;
  for (let i = 0; i < 4; i += 1) game.totals[i] += handScores[i];
  game.phase = 'hand_end';

  if (matchOver(game.totals, game.threshold)) {
    game.matchWinners = winners(game.totals);
    game.phase = 'match_end';
  }
}

/** Start the next hand after hand_end. */
export function nextHand(game, random = Math.random) {
  if (game.phase !== 'hand_end') return false;
  game.handIndex += 1;
  startHand(game, random);
  return true;
}

/** Fresh match. */
export function newMatch(game, random = Math.random) {
  game.totals = [0, 0, 0, 0];
  game.handIndex = 0;
  startHand(game, random);
  return game;
}

/**
 * Drive computer seats until human must act or a pause point.
 * @param {Game} game
 * @returns {'await_human' | 'trick_end' | 'hand_end' | 'match_end' | 'passing'}
 */
export function advanceAi(game) {
  if (game.phase === 'passing') return 'passing';
  if (game.phase === 'trick_end') return 'trick_end';
  if (game.phase === 'hand_end') return 'hand_end';
  if (game.phase === 'match_end') return 'match_end';

  while (game.phase === 'play' && game.toPlay !== 0) {
    const seat = game.toPlay;
    const card = choosePlay({
      hand: game.hands[seat],
      trick: game.trick,
      leadSuit: game.trick.length ? game.trick[0].suit : null,
      heartsBroken: game.heartsBroken,
      isFirstTrick: game.isFirstTrick,
    });
    playCard(game, card.id, seat);
    if (game.phase === 'trick_end') return 'trick_end';
  }
  return game.phase === 'play' ? 'await_human' : /** @type {any} */ (game.phase);
}

export { SEAT_NAMES, legalPlays, scoreHand, passDirectionForHand, passTarget };
