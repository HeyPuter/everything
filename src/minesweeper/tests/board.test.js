import { describe, expect, it } from 'vitest';
import {
  boardStats,
  cellAt,
  createEmptyBoard,
  indexOf,
  neighbours,
  placeMines,
} from '../src/game/board.js';
import { DIFFICULTIES } from '../src/game/difficulties.js';

/** Deterministic sequence of [0,1) values cycling through `values`. */
function seqRandom(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

describe('createEmptyBoard', () => {
  it('matches classic beginner dimensions', () => {
    const board = createEmptyBoard('beginner');
    expect(board.rows).toBe(9);
    expect(board.cols).toBe(9);
    expect(board.mines).toBe(10);
    expect(board.cells).toHaveLength(81);
    expect(board.minesPlaced).toBe(false);
    expect(board.cells.every((c) => !c.mine && c.mark === 'hidden')).toBe(true);
  });

  it('matches classic intermediate and expert sizes', () => {
    const mid = createEmptyBoard('intermediate');
    expect(mid).toMatchObject({ rows: 16, cols: 16, mines: 40 });
    expect(mid.cells).toHaveLength(256);

    const expert = createEmptyBoard('expert');
    expect(expert).toMatchObject({ rows: 16, cols: 30, mines: 99 });
    expect(expert.cells).toHaveLength(480);
  });
});

describe('placeMines', () => {
  it('places exactly the configured mine count', () => {
    const board = createEmptyBoard('beginner');
    placeMines(board, [], () => 0.5);
    const mines = board.cells.filter((c) => c.mine).length;
    expect(mines).toBe(DIFFICULTIES.beginner.mines);
    expect(board.minesPlaced).toBe(true);
  });

  it('never places a mine on a forbidden index (first-click cell)', () => {
    const board = createEmptyBoard('beginner');
    const safe = indexOf(board, 4, 4);
    placeMines(board, [safe], seqRandom([0.01, 0.99, 0.25, 0.75]));
    expect(board.cells[safe].mine).toBe(false);
  });

  it('computes adjacent counts from placed mines', () => {
    const board = createEmptyBoard('beginner');
    // Force mines onto the first 10 candidate cells by always swapping with 0.
    placeMines(board, [], () => 0);
    const mineCount = board.cells.filter((c) => c.mine).length;
    expect(mineCount).toBe(10);

    for (let row = 0; row < board.rows; row++) {
      for (let col = 0; col < board.cols; col++) {
        const cell = cellAt(board, row, col);
        if (cell.mine) continue;
        let expected = 0;
        for (const [r, c] of neighbours(board, row, col)) {
          if (cellAt(board, r, c).mine) expected++;
        }
        expect(cell.adjacent).toBe(expected);
      }
    }
  });

  it('refuses a second placement on the same board', () => {
    const board = createEmptyBoard('beginner');
    placeMines(board, [], () => 0.3);
    expect(() => placeMines(board, [], () => 0.3)).toThrow(/already placed/);
  });
});

describe('boardStats', () => {
  it('counts flags and revealed cells', () => {
    const board = createEmptyBoard('beginner');
    board.cells[0].mark = 'flagged';
    board.cells[1].mark = 'revealed';
    expect(boardStats(board)).toEqual({ flags: 1, revealed: 1, exploded: false });
  });
});
