/**
 * PDF tokenizer and object parser over a byte array. Used for the file
 * structure (objects, xref tables), content streams (operands followed by
 * operators, inline images) and PostScript calculator functions.
 *
 * The parser is forgiving: malformed numbers, unbalanced strings and stray
 * keywords are skipped rather than aborting the whole import.
 */
import { Name, Ref, Cmd, PDFDict, PDFStream, isCmd } from './primitives.js';

export const EOF = Symbol('EOF');

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

const isWS = (c) => WS[c] === 1;
const isDelim = (c) => DELIM[c] === 1;

function hexVal(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

export class Lexer {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.b = bytes;
    this.pos = pos;
    this.end = end;
  }

  skipSpace() {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (isWS(c)) this.pos++;
      else if (c === 37) {
        // Comment to end of line.
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** The next token: number, string ({ str }), Name, Cmd, or EOF. */
  next() {
    this.skipSpace();
    if (this.pos >= this.end) return EOF;
    const b = this.b;
    const c = b[this.pos];
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const n = this.number();
      if (n !== null) return n;
    }
    switch (c) {
      case 40: // (
        this.pos++;
        return { str: this.literal() };
      case 60: // <
        if (b[this.pos + 1] === 60) {
          this.pos += 2;
          return Cmd.get('<<');
        }
        this.pos++;
        return { str: this.hex() };
      case 62: // >
        if (b[this.pos + 1] === 62) {
          this.pos += 2;
          return Cmd.get('>>');
        }
        this.pos++;
        return Cmd.get('>');
      case 91:
        this.pos++;
        return Cmd.get('[');
      case 93:
        this.pos++;
        return Cmd.get(']');
      case 123:
        this.pos++;
        return Cmd.get('{');
      case 125:
        this.pos++;
        return Cmd.get('}');
      case 47:
        this.pos++;
        return Name.get(this.name());
      case 41:
        this.pos++;
        return Cmd.get(')');
      default: {
        const start = this.pos;
        while (this.pos < this.end && !isWS(b[this.pos]) && !isDelim(b[this.pos])) this.pos++;
        if (this.pos === start) {
          this.pos++;
          return Cmd.get(String.fromCharCode(c));
        }
        let s = '';
        for (let i = start; i < this.pos; i++) s += String.fromCharCode(b[i]);
        return Cmd.get(s);
      }
    }
  }

  number() {
    const b = this.b;
    const start = this.pos;
    let p = this.pos;
    let sign = 1;
    while (b[p] === 43 || b[p] === 45) {
      if (b[p] === 45) sign = -sign;
      p++;
    }
    let int = 0;
    let digits = 0;
    while (p < this.end && b[p] >= 48 && b[p] <= 57) {
      int = int * 10 + (b[p] - 48);
      p++;
      digits++;
    }
    let frac = 0;
    if (b[p] === 46) {
      p++;
      let scale = 0.1;
      while (p < this.end && b[p] >= 48 && b[p] <= 57) {
        frac += (b[p] - 48) * scale;
        scale /= 10;
        p++;
        digits++;
      }
    }
    if (!digits) {
      // A lone sign or dot: treat as zero (some writers emit "-" for 0).
      if (p < this.end && !isWS(b[p]) && !isDelim(b[p])) {
        this.pos = start;
        return null;
      }
      this.pos = p;
      return 0;
    }
    // Exponents are not PDF syntax but appear in some files.
    if ((b[p] === 101 || b[p] === 69) && ((b[p + 1] >= 48 && b[p + 1] <= 57) || b[p + 1] === 45 || b[p + 1] === 43)) {
      let q = p + 1;
      let es = 1;
      if (b[q] === 45 || b[q] === 43) {
        if (b[q] === 45) es = -1;
        q++;
      }
      let e = 0;
      while (q < this.end && b[q] >= 48 && b[q] <= 57) e = e * 10 + (b[q++] - 48);
      this.pos = q;
      return sign * (int + frac) * Math.pow(10, es * e);
    }
    this.pos = p;
    return sign * (int + frac);
  }

  literal() {
    const b = this.b;
    let depth = 1;
    const out = [];
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 40) {
        depth++;
        out.push(c);
      } else if (c === 41) {
        if (--depth === 0) break;
        out.push(c);
      } else if (c === 92) {
        const d = b[this.pos++];
        switch (d) {
          case 110: out.push(10); break;
          case 114: out.push(13); break;
          case 116: out.push(9); break;
          case 98: out.push(8); break;
          case 102: out.push(12); break;
          case 40: case 41: case 92: out.push(d); break;
          case 13:
            if (b[this.pos] === 10) this.pos++;
            break;
          case 10:
            break;
          default:
            if (d >= 48 && d <= 55) {
              let v = d - 48;
              for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) v = v * 8 + (b[this.pos++] - 48);
              out.push(v & 0xff);
            } else if (d !== undefined) out.push(d);
        }
      } else if (c === 13) {
        // End-of-line in a string is a single LF.
        if (b[this.pos] === 10) this.pos++;
        out.push(10);
      } else out.push(c);
    }
    let s = '';
    for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.slice(i, i + 0x8000));
    return s;
  }

  hex() {
    const b = this.b;
    let s = '';
    let hi = -1;
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 62) break;
      const v = hexVal(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        s += String.fromCharCode((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) s += String.fromCharCode(hi << 4);
    return s;
  }

  name() {
    const b = this.b;
    let s = '';
    while (this.pos < this.end && !isWS(b[this.pos]) && !isDelim(b[this.pos])) {
      const c = b[this.pos++];
      if (c === 35 && hexVal(b[this.pos]) >= 0 && hexVal(b[this.pos + 1]) >= 0) {
        s += String.fromCharCode((hexVal(b[this.pos]) << 4) | hexVal(b[this.pos + 1]));
        this.pos += 2;
      } else s += String.fromCharCode(c);
    }
    return s;
  }
}

