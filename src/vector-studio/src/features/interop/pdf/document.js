/**
 * PDF file structure: cross-reference tables and streams (with /Prev
 * chains and hybrid files), object streams, the trailer, the page tree
 * with inherited attributes, and reconstruction of the object table by
 * scanning the file when the cross-reference data is missing or damaged.
 *
 * Encrypted files using the standard security handler are decrypted with
 * the password given to the constructor (or an empty one, which opens files
 * that only restrict printing or copying); see crypto.js. A missing or
 * wrong password throws a PDFError with code 'password'.
 */
import { Lexer, Parser, EOF } from './lexer.js';
import { Ref, PDFDict, PDFStream, Name, isCmd, textString } from './primitives.js';
import { createDecryptor, isStandardEncryption } from './crypto.js';
import './filters.js';

export class PDFError extends Error {
  constructor(message, code = 'invalid') {
    super(message);
    this.code = code;
  }
}

const latin = (b, s, e) => {
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
};

/** Offset of "%PDF-" within the first KB (some files have junk before the header), or -1. */
export function pdfHeaderOffset(bytes) {
  const n = Math.min(bytes.length - 5, 1024);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 37 && bytes[i + 1] === 80 && bytes[i + 2] === 68 && bytes[i + 3] === 70 && bytes[i + 4] === 45) return i;
  }
  return -1;
}

export function isPDF(bytes) {
  return pdfHeaderOffset(bytes) >= 0;
}

export class PDFDocument {
  /**
   * bytes: the file (Uint8Array); opts: { password } for encrypted files
   * (used to derive the decryption key, not kept). Throws PDFError for
   * files that cannot be read.
   */
  constructor(bytes, { password = '' } = {}) {
    const off = pdfHeaderOffset(bytes);
    if (off < 0) throw new PDFError('This is not a PDF file.');
    this.bytes = off ? bytes.subarray(off) : bytes;
    this.entries = new Map(); // num -> { type: 'n', offset, gen } | { type: 'c', stm, index }
    this.cache = new Map();
    this.trailer = null;
    this.decryptor = null;
    this.repaired = false;
    this.version = latin(this.bytes, 5, 8);
    try {
      this.readXref();
    } catch {
      this.entries.clear();
      this.trailer = null;
    }
    if (!this.trailer || !this.catalogOk()) this.reconstruct();
    const enc = this.trailer.get('Encrypt');
    if (enc) {
      const id = this.trailer.get('ID');
      this.decryptor = createDecryptor(enc, Array.isArray(id) ? id[0] : '', password);
      if (!this.decryptor) {
        if (isStandardEncryption(enc)) throw new PDFError(password ? 'The password is not correct.' : 'This PDF needs a password to open.', 'password');
        throw new PDFError('This PDF is protected with an encryption method that cannot be opened here.', 'encrypted');
      }
      this.encryptRef = this.trailer.getRaw('Encrypt');
      this.cache.clear();
    }
    this.catalog = this.trailer.get('Root');
    if (!(this.catalog instanceof PDFDict)) throw new PDFError('The PDF has no document catalog.');
    this.pages = [];
    this.collectPages(this.catalog.get('Pages'), {}, new Set());
    if (!this.pages.length) throw new PDFError('The PDF has no pages.');
  }

  catalogOk() {
    try {
      const root = this.trailer.get('Root');
      return root instanceof PDFDict && root.get('Pages') instanceof PDFDict;
    } catch {
      return false;
    }
  }

  // ---- cross-reference data ----

  readXref() {
    const b = this.bytes;
    // startxref near the end.
    const tail = latin(b, Math.max(0, b.length - 2048), b.length);
    const m = /startxref\s+(\d+)/g;
    let last = null;
    let r;
    while ((r = m.exec(tail))) last = r;
    if (!last) throw new PDFError('No startxref');
    let offset = Number(last[1]);
    const seen = new Set();
    while (offset >= 0 && !seen.has(offset)) {
      seen.add(offset);
      const trailer = this.readXrefAt(offset);
      if (!this.trailer) this.trailer = trailer;
      // Hybrid files: the classic table points to a cross-reference stream too.
      const stm = trailer.get('XRefStm');
      if (typeof stm === 'number' && !seen.has(stm)) {
        seen.add(stm);
        try {
          this.readXrefAt(stm);
        } catch {
          /* ignore */
        }
      }
      const prev = trailer.get('Prev');
      offset = typeof prev === 'number' ? prev : -1;
    }
  }

