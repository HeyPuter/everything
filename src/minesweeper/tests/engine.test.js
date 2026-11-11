import { describe, expect, it } from 'vitest';
import { cellAt, indexOf } from '../src/game/board.js';
import {
  checkWin,
  chord,
  createGame,
  ensureMines,
  minesRemaining,
  reveal,
  toggleFlag,
} from '../src/game/engine.js';

/** Place mines by mutating after ensureMines with a controlled layout. */
function plantLayout(game, mineCoords) {
  // Clear any previous placement state by rebuilding from ensureMines then
  // rewriting the mine map to the exact layout under test.
  ensureMines(game, 0, 0, () => 0);
  for (const cell of game.board.cells) {
    cell.mine = false;
    cell.adjacent = 0;
    cell.mark = 'hidden';
  }
  for (const [r, c] of mineCoords) {
    cellAt(game.board, r, c).mine = true;
  }
  for (let row = 0; row < game.board.rows; row++) {
    for (let col = 0; col < game.board.cols; col++) {
      const cell = cellAt(game.board, row, col);
      if (cell.mine) {
        cell.adjacent = 0;
        continue;
      }
      let n = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = row + dr;
          const nc = col + dc;
          if (nr < 0 || nc < 0 || nr >= game.board.rows || nc >= game.board.cols) continue;
          if (cellAt(game.board, nr, nc).mine) n++;
        }
      }
      cell.adjacent = n;
    }
  }
  game.board.mines = mineCoords.length;
  game.board.minesPlaced = true;
  game.status = 'playing';
  game.explodedIndex = null;
}

describe('first-click safety', () => {
  it('does not place mines until the first reveal', () => {
    const game = createGame('beginner');
    expect(game.board.minesPlaced).toBe(false);
    expect(game.status).toBe('ready');
  });

  it('never makes the first clicked cell a mine', () => {
    for (let seed = 0; seed < 20; seed++) {
      const game = createGame('beginner');
      let i = 0;
      const random = () => {
        i++;
        return ((seed * 17 + i * 13) % 1000) / 1000;
      };
      const row = seed % 9;
      const col = (seed * 3) % 9;
      reveal(game, row, col, random);
      expect(cellAt(game.board, row, col).mine).toBe(false);
      expect(game.status).not.toBe('lost');
      expect(cellAt(game.board, row, col).mark).toBe('revealed');
    }
  });
});

describe('reveal', () => {
  it('flood-fills contiguous zero cells', () => {
    const game = createGame('beginner');
    // One mine in the corner; the rest of the board should open from (8,8).
    plantLayout(game, [[0, 0]]);
    game.status = 'ready';
    reveal(game, 8, 8, () => 0);
    const revealed = game.board.cells.filter((c) => c.mark === 'revealed').length;
    expect(revealed).toBe(80); // every safe cell
    expect(cellAt(game.board, 0, 0).mark).toBe('hidden');
    expect(cellAt(game.board, 0, 1).mark).toBe('revealed'); // edge number 1
    expect(game.status).toBe('won');
  });

  it('loses when a mine is revealed and shows all mines', () => {
    const game = createGame('beginner');
    plantLayout(game, [
      [1, 1],
      [2, 2],
    ]);
    reveal(game, 1, 1, () => 0);
    expect(game.status).toBe('lost');
    expect(game.explodedIndex).toBe(indexOf(game.board, 1, 1));
    expect(cellAt(game.board, 1, 1).mark).toBe('revealed');
    expect(cellAt(game.board, 2, 2).mark).toBe('revealed');
  });

  it('ignores flagged and already-revealed cells', () => {
    const game = createGame('beginner');
    plantLayout(game, [[0, 0]]);
    toggleFlag(game, 4, 4);
    expect(reveal(game, 4, 4, () => 0)).toBe(false);
    reveal(game, 8, 8, () => 0);
    expect(reveal(game, 8, 8, () => 0)).toBe(false);
  });
});

