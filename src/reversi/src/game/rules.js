/**
 * Legal moves, flips, and pass / end-of-game detection.
 */

import {
  BLACK,
  DIRECTIONS,
  EMPTY,
  SIZE,
  WHITE,
  cloneBoard,
  inBounds,
  indexOf,
  opponent,
} from './board.js';

/**
 * Discs that would flip if `player` played at (row, col). Empty if illegal.
 * @param {import('./board.js').Cell[]} board
 * @param {import('./board.js').Player} player
 * @param {number} row
 * @param {number} col
 * @returns {number[]} Flat indices to flip (not including the placement square).
 */
export function flipsAt(board, player, row, col) {
  if (!inBounds(row, col) || board[indexOf(row, col)] !== EMPTY) return [];
  const other = opponent(player);
  /** @type {number[]} */
  const flips = [];

  for (const [dr, dc] of DIRECTIONS) {
    /** @type {number[]} */
    const ray = [];
    let r = row + dr;
    let c = col + dc;
    while (inBounds(r, c) && board[indexOf(r, c)] === other) {
      ray.push(indexOf(r, c));
      r += dr;
      c += dc;
    }
    if (ray.length > 0 && inBounds(r, c) && board[indexOf(r, c)] === player) {
      flips.push(...ray);
    }
  }
  return flips;
}

/** @param {import('./board.js').Cell[]} board @param {import('./board.js').Player} player */
export function isLegalMove(board, player, row, col) {
  return flipsAt(board, player, row, col).length > 0;
}

/** @param {import('./board.js').Cell[]} board @param {import('./board.js').Player} player */
export function legalMoves(board, player) {
  /** @type {{ row: number, col: number, flips: number[] }[]} */
  const moves = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const flips = flipsAt(board, player, row, col);
      if (flips.length) moves.push({ row, col, flips });
    }
  }
  return moves;
}

/**
 * Apply a move, returning a new board. Throws if illegal.
 * @param {import('./board.js').Cell[]} board
 * @param {import('./board.js').Player} player
 * @param {number} row
 * @param {number} col
 */
export function applyMove(board, player, row, col) {
  const flips = flipsAt(board, player, row, col);
  if (!flips.length) {
    throw new Error(`Illegal move for ${player === BLACK ? 'black' : 'white'} at ${row},${col}`);
  }
  const next = cloneBoard(board);
  next[indexOf(row, col)] = player;
  for (const i of flips) next[i] = player;
  return next;
}

/** True when the player has at least one legal square. */
export function canMove(board, player) {
  return legalMoves(board, player).length > 0;
}

/**
 * After a move (or at start), decide whose turn it is.
 * Passes automatically when the opponent has no move; ends when neither can move.
 * @param {import('./board.js').Cell[]} board
 * @param {import('./board.js').Player} justMoved
 * @returns {{ turn: import('./board.js').Player | null, passed: boolean, over: boolean }}
 */
export function nextTurnState(board, justMoved) {
  const other = opponent(justMoved);
  if (canMove(board, other)) {
    return { turn: other, passed: false, over: false };
  }
  if (canMove(board, justMoved)) {
    return { turn: justMoved, passed: true, over: false };
  }
  return { turn: null, passed: false, over: true };
}

/**
 * @param {import('./board.js').Cell[]} board
 * @returns {'black' | 'white' | 'draw' | null}
 */
export function winnerOf(board) {
  let black = 0;
  let white = 0;
  for (const cell of board) {
    if (cell === BLACK) black++;
    else if (cell === WHITE) white++;
  }
  if (black > white) return 'black';
  if (white > black) return 'white';
  return 'draw';
}