  /** Read the table or stream at `offset`; earlier-read entries win (newer sections are read first). */
  readXrefAt(offset) {
    const b = this.bytes;
    let p = offset;
    while (p < b.length && (b[p] === 32 || b[p] === 10 || b[p] === 13)) p++;
    if (latin(b, p, p + 4) === 'xref') return this.readTable(p + 4);
    const parser = new Parser(new Lexer(b, p), this);
    const num = parser.getObj();
    const gen = parser.getObj();
    const kw = parser.getObj();
    if (typeof num !== 'number' || typeof gen !== 'number' || !isCmd(kw, 'obj')) throw new PDFError('Bad xref offset');
    const stream = parser.getObj();
    if (!(stream instanceof PDFStream) || stream.dict.name('Type') !== 'XRef') throw new PDFError('Bad xref stream');
    this.readXrefStream(stream);
    return stream.dict;
  }

  readTable(pos) {
    const b = this.bytes;
    const lexer = new Lexer(b, pos);
    for (;;) {
      const save = lexer.pos;
      const t = lexer.next();
      if (isCmd(t, 'trailer')) break;
      if (typeof t !== 'number') {
        lexer.pos = save;
        break;
      }
      const start = t;
      const count = lexer.next();
      if (typeof count !== 'number') throw new PDFError('Bad xref subsection');
      for (let i = 0; i < count; i++) {
        const off = lexer.next();
        const gen = lexer.next();
        const type = lexer.next();
        if (typeof off !== 'number' || typeof gen !== 'number' || !(type instanceof Object)) throw new PDFError('Bad xref entry');
        const num = start + i;
        // Some writers start the first subsection at 1 while listing object 0.
        if (type.cmd === 'n' && !this.entries.has(num)) this.entries.set(num, { type: 'n', offset: off, gen });
        else if (type.cmd === 'f' && !this.entries.has(num)) this.entries.set(num, { type: 'f' });
      }
    }
    const parser = new Parser(lexer, this);
    const trailer = parser.getObj();
    if (!(trailer instanceof PDFDict)) throw new PDFError('Bad trailer');
    return trailer;
  }

  readXrefStream(stream) {
    const d = stream.dict;
    const w = d.get('W');
    const size = d.num('Size', 0);
    let index = d.get('Index');
    if (!Array.isArray(index)) index = [0, size];
    const data = stream.decoded();
    const [w0, w1, w2] = w;
    const rec = w0 + w1 + w2;
    let p = 0;
    const field = (n, dflt) => {
      if (!n) return dflt;
      let v = 0;
      for (let i = 0; i < n; i++) v = v * 256 + data[p++];
      return v;
    };
    for (let s = 0; s + 1 < index.length; s += 2) {
      const first = index[s];
      const count = index[s + 1];
      for (let i = 0; i < count && p + rec <= data.length; i++) {
        const type = field(w0, 1);
        const f2 = field(w1, 0);
        const f3 = field(w2, 0);
        const num = first + i;
        if (this.entries.has(num)) continue;
        if (type === 1) this.entries.set(num, { type: 'n', offset: f2, gen: f3 });
        else if (type === 2) this.entries.set(num, { type: 'c', stm: f2, index: f3 });
        else if (type === 0) this.entries.set(num, { type: 'f' });
      }
    }
  }