/**
 * Objects from tokens. `xref` (optional) resolves stream lengths given as
 * references. Strings come back as JS byte strings.
 */
export class Parser {
  constructor(lexer, xref = null, { allowStreams = true } = {}) {
    this.lexer = lexer;
    this.xref = xref;
    this.allowStreams = allowStreams;
    this.buf = [];
  }

  token() {
    return this.buf.length ? this.buf.shift() : this.lexer.next();
  }

  peek(i = 0) {
    while (this.buf.length <= i) this.buf.push(this.lexer.next());
    return this.buf[i];
  }

  /** The next object, or EOF. Operators come back as Cmd. */
  getObj() {
    const t = this.token();
    if (t === EOF) return EOF;
    if (typeof t === 'number') {
      // "num gen R" is an indirect reference.
      if (Number.isInteger(t) && t >= 0) {
        const t1 = this.peek(0);
        if (typeof t1 === 'number' && Number.isInteger(t1) && t1 >= 0 && isCmd(this.peek(1), 'R')) {
          this.buf.splice(0, 2);
          return new Ref(t, t1);
        }
      }
      return t;
    }
    if (t && typeof t === 'object' && 'str' in t) return t.str;
    if (t instanceof Name) return t;
    if (t instanceof Cmd) {
      switch (t.cmd) {
        case '[': {
          const arr = [];
          for (;;) {
            const p = this.peek(0);
            if (p === EOF) return arr;
            if (isCmd(p, ']')) {
              this.token();
              return arr;
            }
            const v = this.getObj();
            if (v === EOF) return arr;
            if (v instanceof Cmd && (v.cmd === '>>' || v.cmd === 'endobj')) return arr;
            arr.push(v);
          }
        }
        case '<<': {
          const dict = new PDFDict(this.xref);
          for (;;) {
            const k = this.token();
            if (k === EOF || isCmd(k, '>>')) break;
            if (!(k instanceof Name)) {
              if (isCmd(k, 'endobj') || isCmd(k, 'stream')) {
                this.buf.unshift(k);
                break;
              }
              continue;
            }
            const p = this.peek(0);
            if (isCmd(p, '>>')) {
              dict.set(k.name, null);
              continue;
            }
            const v = this.getObj();
            if (v === EOF) break;
            dict.set(k.name, v);
          }
          if (this.allowStreams && isCmd(this.peek(0), 'stream')) {
            this.buf.shift();
            return this.stream(dict);
          }
          return dict;
        }
        case 'true':
          return true;
        case 'false':
          return false;
        case 'null':
          return null;
        default:
          return t;
      }
    }
    return t;
  }

  /** Read stream data after the `stream` keyword. */
  stream(dict) {
    const lx = this.lexer;
    const b = lx.b;
    let p = lx.pos;
    // The keyword is followed by CRLF or LF (sometimes CR or spaces).
    while (b[p] === 32) p++;
    if (b[p] === 13) p++;
    if (b[p] === 10) p++;
    let length = dict.get('Length');
    if (typeof length !== 'number' || length < 0) length = -1;
    let end = length >= 0 ? p + length : -1;
    if (end < 0 || end > lx.end || !endstreamNear(b, end)) {
      const found = findEndstream(b, p, lx.end);
      if (found >= 0) end = found;
      else if (end < 0 || end > lx.end) end = lx.end;
    }
    const raw = b.subarray(p, end);
    lx.pos = end;
    // Skip "endstream".
    const t = lx.next();
    if (!isCmd(t, 'endstream')) this.buf.push(t);
    return new PDFStream(dict, raw);
  }
}

function endstreamNear(b, end) {
  let p = end;
  while (p < b.length && (b[p] === 13 || b[p] === 10 || b[p] === 32)) p++;
  return b[p] === 101 && b[p + 1] === 110 && b[p + 2] === 100 && b[p + 3] === 115; // "ends"
}

/** Position of the end of stream data before "endstream" (EOL before it excluded). */
export function findEndstream(b, from, to) {
  const pat = [101, 110, 100, 115, 116, 114, 101, 97, 109];
  outer: for (let i = from; i <= to - pat.length; i++) {
    if (b[i] !== 101) continue;
    for (let k = 1; k < pat.length; k++) if (b[i + k] !== pat[k]) continue outer;
    let e = i;
    if (b[e - 1] === 10) e--;
    if (b[e - 1] === 13) e--;
    return Math.max(from, e);
  }
  return -1;
}
