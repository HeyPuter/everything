/**
 * Lightweight Reversi AI: greedy disc count with corner / edge heuristics.
 * Depth-1 evaluation is enough for a playable opponent; injectable random
 * breaks ties so games do not always look identical.
 */

import { BLACK, SIZE, WHITE, countDiscs, indexOf } from './board.js';
import { applyMove, legalMoves } from './rules.js';

const CORNERS = new Set([
  indexOf(0, 0),
  indexOf(0, SIZE - 1),
  indexOf(SIZE - 1, 0),
  indexOf(SIZE - 1, SIZE - 1),
]);

const X_SQUARES = new Set([
  indexOf(1, 1),
  indexOf(1, SIZE - 2),
  indexOf(SIZE - 2, 1),
  indexOf(SIZE - 2, SIZE - 2),
]);

/**
 * @param {import('./board.js').Cell[]} board
 * @param {import('./board.js').Player} player
 */
function evaluate(board, player) {
  const { black, white } = countDiscs(board);
  const mine = player === BLACK ? black : white;
  const theirs = player === BLACK ? white : black;
  let score = mine - theirs;

  for (const i of CORNERS) {
    if (board[i] === player) score += 25;
    else if (board[i] === (player === BLACK ? WHITE : BLACK)) score -= 25;
  }
  for (const i of X_SQUARES) {
    if (board[i] === player) score -= 8;
  }
  return score;
}

/**
 * Pick a legal move for `player`. Returns null if none.
 * @param {import('./board.js').Cell[]} board
 * @param {import('./board.js').Player} player
 * @param {() => number} [random]
 * @returns {{ row: number, col: number } | null}
 */
export function chooseMove(board, player, random = Math.random) {
  const moves = legalMoves(board, player);
  if (!moves.length) return null;

  let best = -Infinity;
  /** @type {{ row: number, col: number }[]} */
  const tied = [];

  for (const move of moves) {
    const next = applyMove(board, player, move.row, move.col);
    let score = evaluate(next, player);
    if (CORNERS.has(indexOf(move.row, move.col))) score += 40;
    if (score > best) {
      best = score;
      tied.length = 0;
      tied.push({ row: move.row, col: move.col });
    } else if (score === best) {
      tied.push({ row: move.row, col: move.col });
    }
  }

  return tied[Math.floor(random() * tied.length)] || tied[0];
}