  /** Map of object number -> offset of its last "n g obj" in the file (later definitions win). */
  scanObjects({ trailers = null, xrefStreams = null } = {}) {
    const b = this.bytes;
    const out = new Map();
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      if (trailers && c === 116 && b[i + 1] === 114 && latin(b, i, i + 7) === 'trailer') {
        try {
          const t = new Parser(new Lexer(b, i + 7), this).getObj();
          if (t instanceof PDFDict) trailers.push(t);
        } catch {
          /* ignore */
        }
        i += 7;
        continue;
      }
      if (c < 48 || c > 57 || (i > 0 && b[i - 1] >= 48 && b[i - 1] <= 57)) continue;
      // "num gen obj" at a line start or after whitespace.
      let p = i;
      let num = 0;
      while (b[p] >= 48 && b[p] <= 57) num = num * 10 + (b[p++] - 48);
      if (b[p] !== 32 && b[p] !== 10 && b[p] !== 13) continue;
      while (b[p] === 32 || b[p] === 10 || b[p] === 13) p++;
      if (b[p] < 48 || b[p] > 57) continue;
      while (b[p] >= 48 && b[p] <= 57) p++;
      while (b[p] === 32 || b[p] === 10 || b[p] === 13) p++;
      if (b[p] !== 111 || b[p + 1] !== 98 || b[p + 2] !== 106) continue;
      out.set(num, i);
      if (xrefStreams && latin(b, p + 3, Math.min(b.length, p + 120)).includes('/XRef')) xrefStreams.push(num);
      i = p + 2;
    }
    return out;
  }

  /** Rebuild the object table by scanning for "n g obj" and find a trailer. */
  reconstruct() {
    this.repaired = true;
    this.entries.clear();
    this.cache.clear();
    const trailers = [];
    const xrefStreams = [];
    this.scanned = this.scanObjects({ trailers, xrefStreams });
    for (const [num, offset] of this.scanned) this.entries.set(num, { type: 'n', offset, gen: 0 });
    // Objects inside object streams.
    for (const [num, e] of [...this.entries]) {
      if (e.type !== 'n') continue;
      let obj;
      try {
        obj = this.fetch(new Ref(num, e.gen));
      } catch {
        continue;
      }
      if (obj instanceof PDFStream && obj.dict.name('Type') === 'ObjStm') {
        const n = obj.dict.num('N', 0);
        try {
          const offs = this.objStmOffsets(obj, n);
          offs.forEach(([objNum], index) => {
            if (!this.entries.has(objNum)) this.entries.set(objNum, { type: 'c', stm: num, index });
          });
        } catch {
          /* ignore */
        }
      }
    }
    let trailer = trailers.reverse().find((t) => t.get('Root') instanceof PDFDict) || null;
    if (!trailer) {
      for (const num of xrefStreams.reverse()) {
        const s = this.fetch(new Ref(num, this.entries.get(num).gen));
        if (s instanceof PDFStream && s.dict.get('Root') instanceof PDFDict) {
          trailer = s.dict;
          break;
        }
      }
    }
    if (!trailer) {
      // Find a catalog directly.
      for (const [num, e] of this.entries) {
        let obj;
        try {
          obj = this.fetch(new Ref(num, e.gen ?? 0));
        } catch {
          continue;
        }
        if (obj instanceof PDFDict && obj.name('Type') === 'Catalog') {
          trailer = new PDFDict(this);
          trailer.set('Root', new Ref(num, e.gen ?? 0));
          break;
        }
      }
    }
    if (!trailer) throw new PDFError('The PDF is damaged and could not be read.');
    this.trailer = trailer;
  }

  objStmOffsets(stream, n) {
    const data = stream.decoded();
    const lexer = new Lexer(data);
    const out = [];
    for (let i = 0; i < n; i++) {
      const num = lexer.next();
      const off = lexer.next();
      if (typeof num !== 'number' || typeof off !== 'number') break;
      out.push([num, off]);
    }
    return out;
  }

  // ---- objects ----

  /** Resolve a reference (null for missing objects). */
  fetch(ref) {
    if (!(ref instanceof Ref)) return ref;
    const key = ref.num;
    if (this.cache.has(key)) return this.cache.get(key);
    const e = this.entries.get(key);
    let obj = null;
    if (!e || e.type === 'f') obj = null;
    else if (e.type === 'n') obj = this.readObject(ref, e.offset);
    else if (e.type === 'c') obj = this.readCompressed(e.stm, e.index, key);
    this.cache.set(key, obj);
    return obj;
  }

  readObject(ref, offset) {
    // Guard against recursion through /Length references.
    this.cache.set(ref.num, null);
    const parser = new Parser(new Lexer(this.bytes, offset), this);
    const num = parser.getObj();
    const gen = parser.getObj();
    const kw = parser.getObj();
    if (num !== ref.num || typeof gen !== 'number' || !isCmd(kw, 'obj')) {
      // A wrong offset in the table: find the object by scanning the file.
      if (!this.scanned) this.scanned = this.scanObjects();
      const at = this.scanned.get(ref.num);
      if (at === undefined || at === offset) return null;
      return this.readObject(ref, at);
    }
    let obj = parser.getObj();
    if (obj === EOF) obj = null;
    if (this.decryptor && !(this.encryptRef instanceof Ref && this.encryptRef.num === ref.num)) obj = this.decryptor.decryptObject(obj, ref.num, gen);
    return obj;
  }

  readCompressed(stmNum, index, num) {
    const e = this.entries.get(stmNum);
    const stream = this.fetch(new Ref(stmNum, e?.gen ?? 0));
    if (!(stream instanceof PDFStream)) return null;
    if (!stream.objOffsets) stream.objOffsets = this.objStmOffsets(stream, stream.dict.num('N', 0));
    const first = stream.dict.num('First', 0);
    let entry = stream.objOffsets[index];
    if (!entry || entry[0] !== num) entry = stream.objOffsets.find((x) => x[0] === num);
    if (!entry) return null;
    const parser = new Parser(new Lexer(stream.decoded(), first + entry[1]), this, { allowStreams: false });
    const obj = parser.getObj();
    return obj === EOF ? null : obj;
  }

  // ---- pages ----

  collectPages(node, inherited, seen) {
    if (!(node instanceof PDFDict) || seen.has(node)) return;
    seen.add(node);
    const inh = { ...inherited };
    for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node.has(k)) inh[k] = node.get(k);
    const kids = node.get('Kids');
    const type = node.name('Type');
    if (Array.isArray(kids) && type !== 'Page') {
      for (const k of kids) this.collectPages(this.fetch(k), inh, seen);
      return;
    }
    this.pages.push(new PDFPage(this, node, inh, this.pages.length));
  }

  /** Document title from the info dictionary. */
  get title() {
    const info = this.trailer.get('Info');
    const t = info instanceof PDFDict ? info.get('Title') : null;
    return typeof t === 'string' ? textString(t) : '';
  }
}

