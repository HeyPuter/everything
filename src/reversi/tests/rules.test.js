import { describe, expect, it } from 'vitest';
import { BLACK, WHITE, createBoard, indexOf } from '../src/game/board.js';
import {
  applyMove,
  canMove,
  flipsAt,
  isLegalMove,
  legalMoves,
  nextTurnState,
  winnerOf,
} from '../src/game/rules.js';

describe('opening position', () => {
  it('starts with the classic four centre discs', () => {
    const board = createBoard();
    expect(board[indexOf(3, 3)]).toBe(WHITE);
    expect(board[indexOf(3, 4)]).toBe(BLACK);
    expect(board[indexOf(4, 3)]).toBe(BLACK);
    expect(board[indexOf(4, 4)]).toBe(WHITE);
  });

  it('gives black four legal opening moves', () => {
    const moves = legalMoves(createBoard(), BLACK);
    const keys = moves.map((m) => `${m.row},${m.col}`).sort();
    expect(keys).toEqual(['2,3', '3,2', '4,5', '5,4']);
  });
});

describe('flips and apply', () => {
  it('flips a sandwiched opponent disc', () => {
    const board = createBoard();
    // Black plays d3 (row 2, col 3): flips the white at d4.
    expect(isLegalMove(board, BLACK, 2, 3)).toBe(true);
    expect(flipsAt(board, BLACK, 2, 3)).toEqual([indexOf(3, 3)]);
    const next = applyMove(board, BLACK, 2, 3);
    expect(next[indexOf(2, 3)]).toBe(BLACK);
    expect(next[indexOf(3, 3)]).toBe(BLACK);
  });

  it('rejects empty squares that do not flip anything', () => {
    expect(isLegalMove(createBoard(), BLACK, 0, 0)).toBe(false);
    expect(() => applyMove(createBoard(), BLACK, 0, 0)).toThrow(/Illegal/);
  });
});

describe('pass and end', () => {
  it('passes when the opponent has no move but the player still does', () => {
    // Construct a board where white cannot move but black can.
    const board = Array(64).fill(0);
    // Fill most with black; leave a white pocket that black can flip into.
    for (let i = 0; i < 64; i++) board[i] = BLACK;
    board[indexOf(0, 0)] = 0;
    board[indexOf(0, 1)] = WHITE;
    // Black just moved; white has no move; black can still play 0,0.
    expect(canMove(board, WHITE)).toBe(false);
    expect(canMove(board, BLACK)).toBe(true);
    const state = nextTurnState(board, BLACK);
    expect(state).toEqual({ turn: BLACK, passed: true, over: false });
  });

  it('ends when neither side can move and reports the winner', () => {
    const board = Array(64).fill(BLACK);
    board[0] = WHITE;
    board[1] = WHITE;
    expect(canMove(board, BLACK)).toBe(false);
    expect(canMove(board, WHITE)).toBe(false);
    const state = nextTurnState(board, BLACK);
    expect(state.over).toBe(true);
    expect(winnerOf(board)).toBe('black');
  });

  it('detects a draw on equal disc counts', () => {
    const board = Array(64).fill(BLACK);
    for (let i = 0; i < 32; i++) board[i] = WHITE;
    expect(winnerOf(board)).toBe('draw');
  });
});