describe('flag', () => {
  it('toggles a flag and updates the remaining counter', () => {
    const game = createGame('beginner');
    expect(minesRemaining(game)).toBe(10);
    toggleFlag(game, 0, 0);
    expect(cellAt(game.board, 0, 0).mark).toBe('flagged');
    expect(minesRemaining(game)).toBe(9);
    toggleFlag(game, 0, 0);
    expect(cellAt(game.board, 0, 0).mark).toBe('hidden');
    expect(minesRemaining(game)).toBe(10);
  });

  it('does not flag revealed cells or after the game ends', () => {
    const game = createGame('beginner');
    plantLayout(game, [[0, 0]]);
    // Reveal a numbered neighbour of the mine without flooding the board.
    cellAt(game.board, 0, 1).mark = 'revealed';
    expect(toggleFlag(game, 0, 1)).toBe(false);
    expect(game.status).toBe('playing');
    reveal(game, 0, 0, () => 0);
    expect(game.status).toBe('lost');
    expect(toggleFlag(game, 3, 3)).toBe(false);
  });
});

describe('chord', () => {
  it('reveals neighbours when adjacent flags match the number', () => {
    const game = createGame('beginner');
    // Mine at (0,0). Cell (0,1) has adjacent=1. Flag the mine, chord (0,1).
    plantLayout(game, [[0, 0]]);
    cellAt(game.board, 0, 1).mark = 'revealed';
    toggleFlag(game, 0, 0);
    expect(chord(game, 0, 1, () => 0)).toBe(true);
    expect(cellAt(game.board, 1, 0).mark).toBe('revealed');
    expect(cellAt(game.board, 1, 1).mark).toBe('revealed');
    expect(game.status).not.toBe('lost');
  });

  it('does nothing when the flag count does not match', () => {
    const game = createGame('beginner');
    plantLayout(game, [[0, 0]]);
    cellAt(game.board, 0, 1).mark = 'revealed';
    expect(chord(game, 0, 1, () => 0)).toBe(false);
  });

  it('loses if a chord opens an unflagged mine (misplaced flag)', () => {
    const game = createGame('beginner');
    // Mines at (0,0) and (0,2). Number at (0,1) is 2.
    // Flag only (1,1) wrongly; chord still fires because flags===2 if we also
    // flag (1,0) — wait, need exactly 2 flags. Flag wrong cells (1,0) and (1,1).
    plantLayout(game, [
      [0, 0],
      [0, 2],
    ]);
    cellAt(game.board, 0, 1).mark = 'revealed';
    expect(cellAt(game.board, 0, 1).adjacent).toBe(2);
    toggleFlag(game, 1, 0);
    toggleFlag(game, 1, 1);
    expect(chord(game, 0, 1, () => 0)).toBe(true);
    expect(game.status).toBe('lost');
  });
});

describe('win detection', () => {
  it('wins when every non-mine cell is revealed', () => {
    const game = createGame('beginner');
    plantLayout(game, [[0, 0]]);
    for (let i = 1; i < game.board.cells.length; i++) {
      const cell = game.board.cells[i];
      if (!cell.mine) cell.mark = 'revealed';
    }
    expect(checkWin(game)).toBe(true);
    // One last reveal path through the API:
    const g2 = createGame('beginner');
    plantLayout(g2, [[0, 0]]);
    reveal(g2, 8, 8, () => 0);
    // Flood from a far corner should open almost everything on a 1-mine board.
    if (g2.status !== 'won') {
      for (let row = 0; row < g2.board.rows; row++) {
        for (let col = 0; col < g2.board.cols; col++) {
          if (row === 0 && col === 0) continue;
          if (cellAt(g2.board, row, col).mark === 'hidden') {
            reveal(g2, row, col, () => 0);
          }
        }
      }
    }
    expect(g2.status).toBe('won');
  });
});
