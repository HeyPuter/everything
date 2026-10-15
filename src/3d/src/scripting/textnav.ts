// Pure text helpers for the Text Editor: caret movement by line / word / page, and the
// word completion candidates of the autocomplete popup.

export type MoveType =
  | 'LINE_BEGIN'
  | 'LINE_END'
  | 'FILE_TOP'
  | 'FILE_BOTTOM'
  | 'PREVIOUS_CHARACTER'
  | 'NEXT_CHARACTER'
  | 'PREVIOUS_WORD'
  | 'NEXT_WORD'
  | 'PREVIOUS_LINE'
  | 'NEXT_LINE'
  | 'PREVIOUS_PAGE'
  | 'NEXT_PAGE';

export const MOVE_TYPES: [MoveType, string][] = [
  ['LINE_BEGIN', 'Line Begin'],
  ['LINE_END', 'Line End'],
  ['FILE_TOP', 'File Top'],
  ['FILE_BOTTOM', 'File Bottom'],
  ['PREVIOUS_CHARACTER', 'Previous Character'],
  ['NEXT_CHARACTER', 'Next Character'],
  ['PREVIOUS_WORD', 'Previous Word'],
  ['NEXT_WORD', 'Next Word'],
  ['PREVIOUS_LINE', 'Previous Line'],
  ['NEXT_LINE', 'Next Line'],
  ['PREVIOUS_PAGE', 'Previous Page'],
  ['NEXT_PAGE', 'Next Page'],
];

export const lineStart = (v: string, pos: number) => v.lastIndexOf('\n', pos - 1) + 1;
export function lineEnd(v: string, pos: number) {
  const i = v.indexOf('\n', pos);
  return i < 0 ? v.length : i;
}

const isWord = (c: string | undefined) => !!c && /[\w$]/.test(c);
const isSpace = (c: string | undefined) => c === ' ' || c === '\t';

/** Start of the previous word (skips spaces, then a run of word or punctuation characters). */
export function wordLeft(v: string, pos: number) {
  let i = pos;
  if (i > 0 && v[i - 1] === '\n') return i - 1;
  while (i > 0 && isSpace(v[i - 1])) i--;
  if (i > 0 && isWord(v[i - 1])) while (i > 0 && isWord(v[i - 1])) i--;
  else while (i > 0 && !isWord(v[i - 1]) && !isSpace(v[i - 1]) && v[i - 1] !== '\n') i--;
  return i;
}

/** End of the next word. */
export function wordRight(v: string, pos: number) {
  let i = pos;
  if (v[i] === '\n') return i + 1;
  while (i < v.length && isSpace(v[i])) i++;
  if (isWord(v[i])) while (i < v.length && isWord(v[i])) i++;
  else while (i < v.length && !isWord(v[i]) && !isSpace(v[i]) && v[i] !== '\n') i++;
  return i;
}

/** The word (identifier) around `pos`: [start, end). */
export function wordAt(v: string, pos: number): [number, number] {
  let s = pos,
    e = pos;
  while (s > 0 && isWord(v[s - 1])) s--;
  while (e < v.length && isWord(v[e])) e++;
  return [s, e];
}

/** Column of `pos` within its line. */
export const columnOf = (v: string, pos: number) => pos - lineStart(v, pos);

/** Position on a line `delta` lines away, keeping the column where possible. */
export function verticalMove(v: string, pos: number, delta: number, column = columnOf(v, pos)) {
  let start = lineStart(v, pos);
  if (delta < 0) {
    for (let k = 0; k < -delta; k++) {
      if (start === 0) return k === 0 ? 0 : start + Math.min(column, lineEnd(v, start) - start);
      start = lineStart(v, start - 1);
    }
  } else {
    for (let k = 0; k < delta; k++) {
      const e = lineEnd(v, start);
      if (e >= v.length) return k === 0 ? v.length : start + Math.min(column, e - start);
      start = e + 1;
    }
  }
  return start + Math.min(column, lineEnd(v, start) - start);
}

/** New caret position for a move. Line Begin toggles between the indentation and column 0. */
export function movePos(v: string, pos: number, type: MoveType, pageLines = 20): number {
  switch (type) {
    case 'LINE_BEGIN': {
      const s = lineStart(v, pos);
      const indent = s + (/^[ \t]*/.exec(v.slice(s, lineEnd(v, s)))?.[0].length ?? 0);
      return pos === indent ? s : indent;
    }
    case 'LINE_END':
      return lineEnd(v, pos);
    case 'FILE_TOP':
      return 0;
    case 'FILE_BOTTOM':
      return v.length;
    case 'PREVIOUS_CHARACTER':
      return Math.max(0, pos - 1);
    case 'NEXT_CHARACTER':
      return Math.min(v.length, pos + 1);
    case 'PREVIOUS_WORD':
      return wordLeft(v, pos);
    case 'NEXT_WORD':
      return wordRight(v, pos);
    case 'PREVIOUS_LINE':
      return verticalMove(v, pos, -1);
    case 'NEXT_LINE':
      return verticalMove(v, pos, 1);
    case 'PREVIOUS_PAGE':
      return verticalMove(v, pos, -pageLines);
    case 'NEXT_PAGE':
      return verticalMove(v, pos, pageLines);
  }
}

// ---------------------------------------------------------------------------
// completion

export const KEYWORDS: Record<'python' | 'javascript' | 'text', string[]> = {
  python: ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'print', 'range', 'len', 'enumerate', 'zip', 'isinstance', 'list', 'dict', 'tuple', 'set', 'str', 'int', 'float', 'bool', 'sorted', 'reversed', 'min', 'max', 'sum', 'abs', 'round', 'bpy', 'mathutils', 'math', 'random', 'Vector', 'Matrix', 'Euler', 'Quaternion'],
  javascript: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield', 'console', 'Math', 'Array', 'Object', 'JSON', 'Number', 'String', 'bpy', 'mathutils'],
  text: [],
};

/** The identifier (or dotted chain) right before the caret. */
export function completionPrefix(before: string): string {
  return /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.?)$/.exec(before)?.[1] ?? '';
}

/** Words of the text and the language keywords that start with `word` (most frequent first). */
export function wordCandidates(text: string, word: string, lang: 'python' | 'javascript' | 'text', max = 50): string[] {
  if (!word) return [];
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const w = m[0];
    if (w.length > word.length && w.startsWith(word)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  // the word being typed counts once in the text; it is not a candidate by itself
  for (const k of KEYWORDS[lang]) if (k.length > word.length && k.startsWith(word)) counts.set(k, (counts.get(k) ?? 0) + 0.5);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([w]) => w);
}
