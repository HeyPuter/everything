// Small single-pass syntax highlighters for Python and JavaScript. Token classes map to
// the text editor theme colours (builtin, symbols, special, preprocessor, reserved,
// comment, string, numbers).
export type TokenType = 'builtin' | 'symbols' | 'special' | 'preprocessor' | 'reserved' | 'comment' | 'string' | 'numbers' | 'plain';

const PY_KEYWORDS = new Set('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'.split(' '));
// constants are drawn like numbers; dunder names use the 'reserved' colour
const PY_CONSTANTS = new Set(['True', 'False', 'None', 'Ellipsis', 'NotImplemented']);
const PY_RESERVED = new Set(['__name__', '__file__', '__init__', '__doc__', '__class__', '__dict__', '__main__']);
const JS_KEYWORDS = new Set('break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch throw try typeof var void while with yield async await get set'.split(' '));
const JS_CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
const JS_RESERVED = new Set(['this', 'arguments']);

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Multi-line string / comment state carried between lines. */
export type LineState = { kind: 'none' } | { kind: 'pystr'; quote: string } | { kind: 'jscomment' } | { kind: 'jstemplate' };

export interface Token {
  text: string;
  type: TokenType;
}

const isIdStart = (c: string) => /[A-Za-z_$À-￿]/.test(c);
const isId = (c: string) => /[\w$À-￿]/.test(c);
// '.' and ',' stay in the plain text colour
const SYMBOLS = /[+\-*/%=<>!&|^~?:;()[\]{}@]/;

function readNumber(s: string, i: number) {
  const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(\d[\d_]*\.?[\d_]*|\.\d[\d_]*)([eE][+-]?\d+)?[jJn]?)/.exec(s.slice(i));
  return m ? m[0].length : 0;
}

export function tokenizeLine(line: string, lang: 'python' | 'javascript' | 'text', state: LineState): { tokens: Token[]; state: LineState } {
  const tokens: Token[] = [];
  if (lang === 'text') return { tokens: [{ text: line, type: 'plain' }], state };
  let i = 0;
  const push = (text: string, type: TokenType) => {
    if (!text) return;
    const last = tokens[tokens.length - 1];
    if (last && last.type === type) last.text += text;
    else tokens.push({ text, type });
  };
  // continue multi-line constructs
  if (state.kind === 'pystr') {
    const end = line.indexOf(state.quote);
    if (end < 0) return { tokens: [{ text: line, type: 'string' }], state };
    push(line.slice(0, end + 3), 'string');
    i = end + 3;
    state = { kind: 'none' };
  } else if (state.kind === 'jscomment') {
    const end = line.indexOf('*/');
    if (end < 0) return { tokens: [{ text: line, type: 'comment' }], state };
    push(line.slice(0, end + 2), 'comment');
    i = end + 2;
    state = { kind: 'none' };
  } else if (state.kind === 'jstemplate') {
    const end = findTemplateEnd(line, 0);
    if (end < 0) return { tokens: [{ text: line, type: 'string' }], state };
    push(line.slice(0, end + 1), 'string');
    i = end + 1;
    state = { kind: 'none' };
  }
  while (i < line.length) {
    const c = line[i];
    if (c === ' ' || c === '\t') {
      let j = i;
      while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
      push(line.slice(i, j), 'plain');
      i = j;
      continue;
    }
    if (lang === 'python') {
      if (c === '#') {
        push(line.slice(i), 'comment');
        break;
      }
      if (c === '@' && /^\s*$/.test(line.slice(0, i))) {
        let j = i + 1;
        while (j < line.length && (isId(line[j]) || line[j] === '.')) j++;
        push(line.slice(i, j), 'preprocessor');
        i = j;
        continue;
      }
      // string prefixes (r, b, f, rb, …)
      const pm = /^([rRbBuUfF]{0,2})('''|"""|'|")/.exec(line.slice(i));
      if (pm && (pm[1] === '' || !isId(line[i - 1] ?? ' '))) {
        const q = pm[2];
        const start = i;
        let j = i + pm[0].length;
        if (q.length === 3) {
          const end = line.indexOf(q, j);
          if (end < 0) {
            push(line.slice(start), 'string');
            return { tokens, state: { kind: 'pystr', quote: q } };
          }
          j = end + 3;
        } else {
          while (j < line.length && line[j] !== q) j += line[j] === '\\' ? 2 : 1;
          j = Math.min(line.length, j + 1);
        }
        push(line.slice(start, j), 'string');
        i = j;
        continue;
      }
    } else {
      if (c === '/' && line[i + 1] === '/') {
        push(line.slice(i), 'comment');
        break;
      }
      if (c === '/' && line[i + 1] === '*') {
        const end = line.indexOf('*/', i + 2);
        if (end < 0) {
          push(line.slice(i), 'comment');
          return { tokens, state: { kind: 'jscomment' } };
        }
        push(line.slice(i, end + 2), 'comment');
        i = end + 2;
        continue;
      }
      if (c === '`') {
        const end = findTemplateEnd(line, i + 1);
        if (end < 0) {
          push(line.slice(i), 'string');
          return { tokens, state: { kind: 'jstemplate' } };
        }
        push(line.slice(i, end + 1), 'string');
        i = end + 1;
        continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < line.length && line[j] !== c) j += line[j] === '\\' ? 2 : 1;
        j = Math.min(line.length, j + 1);
        push(line.slice(i, j), 'string');
        i = j;
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(line[i + 1] ?? ''))) {
      const n = readNumber(line, i);
      if (n && !isId(line[i - 1] ?? ' ')) {
        push(line.slice(i, i + n), 'numbers');
        i += n;
        continue;
      }
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < line.length && isId(line[j])) j++;
      const w = line.slice(i, j);
      let type: TokenType = 'plain';
      if (lang === 'python') {
        if (PY_KEYWORDS.has(w)) type = 'builtin';
        else if (PY_CONSTANTS.has(w)) type = 'numbers';
        else if (PY_RESERVED.has(w)) type = 'reserved';
      } else {
        if (JS_KEYWORDS.has(w)) type = 'builtin';
        else if (JS_CONSTANTS.has(w)) type = 'numbers';
        else if (JS_RESERVED.has(w)) type = 'reserved';
      }
      push(w, type);
      i = j;
      continue;
    }
    if (SYMBOLS.test(c)) {
      push(c, 'symbols');
      i++;
      continue;
    }
    push(c, 'plain');
    i++;
  }
  return { tokens, state };
}

function findTemplateEnd(line: string, from: number) {
  for (let j = from; j < line.length; j++) {
    if (line[j] === '\\') j++;
    else if (line[j] === '`') return j;
  }
  return -1;
}

/** Highlight a whole document; returns one HTML string per line. */
export function highlightLines(src: string, lang: 'python' | 'javascript' | 'text', enabled = true): string[] {
  const lines = src.split('\n');
  if (!enabled || lang === 'text') return lines.map((l) => esc(l));
  let state: LineState = { kind: 'none' };
  return lines.map((l) => {
    const r = tokenizeLine(l, lang, state);
    state = r.state;
    return r.tokens.map((t) => (t.type === 'plain' ? esc(t.text) : `<span class="sy-${t.type}">${esc(t.text)}</span>`)).join('');
  });
}
