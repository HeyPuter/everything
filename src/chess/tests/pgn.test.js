import { describe, it, expect } from 'vitest';
import { buildPgn, parsePgn, replayPgn, pgnDate, pgnFilename } from '../src/game/pgn.js';
import { Chess } from '../src/engine/chess.js';

const DATE = new Date(2026, 7, 11, 14, 32); // 11 August 2026, local time

const base = {
  sans: ['e4', 'e5'],
  result: '*',
  white: 'Player',
  black: 'Computer (Hard)',
  date: DATE,
};

/** The tag pairs of a PGN, as an ordered list of [key, value]. */
function tags(pgn) {
  return [...pgn.matchAll(/^\[(\w+) "(.*)"\]$/gm)].map((m) => [m[1], m[2]]);
}

function moveText(pgn) {
  return pgn.split('\n\n')[1].trim();
}

describe('tag pairs', () => {
  it('carries the mandatory seven-tag roster, in order', () => {
    const keys = tags(buildPgn(base)).map(([key]) => key);
    expect(keys.slice(0, 7)).toEqual([
      'Event', 'Site', 'Date', 'Round', 'White', 'Black', 'Result',
    ]);
  });

  it('writes the players and the result', () => {
    const pgn = buildPgn({ ...base, result: '1-0' });
    expect(pgn).toContain('[White "Player"]');
    expect(pgn).toContain('[Black "Computer (Hard)"]');
    expect(pgn).toContain('[Result "1-0"]');
  });

  it('formats the date as YYYY.MM.DD', () => {
    expect(pgnDate(DATE)).toBe('2026.08.11');
    expect(buildPgn(base)).toContain('[Date "2026.08.11"]');
  });

  it('writes the time control in seconds, or "-" when untimed', () => {
    expect(buildPgn(base)).toContain('[TimeControl "-"]');
    expect(
      buildPgn({ ...base, control: { initial: 300000, increment: 3000 } }),
    ).toContain('[TimeControl "300+3"]');
    expect(
      buildPgn({ ...base, control: { initial: 60000, increment: 0 } }),
    ).toContain('[TimeControl "60+0"]');
  });

  it('spells out a termination only when it was not a normal one', () => {
    expect(buildPgn(base)).not.toContain('Termination');
    expect(buildPgn({ ...base, termination: 'normal' })).not.toContain('Termination');
    expect(buildPgn({ ...base, termination: 'time forfeit' })).toContain(
      '[Termination "time forfeit"]',
    );
  });

  it('escapes quotes and backslashes in a name off the wire', () => {
    const pgn = buildPgn({ ...base, black: 'a"b\\c' });
    expect(pgn).toContain('[Black "a\\"b\\\\c"]');
  });

  it('caps a long name without splitting an escape in half', () => {
    // A cap applied to the escaped text can fall between a backslash and the
    // character it escapes, leaving a tag that ends on a dangling escape.
    const pgn = buildPgn({ ...base, black: `${'a'.repeat(119)}"` });
    const [, value] = tags(pgn).find(([key]) => key === 'Black');
    expect(value).toBe(`${'a'.repeat(119)}\\"`);
    expect(value.endsWith('\\')).toBe(false);
  });

  it('keeps a name with newlines on one line', () => {
    const pgn = buildPgn({ ...base, black: 'first\nsecond' });
    expect(pgn).toContain('[Black "first second"]');
    // One tag per line, and no stray line the parser would choke on.
    expect(pgn.split('\n').filter((line) => line.startsWith('['))).toHaveLength(8);
  });
});

describe('movetext', () => {
  it('numbers moves in pairs and ends with the result', () => {
    const pgn = buildPgn({ ...base, sans: ['e4', 'e5', 'Nf3', 'Nc6'], result: '1-0' });
    expect(moveText(pgn)).toBe('1. e4 e5 2. Nf3 Nc6 1-0');
  });

  it('numbers a game that ends on White’s move', () => {
    const pgn = buildPgn({ ...base, sans: ['e4', 'e5', 'Qh5'], result: '*' });
    expect(moveText(pgn)).toBe('1. e4 e5 2. Qh5 *');
  });

  it('is just the result when no moves were played', () => {
    expect(moveText(buildPgn({ ...base, sans: [], result: '*' }))).toBe('*');
  });

  it('wraps movetext at 80 columns', () => {
    const sans = Array.from({ length: 120 }, (_, i) => (i % 2 ? 'Nf6' : 'Nf3'));
    const lines = moveText(buildPgn({ ...base, sans, result: '1/2-1/2' })).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(80);
    // Nothing is lost or split across the wrap.
    expect(lines.join(' ').split(/\s+/).filter((t) => t === 'Nf3')).toHaveLength(60);
  });

  it('ends with a newline, as PGN readers expect', () => {
    expect(buildPgn(base).endsWith('\n')).toBe(true);
  });
});

