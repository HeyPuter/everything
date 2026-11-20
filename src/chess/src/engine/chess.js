/**
 * Chess engine: board state, legal move generation, and game-status detection.
 *
 * Board representation: a flat 64-element array indexed 0..63 where index 0 is
 * a8 and index 63 is h1 (rank 8 down to rank 1, files a..h). Pieces are single
 * characters — uppercase for White ("PNBRQK"), lowercase for Black ("pnbrqk"),
 * and null for empty squares.
 *
 * Methods prefixed with an underscore operate on internal move objects (with
 * numeric square indices) and are shared with the AI search for speed. The
 * public API speaks algebraic squares ("e4") and verbose move objects.
 */

export const WHITE = 'w';
export const BLACK = 'b';

export const START_FEN =
  'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FILES = 'abcdefgh';

const KNIGHT_DELTAS = [
  [1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_DELTAS = [
  [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const QUEEN_DIRS = [...BISHOP_DIRS, ...ROOK_DIRS];

// Castling-right bits.
const C_WK = 1;
const C_WQ = 2;
const C_BK = 4;
const C_BQ = 8;

// Mask applied to castling rights whenever a move touches a square: moving the
// king or a rook (or capturing a rook on its home square) clears the bits.
const CASTLE_MASK = new Array(64).fill(15);
CASTLE_MASK[0] = 15 & ~C_BQ;  // a8
CASTLE_MASK[4] = 15 & ~(C_BK | C_BQ); // e8
CASTLE_MASK[7] = 15 & ~C_BK;  // h8
CASTLE_MASK[56] = 15 & ~C_WQ; // a1
CASTLE_MASK[60] = 15 & ~(C_WK | C_WQ); // e1
CASTLE_MASK[63] = 15 & ~C_WK; // h1

export function squareToIndex(square) {
  const file = square.charCodeAt(0) - 97;
  const rank = square.charCodeAt(1) - 49;
  if (file < 0 || file > 7 || rank < 0 || rank > 7) {
    throw new Error(`Invalid square: ${square}`);
  }
  return (7 - rank) * 8 + file;
}

export function indexToSquare(index) {
  return FILES[index & 7] + (8 - (index >> 3));
}

export function colorOf(piece) {
  return piece.charCodeAt(0) < 97 ? WHITE : BLACK;
}

export function typeOf(piece) {
  return piece.toLowerCase();
}

function otherColor(color) {
  return color === WHITE ? BLACK : WHITE;
}

/**
 * Strip the marks a PGN file may hang on a move so it can be matched against
 * the SAN this engine writes. Check, mate, annotation (`!`/`?`), the equals
 * in a promotion, and zeros-for-castling are all the same move.
 */
function normalizeSan(san) {
  return String(san)
    .replace(/0-0-0/g, 'O-O-O')
    .replace(/0-0/g, 'O-O')
    .replace(/×/g, 'x')
    .replace(/e\.p\.?/gi, '')
    .replace(/[+#?!]+$/g, '')
    .replace(/=([qrbn])/i, (_, piece) => piece.toUpperCase())
    .replace(/([a-h](?:x[a-h])?[18])([qrbn])$/i, (_, rest, piece) => rest + piece.toUpperCase());
}

export class Chess {
  constructor(fen = START_FEN) {
    this.load(fen);
  }

  load(fen) {
    const fields = fen.trim().split(/\s+/);
    if (fields.length < 4) {
      throw new Error(`Invalid FEN: expected at least 4 fields in "${fen}"`);
    }
    const [placement, turn, castling, ep, halfmove = '0', fullmove = '1'] = fields;

    const board = new Array(64).fill(null);
    const ranks = placement.split('/');
    if (ranks.length !== 8) {
      throw new Error(`Invalid FEN: expected 8 ranks in "${placement}"`);
    }
    let kw = -1;
    let kb = -1;
    for (let r = 0; r < 8; r++) {
      let f = 0;
      for (const ch of ranks[r]) {
        if (ch >= '1' && ch <= '8') {
          f += ch.charCodeAt(0) - 48;
        } else if ('pnbrqkPNBRQK'.includes(ch)) {
          if (f > 7) throw new Error(`Invalid FEN: rank overflow in "${ranks[r]}"`);
          const idx = r * 8 + f;
          board[idx] = ch;
          if (ch === 'K') kw = idx;
          if (ch === 'k') kb = idx;
          f++;
        } else {
          throw new Error(`Invalid FEN: bad character "${ch}"`);
        }
      }
      if (f !== 8) throw new Error(`Invalid FEN: rank "${ranks[r]}" does not fill 8 files`);
    }
    if (kw === -1 || kb === -1) {
      throw new Error('Invalid FEN: both kings must be on the board');
    }
    if (turn !== WHITE && turn !== BLACK) {
      throw new Error(`Invalid FEN: bad side to move "${turn}"`);
    }

    let castleBits = 0;
    if (castling !== '-') {
      for (const ch of castling) {
        const bit = { K: C_WK, Q: C_WQ, k: C_BK, q: C_BQ }[ch];
        if (bit === undefined) throw new Error(`Invalid FEN: bad castling "${castling}"`);
        castleBits |= bit;
      }
    }

    this._board = board;
    this._turn = turn;
    this._castling = castleBits;
    this._ep = ep === '-' ? -1 : squareToIndex(ep);
    this._halfmove = parseInt(halfmove, 10);
    this._fullmove = parseInt(fullmove, 10);
    this._kw = kw;
    this._kb = kb;
    this._history = [];      // internal undo stack (search + play)
    this._log = [];          // verbose public move log
    this._positionCounts = new Map([[this._positionKey(), 1]]);
  }

  reset() {
    this.load(START_FEN);
  }

  fen() {
    let placement = '';
    for (let r = 0; r < 8; r++) {
      let empty = 0;
      for (let f = 0; f < 8; f++) {
        const piece = this._board[r * 8 + f];
        if (piece === null) {
          empty++;
        } else {
          if (empty) placement += empty;
          empty = 0;
          placement += piece;
        }
      }
      if (empty) placement += empty;
      if (r < 7) placement += '/';
    }
    let castling = '';
    if (this._castling & C_WK) castling += 'K';
    if (this._castling & C_WQ) castling += 'Q';
    if (this._castling & C_BK) castling += 'k';
    if (this._castling & C_BQ) castling += 'q';
    const ep = this._ep === -1 ? '-' : indexToSquare(this._ep);
    return [
      placement,
      this._turn,
      castling || '-',
      ep,
      this._halfmove,
      this._fullmove,
    ].join(' ');
  }

  turn() {
    return this._turn;
  }

  board() {
    return this._board.slice();
  }

  get(square) {
    return this._board[squareToIndex(square)];
  }

  kingSquare(color) {
    return indexToSquare(color === WHITE ? this._kw : this._kb);
  }

  moveNumber() {
    return this._fullmove;
  }

  history() {
    return this._log.slice();
  }

  lastMove() {
    return this._log.length ? this._log[this._log.length - 1] : null;
  }

  /* ------------------------------------------------------------------ */
  /* Move generation                                                     */
  /* ------------------------------------------------------------------ */

  _pushPawnMoves(moves, from, to, piece, color, captured) {
    const promoRow = color === WHITE ? 0 : 7;
    if (to >> 3 === promoRow) {
      const flags = captured ? 'cp' : 'p';
      for (const promotion of ['q', 'r', 'b', 'n']) {
        moves.push({ from, to, piece, color, flags, captured, promotion });
      }
    } else {
      moves.push({
        from, to, piece, color,
        flags: captured ? 'c' : 'n',
        captured,
        promotion: null,
      });
    }
  }

  _castlingMoves(moves, color, from) {
    const home = color === WHITE ? 60 : 4; // e1 / e8
    if (from !== home) return;
    const board = this._board;
    const enemy = otherColor(color);
    const rook = color === WHITE ? 'R' : 'r';
    const kBit = color === WHITE ? C_WK : C_BK;
    const qBit = color === WHITE ? C_WQ : C_BQ;

    if (
      this._castling & kBit &&
      board[home + 1] === null && board[home + 2] === null &&
      board[home + 3] === rook &&
      !this._attacked(home, enemy) &&
      !this._attacked(home + 1, enemy) &&
      !this._attacked(home + 2, enemy)
    ) {
      moves.push({
        from, to: home + 2, piece: board[from], color,
        flags: 'k', captured: null, promotion: null,
      });
    }
    if (
      this._castling & qBit &&
      board[home - 1] === null && board[home - 2] === null &&
      board[home - 3] === null &&
      board[home - 4] === rook &&
      !this._attacked(home, enemy) &&
      !this._attacked(home - 1, enemy) &&
      !this._attacked(home - 2, enemy)
    ) {
      moves.push({
        from, to: home - 2, piece: board[from], color,
        flags: 'q', captured: null, promotion: null,
      });
    }
  }

  /** All pseudo-legal moves for `color` (may leave own king in check). */
  _pseudoMoves(color = this._turn) {
    const moves = [];
    const board = this._board;
    for (let from = 0; from < 64; from++) {
      const piece = board[from];
      if (piece === null || colorOf(piece) !== color) continue;
      const type = typeOf(piece);
      const f = from & 7;
      const r = from >> 3;

      if (type === 'p') {
        const dir = color === WHITE ? -1 : 1;
        const startRow = color === WHITE ? 6 : 1;
        const one = from + dir * 8;
        if (board[one] === null) {
          this._pushPawnMoves(moves, from, one, piece, color, null);
          const two = from + dir * 16;
          if (r === startRow && board[two] === null) {
            moves.push({
              from, to: two, piece, color,
              flags: 'b', captured: null, promotion: null,
            });
          }
        }
        for (const df of [-1, 1]) {
          const tf = f + df;
          if (tf < 0 || tf > 7) continue;
          const to = one + df;
          const target = board[to];
          if (target !== null && colorOf(target) !== color) {
            this._pushPawnMoves(moves, from, to, piece, color, target);
          } else if (to === this._ep) {
            moves.push({
              from, to, piece, color,
              flags: 'e',
              captured: color === WHITE ? 'p' : 'P',
              promotion: null,
            });
          }
        }
      } else if (type === 'n' || type === 'k') {
        const deltas = type === 'n' ? KNIGHT_DELTAS : KING_DELTAS;
        for (const [df, dr] of deltas) {
          const tf = f + df;
          const tr = r + dr;
          if (tf < 0 || tf > 7 || tr < 0 || tr > 7) continue;
          const to = tr * 8 + tf;
          const target = board[to];
          if (target === null) {
            moves.push({ from, to, piece, color, flags: 'n', captured: null, promotion: null });
          } else if (colorOf(target) !== color) {
            moves.push({ from, to, piece, color, flags: 'c', captured: target, promotion: null });
          }
        }
        if (type === 'k') this._castlingMoves(moves, color, from);
      } else {
        const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : QUEEN_DIRS;
        for (const [df, dr] of dirs) {
          let tf = f + df;
          let tr = r + dr;
          while (tf >= 0 && tf <= 7 && tr >= 0 && tr <= 7) {
            const to = tr * 8 + tf;
            const target = board[to];
            if (target === null) {
              moves.push({ from, to, piece, color, flags: 'n', captured: null, promotion: null });
            } else {
              if (colorOf(target) !== color) {
                moves.push({ from, to, piece, color, flags: 'c', captured: target, promotion: null });
              }
              break;
            }
            tf += df;
            tr += dr;
          }
        }
      }
    }
    return moves;
  }

  /** Is `square` (index) attacked by any piece of color `by`? */
  _attacked(square, by) {
    const board = this._board;
    const f = square & 7;
    const r = square >> 3;

    // Pawns (white pawns attack toward lower row indices).
    const pawnRow = by === WHITE ? r + 1 : r - 1;
    if (pawnRow >= 0 && pawnRow <= 7) {
      const pawn = by === WHITE ? 'P' : 'p';
      if (f > 0 && board[pawnRow * 8 + f - 1] === pawn) return true;
      if (f < 7 && board[pawnRow * 8 + f + 1] === pawn) return true;
    }

    const knight = by === WHITE ? 'N' : 'n';
    for (const [df, dr] of KNIGHT_DELTAS) {
      const tf = f + df;
      const tr = r + dr;
      if (tf >= 0 && tf <= 7 && tr >= 0 && tr <= 7 && board[tr * 8 + tf] === knight) {
        return true;
      }
    }

    const king = by === WHITE ? 'K' : 'k';
    for (const [df, dr] of KING_DELTAS) {
      const tf = f + df;
      const tr = r + dr;
      if (tf >= 0 && tf <= 7 && tr >= 0 && tr <= 7 && board[tr * 8 + tf] === king) {
        return true;
      }
    }

    const rook = by === WHITE ? 'R' : 'r';
    const bishop = by === WHITE ? 'B' : 'b';
    const queen = by === WHITE ? 'Q' : 'q';
    for (const [df, dr] of ROOK_DIRS) {
      let tf = f + df;
      let tr = r + dr;
      while (tf >= 0 && tf <= 7 && tr >= 0 && tr <= 7) {
        const target = board[tr * 8 + tf];
        if (target !== null) {
          if (target === rook || target === queen) return true;
          break;
        }
        tf += df;
        tr += dr;
      }
    }
    for (const [df, dr] of BISHOP_DIRS) {
      let tf = f + df;
      let tr = r + dr;
      while (tf >= 0 && tf <= 7 && tr >= 0 && tr <= 7) {
        const target = board[tr * 8 + tf];
        if (target !== null) {
          if (target === bishop || target === queen) return true;
          break;
        }
        tf += df;
        tr += dr;
      }
    }
    return false;
  }

  _kingAttacked(color) {
    const kingIdx = color === WHITE ? this._kw : this._kb;
    return this._attacked(kingIdx, otherColor(color));
  }

  /* ------------------------------------------------------------------ */
  /* Make / undo (internal move objects)                                 */
  /* ------------------------------------------------------------------ */

  _makeMove(m) {
    const us = m.color;
    this._history.push({
      m,
      castling: this._castling,
      ep: this._ep,
      halfmove: this._halfmove,
      kw: this._kw,
      kb: this._kb,
    });

    const board = this._board;
    board[m.from] = null;
    board[m.to] = m.promotion
      ? (us === WHITE ? m.promotion.toUpperCase() : m.promotion)
      : m.piece;

    if (m.flags === 'e') {
      board[us === WHITE ? m.to + 8 : m.to - 8] = null;
    } else if (m.flags === 'k') {
      board[m.to - 1] = board[m.to + 1]; // rook h-file -> f-file
      board[m.to + 1] = null;
    } else if (m.flags === 'q') {
      board[m.to + 1] = board[m.to - 2]; // rook a-file -> d-file
      board[m.to - 2] = null;
    }

    if (m.piece === 'K') this._kw = m.to;
    else if (m.piece === 'k') this._kb = m.to;

    this._castling &= CASTLE_MASK[m.from] & CASTLE_MASK[m.to];
    this._ep = m.flags === 'b' ? (m.from + m.to) / 2 : -1;
    this._halfmove = typeOf(m.piece) === 'p' || m.captured ? 0 : this._halfmove + 1;
    if (us === BLACK) this._fullmove++;
    this._turn = otherColor(us);
  }

  _undoMove() {
    const entry = this._history.pop();
    if (!entry) return null;
    const { m } = entry;
    this._castling = entry.castling;
    this._ep = entry.ep;
    this._halfmove = entry.halfmove;
    this._kw = entry.kw;
    this._kb = entry.kb;
    this._turn = m.color;
    if (m.color === BLACK) this._fullmove--;

    const board = this._board;
    board[m.from] = m.piece;
    board[m.to] = null;
    if (m.flags === 'e') {
      board[m.color === WHITE ? m.to + 8 : m.to - 8] = m.captured;
    } else if (m.captured) {
      board[m.to] = m.captured;
    }
    if (m.flags === 'k') {
      board[m.to + 1] = board[m.to - 1];
      board[m.to - 1] = null;
    } else if (m.flags === 'q') {
      board[m.to - 2] = board[m.to + 1];
      board[m.to + 1] = null;
    }
    return m;
  }

  /** All fully legal moves for the side to move (internal move objects). */
  _legalMoves() {
    const us = this._turn;
    const legal = [];
    for (const m of this._pseudoMoves(us)) {
      this._makeMove(m);
      if (!this._kingAttacked(us)) legal.push(m);
      this._undoMove();
    }
    return legal;
  }

  /* ------------------------------------------------------------------ */
  /* Public move API                                                     */
  /* ------------------------------------------------------------------ */

  _verbose(m) {
    return {
      color: m.color,
      piece: m.piece,
      from: indexToSquare(m.from),
      to: indexToSquare(m.to),
      flags: m.flags,
      captured: m.captured || null,
      promotion: m.promotion || null,
    };
  }

  /**
   * Legal moves as verbose objects. Options: `square` limits to moves from
   * that square.
   */
  moves({ square = null } = {}) {
    const fromIdx = square === null ? -1 : squareToIndex(square);
    const result = [];
    for (const m of this._legalMoves()) {
      if (fromIdx !== -1 && m.from !== fromIdx) continue;
      result.push(this._verbose(m));
    }
    return result;
  }

  _moveToSan(m, legalMoves) {
    let san;
    if (m.flags === 'k') {
      san = 'O-O';
    } else if (m.flags === 'q') {
      san = 'O-O-O';
    } else if (typeOf(m.piece) === 'p') {
      san = m.captured
        ? FILES[m.from & 7] + 'x' + indexToSquare(m.to)
        : indexToSquare(m.to);
      if (m.promotion) san += '=' + m.promotion.toUpperCase();
    } else {
      let disambiguator = '';
      const rivals = legalMoves.filter(
        (o) => o !== m && o.piece === m.piece && o.to === m.to && o.from !== m.from,
      );
      if (rivals.length) {
        const sameFile = rivals.some((o) => (o.from & 7) === (m.from & 7));
        const sameRank = rivals.some((o) => (o.from >> 3) === (m.from >> 3));
        if (!sameFile) disambiguator = FILES[m.from & 7];
        else if (!sameRank) disambiguator = String(8 - (m.from >> 3));
        else disambiguator = indexToSquare(m.from);
      }
      san = m.piece.toUpperCase() + disambiguator + (m.captured ? 'x' : '') + indexToSquare(m.to);
    }

    this._makeMove(m);
    if (this._kingAttacked(this._turn)) {
      san += this._legalMoves().length === 0 ? '#' : '+';
    }
    this._undoMove();
    return san;
  }

  /**
   * Make a move given `{from, to, promotion}` (algebraic squares) or a SAN /
   * UCI string (`Nf3`, `O-O`, `e2e4`). Returns the verbose move (including
   * `san`) or null if the move is illegal or the SAN does not name exactly
   * one legal move.
   */
  move(spec) {
    if (typeof spec === 'string') return this._moveSan(spec);
    const { from, to, promotion = 'q' } = spec || {};
    const fromIdx = squareToIndex(from);
    const toIdx = squareToIndex(to);
    const legal = this._legalMoves();
    const m = legal.find(
      (o) =>
        o.from === fromIdx &&
        o.to === toIdx &&
        (o.promotion === null || o.promotion === promotion),
    );
    if (!m) return null;
    return this._commitMove(m, legal);
  }

  /**
   * Play a move written in SAN (the form the move list and PGN use) or as
   * UCI coordinates. Check, mate and annotation marks are ignored, so
   * `Qxf7#` and `e4!` match the same moves as `Qxf7` and `e4`. Castling
   * written with zeros (`0-0`) is accepted. Returns null when the token is
   * empty, names no legal move, or names more than one.
   */
  _moveSan(token) {
    const raw = String(token).trim();
    if (!raw) return null;
    const uci = raw.match(/^([a-h][1-8])([a-h][1-8])([qrbn])?$/i);
    if (uci) {
      return this.move({
        from: uci[1],
        to: uci[2],
        promotion: (uci[3] || 'q').toLowerCase(),
      });
    }
    const wanted = normalizeSan(raw);
    if (!wanted) return null;
    const legal = this._legalMoves();
    let found = null;
    for (const m of legal) {
      if (normalizeSan(this._moveToSan(m, legal)) !== wanted) continue;
      if (found) return null;
      found = m;
    }
    if (!found) return null;
    return this._commitMove(found, legal);
  }

  _commitMove(m, legal) {
    const san = this._moveToSan(m, legal);
    this._makeMove(m);
    const key = this._positionKey();
    this._positionCounts.set(key, (this._positionCounts.get(key) || 0) + 1);
    const verbose = { ...this._verbose(m), san };
    this._log.push(verbose);
    return verbose;
  }

  /** Undo the last public move. Returns the verbose move or null. */
  undo() {
    if (this._log.length === 0) return null;
    const key = this._positionKey();
    const count = this._positionCounts.get(key);
    if (count > 1) this._positionCounts.set(key, count - 1);
    else this._positionCounts.delete(key);
    this._undoMove();
    return this._log.pop();
  }

  /* ------------------------------------------------------------------ */
  /* Game status                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Repetition key: piece placement, side to move, castling rights, and the
   * en-passant square (only when an en-passant capture is actually legal).
   */
  _positionKey() {
    const parts = this.fen().split(' ');
    let ep = '-';
    if (this._ep !== -1 && this._legalMoves().some((m) => m.flags === 'e')) {
      ep = parts[3];
    }
    return `${parts[0]} ${parts[1]} ${parts[2]} ${ep}`;
  }

  inCheck() {
    return this._kingAttacked(this._turn);
  }

  isCheckmate() {
    return this.inCheck() && this._legalMoves().length === 0;
  }

  isStalemate() {
    return !this.inCheck() && this._legalMoves().length === 0;
  }

  isInsufficientMaterial() {
    const minors = []; // square indices of bishops/knights
    let bishopsOnly = true;
    for (let i = 0; i < 64; i++) {
      const piece = this._board[i];
      if (piece === null) continue;
      const type = typeOf(piece);
      if (type === 'k') continue;
      if (type === 'p' || type === 'r' || type === 'q') return false;
      minors.push(i);
      if (type === 'n') bishopsOnly = false;
    }
    if (minors.length <= 1) return true; // K vs K, or K+minor vs K
    if (!bishopsOnly) return false;
    // Bishops only: draw if they all live on same-colored squares.
    const shade = (i) => ((i & 7) + (i >> 3)) & 1;
    return minors.every((i) => shade(i) === shade(minors[0]));
  }

  isThreefoldRepetition() {
    return (this._positionCounts.get(this._positionKey()) || 0) >= 3;
  }

  /**
   * Could `color` still deliver mate with the material it has left? Used for
   * the flag-fall rule (FIDE 6.9): running out of time loses, unless the
   * opponent has no way to checkmate, in which case the game is drawn.
   *
   * A lone king, or a king with a single knight or a single bishop, can never
   * mate — not even with the loser cooperating. Anything more is treated as
   * mating material, which is where practical implementations stop: rarer dead
   * positions (two bishops on one color, a blocked-in pawn) would need a full
   * search of the position rather than a material count.
   */
  hasMatingMaterial(color) {
    let minors = 0;
    for (let i = 0; i < 64; i++) {
      const piece = this._board[i];
      if (piece === null || colorOf(piece) !== color) continue;
      const type = typeOf(piece);
      if (type === 'k') continue;
      if (type === 'n' || type === 'b') minors++;
      else return true; // a pawn, rook, or queen is always enough
    }
    return minors > 1;
  }

  isFiftyMoveRule() {
    return this._halfmove >= 100;
  }

  isDraw() {
    if (this.isCheckmate()) return false;
    return (
      this.isStalemate() ||
      this.isInsufficientMaterial() ||
      this.isFiftyMoveRule() ||
      this.isThreefoldRepetition()
    );
  }

  isGameOver() {
    return this.isCheckmate() || this.isDraw();
  }

  /** Summary of the game state for UIs. */
  status() {
    const check = this.inCheck();
    const hasMoves = this._legalMoves().length > 0;
    if (!hasMoves && check) {
      return {
        over: true,
        result: this._turn === WHITE ? '0-1' : '1-0',
        reason: 'checkmate',
        check,
        turn: this._turn,
      };
    }
    let reason = null;
    if (!hasMoves) reason = 'stalemate';
    else if (this.isInsufficientMaterial()) reason = 'insufficient material';
    else if (this.isFiftyMoveRule()) reason = 'fifty-move rule';
    else if (this.isThreefoldRepetition()) reason = 'threefold repetition';
    if (reason) {
      return { over: true, result: '1/2-1/2', reason, check, turn: this._turn };
    }
    return { over: false, result: null, reason: null, check, turn: this._turn };
  }
}

/** Count leaf nodes of the move-generation tree; used to validate the engine. */
export function perft(game, depth) {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const m of game._pseudoMoves(game._turn)) {
    game._makeMove(m);
    if (!game._kingAttacked(m.color)) {
      nodes += depth === 1 ? 1 : perft(game, depth - 1);
    }
    game._undoMove();
  }
  return nodes;
}
