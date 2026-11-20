import { describe, it, expect } from 'vitest';
import { Chess } from '../src/engine/chess.js';

const play = (game, ...moves) => {
  for (const [from, to] of moves) {
    expect(game.move({ from, to })).not.toBe(null);
  }
};

describe('basic move legality', () => {
  it('has 20 legal moves at the start', () => {
    expect(new Chess().moves()).toHaveLength(20);
  });

  it('rejects illegal moves', () => {
    const game = new Chess();
    expect(game.move({ from: 'e2', to: 'e5' })).toBe(null);
    expect(game.move({ from: 'e7', to: 'e5' })).toBe(null); // not black's turn
    expect(game.move({ from: 'e4', to: 'e5' })).toBe(null); // empty square
    expect(game.fen()).toBe(new Chess().fen()); // nothing changed
  });

  it('does not allow moving into check', () => {
    // Black king would walk next to the white king / into the rook's file.
    const game = new Chess('4k3/8/8/8/8/8/8/4KR2 b - - 0 1');
    const targets = game.moves({ square: 'e8' }).map((m) => m.to);
    expect(targets).not.toContain('f8'); // rook's file
    expect(targets).toContain('d8');
  });

  it('forces resolving check', () => {
    const game = new Chess('4k3/8/8/8/7b/8/8/R3K3 b - - 0 1');
    game.move({ from: 'h4', to: 'e7' }); // discovered nothing, just reposition
    const check = new Chess('4k3/4R3/8/8/8/8/8/4K3 b - - 0 1');
    expect(check.inCheck()).toBe(true);
    // Every legal reply must leave the king out of check.
    for (const m of check.moves()) {
      check.move(m);
      check.undo();
    }
    const replies = check.moves().map((m) => `${m.from}${m.to}`);
    expect(replies).toContain('e8e7'); // capture the rook
    expect(replies).not.toContain('e8e8');
  });
});