describe('a real game', () => {
  it('exports a game played through the engine', () => {
    // Scholar's mate, so the export includes a check, a capture and a mate.
    const game = new Chess();
    for (const [from, to] of [
      ['e2', 'e4'], ['e7', 'e5'],
      ['f1', 'c4'], ['b8', 'c6'],
      ['d1', 'h5'], ['g8', 'f6'],
      ['h5', 'f7'],
    ]) {
      expect(game.move({ from, to })).not.toBe(null);
    }
    expect(game.isCheckmate()).toBe(true);
    const pgn = buildPgn({
      ...base,
      sans: game.history().map((m) => m.san),
      result: game.status().result,
    });
    expect(moveText(pgn)).toBe('1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0');
    expect(pgn).toContain('[Result "1-0"]');
  });
});

describe('pgnFilename', () => {
  it('names the file after the date and time', () => {
    expect(pgnFilename(DATE)).toBe('chess-20260811-1432.pgn');
  });
});

describe('parsePgn', () => {
  it('reads tags, numbered moves, and the result', () => {
    const parsed = parsePgn(`[Event "Casual game"]
[White "Ada"]
[Black "Charles"]
[Result "1-0"]

1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6 4. Qxf7# 1-0
`);
    expect(parsed.error).toBeUndefined();
    expect(parsed.tags.White).toBe('Ada');
    expect(parsed.tags.Black).toBe('Charles');
    expect(parsed.sans).toEqual(['e4', 'e5', 'Bc4', 'Nc6', 'Qh5', 'Nf6', 'Qxf7#']);
    expect(parsed.result).toBe('1-0');
    expect(parsed.fen).toBe(null);
  });

  it('strips comments, NAGs, and a variation, and keeps a FEN start', () => {
    const parsed = parsePgn(`[FEN "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"]
[SetUp "1"]
[Result "*"]

2. Nf3 {develop} Nc6 $1 (2... d6 3. d4) 3. Bb5 *
`);
    expect(parsed.fen).toContain('4p3/4P3');
    expect(parsed.sans).toEqual(['Nf3', 'Nc6', 'Bb5']);
    expect(parsed.result).toBe('*');
  });

  it('accepts a number glued to its move, and only the first game', () => {
    const parsed = parsePgn('1.e4 e5 2.Nf3 Nc6 1-0\n\n[Event "Two"]\n\n1. d4 d5 0-1\n');
    expect(parsed.sans).toEqual(['e4', 'e5', 'Nf3', 'Nc6']);
    expect(parsed.result).toBe('1-0');
  });

  it('rejects an empty paste', () => {
    expect(parsePgn('').error).toMatch(/Paste a PGN/);
    expect(parsePgn('   \n').error).toMatch(/Paste a PGN/);
  });
});

describe('replayPgn', () => {
  it('replays an exported game back to the same position', () => {
    const original = new Chess();
    for (const [from, to] of [
      ['e2', 'e4'], ['e7', 'e5'],
      ['f1', 'c4'], ['b8', 'c6'],
      ['d1', 'h5'], ['g8', 'f6'],
      ['h5', 'f7'],
    ]) {
      original.move({ from, to });
    }
    const pgn = buildPgn({
      ...base,
      sans: original.history().map((m) => m.san),
      result: original.status().result,
    });
    const copy = new Chess();
    const replayed = replayPgn(parsePgn(pgn), copy);
    expect(replayed.ok).toBe(true);
    expect(copy.fen()).toBe(original.fen());
    expect(copy.history().map((m) => m.san)).toEqual(original.history().map((m) => m.san));
    expect(copy.isCheckmate()).toBe(true);
  });

  it('loads a FEN start and plays from there', () => {
    const parsed = parsePgn(`[FEN "4k3/8/8/8/8/8/4P3/4K3 w - - 0 1"]
[SetUp "1"]
[Result "*"]

1. e4 *
`);
    const game = new Chess();
    expect(replayPgn(parsed, game).ok).toBe(true);
    expect(game.get('e4')).toBe('P');
    expect(game.turn()).toBe('b');
  });

  it('stops on an illegal move without pretending the rest applied', () => {
    const game = new Chess();
    const replayed = replayPgn(parsePgn('1. e4 e5 2. Qh5 Na1'), game);
    expect(replayed.error).toMatch(/Na1/);
    expect(game.history().map((m) => m.san)).toEqual(['e4', 'e5', 'Qh5']);
  });

  it('rejects a FEN the engine will not load', () => {
    const game = new Chess();
    const replayed = replayPgn(
      parsePgn('[FEN "8/8/8/8/8/8/8/8 w - - 0 1"]\n\n1. e4 *\n'),
      game,
    );
    expect(replayed.error).toMatch(/cannot load/);
  });
});
