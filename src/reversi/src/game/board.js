/**
 * Reversi / Othello board primitives. DOCUMENTED public rules: 8×8 grid,
 * opening four discs in the centre, eight ray directions.
 */

export const SIZE = 8;
export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

/** @typedef {0 | 1 | 2} Cell */
/** @typedef {1 | 2} Player */

export const DIRECTIONS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

export function opponent(player) {
  return player === BLACK ? WHITE : BLACK;
}

/** Fresh opening position: white on d4/e5, black on e4/d5 (0-indexed). */
export function createBoard() {
  /** @type {Cell[]} */
  const cells = Array(SIZE * SIZE).fill(EMPTY);
  cells[indexOf(3, 3)] = WHITE;
  cells[indexOf(3, 4)] = BLACK;
  cells[indexOf(4, 3)] = BLACK;
  cells[indexOf(4, 4)] = WHITE;
  return cells;
}

export function indexOf(row, col) {
  return row * SIZE + col;
}

export function inBounds(row, col) {
  return row >= 0 && col >= 0 && row < SIZE && col < SIZE;
}

/** @param {Cell[]} board */
export function cloneBoard(board) {
  return board.slice();
}

/** @param {Cell[]} board */
export function countDiscs(board) {
  let black = 0;
  let white = 0;
  for (const cell of board) {
    if (cell === BLACK) black++;
    else if (cell === WHITE) white++;
  }
  return { black, white, empty: SIZE * SIZE - black - white };
}
