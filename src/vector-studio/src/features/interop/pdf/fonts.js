/**
 * PDF fonts: decoding shown strings into glyphs with Unicode text and
 * widths, family/weight/style for editable text, and glyph outlines from
 * embedded font programs (TrueType, CFF, Type 1) or Type 3 glyph
 * procedures.
 *
 * A glyph: { code, unicode, width (text space units per 1 unit of size,
 * i.e. advance/1000 for most fonts), space (single-byte code 32),
 * key (for outline lookup) }.
 */
import { PDFDict, PDFStream, Name, Ref } from './primitives.js';
import { ENCODINGS, STANDARD, glyphNameToUnicode, winAnsiUnicode } from './encodings.js';
import { parseCMap, encodingCMap } from './cmap.js';
import { SfntFont } from './truetype.js';
import { parseCFF } from './cff.js';
import { parseType1 } from './type1.js';

const STD14 = {
  Helvetica: ['sans', 400, 'normal'], 'Helvetica-Bold': ['sans', 700, 'normal'], 'Helvetica-Oblique': ['sans', 400, 'italic'], 'Helvetica-BoldOblique': ['sans', 700, 'italic'],
  Arial: ['sans', 400, 'normal'], ArialMT: ['sans', 400, 'normal'], 'Arial-BoldMT': ['sans', 700, 'normal'], 'Arial-ItalicMT': ['sans', 400, 'italic'], 'Arial-BoldItalicMT': ['sans', 700, 'italic'],
  'Times-Roman': ['serif', 400, 'normal'], 'Times-Bold': ['serif', 700, 'normal'], 'Times-Italic': ['serif', 400, 'italic'], 'Times-BoldItalic': ['serif', 700, 'italic'],
  TimesNewRomanPSMT: ['serif', 400, 'normal'], 'TimesNewRomanPS-BoldMT': ['serif', 700, 'normal'], 'TimesNewRomanPS-ItalicMT': ['serif', 400, 'italic'], 'TimesNewRomanPS-BoldItalicMT': ['serif', 700, 'italic'],
  Courier: ['mono', 400, 'normal'], 'Courier-Bold': ['mono', 700, 'normal'], 'Courier-Oblique': ['mono', 400, 'italic'], 'Courier-BoldOblique': ['mono', 700, 'italic'], CourierNewPSMT: ['mono', 400, 'normal'],
  Symbol: ['symbol', 400, 'normal'], ZapfDingbats: ['symbol', 400, 'normal'],
};

const WEIGHTS = [
  [/thin|hairline/, 100], [/extralight|ultralight/, 200], [/light/, 300], [/semibold|demibold|demi/, 600], [/extrabold|ultrabold|heavy/, 800], [/black/, 900], [/bold/, 700], [/medium/, 500],
];

/** { family, weight, style, category } from a PDF font name like "ABCDEF+OpenSans-SemiBoldItalic" or "Arial,Bold". */
export function parseFontName(raw, descriptor = null) {
  const name = String(raw || '').replace(/^[A-Z]{6}\+/, '');
  if (STD14[name]) {
    const [category, weight, style] = STD14[name];
    return { family: name.split(/[-,]/)[0].replace(/MT$|PSMT$|PS$/, ''), weight, style, category, standard: true };
  }
  let [fam, sty = ''] = name.split(/[-,]/);
  // Families written together with their style ("ArialBold", "TimesNewRomanPSMT").
  fam = fam.replace(/(PSMT|PS|MT)$/, '');
  const famStyle = /(Bold|Italic|Oblique|Light|Medium|Black|Semibold|SemiBold|Regular|Roman|Book)+$/.exec(fam);
  if (famStyle && famStyle.index > 0 && !sty) {
    sty = famStyle[0];
    fam = fam.slice(0, famStyle.index);
  }
  const s = sty.toLowerCase();
  let weight = 400;
  for (const [re, w] of WEIGHTS) {
    if (re.test(s)) {
      weight = w;
      break;
    }
  }
  if (descriptor) {
    const fw = descriptor.num('FontWeight', 0);
    if (fw >= 100 && fw <= 900 && weight === 400 && !/regular|roman|book/.test(s)) weight = fw;
    if ((descriptor.num('Flags', 0) & 0x40000) && weight < 700) weight = 700;
  }
  let style = /italic|oblique|slanted/.test(s) ? 'italic' : 'normal';
  if (descriptor && style === 'normal' && (descriptor.num('ItalicAngle', 0) !== 0 || descriptor.num('Flags', 0) & 64)) style = 'italic';
  const descFam = descriptor?.get('FontFamily');
  const family = typeof descFam === 'string' && descFam.trim() ? descFam.trim() : fam.replace(/([a-z])([A-Z])/g, '$1 $2');
  const flags = descriptor ? descriptor.num('Flags', 0) : 0;
  const category = flags & 1 ? 'mono' : flags & 2 ? 'serif' : 'sans';
  return { family, weight, style, category, standard: false };
}

