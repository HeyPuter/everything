/**
 * Board generation and neighbour maths. Pure: no DOM, no storage.
 *
 * Mines are placed only after the first reveal so that click can be excluded
 * from the mine set (classic first-click safety).
 */

import { getDifficulty } from './difficulties.js';

/** @typedef {'hidden' | 'revealed' | 'flagged'} CellMark */

/**
 * @typedef {object} Cell
 * @property {boolean} mine
 * @property {number} adjacent  Count of neighbouring mines (0–8).
 * @property {CellMark} mark
 */

/**
 * @typedef {object} Board
 * @property {number} rows
 * @property {number} cols
 * @property {number} mines
 * @property {Cell[]} cells  Row-major flat array, length rows * cols.
 * @property {boolean} minesPlaced
 */

/**
 * @param {string} difficultyId
 * @returns {Board}
 */
export function createEmptyBoard(difficultyId) {
  const { rows, cols, mines } = getDifficulty(difficultyId);
  const cells = Array.from({ length: rows * cols }, () => ({
    mine: false,
    adjacent: 0,
    mark: /** @type {CellMark} */ ('hidden'),
  }));
  return { rows, cols, mines, cells, minesPlaced: false };
}

/** @param {Board} board @param {number} row @param {number} col */
export function inBounds(board, row, col) {
  return row >= 0 && col >= 0 && row < board.rows && col < board.cols;
}

/** @param {Board} board @param {number} row @param {number} col */
export function indexOf(board, row, col) {
  return row * board.cols + col;
}

/** @param {Board} board @param {number} index */
export function coordsOf(board, index) {
  return { row: Math.floor(index / board.cols), col: index % board.cols };
}

/** @param {Board} board @param {number} row @param {number} col */
export function cellAt(board, row, col) {
  if (!inBounds(board, row, col)) return null;
  return board.cells[indexOf(board, row, col)];
}

/**
 * Yield [row, col] for the up-to-eight neighbours of a cell.
 * @param {Board} board
 * @param {number} row
 * @param {number} col
 * @returns {Generator<[number, number]>}
 */
export function* neighbours(board, row, col) {
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const r = row + dr;
      const c = col + dc;
      if (inBounds(board, r, c)) yield [r, c];
    }
  }
}

/**
 * Place `board.mines` mines uniformly at random, never on any index in
 * `forbidden`. Then fill each cell's adjacent-mine count.
 *
 * @param {Board} board
 * @param {Iterable<number>} forbidden  Flat indices that must stay clear.
 * @param {() => number} [random]  Returns [0, 1). Injectable for tests.
 */
export function placeMines(board, forbidden, random = Math.random) {
  if (board.minesPlaced) {
    throw new Error('Mines are already placed on this board');
  }

  const blocked = new Set(forbidden);
  const candidates = [];
  for (let i = 0; i < board.cells.length; i++) {
    if (!blocked.has(i)) candidates.push(i);
  }

  if (board.mines > candidates.length) {
    throw new Error(
      `Cannot place ${board.mines} mines: only ${candidates.length} safe cells`,
    );
  }

  // Fisher–Yates partial shuffle: pick the first `mines` of a shuffled list.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = candidates[i];
    candidates[i] = candidates[j];
    candidates[j] = tmp;
  }

  for (let i = 0; i < board.mines; i++) {
    board.cells[candidates[i]].mine = true;
  }

  for (let row = 0; row < board.rows; row++) {
    for (let col = 0; col < board.cols; col++) {
      const cell = cellAt(board, row, col);
      if (cell.mine) {
        cell.adjacent = 0;
        continue;
      }
      let count = 0;
      for (const [r, c] of neighbours(board, row, col)) {
        if (cellAt(board, r, c).mine) count++;
      }
      cell.adjacent = count;
    }
  }

  board.minesPlaced = true;
  return board;
}

/**
 * Count flagged cells and revealed non-mine cells.
 * @param {Board} board
 */
export function boardStats(board) {
  let flags = 0;
  let revealed = 0;
  let exploded = false;
  for (const cell of board.cells) {
    if (cell.mark === 'flagged') flags++;
    if (cell.mark === 'revealed') {
      revealed++;
      if (cell.mine) exploded = true;
    }
  }
  return { flags, revealed, exploded };
}
