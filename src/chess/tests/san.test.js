import { describe, it, expect } from 'vitest';
import { Chess } from '../src/engine/chess.js';

describe('SAN notation', () => {
  it('writes pawn moves and captures', () => {
    const game = new Chess();
    expect(game.move({ from: 'e2', to: 'e4' }).san).toBe('e4');
    expect(game.move({ from: 'd7', to: 'd5' }).san).toBe('d5');
    expect(game.move({ from: 'e4', to: 'd5' }).san).toBe('exd5');
  });

  it('writes piece moves and captures', () => {
    const game = new Chess();
    game.move({ from: 'e2', to: 'e4' });
    game.move({ from: 'd7', to: 'd5' });
    expect(game.move({ from: 'g1', to: 'f3' }).san).toBe('Nf3');
    expect(game.move({ from: 'd5', to: 'e4' }).san).toBe('dxe4');
    expect(game.move({ from: 'f3', to: 'g5' }).san).toBe('Ng5');
  });

  it('writes castling', () => {
    const game = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(game.move({ from: 'e1', to: 'g1' }).san).toBe('O-O');
    expect(game.move({ from: 'e8', to: 'c8' }).san).toBe('O-O-O');
  });

  it('disambiguates by file', () => {
    // Knights on b1 and f3 can both reach d2.
    const game = new Chess('k7/8/8/8/8/5N2/8/1N2K3 w - - 0 1');
    expect(game.move({ from: 'b1', to: 'd2' }).san).toBe('Nbd2');
  });

  it('disambiguates by rank', () => {
    // Rooks on a1 and a5 can both reach a3.
    const game = new Chess('7k/8/8/R7/8/8/8/R3K3 w - - 0 1');
    expect(game.move({ from: 'a1', to: 'a3' }).san).toBe('R1a3');
  });

  it('marks checks and mates', () => {
    const check = new Chess('k7/8/8/8/8/8/1R6/K7 w - - 0 1');
    expect(check.move({ from: 'b2', to: 'b8' }).san).toBe('Rb8+');

    const mate = new Chess('7k/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    expect(mate.move({ from: 'a1', to: 'a8' }).san).toBe('Ra8#');
  });

  it('writes promotions with checks', () => {
    const game = new Chess('3r3k/4P3/8/8/8/8/8/4K3 w - - 0 1');
    expect(game.move({ from: 'e7', to: 'd8', promotion: 'q' }).san).toBe('exd8=Q+');
  });

  it('records history in order', () => {
    const game = new Chess();
    game.move({ from: 'e2', to: 'e4' });
    game.move({ from: 'e7', to: 'e5' });
    game.move({ from: 'g1', to: 'f3' });
    expect(game.history().map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);
  });
});

describe('playing SAN', () => {
  it('replays a string the same way as the coordinate form', () => {
    const bySan = new Chess();
    const bySquares = new Chess();
    for (const [san, from, to] of [
      ['e4', 'e2', 'e4'],
      ['e5', 'e7', 'e5'],
      ['Nf3', 'g1', 'f3'],
    ]) {
      expect(bySan.move(san).san).toBe(san);
      expect(bySquares.move({ from, to }).san).toBe(san);
    }
    expect(bySan.fen()).toBe(bySquares.fen());
  });

  it('accepts zeros for castling and ignores check marks', () => {
    const game = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    expect(game.move('0-0').san).toBe('O-O');
    expect(game.move('O-O-O+').san).toBe('O-O-O');
  });

  it('accepts a promotion written without the equals, and UCI coordinates', () => {
    const equals = new Chess('7k/4P3/8/8/8/8/8/4K3 w - - 0 1');
    expect(equals.move('e8Q').san).toBe('e8=Q+');
    const uci = new Chess('7k/4P3/8/8/8/8/8/4K3 w - - 0 1');
    expect(uci.move('e7e8q').san).toBe('e8=Q+');
  });

  it('returns null for an empty token, an illegal move, or a typo', () => {
    const game = new Chess();
    expect(game.move('')).toBe(null);
    expect(game.move('e5')).toBe(null);
    expect(game.move('Nf4')).toBe(null);
    expect(game.history()).toEqual([]);
  });
});
