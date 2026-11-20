import { describe, expect, it } from 'vitest';
import { BLACK, WHITE } from '../src/game/board.js';
import { createGame, currentLegalMoves, isAiTurn, play, scores } from '../src/game/engine.js';
import { chooseMove } from '../src/game/ai.js';
import { legalMoves } from '../src/game/rules.js';

describe('engine', () => {
  it('plays a legal opening move and switches to white', () => {
    const game = createGame();
    expect(play(game, 2, 3)).toBe(true);
    expect(game.turn).toBe(WHITE);
    expect(scores(game).black).toBe(4);
    expect(scores(game).white).toBe(1);
  });

  it('rejects illegal placements', () => {
    const game = createGame();
    expect(play(game, 0, 0)).toBe(false);
    expect(game.turn).toBe(BLACK);
  });

  it('lists current legal moves for the side to play', () => {
    const game = createGame();
    expect(currentLegalMoves(game)).toHaveLength(4);
  });

  it('marks AI turns correctly', () => {
    const game = createGame({ mode: 'ai', human: BLACK });
    expect(isAiTurn(game)).toBe(false);
    play(game, 2, 3);
    expect(isAiTurn(game)).toBe(true);
  });
});

describe('ai', () => {
  it('returns one of the legal opening replies for white', () => {
    const game = createGame();
    play(game, 2, 3);
    const move = chooseMove(game.board, WHITE, () => 0);
    expect(move).not.toBeNull();
    const legal = legalMoves(game.board, WHITE);
    expect(legal.some((m) => m.row === move.row && m.col === move.col)).toBe(true);
  });

  it('returns null when there are no moves', () => {
    const board = Array(64).fill(BLACK);
    expect(chooseMove(board, WHITE)).toBeNull();
  });
});