describe('en passant', () => {
  it('allows the capture only immediately after a double push', () => {
    const game = new Chess();
    play(game, ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
    const ep = game.moves({ square: 'e5' }).find((m) => m.flags === 'e');
    expect(ep).toBeDefined();
    expect(ep.to).toBe('d6');
    expect(game.move({ from: 'e5', to: 'd6' })).not.toBe(null);
    expect(game.get('d5')).toBe(null); // the pawn is gone
    expect(game.get('d6')).toBe('P');
  });

  it('expires after one move', () => {
    const game = new Chess();
    play(
      game,
      ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5'],
      ['h2', 'h3'], ['a6', 'a5'],
    );
    expect(game.moves({ square: 'e5' }).find((m) => m.flags === 'e')).toBeUndefined();
  });

  it('is illegal when it exposes the king', () => {
    // Rook on h4 pins both pawns' rank: exd3 would expose the black king on a4.
    const game = new Chess('8/8/8/8/k2Pp2R/8/8/4K3 b - d3 0 1');
    const targets = game.moves({ square: 'e4' }).map((m) => m.to);
    expect(targets).not.toContain('d3');
    expect(targets).toContain('e3');
  });
});

describe('castling', () => {
  it('generates both castling moves when legal', () => {
    const game = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const kingMoves = game.moves({ square: 'e1' }).map((m) => m.to);
    expect(kingMoves).toContain('g1');
    expect(kingMoves).toContain('c1');
    const move = game.move({ from: 'e1', to: 'g1' });
    expect(move.san).toBe('O-O');
    expect(game.get('f1')).toBe('R'); // rook jumped over
    expect(game.get('h1')).toBe(null);
  });

  it('forbids castling through an attacked square', () => {
    // Black rook on f3 covers f1: kingside is out, queenside is fine.
    const game = new Chess('r3k2r/8/8/8/8/5r2/8/R3K2R w KQkq - 0 1');
    const kingMoves = game.moves({ square: 'e1' }).map((m) => m.to);
    expect(kingMoves).not.toContain('g1');
    expect(kingMoves).toContain('c1');
  });

  it('forbids castling while in check', () => {
    const game = new Chess('r3k2r/8/8/8/8/4r3/8/R3K2R w KQkq - 0 1');
    expect(game.inCheck()).toBe(true);
    const kingMoves = game.moves({ square: 'e1' }).map((m) => m.to);
    expect(kingMoves).not.toContain('g1');
    expect(kingMoves).not.toContain('c1');
  });

  it('forbids castling through pieces', () => {
    const game = new Chess(); // everything still at home
    expect(game.moves({ square: 'e1' })).toHaveLength(0);
  });

  it('loses the right after the king moves', () => {
    const game = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    play(game, ['e1', 'e2'], ['a8', 'a7'], ['e2', 'e1'], ['a7', 'a8']);
    const kingMoves = game.moves({ square: 'e1' }).map((m) => m.to);
    expect(kingMoves).not.toContain('g1');
    expect(kingMoves).not.toContain('c1');
  });

  it('loses the right after the rook is captured', () => {
    const game = new Chess('r3k2r/8/8/8/8/8/6b1/R3K2R b KQkq - 0 1');
    play(game, ['g2', 'h1']); // bishop takes the h1 rook
    expect(game.fen()).toContain(' Qkq '); // white kingside right gone
  });
});

describe('promotion', () => {
  it('offers all four promotion pieces', () => {
    const game = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    const promos = game.moves({ square: 'a7' }).map((m) => m.promotion);
    expect(promos.sort()).toEqual(['b', 'n', 'q', 'r']);
  });

  it('promotes to the chosen piece', () => {
    const game = new Chess('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    const move = game.move({ from: 'a7', to: 'a8', promotion: 'n' });
    expect(move.san).toBe('a8=N');
    expect(game.get('a8')).toBe('N');
  });

  it('promotes on capture', () => {
    const game = new Chess('3r3k/4P3/8/8/8/8/8/4K3 w - - 0 1');
    const move = game.move({ from: 'e7', to: 'd8', promotion: 'q' });
    expect(move.san).toBe('exd8=Q+');
    expect(game.get('d8')).toBe('Q');
    expect(game.inCheck()).toBe(true);
  });
});

describe('game end detection', () => {
  it("detects fool's mate", () => {
    const game = new Chess();
    play(game, ['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4']);
    const mate = game.move({ from: 'd8', to: 'h4' });
    expect(mate.san).toBe('Qh4#');
    expect(game.isCheckmate()).toBe(true);
    expect(game.isGameOver()).toBe(true);
    expect(game.status()).toMatchObject({
      over: true,
      result: '0-1',
      reason: 'checkmate',
    });
  });

  it('detects a back-rank mate for white', () => {
    const game = new Chess('7k/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    const move = game.move({ from: 'a1', to: 'a8' });
    expect(move.san).toBe('Ra8#');
    expect(game.status().result).toBe('1-0');
  });

  it('detects stalemate', () => {
    const game = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
    expect(game.inCheck()).toBe(false);
    expect(game.isStalemate()).toBe(true);
    expect(game.isDraw()).toBe(true);
    expect(game.status()).toMatchObject({ result: '1/2-1/2', reason: 'stalemate' });
  });

  it('detects the fifty-move rule', () => {
    const game = new Chess('7k/8/8/8/8/8/8/R6K w - - 99 80');
    expect(game.isFiftyMoveRule()).toBe(false);
    game.move({ from: 'a1', to: 'a2' });
    expect(game.isFiftyMoveRule()).toBe(true);
    expect(game.status().reason).toBe('fifty-move rule');
  });

  it('resets the fifty-move counter on captures and pawn moves', () => {
    const game = new Chess();
    game.move({ from: 'g1', to: 'f3' });
    expect(game.fen().split(' ')[4]).toBe('1');
    game.move({ from: 'e7', to: 'e5' });
    expect(game.fen().split(' ')[4]).toBe('0');
  });

  it('detects threefold repetition', () => {
    const game = new Chess();
    const shuffle = [
      ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8'],
      ['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8'],
    ];
    for (const [from, to] of shuffle) {
      expect(game.isThreefoldRepetition()).toBe(false);
      game.move({ from, to });
    }
    expect(game.isThreefoldRepetition()).toBe(true);
    expect(game.status().reason).toBe('threefold repetition');
  });

  it('detects insufficient material', () => {
    expect(new Chess('k7/8/8/8/8/8/8/K7 w - - 0 1').isInsufficientMaterial()).toBe(true);
    expect(new Chess('k7/8/8/8/8/8/8/K5B1 w - - 0 1').isInsufficientMaterial()).toBe(true);
    expect(new Chess('k7/8/8/8/8/8/8/K5N1 w - - 0 1').isInsufficientMaterial()).toBe(true);
    // Same-colored bishops (both on dark squares).
    expect(new Chess('k7/8/8/8/5b2/8/8/K1B5 w - - 0 1').isInsufficientMaterial()).toBe(true);
    // Opposite-colored bishops can still mate.
    expect(new Chess('k7/8/8/8/4b3/8/8/K1B5 w - - 0 1').isInsufficientMaterial()).toBe(false);
    expect(new Chess('k7/8/8/8/8/8/8/K5R1 w - - 0 1').isInsufficientMaterial()).toBe(false);
    expect(new Chess('k7/p7/8/8/8/8/8/K7 w - - 0 1').isInsufficientMaterial()).toBe(false);
  });
});

describe('undo', () => {
  it('restores the exact position, including counters', () => {
    const game = new Chess();
    const snapshots = [game.fen()];
    const moves = [
      ['e2', 'e4'], ['e7', 'e5'], ['g1', 'f3'], ['b8', 'c6'], ['f1', 'b5'],
    ];
    for (const [from, to] of moves) {
      game.move({ from, to });
      snapshots.push(game.fen());
    }
    for (let i = moves.length; i > 0; i--) {
      expect(game.fen()).toBe(snapshots[i]);
      expect(game.undo()).not.toBe(null);
    }
    expect(game.fen()).toBe(snapshots[0]);
    expect(game.undo()).toBe(null);
  });

  it('restores captured pieces, castling and en passant state', () => {
    const game = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
    const before = game.fen();
    game.move({ from: 'e1', to: 'g1' });
    game.undo();
    expect(game.fen()).toBe(before);

    const ep = new Chess();
    play(ep, ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5']);
    const beforeEp = ep.fen();
    ep.move({ from: 'e5', to: 'd6' });
    ep.undo();
    expect(ep.fen()).toBe(beforeEp);
    expect(ep.get('d5')).toBe('p');
  });

  it('keeps repetition counting consistent across undo', () => {
    const game = new Chess();
    const cycle = [['g1', 'f3'], ['g8', 'f6'], ['f3', 'g1'], ['f6', 'g8']];
    for (let rep = 0; rep < 2; rep++) {
      for (const [from, to] of cycle) game.move({ from, to });
    }
    expect(game.isThreefoldRepetition()).toBe(true);
    game.undo();
    expect(game.isThreefoldRepetition()).toBe(false);
  });
});

// Used by the flag-fall rule: running out of time is only a loss if the
// opponent could still mate with what they have left.
describe('mating material', () => {
  const material = (fen, color) => new Chess(fen).hasMatingMaterial(color);

  it('a lone king cannot mate', () => {
    expect(material('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'w')).toBe(false);
    expect(material('4k3/8/8/8/8/8/8/4K3 w - - 0 1', 'b')).toBe(false);
  });

  it('a king and one minor piece cannot mate', () => {
    expect(material('4k3/8/8/8/8/8/8/4KB2 w - - 0 1', 'w')).toBe(false);
    expect(material('4k3/8/8/8/8/8/8/4KN2 w - - 0 1', 'w')).toBe(false);
  });

  it('two knights or opposite-colored bishops are enough', () => {
    expect(material('4k3/8/8/8/8/8/8/3NKN2 w - - 0 1', 'w')).toBe(true);
    // Bishops on c1 and f1 (opposite colors).
    expect(material('4k3/8/8/8/8/8/8/2B1KB2 w - - 0 1', 'w')).toBe(true);
  });

  it('same-colored bishops alone cannot mate', () => {
    // Bishops on d1 and f1 share a square color.
    expect(material('4k3/8/8/8/8/8/8/3BKB2 w - - 0 1', 'w')).toBe(false);
    // White bishops on a3 and c1 (same color); Black has a pawn so the
    // position is not a draw by insufficient material, but White still
    // cannot mate — flag-fall must be a draw (FIDE 6.9).
    const fen = 'k7/p7/8/8/8/B7/8/2B4K w - - 0 1';
    const game = new Chess(fen);
    expect(game.isInsufficientMaterial()).toBe(false);
    expect(game.hasMatingMaterial('w')).toBe(false);
  });

  it('a pawn, a rook or a queen is always enough', () => {
    expect(material('4k3/8/8/8/8/8/4P3/4K3 w - - 0 1', 'w')).toBe(true);
    expect(material('4k3/8/8/8/8/8/8/4K2R w - - 0 1', 'w')).toBe(true);
    expect(material('4k3/8/8/8/8/8/8/3QK3 w - - 0 1', 'w')).toBe(true);
  });

  it('counts each side separately', () => {
    // White has a rook, Black only a bishop.
    const fen = '3bk3/8/8/8/8/8/8/4K2R w - - 0 1';
    expect(material(fen, 'w')).toBe(true);
    expect(material(fen, 'b')).toBe(false);
  });
});
