/**
 * Playable Reversi session: hotseat or vs computer.
 */

import { BLACK, WHITE, countDiscs, createBoard } from './board.js';
import { applyMove, canMove, legalMoves, nextTurnState, winnerOf } from './rules.js';

/**
 * @typedef {object} Game
 * @property {import('./board.js').Cell[]} board
 * @property {import('./board.js').Player | null} turn
 * @property {'hotseat' | 'ai'} mode
 * @property {import('./board.js').Player} human  Colour the human plays in AI mode.
 * @property {boolean} over
 * @property {boolean} lastPassed
 * @property {'black' | 'white' | 'draw' | null} winner
 * @property {{ row: number, col: number, player: number }[]} history
 */

/**
 * @param {object} [options]
 * @param {'hotseat' | 'ai'} [options.mode]
 * @param {import('./board.js').Player} [options.human]
 * @returns {Game}
 */
export function createGame({ mode = 'hotseat', human = BLACK } = {}) {
  return {
    board: createBoard(),
    turn: BLACK,
    mode,
    human,
    over: false,
    lastPassed: false,
    winner: null,
    history: [],
  };
}

/** @param {Game} game */
export function scores(game) {
  return countDiscs(game.board);
}

/** @param {Game} game */
export function currentLegalMoves(game) {
  if (game.over || game.turn == null) return [];
  return legalMoves(game.board, game.turn);
}

/**
 * @param {Game} game
 * @param {number} row
 * @param {number} col
 * @returns {boolean}
 */
export function play(game, row, col) {
  if (game.over || game.turn == null) return false;
  if (!canMove(game.board, game.turn)) return false;
  try {
    game.board = applyMove(game.board, game.turn, row, col);
  } catch {
    return false;
  }
  game.history.push({ row, col, player: game.turn });
  const state = nextTurnState(game.board, game.turn);
  game.lastPassed = state.passed;
  game.over = state.over;
  game.turn = state.turn;
  if (game.over) game.winner = winnerOf(game.board);
  return true;
}

/** Whether the active side is the computer. */
export function isAiTurn(game) {
  return game.mode === 'ai' && !game.over && game.turn != null && game.turn !== game.human;
}
