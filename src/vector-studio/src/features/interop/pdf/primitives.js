/**
 * PDF object model: names, references, operators, dictionaries and
 * streams. Strings are JS strings of byte values (one char per byte, 0-255),
 * so text decoding can work on char codes; numbers, booleans, null and
 * arrays are plain JS values.
 */

const names = new Map();
export class Name {
  constructor(name) {
    this.name = name;
  }

  static get(name) {
    let n = names.get(name);
    if (!n) names.set(name, (n = new Name(name)));
    return n;
  }

  toString() {
    return `/${this.name}`;
  }
}

export class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }

  toString() {
    return `${this.num} ${this.gen} R`;
  }
}

const cmds = new Map();
/** An operator or keyword (content stream operators, `obj`, `R`, `true`...). */
export class Cmd {
  constructor(cmd) {
    this.cmd = cmd;
  }

  static get(cmd) {
    let c = cmds.get(cmd);
    if (!c) cmds.set(cmd, (c = new Cmd(cmd)));
    return c;
  }
}

export const isName = (v, name) => v instanceof Name && (name === undefined || v.name === name);
export const isCmd = (v, cmd) => v instanceof Cmd && (cmd === undefined || v.cmd === cmd);
export const isRef = (v) => v instanceof Ref;

/** A dictionary whose values resolve indirect references through the document. */
export class PDFDict {
  constructor(xref = null) {
    this.map = new Map();
    this.xref = xref;
  }

  /** The value for the first key present (aliases like 'F', 'Filter'), with references resolved. */
  get(...keys) {
    for (const k of keys) {
      if (!this.map.has(k)) continue;
      const v = this.map.get(k);
      return v instanceof Ref && this.xref ? this.xref.fetch(v) : v;
    }
    return undefined;
  }

  getRaw(key) {
    return this.map.get(key);
  }

  has(key) {
    return this.map.has(key);
  }

  set(key, value) {
    this.map.set(key, value);
  }

  keys() {
    return [...this.map.keys()];
  }

  /** A number value (with a fallback when missing or not a number). */
  num(key, fallback = 0) {
    const v = this.get(key);
    return typeof v === 'number' ? v : fallback;
  }

  /** A name value as a JS string, or the fallback. */
  name(key, fallback = null) {
    const v = this.get(key);
    return v instanceof Name ? v.name : fallback;
  }

  /** An array value with its items resolved. */
  array(key) {
    const v = this.get(key);
    if (!Array.isArray(v)) return null;
    return v.map((x) => (x instanceof Ref && this.xref ? this.xref.fetch(x) : x));
  }
}

/**
 * A stream: its dictionary and raw (still encoded) bytes. `decoded()`
 * applies the stream's filters (see filters.js, installed by the document).
 */
export class PDFStream {
  constructor(dict, raw) {
    this.dict = dict;
    this.raw = raw;
    this.cache = null;
  }

  decoded() {
    if (!this.cache) this.cache = PDFStream.decode(this);
    return this.cache;
  }

  /** Overridden by filters.js. */
  static decode(stream) {
    return stream.raw;
  }
}

/** Resolve a value that may be a reference. */
export function resolve(xref, v) {
  return v instanceof Ref && xref ? xref.fetch(v) : v;
}

/** Bytes (Uint8Array) of a byte string. */
export function strBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

/** Byte string of bytes. */
export function bytesStr(bytes, start = 0, end = bytes.length) {
  let s = '';
  for (let i = start; i < end; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(end, i + 0x8000)));
  return s;
}

/** A PDF text string (UTF-16BE with BOM, UTF-8 with BOM, or PDFDocEncoding ~ Latin-1) as JS text. */
export function textString(s) {
  if (typeof s !== 'string') return '';
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
    return out;
  }
  if (s.charCodeAt(0) === 0xef && s.charCodeAt(1) === 0xbb && s.charCodeAt(2) === 0xbf) {
    try {
      return new TextDecoder().decode(strBytes(s.slice(3)));
    } catch {
      return s.slice(3);
    }
  }
  return s;
}