const rectOf = (v) => {
  if (!Array.isArray(v) || v.length < 4 || v.some((x) => typeof x !== 'number')) return null;
  const [x1, y1, x2, y2] = v;
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
};

function intersect(a, b) {
  if (!a) return b;
  if (!b) return a;
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const t = Math.min(a.y + a.h, b.y + b.h);
  if (r <= x || t <= y) return a;
  return { x, y, w: r - x, h: t - y };
}

export class PDFPage {
  constructor(doc, dict, inherited, index) {
    this.doc = doc;
    this.dict = dict;
    this.index = index;
    this.resources = inherited.Resources instanceof PDFDict ? inherited.Resources : new PDFDict(doc);
    const media = rectOf(inherited.MediaBox) || { x: 0, y: 0, w: 612, h: 792 };
    this.mediaBox = media.w > 0 && media.h > 0 ? media : { x: 0, y: 0, w: 612, h: 792 };
    this.cropBox = intersect(this.mediaBox, rectOf(inherited.CropBox));
    this.bleedBox = intersect(this.cropBox, rectOf(dict.get('BleedBox'))) || this.cropBox;
    this.trimBox = intersect(this.cropBox, rectOf(dict.get('TrimBox'))) || this.cropBox;
    this.artBox = intersect(this.cropBox, rectOf(dict.get('ArtBox'))) || this.cropBox;
    const rot = typeof inherited.Rotate === 'number' ? inherited.Rotate : 0;
    this.rotate = (((Math.round(rot / 90) * 90) % 360) + 360) % 360;
    const unit = dict.get('UserUnit');
    this.userUnit = typeof unit === 'number' && unit > 0 ? unit : 1;
  }

  box(kind) {
    return { media: this.mediaBox, crop: this.cropBox, bleed: this.bleedBox, trim: this.trimBox, art: this.artBox }[kind] || this.cropBox;
  }

  /** The concatenated content streams. */
  contents() {
    let c = this.dict.get('Contents');
    if (!c) return new Uint8Array(0);
    if (!Array.isArray(c)) c = [c];
    const parts = [];
    for (const s of c) {
      const st = this.doc.fetch(s);
      if (!(st instanceof PDFStream)) continue;
      try {
        parts.push(st.decoded());
      } catch {
        /* skip a damaged part */
      }
    }
    let n = 0;
    for (const p of parts) n += p.length + 1;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.length;
      out[o++] = 10;
    }
    return out;
  }

  /** Width and height as displayed (after /Rotate) for a box. */
  size(kind = 'crop') {
    const b = this.box(kind);
    return this.rotate % 180 ? { w: b.h, h: b.w } : { w: b.w, h: b.h };
  }
}

export { Name };
