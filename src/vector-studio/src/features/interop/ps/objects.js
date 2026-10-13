/**
 * PostScript objects and the tokenizer. Numbers and booleans are JS
 * values; names, strings, arrays (procedures), dictionaries, operators,
 * marks and files are small classes so the interpreter can tell literal
 * from executable objects.
 */

export class PSName {
  constructor(name, exec) {
    this.name = name;
    this.exec = exec;
  }
}
const LIT = new Map();
const EXE = new Map();
export function nameOf(name, exec = false) {
  const t = exec ? EXE : LIT;
  let n = t.get(name);
  if (!n) t.set(name, (n = new PSName(name, exec)));
  return n;
}

export class PSString {
  constructor(bytes, off = 0, len = bytes.length) {
    this.bytes = bytes;
    this.off = off;
    this.len = len;
    this.exec = false;
  }

  static from(text) {
    const b = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i) & 255;
    return new PSString(b);
  }

  get(i) {
    return this.bytes[this.off + i];
  }

  set(i, v) {
    this.bytes[this.off + i] = v & 255;
  }

  data() {
    return this.bytes.subarray(this.off, this.off + this.len);
  }

  text() {
    let s = '';
    const d = this.data();
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return s;
  }
}

export class PSArray {
  constructor(items, exec = false, off = 0, len = items.length) {
    this.items = items;
    this.exec = exec;
    this.off = off;
    this.len = len;
  }

  get(i) {
    return this.items[this.off + i];
  }

  set(i, v) {
    this.items[this.off + i] = v;
  }

  list() {
    return this.off === 0 && this.len === this.items.length ? this.items : this.items.slice(this.off, this.off + this.len);
  }
}

export class PSDict {
  constructor() {
    this.map = new Map();
    this.exec = false;
  }

  static key(k) {
    if (k instanceof PSName) return k.name;
    if (k instanceof PSString) return k.text();
    if (typeof k === 'number') return `#${k}`;
    if (typeof k === 'boolean') return `?${k}`;
    return k;
  }

  get(k) {
    return this.map.get(PSDict.key(k));
  }

  has(k) {
    return this.map.has(PSDict.key(k));
  }

  set(k, v) {
    this.map.set(PSDict.key(k), v);
  }

  delete(k) {
    this.map.delete(PSDict.key(k));
  }
}

export class PSOp {
  constructor(name, fn) {
    this.name = name;
    this.fn = fn;
    this.exec = true;
  }
}

export const MARK = { mark: true };

/**
 * A readable file: the program itself (currentfile) or decoded filter
 * data. Filter data is produced on first read (`source` may be a function
 * returning { bytes, pos, end }), since a filter is usually created before
 * the data it reads appears in the program.
 */
export class PSFile {
  constructor(source) {
    this.lazy = typeof source === 'function' ? source : null;
    this.src = this.lazy ? null : source;
    this.exec = false;
  }

  get source() {
    if (!this.src) this.src = this.lazy();
    return this.src;
  }

  /** Read one byte (-1 at the end). */
  read() {
    const s = this.source;
    if (s.pos >= s.end) return -1;
    return s.bytes[s.pos++];
  }

  get pos() {
    return this.source.pos;
  }

  set pos(v) {
    this.source.pos = v;
  }
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

/** Tokenizer over bytes; `pos` is shared with currentfile reads. */
export class Scanner {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.bytes = bytes;
    this.pos = pos;
    this.end = end;
  }

