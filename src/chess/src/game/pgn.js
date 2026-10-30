/**
 * PGN (Portable Game Notation): export of a played game, and import of a
 * PGN dump from another program.
 *
 * Export takes the SAN list the move log already holds, plus whatever the
 * app knows about the players and how the game ended. Import reads tag
 * pairs and movetext, strips comments, NAGs and variations, and hands back
 * a SAN list the engine can replay. Neither side touches the DOM.
 */

/** Tokens that end a PGN game, including an unfinished one. */
const RESULT_TOKENS = new Set(['1-0', '0-1', '1/2-1/2', '*']);

/** PGN wraps movetext at 80 columns; long lines are legal but discourteous. */
const LINE_WIDTH = 80;

/**
 * Tag values are quoted strings in which `"` and `\` must be escaped, and
 * which cannot contain newlines. Opponent names come off the wire, so this
 * also caps the length rather than trusting it.
 */
function tagValue(value) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(0, 120)
    .replace(/[\\"]/g, (ch) => `\\${ch}`);
}

/** `YYYY.MM.DD` in local time, the PGN date format. */
export function pgnDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

/** PGN's TimeControl tag: seconds+increment, or "-" for an untimed game. */
function timeControlTag(control) {
  if (!control) return '-';
  return `${Math.round(control.initial / 1000)}+${Math.round(control.increment / 1000)}`;
}

/** `1. e4 e5 2. Nf3` … wrapped at LINE_WIDTH, with the result appended. */
function movetext(sans, result) {
  const tokens = [];
  sans.forEach((san, i) => {
    if (i % 2 === 0) tokens.push(`${i / 2 + 1}.`);
    tokens.push(san);
  });
  tokens.push(result);

  const lines = [];
  let line = '';
  for (const token of tokens) {
    if (line && line.length + 1 + token.length > LINE_WIDTH) {
      lines.push(line);
      line = token;
    } else {
      line = line ? `${line} ${token}` : token;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/**
 * Build a complete PGN game.
 *
 * @param {{
 *   sans: string[],                 moves in standard algebraic notation
 *   result: string,                 "1-0" | "0-1" | "1/2-1/2" | "*"
 *   white: string, black: string,   player names
 *   date: Date,
 *   control?: {initial: number, increment: number}|null,
 *   termination?: string,           PGN Termination, omitted when "normal"
 *   event?: string, site?: string,
 * }} game
 */
export function buildPgn({
  sans,
  result,
  white,
  black,
  date,
  control = null,
  termination = 'normal',
  event = 'Casual game',
  site = 'chess.puter.com',
}) {
  const tags = [
    ['Event', event],
    ['Site', site],
    ['Date', pgnDate(date)],
    ['Round', '-'],
    ['White', white],
    ['Black', black],
    ['Result', result],
    ['TimeControl', timeControlTag(control)],
  ];
  // Termination is optional and "normal" is the default reading, so only a
  // game that ended some other way is worth spelling out.
  if (termination && termination !== 'normal') tags.push(['Termination', termination]);

  const header = tags.map(([key, value]) => `[${key} "${tagValue(value)}"]`).join('\n');
  return `${header}\n\n${movetext(sans, result)}\n`;
}

/**
 * Read the first game in a PGN dump. Later games in the same file are
 * ignored. Comments `{…}` and `;…`, numeric annotation glyphs, and
 * parenthetical variations are dropped; a `[FEN "…"]` tag is kept so a
 * game that did not start from the initial array can be replayed.
 *
 * @returns {{
 *   tags: Record<string, string>,
 *   sans: string[],
 *   result: string,
 *   fen: string|null,
 * } | { error: string }}
 */
export function parsePgn(source) {
  if (typeof source !== 'string' || !source.trim()) {
    return { error: 'Paste a PGN game, or choose a .pgn file.' };
  }

  let text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  // Percent-escaped lines are commentary the spec says to skip.
  text = text.replace(/^%.*$/gm, '');

  const tags = {};
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (text[i] !== '[') break;
    const lineEnd = text.indexOf('\n', i);
    const line = text.slice(i, lineEnd === -1 ? n : lineEnd);
    const match = line.match(/^\[(\w+)\s+"((?:\\.|[^"\\])*)"\]\s*$/);
    if (!match) break;
    tags[match[1]] = match[2].replace(/\\([\\"])/g, '$1');
    i = lineEnd === -1 ? n : lineEnd + 1;
  }

  const tokens = tokenizeMovetext(text.slice(i));
  const sans = [];
  let result = tags.Result && RESULT_TOKENS.has(tags.Result) ? tags.Result : null;
  for (const token of tokens) {
    if (RESULT_TOKENS.has(token)) {
      result = token;
      break;
    }
    // `12.` / `12...` are move numbers; `12.e4` is a number glued to a move.
    const glued = token.match(/^(\d+\.+)(.*)$/);
    const san = glued ? glued[2] : token;
    if (!san) continue;
    if (RESULT_TOKENS.has(san)) {
      result = san;
      break;
    }
    sans.push(san);
  }

  const fen = tags.FEN && tags.FEN.trim() ? tags.FEN.trim() : null;
  return { tags, sans, result: result || '*', fen };
}

/** Drop comments, NAGs and variations, then split on whitespace. */
function tokenizeMovetext(source) {
  const stripped = stripVariations(stripComments(source)).replace(/\$\d+/g, ' ');
  return stripped.trim().split(/\s+/).filter(Boolean);
}

function stripComments(source) {
  let out = '';
  for (let i = 0; i < source.length; ) {
    const ch = source[i];
    if (ch === '{') {
      const end = source.indexOf('}', i + 1);
      if (end === -1) break;
      i = end + 1;
    } else if (ch === ';') {
      const end = source.indexOf('\n', i + 1);
      if (end === -1) break;
      i = end;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

function stripVariations(source) {
  let out = '';
  let depth = 0;
  for (const ch of source) {
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (depth > 0) depth--;
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

/**
 * Replay a parsed PGN onto `game`. `game` must speak `reset()`, `load(fen)`
 * and `move(san)`. On success the game is left in the final position; on
 * failure it may be part-way through and the caller should discard it.
 *
 * @param {{tags: object, sans: string[], result: string, fen: string|null}} parsed
 * @param {{reset: Function, load: Function, move: Function}} game
 * @returns {{ok: true, result: string, tags: object} | { error: string }}
 */
export function replayPgn(parsed, game) {
  if (parsed.error) return parsed;
  try {
    if (parsed.fen) game.load(parsed.fen);
    else game.reset();
  } catch {
    return { error: 'That PGN starts from a position this app cannot load.' };
  }
  for (const san of parsed.sans) {
    if (!game.move(san)) {
      return { error: `Illegal or unknown move ${san}.` };
    }
  }
  return { ok: true, result: parsed.result, tags: parsed.tags };
}

/** A filesystem-safe name for a downloaded game. */
export function pgnFilename(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return [
    'chess-',
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    '.pgn',
  ].join('');
}
