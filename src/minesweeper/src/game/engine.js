/**
 * Playable Minesweeper rules: reveal, flag, chord, flood fill, win/lose.
 *
 * Status lifecycle:
 *   ready  → playing (first successful reveal) → won | lost
 * Reset creates a fresh board; the face button always returns to ready.
 */

import { createEmptyBoard, cellAt, indexOf, neighbours, placeMines, boardStats } from './board.js';
import { getDifficulty } from './difficulties.js';

/** @typedef {'ready' | 'playing' | 'won' | 'lost'} GameStatus */

/**
 * @typedef {object} Game
 * @property {import('./difficulties.js').DifficultyId} difficulty
 * @property {import('./board.js').Board} board
 * @property {GameStatus} status
 * @property {number | null} explodedIndex  Flat index of the mine that ended the game.
 */

/**
 * @param {string} [difficultyId]
 * @returns {Game}
 */
export function createGame(difficultyId = 'beginner') {
  const difficulty = getDifficulty(difficultyId).id;
  return {
    difficulty,
    board: createEmptyBoard(difficulty),
    status: 'ready',
    explodedIndex: null,
  };
}

/** Remaining mines shown on the counter: total − flags (can go negative). */
export function minesRemaining(game) {
  const { flags } = boardStats(game.board);
  return game.board.mines - flags;
}

/**
 * Ensure mines exist before a reveal. The clicked cell is always excluded so
 * the first click can never land on a mine (classic first-click safety).
 *
 * @param {Game} game
 * @param {number} row
 * @param {number} col
 * @param {() => number} [random]
 */
export function ensureMines(game, row, col, random = Math.random) {
  if (game.board.minesPlaced) return game;
  const forbidden = [indexOf(game.board, row, col)];
  placeMines(game.board, forbidden, random);
  return game;
}

/**
 * Left-click: reveal a hidden cell. Flags are left alone.
 * Returns whether anything changed.
 *
 * @param {Game} game
 * @param {number} row
 * @param {number} col
 * @param {() => number} [random]
 */
export function reveal(game, row, col, random = Math.random) {
  if (game.status === 'won' || game.status === 'lost') return false;
  const cell = cellAt(game.board, row, col);
  if (!cell || cell.mark !== 'hidden') return false;

  ensureMines(game, row, col, random);

  if (game.status === 'ready') game.status = 'playing';

  if (cell.mine) {
    cell.mark = 'revealed';
    game.status = 'lost';
    game.explodedIndex = indexOf(game.board, row, col);
    revealAllMines(game);
    return true;
  }

  floodReveal(game.board, row, col);
  if (checkWin(game)) game.status = 'won';
  return true;
}

/**
 * Right-click: toggle flag on a hidden cell (or clear a flag).
 * Revealed cells ignore flags. No effect after the game ends.
 *
 * @param {Game} game
 * @param {number} row
 * @param {number} col
 */
export function toggleFlag(game, row, col) {
  if (game.status === 'won' || game.status === 'lost') return false;
  const cell = cellAt(game.board, row, col);
  if (!cell) return false;
  if (cell.mark === 'revealed') return false;
  cell.mark = cell.mark === 'flagged' ? 'hidden' : 'flagged';
  return true;
}

/**
 * Chord (middle-click or both-buttons) on a revealed numbered cell: when the
 * adjacent flag count equals the number, reveal every unflagged neighbour.
 *
 * @param {Game} game
 * @param {number} row
 * @param {number} col
 * @param {() => number} [random]
 */
export function chord(game, row, col, random = Math.random) {
  if (game.status === 'won' || game.status === 'lost') return false;
  const cell = cellAt(game.board, row, col);
  if (!cell || cell.mark !== 'revealed' || cell.adjacent === 0) return false;

  let flags = 0;
  for (const [r, c] of neighbours(game.board, row, col)) {
    if (cellAt(game.board, r, c).mark === 'flagged') flags++;
  }
  if (flags !== cell.adjacent) return false;

  let changed = false;
  for (const [r, c] of neighbours(game.board, row, col)) {
    const n = cellAt(game.board, r, c);
    if (n.mark === 'hidden') {
      if (reveal(game, r, c, random)) changed = true;
      if (game.status === 'lost') return true;
    }
  }
  return changed;
}

/**
 * Flood-fill reveal from a zero (or a single numbered cell). Stops at numbers
 * and never crosses into flagged cells.
 *
 * @param {import('./board.js').Board} board
 * @param {number} startRow
 * @param {number} startCol
 */
export function floodReveal(board, startRow, startCol) {
  const start = cellAt(board, startRow, startCol);
  if (!start || start.mark !== 'hidden' || start.mine) return;

  /** @type {[number, number][]} */
  const stack = [[startRow, startCol]];
  while (stack.length) {
    const [row, col] = stack.pop();
    const cell = cellAt(board, row, col);
    if (!cell || cell.mark !== 'hidden' || cell.mine) continue;
    cell.mark = 'revealed';
    if (cell.adjacent !== 0) continue;
    for (const [r, c] of neighbours(board, row, col)) {
      const n = cellAt(board, r, c);
      if (n && n.mark === 'hidden' && !n.mine) stack.push([r, c]);
    }
  }
}

/** @param {Game} game */
export function checkWin(game) {
  const { board } = game;
  const safe = board.rows * board.cols - board.mines;
  let revealed = 0;
  for (const cell of board.cells) {
    if (cell.mark === 'revealed' && !cell.mine) revealed++;
  }
  return revealed === safe;
}

/** On loss, show every mine so the player can see the layout. */
function revealAllMines(game) {
  for (const cell of game.board.cells) {
    if (cell.mine) cell.mark = 'revealed';
  }
}

/**
 * How many adjacent flags surround a cell (for chord eligibility in the UI).
 * @param {Game} game
 * @param {number} row
 * @param {number} col
 */
export function adjacentFlags(game, row, col) {
  let flags = 0;
  for (const [r, c] of neighbours(game.board, row, col)) {
    if (cellAt(game.board, r, c).mark === 'flagged') flags++;
  }
  return flags;
}