  skip() {
    const b = this.bytes;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (WS.has(c)) this.pos++;
      else if (c === 37) {
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
      } else break;
    }
  }

  /** The next token, or undefined at the end. Procedures come back as executable PSArrays. */
  next() {
    this.skip();
    if (this.pos >= this.end) return undefined;
    const b = this.bytes;
    const c = b[this.pos];
    if (c === 123) {
      this.pos++;
      const items = [];
      for (;;) {
        this.skip();
        if (this.pos >= this.end) break;
        if (b[this.pos] === 125) {
          this.pos++;
          break;
        }
        const t = this.next();
        if (t === undefined) break;
        items.push(t);
      }
      return new PSArray(items, true);
    }
    if (c === 125) {
      this.pos++;
      return nameOf('}', true);
    }
    if (c === 40) {
      this.pos++;
      return this.literal();
    }
    if (c === 60) {
      if (b[this.pos + 1] === 60) {
        this.pos += 2;
        return nameOf('<<', true);
      }
      if (b[this.pos + 1] === 126) {
        this.pos += 2;
        return this.ascii85();
      }
      this.pos++;
      return this.hex();
    }
    if (c === 62 && b[this.pos + 1] === 62) {
      this.pos += 2;
      return nameOf('>>', true);
    }
    if (c === 91 || c === 93) {
      this.pos++;
      return nameOf(String.fromCharCode(c), true);
    }
    if (c === 47) {
      this.pos++;
      let immediate = false;
      if (b[this.pos] === 47) {
        immediate = true;
        this.pos++;
      }
      const n = this.word();
      return immediate ? { immediate: n } : nameOf(n, false);
    }
    const w = this.word() || String.fromCharCode(b[this.pos++]);
    const num = parseNumber(w);
    if (num !== null) return num;
    return nameOf(w, true);
  }

  word() {
    const b = this.bytes;
    const s = this.pos;
    while (this.pos < this.end && !WS.has(b[this.pos]) && !DELIM.has(b[this.pos])) this.pos++;
    let out = '';
    for (let i = s; i < this.pos; i++) out += String.fromCharCode(b[i]);
    return out;
  }

  literal() {
    const b = this.bytes;
    const out = [];
    let depth = 1;
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
        const esc = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 }[d];
        if (esc !== undefined) out.push(esc);
        else if (d >= 48 && d <= 55) {
          let v = d - 48;
          for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) v = v * 8 + (b[this.pos++] - 48);
          out.push(v & 255);
        } else if (d === 13) {
          if (b[this.pos] === 10) this.pos++;
        } else if (d !== 10) out.push(d);
      } else out.push(c);
    }
    return new PSString(Uint8Array.from(out));
  }

  hex() {
    const b = this.bytes;
    const out = [];
    let hi = -1;
    while (this.pos < this.end) {
      const c = b[this.pos++];
      if (c === 62) break;
      const v = hexv(c);
      if (v < 0) continue;
      if (hi < 0) hi = v;
      else {
        out.push((hi << 4) | v);
        hi = -1;
      }
    }
    if (hi >= 0) out.push(hi << 4);
    return new PSString(Uint8Array.from(out));
  }

  ascii85() {
    const start = this.pos;
    const b = this.bytes;
    while (this.pos < this.end && !(b[this.pos] === 126 && b[this.pos + 1] === 62)) this.pos++;
    const chunk = b.subarray(start, this.pos);
    this.pos += 2;
    return new PSString(decodeA85(chunk));
  }
}

export function hexv(c) {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 65 && c <= 70) return c - 55;
  if (c >= 97 && c <= 102) return c - 87;
  return -1;
}

export function decodeA85(b) {
  const out = [];
  const g = [];
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 126) break;
    if (c === 122 && !g.length) {
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117) continue;
    g.push(c - 33);
    if (g.length === 5) {
      let v = 0;
      for (const d of g) v = v * 85 + d;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      g.length = 0;
    }
  }
  if (g.length > 1) {
    const k = g.length;
    while (g.length < 5) g.push(84);
    let v = 0;
    for (const d of g) v = v * 85 + d;
    for (let j = 0; j < k - 1; j++) out.push((v >>> (24 - 8 * j)) & 255);
  }
  return Uint8Array.from(out);
}

function parseNumber(w) {
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(w)) return Number(w);
  const m = /^(\d+)#([0-9a-zA-Z]+)$/.exec(w);
  if (m) {
    const v = parseInt(m[2], Number(m[1]));
    return Number.isNaN(v) ? null : v;
  }
  return null;
}
