// Cursor and selection model for editing text strips in place (pure, unit tested). Positions are
// indices into the strip's text; wrapped lines come from `wrapRanges`.
import type { WrappedLine } from './text';

export type CursorMove = 'PREVIOUS_CHARACTER' | 'NEXT_CHARACTER' | 'PREVIOUS_WORD' | 'NEXT_WORD' | 'LINE_BEGIN' | 'LINE_END' | 'PREVIOUS_LINE' | 'NEXT_LINE' | 'TEXT_BEGIN' | 'TEXT_END';

/** Line index holding a position. */
export function lineOf(lines: WrappedLine[], i: number): number {
  let l = 0;
  for (let k = 0; k < lines.length; k++) if (lines[k].start <= i) l = k;
  return l;
}

/** Column of a position within its line (spaces dropped at a wrap count as the line end). */
export function colOf(lines: WrappedLine[], i: number): number {
  const l = lines[lineOf(lines, i)];
  return Math.max(0, Math.min(i - l.start, l.text.length));
}

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

export function prevWord(text: string, i: number): number {
  while (i > 0 && !isWord(text[i - 1])) i--;
  while (i > 0 && isWord(text[i - 1])) i--;
  return i;
}

export function nextWord(text: string, i: number): number {
  while (i < text.length && !isWord(text[i])) i++;
  while (i < text.length && isWord(text[i])) i++;
  return i;
}

/** Column on a line whose x (from `width` of the line's prefix) is closest to `x`. */
export function colAtX(line: WrappedLine, x: number, width: (s: string) => number): number {
  let best = 0,
    bd = Infinity;
  for (let c = 0; c <= line.text.length; c++) {
    const d = Math.abs(width(line.text.slice(0, c)) - x);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/** New cursor position after a movement. `lineX(l)` is the x of line l's start (alignment). */
export function moveCursor(text: string, lines: WrappedLine[], i: number, type: CursorMove, width: (s: string) => number, lineX: (l: number) => number = () => 0): number {
  i = Math.max(0, Math.min(text.length, i));
  const L = lineOf(lines, i);
  switch (type) {
    case 'PREVIOUS_CHARACTER':
      return Math.max(0, i - 1);
    case 'NEXT_CHARACTER':
      return Math.min(text.length, i + 1);
    case 'PREVIOUS_WORD':
      return prevWord(text, i);
    case 'NEXT_WORD':
      return nextWord(text, i);
    case 'LINE_BEGIN':
      return lines[L].start;
    case 'LINE_END':
      return lines[L].start + lines[L].text.length;
    case 'TEXT_BEGIN':
      return 0;
    case 'TEXT_END':
      return text.length;
    case 'PREVIOUS_LINE':
    case 'NEXT_LINE': {
      const T = L + (type === 'PREVIOUS_LINE' ? -1 : 1);
      if (T < 0) return 0;
      if (T >= lines.length) return text.length;
      const x = lineX(L) + width(lines[L].text.slice(0, colOf(lines, i)));
      return lines[T].start + colAtX(lines[T], x - lineX(T), width);
    }
  }
}

export interface TextEditResult {
  text: string;
  cursor: number;
}

/** Replace the range [a, b) with `insert`; the cursor lands after it. */
export function replaceRange(text: string, a: number, b: number, insert: string): TextEditResult {
  const lo = Math.max(0, Math.min(a, b)),
    hi = Math.min(text.length, Math.max(a, b));
  return { text: text.slice(0, lo) + insert + text.slice(hi), cursor: lo + insert.length };
}

/** Delete the selection, or one character before / after the cursor. */
export function deleteAt(text: string, cursor: number, anchor: number, forward: boolean): TextEditResult {
  if (cursor !== anchor) return replaceRange(text, cursor, anchor, '');
  if (forward) return cursor < text.length ? replaceRange(text, cursor, cursor + 1, '') : { text, cursor };
  return cursor > 0 ? replaceRange(text, cursor - 1, cursor, '') : { text, cursor };
}