/** Approximate advance (per 1000) for fonts without widths (non-embedded standard fonts). */
function approxWidth(ch, category) {
  if (category === 'mono') return 600;
  if (!ch) return 500;
  if (ch === ' ') return 278;
  if (/[il.,:;'!|]/.test(ch)) return 250;
  if (/[fjrt()\[\]\-]/.test(ch)) return 333;
  if (/[mwMW]/.test(ch)) return 833;
  if (/[A-Z]/.test(ch)) return 667;
  if (/[0-9]/.test(ch)) return 556;
  return 520;
}

export class PDFFont {
  constructor(xref, dict, { warn = () => {} } = {}) {
    this.xref = xref;
    this.dict = dict;
    this.warn = warn;
    this.subtype = dict.name('Subtype', 'Type1');
    this.composite = this.subtype === 'Type0';
    this.baseFont = dict.name('BaseFont', '') || '';
    const desc = this.composite ? this.descendant()?.get('FontDescriptor') : dict.get('FontDescriptor');
    this.descriptor = desc instanceof PDFDict ? desc : null;
    this.info = parseFontName(this.baseFont, this.descriptor);
    this.type3 = this.subtype === 'Type3';
    this.matrix = this.type3 ? dict.array('FontMatrix') || [0.001, 0, 0, 0.001, 0, 0] : [0.001, 0, 0, 0.001, 0, 0];
    this.vertical = false;
    this.program = undefined; // parsed lazily
    this.toUnicode = null;
    const tu = dict.get('ToUnicode');
    if (tu instanceof PDFStream) {
      try {
        this.toUnicode = parseCMap(tu.decoded(), { toUnicode: true });
      } catch {
        this.toUnicode = null;
      }
    } else if (tu instanceof Name && /^Identity-[HV]$/.test(tu.name)) this.toUnicodeIdentity = true;
    if (this.composite) this.initComposite();
    else this.initSimple();
  }

  descendant() {
    const d = this.dict.get('DescendantFonts');
    const f = Array.isArray(d) ? this.xref.fetch(d[0]) : null;
    return f instanceof PDFDict ? f : null;
  }

  initSimple() {
    const d = this.dict;
    this.firstChar = d.num('FirstChar', 0);
    this.widths = d.array('Widths') || null;
    this.missingWidth = this.descriptor ? this.descriptor.num('MissingWidth', 0) : 0;
    // Encoding: base table plus Differences.
    const enc = d.get('Encoding');
    let base = null;
    const diffs = new Map();
    if (enc instanceof Name) base = ENCODINGS[enc.name] || null;
    else if (enc instanceof PDFDict) {
      const bn = enc.name('BaseEncoding');
      if (bn) base = ENCODINGS[bn] || null;
      const arr = enc.array('Differences');
      if (arr) {
        let code = 0;
        for (const x of arr) {
          if (typeof x === 'number') code = x;
          else if (x instanceof Name) diffs.set(code++, x.name);
        }
      }
    }
    this.hasExplicitEncoding = Boolean(base) || diffs.size > 0;
    const flags = this.descriptor ? this.descriptor.num('Flags', 0) : 0;
    this.symbolic = Boolean(flags & 4) && !(flags & 32);
    if (!base) base = this.symbolic || this.type3 ? null : this.subtype === 'TrueType' ? ENCODINGS.WinAnsiEncoding : STANDARD;
    this.baseEncoding = base;
    this.differences = diffs;
    if (this.type3) {
      const procs = d.get('CharProcs');
      this.charProcs = procs instanceof PDFDict ? procs : null;
      const r = d.get('Resources');
      this.resources = r instanceof PDFDict ? r : null;
    }
  }

  initComposite() {
    const { cmap, known } = encodingCMap(this.dict.get('Encoding'));
    this.cmap = cmap;
    this.cmapKnown = known;
    this.vertical = cmap.vertical;
    const cid = this.descendant();
    this.cidFont = cid;
    this.cidSubtype = cid?.name('Subtype', 'CIDFontType2') || 'CIDFontType2';
    this.defaultWidth = cid ? cid.num('DW', 1000) : 1000;
    this.cidWidths = new Map();
    const w = cid?.array('W');
    if (w) {
      for (let i = 0; i < w.length; ) {
        const first = w[i];
        const next = this.xref.fetch(w[i + 1]);
        if (Array.isArray(next)) {
          next.forEach((v, k) => this.cidWidths.set(first + k, this.xref.fetch(v)));
          i += 2;
        } else {
          const last = next;
          const v = w[i + 2];
          for (let c = first; c <= last && c - first < 65536; c++) this.cidWidths.set(c, v);
          i += 3;
        }
      }
    }
    const map = cid?.get('CIDToGIDMap');
    if (map instanceof PDFStream) {
      try {
        this.cidToGid = map.decoded();
      } catch {
        this.cidToGid = null;
      }
    }
  }

  /** Glyph name for a simple-font code (Differences, then base encoding, then the program's own encoding). */
  glyphNameFor(code) {
    if (this.differences.has(code)) return this.differences.get(code);
    if (this.baseEncoding && this.baseEncoding[code]) return this.baseEncoding[code];
    const prog = this.loadProgram();
    if (prog?.kind === 'type1') return prog.font.encoding.get(code) || '';
    if (prog?.kind === 'cff' && !prog.font.isCID) {
      const g = prog.font.encoding.get(code);
      return g !== undefined ? prog.font.glyphName(g) : '';
    }
    return '';
  }

  /** Decode a byte string into glyphs. */
  decode(str) {
    const out = [];
    if (this.composite) {
      for (const { code, bytes } of this.cmap.codes(str)) {
        const cid = this.cmap.lookup(code);
        const c = typeof cid === 'number' ? cid : code;
        let unicode = this.toUnicode?.lookup(code);
        if (unicode === undefined && this.toUnicodeIdentity) unicode = String.fromCharCode(code);
        const w = this.cidWidths.get(c) ?? this.defaultWidth;
        out.push({ code, cid: c, unicode: typeof unicode === 'string' ? unicode : '', width: w / 1000, space: bytes === 1 && code === 32 });
      }
      return out;
    }
    for (let i = 0; i < str.length; i++) {
      const code = str.charCodeAt(i);
      let unicode = this.toUnicode?.lookup(code);
      const name = this.glyphNameFor(code);
      if (typeof unicode !== 'string') {
        unicode = glyphNameToUnicode(name);
        if (!unicode && !this.type3 && (this.symbolic || !name)) unicode = code >= 32 ? String.fromCharCode(winAnsiUnicode(code)) : '';
      }
      let w;
      const wi = code - this.firstChar;
      if (this.widths && wi >= 0 && wi < this.widths.length && typeof this.widths[wi] === 'number') w = this.widths[wi];
      else if (this.widths || this.missingWidth) w = this.missingWidth;
      else w = approxWidth(unicode, this.info.category);
      // Type 3 widths are in glyph space.
      const width = this.type3 ? w * this.matrix[0] : w / 1000;
      out.push({ code, unicode, name, width, space: code === 32 });
    }
    return out;
  }

  /** Whether every glyph of the string has Unicode text (needed for editable text). */
  static hasText(glyphs) {
    return glyphs.every((g) => g.unicode);
  }

  // ---- outlines ----

  loadProgram() {
    if (this.program !== undefined) return this.program;
    this.program = null;
    const desc = this.descriptor;
    if (!desc) return null;
    const ff = desc.get('FontFile');
    const ff2 = desc.get('FontFile2');
    const ff3 = desc.get('FontFile3');
    try {
      if (ff2 instanceof PDFStream) this.program = { kind: 'sfnt', font: new SfntFont(ff2.decoded()) };
      else if (ff3 instanceof PDFStream) {
        const sub = ff3.dict.name('Subtype', '');
        const data = ff3.decoded();
        if (sub === 'OpenType') this.program = { kind: 'sfnt', font: new SfntFont(data) };
        else this.program = { kind: 'cff', font: parseCFF(data) };
      } else if (ff instanceof PDFStream) {
        this.program = { kind: 'type1', font: parseType1(ff.decoded(), { length1: ff.dict.num('Length1', 0) }) };
      }
    } catch {
      this.program = null;
    }
    if (this.program?.kind === 'sfnt' && this.program.font.cff) this.program = { kind: 'cff', font: this.program.font.cff, sfnt: this.program.font };
    return this.program;
  }

  /** True when glyph outlines can be drawn for this font. */
  get hasOutlines() {
    if (this.type3) return Boolean(this.charProcs);
    return Boolean(this.loadProgram());
  }

  /**
   * Outline of a glyph as path commands in text space units (already
   * scaled by the font matrix, y up), or null.
   */
  glyphOutline(g) {
    const prog = this.loadProgram();
    if (!prog) return null;
    let cmds = null;
    let scale = [0.001, 0, 0, 0.001, 0, 0];
    if (prog.kind === 'sfnt') {
      const f = prog.font;
      const gid = this.gidFor(g, f);
      if (gid === null) return null;
      cmds = f.glyphPath(gid);
      const s = 1 / (f.unitsPerEm || 1000);
      scale = [s, 0, 0, s, 0, 0];
    } else if (prog.kind === 'cff') {
      const f = prog.font;
      let gid = null;
      if (this.composite) {
        if (f.isCID) gid = f.cidToGid.get(g.cid) ?? (this.cidToGidMapped(g.cid) ?? null);
        else gid = this.cidToGidMapped(g.cid) ?? g.cid;
      } else {
        const name = this.glyphNameFor(g.code);
        gid = name && f.nameToGid.has(name) ? f.nameToGid.get(name) : f.encoding.get(g.code) ?? null;
      }
      if (gid === null || gid === undefined) return null;
      cmds = f.glyphPath(gid);
      scale = f.matrix;
    } else if (prog.kind === 'type1') {
      const f = prog.font;
      let name = this.glyphNameFor(g.code);
      if (!f.has(name)) name = f.encoding.get(g.code) || name;
      if (!f.has(name)) return null;
      cmds = f.glyphPath(name);
      scale = f.matrix;
    }
    if (!cmds) return null;
    const [a, b, c, d, e, f2] = scale;
    return cmds.map((cmd) => {
      if (cmd[0] === 'Z') return cmd;
      const t = [cmd[0]];
      for (let i = 1; i < cmd.length; i += 2) t.push(a * cmd[i] + c * cmd[i + 1] + e, b * cmd[i] + d * cmd[i + 1] + f2);
      return t;
    });
  }

  cidToGidMapped(cid) {
    if (!this.cidToGid) return null;
    const i = cid * 2;
    if (i + 1 >= this.cidToGid.length) return null;
    return (this.cidToGid[i] << 8) | this.cidToGid[i + 1];
  }

  /** Glyph index of a glyph in a TrueType program. */
  gidFor(g, f) {
    if (this.composite) return this.cidToGidMapped(g.cid) ?? g.cid;
    const code = g.code;
    const c30 = f.cmap(3, 0);
    const c31 = f.cmap(3, 1);
    const c10 = f.cmap(1, 0);
    if (!this.symbolic || this.hasExplicitEncoding) {
      const name = this.glyphNameFor(code);
      if (name && f.post.has(name)) return f.post.get(name);
      const uni = glyphNameToUnicode(name);
      if (uni && c31?.has(uni.codePointAt(0))) return c31.get(uni.codePointAt(0));
    }
    if (c30) {
      for (const k of [code, 0xf000 + code, 0xf100 + code, 0xf200 + code]) if (c30.has(k)) return c30.get(k);
    }
    if (c10?.has(code)) return c10.get(code);
    if (c31?.has(code)) return c31.get(code);
    return code < f.numGlyphs || !f.numGlyphs ? code : null;
  }

  /** Type 3 glyph procedure stream for a code. */
  charProc(code) {
    if (!this.charProcs) return null;
    const name = this.glyphNameFor(code);
    const s = name ? this.charProcs.get(name) : null;
    return s instanceof PDFStream ? s : null;
  }
}

/** Load a font resource (cached per dictionary). */
export function loadFont(xref, ref, cache, opts) {
  const key = ref instanceof Ref ? `r${ref.num}` : ref;
  if (cache.has(key)) return cache.get(key);
  const dict = xref.fetch(ref);
  let font = null;
  if (dict instanceof PDFDict) {
    try {
      font = new PDFFont(xref, dict, opts);
    } catch {
      font = null;
    }
  }
  cache.set(key, font);
  return font;
}
