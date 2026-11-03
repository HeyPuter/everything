/**
 * ASCII DXF reader. Converts the group-code stream of a DXF file into the
 * drawing model described in core/schema.js.
 *
 * The text is scanned once with indexOf-based line splitting. Groups are
 * collected per record (everything from one 0 group to the next) into two
 * reused parallel arrays, so no object is allocated per group.
 */
import { defaultHeader, defaultLayer, COLOR_BYLAYER, LW_BYLAYER, LW_DEFAULT, TWO_PI } from '../../core/schema.js';
import { rgbToHex } from '../../core/colors.js';
import { STANDARD_LINETYPES } from '../../core/linetypes.js';
import { defaultTextStyle, defaultDimStyle } from '../../core/styles.js';
import {
  normAngle,
  uniformKnots,
  clampSpline,
  fitToSpline,
  tessellateSpline,
  ellipsePoints,
  conjugateToEllipse,
} from './geom.js';

const DEG = Math.PI / 180;
const ATTACH = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const VALIGN = ['baseline', 'bottom', 'middle', 'top'];
const INSUNITS = {
  0: 'unitless', 1: 'in', 2: 'ft', 3: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 7: 'm', 8: 'in', 9: 'in',
  10: 'ft', 11: 'mm', 12: 'mm', 13: 'mm', 14: 'cm', 15: 'm', 16: 'm', 17: 'm', 18: 'm', 19: 'm',
  20: 'm', 21: 'ft', 22: 'in', 23: 'ft', 24: 'ft',
};
const LUNITS = { 1: 'scientific', 2: 'decimal', 3: 'engineering', 4: 'architectural', 5: 'fractional' };
const AUNITS = { 0: 'deg', 1: 'dms', 2: 'grad', 3: 'rad', 4: 'dms' };
const ARROWS = {
  '': 'closed', closedfilled: 'closed', closed: 'closed', closedblank: 'closed', small: 'dot',
  open: 'open', open30: 'open', open90: 'open', origin: 'dot', origin2: 'dot',
  archtick: 'tick', oblique: 'tick', integral: 'tick', dot: 'dot', dotsmall: 'dot',
  dotblank: 'dot', boxfilled: 'dot', boxblank: 'dot', datumfilled: 'closed',
  datumblank: 'closed', none: 'none',
};
const MAX_MINSERT = 10000;

/* ------------------------------------------------------------------ */
/* Decoding                                                            */
/* ------------------------------------------------------------------ */

function isBinaryDxf(b) {
  if (b.length < 22 || b[18] !== 13 || b[19] !== 10 || b[20] !== 26 || b[21] !== 0) return false;
  let s = '';
  for (let i = 0; i < 18; i++) s += String.fromCharCode(b[i]);
  return s.includes('Binary DXF');
}

/** Value of a header variable found by a plain text search, or null. */
function sniffHeader(head, name) {
  const i = head.indexOf(name);
  if (i < 0) return null;
  let p = head.indexOf('\n', i);
  if (p < 0) return null;
  p = head.indexOf('\n', p + 1);
  if (p < 0) return null;
  let e = head.indexOf('\n', p + 1);
  if (e < 0) e = head.length;
  return head.slice(p + 1, e).trim();
}

function codepageLabel(cp) {
  if (!cp) return 'windows-1252';
  const s = cp.toUpperCase();
  if (s.startsWith('ANSI_')) {
    const n = +s.slice(5);
    if (n === 874) return 'windows-874';
    if (n === 932) return 'shift_jis';
    if (n === 936) return 'gbk';
    if (n === 949 || n === 1361) return 'euc-kr';
    if (n === 950) return 'big5';
    if (n >= 1250 && n <= 1258) return 'windows-' + n;
  }
  if (s === 'DOS866') return 'ibm866';
  if (s.startsWith('ISO8859-')) return 'iso-8859-' + s.slice(8);
  if (s === 'UTF8' || s === 'UTF-8') return 'utf-8';
  return 'windows-1252';
}

/** Turn the input into a string, honouring $ACADVER and $DWGCODEPAGE. */
function decodeInput(input) {
  if (typeof input === 'string') return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  let bytes;
  if (input instanceof Uint8Array) bytes = input;
  else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
  else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  else throw new TypeError('parseDxf expects a string, ArrayBuffer or Uint8Array');
  if (isBinaryDxf(bytes)) {
    throw new Error('Binary DXF files are not supported. Save the drawing as ASCII DXF and try again.');
  }
  const head = new TextDecoder('windows-1252').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const ver = sniffHeader(head, '$ACADVER');
  if (ver && ver.toUpperCase() >= 'AC1021') return new TextDecoder('utf-8').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    let label = codepageLabel(sniffHeader(head, '$DWGCODEPAGE'));
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      label = 'windows-1252';
      return new TextDecoder(label).decode(bytes);
    }
  }
}

/** Decode \U+XXXX escapes. */
export function decodeUnicode(s) {
  if (s.indexOf('\\U+') < 0 && s.indexOf('\\u+') < 0) return s;
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && (s[i + 1] === 'U' || s[i + 1] === 'u') && s[i + 2] === '+') {
      const code = parseInt(s.slice(i + 3, i + 7), 16);
      if (code === code) {
        out += String.fromCharCode(code);
        i += 7;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const PCT = { c: '⌀', C: '⌀', d: '°', D: '°', p: '±', P: '±' };

/** Plain value of a TEXT string: %% control codes, caret codes, \U+ escapes. */
export function decodeText(s) {
  if (s.indexOf('%%') < 0 && s.indexOf('^') < 0 && s.indexOf('\\') < 0) return s;
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '%' && s[i + 1] === '%' && i + 2 < n) {
      const d = s[i + 2];
      if (PCT[d]) {
        out += PCT[d];
        i += 3;
        continue;
      }
      if (d === '%') {
        out += '%';
        i += 3;
        continue;
      }
      if (d === 'u' || d === 'U' || d === 'o' || d === 'O' || d === 'k' || d === 'K') {
        i += 3;
        continue;
      }
      if (d >= '0' && d <= '9') {
        let j = i + 2;
        while (j < n && j < i + 5 && s[j] >= '0' && s[j] <= '9') j++;
        out += String.fromCharCode(+s.slice(i + 2, j));
        i = j;
        continue;
      }
    } else if (c === '^' && i + 1 < n) {
      const d = s.charCodeAt(i + 1);
      if (d === 32 || d === 73 || d === 74 || d === 77) {
        out += d === 32 ? '^' : d === 73 ? '\t' : d === 74 ? '\n' : '';
        i += 2;
        continue;
      }
    } else if (c === '\\' && (s[i + 1] === 'U' || s[i + 1] === 'u') && s[i + 2] === '+') {
      const code = parseInt(s.slice(i + 3, i + 7), 16);
      if (code === code) {
        out += String.fromCharCode(code);
        i += 7;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

function skipTo(s, i, ch) {
  const j = s.indexOf(ch, i);
  return j < 0 ? s.length : j;
}

/**
 * Plain text of an MTEXT string: paragraph breaks become '\n', formatting
 * codes (\f \H \C \W \Q \T \A \p ...) and grouping braces are removed,
 * stacked fractions become 'a/b'.
 */
export function stripMtext(s) {
  if (s.indexOf('\\') < 0 && s.indexOf('{') < 0 && s.indexOf('}') < 0 && s.indexOf('%%') < 0 && s.indexOf('^') < 0) {
    return s;
  }
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) {
      const d = s[i + 1];
      switch (d) {
        case 'P':
        case 'X':
        case 'N':
          out += '\n';
          i += 2;
          break;
        case '~':
          out += ' ';
          i += 2;
          break;
        case '\\':
        case '{':
        case '}':
          out += d;
          i += 2;
          break;
        case 'U':
        case 'u':
          if (s[i + 2] === '+') {
            const code = parseInt(s.slice(i + 3, i + 7), 16);
            if (code === code) {
              out += String.fromCharCode(code);
              i += 7;
              break;
            }
          }
          out += d;
          i += 2;
          break;
        case 'M':
          if (s[i + 2] === '+') {
            out += '?';
            i = Math.min(n, i + 8);
          } else {
            out += d;
            i += 2;
          }
          break;
        case 'L':
        case 'l':
        case 'O':
        case 'o':
        case 'K':
        case 'k':
          i += 2;
          break;
        case 'S': {
          const e = skipTo(s, i + 2, ';');
          const body = s.slice(i + 2, e);
          let k = body.indexOf('^');
          if (k < 0) k = body.indexOf('#');
          if (k < 0) k = body.indexOf('/');
          out += k < 0 ? body : body.slice(0, k).trim() + '/' + body.slice(k + 1).trim();
          i = e + 1;
          break;
        }
        case 'f':
        case 'F':
        case 'H':
        case 'h':
        case 'C':
        case 'c':
        case 'T':
        case 't':
        case 'Q':
        case 'q':
        case 'W':
        case 'w':
        case 'A':
        case 'a':
        case 'p':
          i = skipTo(s, i + 2, ';') + 1;
          break;
        default:
          out += d;
          i += 2;
      }
    } else if (c === '{' || c === '}') {
      i++;
    } else if (c === '%' && s[i + 1] === '%' && i + 2 < n) {
      const d = s[i + 2];
      if (PCT[d]) out += PCT[d];
      else if (d === '%') out += '%';
      else out += '%%' + d;
      i += 3;
    } else if (c === '^' && i + 1 < n) {
      const d = s.charCodeAt(i + 1);
      if (d === 32 || d === 73 || d === 74 || d === 77) {
        out += d === 32 ? '^' : d === 73 ? '\t' : d === 74 ? '\n' : '';
        i += 2;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Tokenizer                                                           */
/* ------------------------------------------------------------------ */

/** Reads (code, value) groups one at a time; `code` and `value` hold the current group. */
class Tokenizer {
  constructor(text) {
    this.s = text;
    this.pos = 0;
    this.line = 0;
    this.code = 0;
    this.value = '';
    this.bad = false;
  }

  /** Advance to the next group. Returns false at end of input or on a malformed code. */
  next() {
    const s = this.s;
    const len = s.length;
    for (;;) {
      if (this.pos >= len) return false;
      let e = s.indexOf('\n', this.pos);
      if (e < 0) e = len;
      let i = this.pos;
      let end = e;
      if (end > i && s.charCodeAt(end - 1) === 13) end--;
      while (i < end && s.charCodeAt(i) === 32) i++;
      while (end > i && (s.charCodeAt(end - 1) === 32 || s.charCodeAt(end - 1) === 9)) end--;
      let neg = false;
      if (i < end && s.charCodeAt(i) === 45) {
        neg = true;
        i++;
      }
      if (i >= end) {
        if (end === this.pos && e < len) {
          // tolerate a blank line between groups
          this.pos = e + 1;
          this.line++;
          continue;
        }
        if (e >= len) return false;
        this.bad = true;
        return false;
      }
      let code = 0;
      for (; i < end; i++) {
        const ch = s.charCodeAt(i) - 48;
        if (ch < 0 || ch > 9) {
          this.bad = true;
          return false;
        }
        code = code * 10 + ch;
      }
      this.line += 2;
      if (e >= len) return false;
      const vs = e + 1;
      let ve = s.indexOf('\n', vs);
      if (ve < 0) ve = len;
      this.pos = ve + 1;
      let vend = ve;
      if (vend > vs && s.charCodeAt(vend - 1) === 13) vend--;
      if (code === 999) continue;
      this.code = neg ? -code : code;
      this.value = s.slice(vs, vend);
      return true;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Helpers on the current record                                       */
/* ------------------------------------------------------------------ */

function num(v) {
  const n = +v;
  return n === n ? n : 0;
}

function int(v) {
  const n = parseInt(v, 10);
  return n === n ? n : 0;
}

function find(R, code, from = 0) {
  const c = R.codes;
  for (let i = from; i < R.end; i++) if (c[i] === code) return i;
  return -1;
}

function gStr(R, code, def = '') {
  const i = find(R, code);
  return i < 0 ? def : R.vals[i];
}

function gNum(R, code, def = 0) {
  const i = find(R, code);
  return i < 0 ? def : num(R.vals[i]);
}

function gInt(R, code, def = 0) {
  const i = find(R, code);
  return i < 0 ? def : int(R.vals[i]);
}

function trueColor(v) {
  const c = int(v) & 0xffffff;
  return rgbToHex([(c >> 16) & 255, (c >> 8) & 255, c & 255]);
}

/* ------------------------------------------------------------------ */
/* Object coordinate systems                                           */
/* ------------------------------------------------------------------ */

/**
 * Build the OCS to WCS transform for extrusion (nx, ny, nz) with the
 * arbitrary axis algorithm. Returns null for the identity (0, 0, 1).
 * m = [Ax.x, Ay.x, N.x, Ax.y, Ay.y, N.y]; only the XY result is kept.
 */
function makeOcs(nx, ny, nz) {
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) return null;
  nx /= l;
  ny /= l;
  nz /= l;
  if (Math.abs(nx) < 1e-10 && Math.abs(ny) < 1e-10 && nz > 0) return null;
  let ax, ay, az;
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) {
    ax = nz;
    ay = 0;
    az = -nx;
  } else {
    ax = -ny;
    ay = nx;
    az = 0;
  }
  const la = Math.hypot(ax, ay, az);
  ax /= la;
  ay /= la;
  az /= la;
  const bx = ny * az - nz * ay;
  const by = nz * ax - nx * az;
  const m = [ax, bx, nx, ay, by, ny];
  return {
    m,
    mirror: ax * by - ay * bx < 0,
    planar: Math.abs(nz) > 1 - 1e-9,
    n: [nx, ny, nz],
  };
}

const P2 = [0, 0];

/** OCS point to projected WCS, written into P2. */
function ocsPt(o, x, y, z) {
  const m = o.m;
  P2[0] = x * m[0] + y * m[1] + z * m[2];
  P2[1] = x * m[3] + y * m[4] + z * m[5];
  return P2;
}

/** OCS direction angle to WCS angle. */
function ocsAngle(o, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const m = o.m;
  return Math.atan2(c * m[3] + s * m[4], c * m[0] + s * m[1]);
}

/** Transform a flat [x, y, bulge, ...] list in place. */
function ocsBulgeList(o, pts, z) {
  for (let i = 0; i < pts.length; i += 3) {
    ocsPt(o, pts[i], pts[i + 1], z);
    pts[i] = P2[0];
    pts[i + 1] = P2[1];
    if (o.mirror && pts[i + 2]) pts[i + 2] = -pts[i + 2];
  }
}

/* ------------------------------------------------------------------ */
/* Parser                                                              */
/* ------------------------------------------------------------------ */

class DxfParser {
  constructor(opts) {
    this.opts = opts;
    this.drawing = {
      version: 1,
      header: defaultHeader(),
      layers: [],
      linetypes: [],
      textStyles: [],
      dimStyles: [],
      blocks: [],
      entities: [],
    };
    this.warnings = [];
    this.warnSet = new Map();
    this.stats = { entities: 0, skipped: {} };
    this.R = { type: '', n: 0, end: 0, codes: [], vals: [] };
    this.section = '';
    this.table = '';
    this.sawSection = false;
    this.sawEof = false;
    this.model = { list: this.drawing.entities, nextId: 1, model: true, name: '' };
    this.block = null;
    this.poly = null;
    this.layerMap = new Map();
    this.ltMap = new Map();
    this.styleMap = new Map();
    this.dimMap = new Map();
    this.blockMap = new Map();
    this.styleHandles = new Map();
    this.brHandles = new Map();
    this.dimRefs = [];
    this.mtextByHandle = new Map();
    this.leaderLinks = [];
    this.lastLayerRaw = null;
    this.lastLayer = '0';
    this.headerRaw = {};
    // common properties of the current entity
    this.cLayer = '0';
    this.cColor = COLOR_BYLAYER;
    this.cLt = 'ByLayer';
    this.cLw = LW_BYLAYER;
    this.cLts = 1;
    this.ocs = null;
  }

  warn(msg) {
    const n = this.warnSet.get(msg);
    if (n === undefined) {
      this.warnSet.set(msg, 1);
      if (this.warnings.length < 200) this.warnings.push(msg);
    } else this.warnSet.set(msg, n + 1);
  }

  skip(type) {
    this.stats.skipped[type] = (this.stats.skipped[type] || 0) + 1;
  }

  run(text) {
    const tk = new Tokenizer(text);
    let more = tk.next();
    while (more && tk.code !== 0) more = tk.next();
    if (!more) throw new Error('Not a DXF file: no group code structure found.');
    const R = this.R;
    const codes = R.codes;
    const vals = R.vals;
    for (;;) {
      R.type = tk.value.trim();
      let n = 0;
      let end = -1;
      while ((more = tk.next()) && tk.code !== 0) {
        if (end < 0 && tk.code >= 1000) end = n;
        codes[n] = tk.code;
        vals[n] = tk.value;
        n++;
      }
      R.n = n;
      R.end = end < 0 ? n : end;
      // a record cut off by the end of input may be incomplete: drop it
      if (more || R.type === 'EOF' || R.type === 'ENDSEC') this.record(R);
      if (this.sawEof || !more) break;
    }
    if (!this.sawSection) throw new Error('Not a DXF file: no SECTION found.');
    if (tk.bad) this.warn(`Malformed group code near line ${tk.line + 1}; the rest of the file was ignored.`);
    else if (!this.sawEof) this.warn('Unexpected end of file; the file may be truncated.');
    this.finish();
    return { drawing: this.drawing, warnings: this.collectWarnings(), stats: this.stats };
  }

  /**
   * Convert records that did not come from DXF text (DWG import): an iterable
   * of { type, codes, vals } with the SECTION / ENDSEC structure of a DXF file.
   */
  runRecords(records) {
    const R = this.R;
    const codes = R.codes;
    const vals = R.vals;
    for (const rec of records) {
      R.type = rec.type;
      const n = rec.codes.length;
      let end = -1;
      for (let i = 0; i < n; i++) {
        const c = rec.codes[i];
        if (end < 0 && c >= 1000) end = i;
        codes[i] = c;
        vals[i] = rec.vals[i];
      }
      R.n = n;
      R.end = end < 0 ? n : end;
      this.record(R);
      if (this.sawEof) break;
    }
    this.finish();
    return { drawing: this.drawing, warnings: this.collectWarnings(), stats: this.stats };
  }

  collectWarnings() {
    return this.warnings.map((w) => {
      const n = this.warnSet.get(w);
      return n > 1 ? `${w} (${n} times)` : w;
    });
  }

  record(R) {
    switch (R.type) {
      case 'SECTION':
        this.sawSection = true;
        this.section = gStr(R, 2).trim().toUpperCase();
        if (this.section === 'HEADER') this.header(R);
        return;
      case 'ENDSEC':
        this.endPoly();
        this.section = '';
        this.block = null;
        return;
      case 'EOF':
        this.sawEof = true;
        return;
    }
    try {
      if (this.section === 'ENTITIES') this.entity(R, this.model);
      else if (this.section === 'BLOCKS') this.blockRecord(R);
      else if (this.section === 'TABLES') this.tableRecord(R);
    } catch (err) {
      this.warn(`Could not read ${R.type}: ${err.message}`);
    }
  }

  /* ---------------- HEADER ---------------- */

  header(R) {
    const h = this.drawing.header;
    const raw = this.headerRaw;
    let name = '';
    for (let i = 0; i < R.n; i++) {
      const c = R.codes[i];
      const v = R.vals[i];
      if (c === 9) {
        name = v.trim().toUpperCase();
        continue;
      }
      switch (name) {
        case '$INSUNITS': {
          const u = int(v);
          h.units = INSUNITS[u] ?? 'unitless';
          if (!(u in INSUNITS)) this.warn(`Unknown $INSUNITS ${u}; using unitless.`);
          else if (![0, 1, 2, 4, 5, 6].includes(u)) this.warn(`Drawing units code ${u} mapped to '${h.units}'.`);
          break;
        }
        case '$LTSCALE':
          h.ltscale = num(v) || 1;
          break;
        case '$CLAYER':
          raw.clayer = v.trim();
          break;
        case '$TEXTSIZE':
          if (num(v) > 0) h.textHeight = num(v);
          break;
        case '$DIMSTYLE':
          raw.dimStyle = v.trim();
          break;
        case '$TEXTSTYLE':
          raw.textStyle = v.trim();
          break;
        case '$CELTYPE':
          raw.cltype = v.trim();
          break;
        case '$CECOLOR':
          if (c === 62) h.ccolor = int(v);
          break;
        case '$CELWEIGHT':
          h.clweight = int(v);
          break;
        case '$LUNITS':
          h.linearFormat = LUNITS[int(v)] ?? 'decimal';
          break;
        case '$LUPREC':
          h.linearPrecision = Math.max(0, Math.min(8, int(v)));
          break;
        case '$AUNITS':
          h.angularFormat = AUNITS[int(v)] ?? 'deg';
          break;
        case '$AUPREC':
          h.angularPrecision = Math.max(0, Math.min(8, int(v)));
          break;
        case '$PDMODE':
          h.pdmode = int(v);
          break;
        case '$PDSIZE':
          h.pdsize = num(v);
          break;
      }
    }
  }

  /* ---------------- TABLES ---------------- */

  tableRecord(R) {
    switch (R.type) {
      case 'TABLE':
        this.table = gStr(R, 2).trim().toUpperCase();
        return;
      case 'ENDTAB':
        this.table = '';
        return;
      case 'LAYER':
        this.layerEntry(R);
        return;
      case 'LTYPE':
        this.ltypeEntry(R);
        return;
      case 'STYLE':
        this.styleEntry(R);
        return;
      case 'DIMSTYLE':
        this.dimStyleEntry(R);
        return;
      case 'BLOCK_RECORD': {
        const hd = gStr(R, 5).trim().toUpperCase();
        if (hd) this.brHandles.set(hd, decodeUnicode(gStr(R, 2).trim()));
        return;
      }
    }
  }

  layerEntry(R) {
    const name = decodeUnicode(gStr(R, 2).trim());
    if (!name) return;
    const L = defaultLayer(name);
    const flags = gInt(R, 70);
    const c = gInt(R, 62, 7);
    L.on = c >= 0;
    const ac = Math.abs(c);
    L.color = ac >= 1 && ac <= 255 ? ac : 7;
    const tc = find(R, 420);
    if (tc >= 0) L.color = trueColor(R.vals[tc]);
    L.frozen = (flags & 1) !== 0;
    L.locked = (flags & 4) !== 0;
    L.linetype = gStr(R, 6, 'Continuous').trim() || 'Continuous';
    const lw = gInt(R, 370, LW_DEFAULT);
    L.lineweight = lw < 0 ? LW_DEFAULT : lw;
    const p = find(R, 290);
    if (p >= 0) L.plot = int(R.vals[p]) !== 0;
    // extended data: transparency and description
    let app = '';
    let n1000 = 0;
    for (let i = R.end; i < R.n; i++) {
      const code = R.codes[i];
      if (code === 1001) {
        app = R.vals[i].trim();
        n1000 = 0;
      } else if (app === 'AcCmTransparency' && code === 1071) {
        const v = int(R.vals[i]);
        if (v & 0x02000000) L.transparency = Math.max(0, Math.min(90, Math.round((1 - (v & 255) / 255) * 100)));
      } else if (app === 'AcAecLayerStandard' && code === 1000) {
        if (++n1000 === 2) L.description = decodeUnicode(R.vals[i]);
      }
    }
    const key = name.toLowerCase();
    const prev = this.layerMap.get(key);
    if (prev) Object.assign(prev, L, { name: prev.name });
    else {
      this.layerMap.set(key, L);
      this.drawing.layers.push(L);
    }
  }

  ltypeEntry(R) {
    const name = decodeUnicode(gStr(R, 2).trim());
    const key = name.toLowerCase();
    if (!name || key === 'bylayer' || key === 'byblock' || this.ltMap.has(key)) return;
    const pattern = [];
    for (let i = 0; i < R.end; i++) if (R.codes[i] === 49) pattern.push(num(R.vals[i]));
    const lt = {
      name: key === 'continuous' ? 'Continuous' : name,
      description: decodeUnicode(gStr(R, 3)),
      pattern: key === 'continuous' ? [] : pattern,
    };
    if (pattern.length === 1 && pattern[0] >= 0) lt.pattern = [];
    this.ltMap.set(key, lt);
    this.drawing.linetypes.push(lt);
  }

  styleEntry(R) {
    const flags = gInt(R, 70);
    const name = decodeUnicode(gStr(R, 2).trim());
    if (!name || flags & 1) return;
    const key = name.toLowerCase();
    const hd = gStr(R, 5).trim().toUpperCase();
    if (this.styleMap.has(key)) {
      if (hd) this.styleHandles.set(hd, this.styleMap.get(key).name);
      return;
    }
    const st = defaultTextStyle(name);
    st.height = Math.max(0, gNum(R, 40));
    st.widthFactor = gNum(R, 41, 1) || 1;
    st.oblique = signedAngle(gNum(R, 50) * DEG);
    const font = gStr(R, 3).toLowerCase();
    if (font.includes('mono') || font.includes('cour')) st.font = 'mono';
    this.styleMap.set(key, st);
    this.drawing.textStyles.push(st);
    if (hd) this.styleHandles.set(hd, name);
  }

  dimStyleEntry(R) {
    const name = decodeUnicode(gStr(R, 2).trim());
    if (!name) return;
    const key = name.toLowerCase();
    const ds = defaultDimStyle(name);
    let tsz = 0;
    let blkName = null;
    let blkHandle = null;
    let txHandle = null;
    for (let i = 0; i < R.end; i++) {
      const v = R.vals[i];
      switch (R.codes[i]) {
        case 140:
          if (num(v) > 0) ds.textHeight = num(v);
          break;
        case 41:
          ds.arrowSize = Math.abs(num(v));
          break;
        case 42:
          ds.extOffset = num(v);
          break;
        case 44:
          ds.extExtend = num(v);
          break;
        case 147:
          ds.textGap = Math.abs(num(v));
          break;
        case 40:
          ds.scale = num(v) > 0 ? num(v) : 1;
          break;
        case 271:
          ds.precision = Math.max(0, Math.min(8, int(v)));
          break;
        case 77:
          ds.textPlacement = int(v) === 0 ? 'centered' : 'above';
          break;
        case 73:
          ds.textAlign = int(v) ? 'horizontal' : 'aligned';
          break;
        case 141:
          ds.centerMark = Math.abs(num(v));
          break;
        case 142:
          tsz = num(v);
          break;
        case 78:
          ds.trailingZeros = (int(v) & 8) === 0;
          break;
        case 176:
          ds.lineColor = int(v);
          break;
        case 178:
          ds.textColor = int(v);
          break;
        case 3: {
          const post = decodeUnicode(v);
          const k = post.indexOf('<>');
          if (k >= 0) {
            ds.prefix = post.slice(0, k);
            ds.suffix = post.slice(k + 2);
          } else ds.suffix = post;
          break;
        }
        case 5:
          blkName = v.trim();
          break;
        case 342:
          blkHandle = v.trim().toUpperCase();
          break;
        case 340:
          txHandle = v.trim().toUpperCase();
          break;
      }
    }
    if (tsz > 0) ds.arrowType = 'tick';
    else if (blkName !== null) ds.arrowType = arrowFromName(blkName);
    this.dimRefs.push({ ds, blkHandle: tsz > 0 ? null : blkHandle, txHandle });
    const prev = this.dimMap.get(key);
    if (prev) Object.assign(prev, ds, { name: prev.name });
    else {
      this.dimMap.set(key, ds);
      this.drawing.dimStyles.push(ds);
    }
  }

  /* ---------------- BLOCKS ---------------- */

  blockRecord(R) {
    if (R.type === 'BLOCK') {
      this.endPoly();
      const name = decodeUnicode(gStr(R, 2).trim() || gStr(R, 3).trim());
      const lower = name.toLowerCase();
      if (!name || lower.startsWith('*model_space') || lower.startsWith('*paper_space')) {
        this.block = { skip: true };
        return;
      }
      const flags = gInt(R, 70);
      const blk = { name, bx: gNum(R, 10), by: gNum(R, 20), entities: [], description: decodeUnicode(gStr(R, 4)) };
      if (flags & 4) this.warn(`External reference block '${name}' imported without its content.`);
      if (this.blockMap.has(lower)) {
        this.warn(`Duplicate block '${name}' ignored.`);
        this.block = { skip: true };
        return;
      }
      this.blockMap.set(lower, blk);
      this.drawing.blocks.push(blk);
      this.block = { skip: false, list: blk.entities, nextId: 1, model: false, name };
      return;
    }
    if (R.type === 'ENDBLK') {
      this.endPoly();
      this.block = null;
      return;
    }
    if (!this.block || this.block.skip) return;
    this.entity(R, this.block);
  }

  /* ---------------- name resolution ---------------- */

  layerName(raw) {
    if (raw === this.lastLayerRaw) return this.lastLayer;
    let name = raw.trim();
    if (name.indexOf('\\') >= 0) name = decodeUnicode(name);
    if (!name) name = '0';
    const key = name.toLowerCase();
    let L = this.layerMap.get(key);
    if (!L) {
      L = defaultLayer(name);
      this.layerMap.set(key, L);
      this.drawing.layers.push(L);
    }
    this.lastLayerRaw = raw;
    this.lastLayer = L.name;
    return L.name;
  }

  ltName(raw, fallback = 'Continuous') {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (key === 'bylayer') return 'ByLayer';
    if (key === 'byblock') return 'ByBlock';
    const lt = this.ltMap.get(key);
    if (lt) return lt.name;
    if (key === 'continuous' || !key) return 'Continuous';
    const std = STANDARD_LINETYPES.find((s) => s.name.toLowerCase() === key);
    if (std) {
      const copy = { name: std.name, description: std.description, pattern: std.pattern.slice() };
      this.ltMap.set(key, copy);
      this.drawing.linetypes.push(copy);
      return copy.name;
    }
    this.warn(`Undefined linetype '${name}' replaced with ${fallback}.`);
    return fallback;
  }

  styleName(raw) {
    const key = raw.trim().toLowerCase();
    if (!key) return 'Standard';
    const st = this.styleMap.get(key);
    return st ? st.name : 'Standard';
  }

  dimStyleName(raw) {
    const key = raw.trim().toLowerCase();
    if (!key) return 'Standard';
    const ds = this.dimMap.get(key);
    return ds ? ds.name : 'Standard';
  }

  /* ---------------- ENTITIES ---------------- */

  /**
   * Read the common entity groups into cLayer, cColor, ... and `ocs`.
   * Returns false when the entity must be dropped (invisible, paper space).
   */
  common(R, cont) {
    let layer = null;
    let color = COLOR_BYLAYER;
    let tc = null;
    let lt = null;
    let lw = LW_BYLAYER;
    let lts = 1;
    let nx = 0;
    let ny = 0;
    let nz = 1;
    let seen = 0;
    const codes = R.codes;
    const vals = R.vals;
    for (let i = 0; i < R.end; i++) {
      switch (codes[i]) {
        case 8:
          if (!(seen & 1)) layer = vals[i];
          seen |= 1;
          break;
        case 62:
          if (!(seen & 2)) color = Math.abs(int(vals[i]));
          seen |= 2;
          break;
        case 420:
          if (!(seen & 4)) tc = vals[i];
          seen |= 4;
          break;
        case 6:
          if (!(seen & 8)) lt = vals[i];
          seen |= 8;
          break;
        case 370:
          if (!(seen & 16)) lw = int(vals[i]);
          seen |= 16;
          break;
        case 48:
          if (!(seen & 32)) lts = num(vals[i]) || 1;
          seen |= 32;
          break;
        case 60:
          if (int(vals[i]) === 1) return false;
          break;
        case 67:
          if (cont.model && int(vals[i]) === 1) return false;
          break;
        case 210:
          if (!(seen & 64)) nx = num(vals[i]);
          break;
        case 220:
          if (!(seen & 64)) ny = num(vals[i]);
          break;
        case 230:
          if (!(seen & 64)) nz = num(vals[i]);
          seen |= 64;
          break;
      }
    }
    this.cLayer = layer === null ? '0' : this.layerName(layer);
    this.cColor = tc !== null ? trueColor(tc) : color > 256 ? COLOR_BYLAYER : color;
    this.cLt = lt === null ? 'ByLayer' : this.ltName(lt, 'ByLayer');
    this.cLw = lw;
    this.cLts = lts;
    this.ocs = nx === 0 && ny === 0 && nz === 1 ? null : makeOcs(nx, ny, nz);
    return true;
  }

  base(type) {
    return {
      id: 0,
      type,
      layer: this.cLayer,
      color: this.cColor,
      linetype: this.cLt,
      lineweight: this.cLw,
      ltscale: this.cLts,
    };
  }

  add(cont, e) {
    e.id = cont.nextId++;
    cont.list.push(e);
    this.stats.entities++;
    return e;
  }

  entity(R, cont) {
    const t = R.type;
    if (this.poly) {
      if (t === 'VERTEX') {
        this.vertex(R);
        return;
      }
      this.endPoly();
      if (t === 'SEQEND') return;
    }
    if (t === 'SEQEND' || t === 'VERTEX') return;
    const ok = this.common(R, cont);
    if (t === 'POLYLINE') {
      this.polylineStart(R, cont, ok);
      return;
    }
    if (!ok) return;
    try {
      switch (t) {
        case 'LINE':
          return this.line(R, cont);
        case 'XLINE':
        case 'RAY':
          return this.xline(R, cont, t === 'RAY' ? 'ray' : 'xline');
        case 'CIRCLE':
          return this.circle(R, cont, false);
        case 'ARC':
          return this.circle(R, cont, true);
        case 'ELLIPSE':
          return this.ellipse(R, cont);
        case 'LWPOLYLINE':
          return this.lwpolyline(R, cont);
        case 'SPLINE':
          return this.spline(R, cont);
        case 'POINT':
          return this.point(R, cont);
        case 'TEXT':
          return this.text(R, cont, false);
        case 'ATTRIB':
          return this.text(R, cont, true);
        case 'MTEXT':
          return this.mtext(R, cont);
        case 'DIMENSION':
          return this.dimension(R, cont);
        case 'LEADER':
          return this.leader(R, cont);
        case 'HATCH':
          return this.hatch(R, cont);
        case 'INSERT':
          return this.insert(R, cont);
        case 'ACAD_TABLE':
          return this.tableEntity(R, cont);
        case 'SOLID':
        case 'TRACE':
          return this.solid(R, cont);
        case 'MULTILEADER':
        case 'MLEADER':
          return this.mleader(R, cont);
        default:
          this.skip(t);
      }
    } catch (err) {
      this.warn(`Could not read ${t}: ${err.message}`);
    }
  }

  line(R, cont) {
    let x1 = 0,
      y1 = 0,
      x2 = 0,
      y2 = 0;
    const codes = R.codes;
    const vals = R.vals;
    for (let i = 0; i < R.end; i++) {
      switch (codes[i]) {
        case 10:
          x1 = num(vals[i]);
          break;
        case 20:
          y1 = num(vals[i]);
          break;
        case 11:
          x2 = num(vals[i]);
          break;
        case 21:
          y2 = num(vals[i]);
          break;
      }
    }
    const e = this.base('line');
    e.x1 = x1;
    e.y1 = y1;
    e.x2 = x2;
    e.y2 = y2;
    this.add(cont, e);
  }

  xline(R, cont, type) {
    const x = gNum(R, 10);
    const y = gNum(R, 20);
    let dx = gNum(R, 11, 1);
    let dy = gNum(R, 21);
    const l = Math.hypot(dx, dy);
    if (!(l > 0)) {
      this.warn(`${type.toUpperCase()} with zero direction skipped.`);
      return;
    }
    dx /= l;
    dy /= l;
    const e = this.base(type);
    e.x = x;
    e.y = y;
    e.dx = dx;
    e.dy = dy;
    this.add(cont, e);
  }

  circle(R, cont, isArc) {
    let cx = 0,
      cy = 0,
      cz = 0,
      r = 0,
      a0 = 0,
      a1 = 360;
    const codes = R.codes;
    const vals = R.vals;
    for (let i = 0; i < R.end; i++) {
      switch (codes[i]) {
        case 10:
          cx = num(vals[i]);
          break;
        case 20:
          cy = num(vals[i]);
          break;
        case 30:
          cz = num(vals[i]);
          break;
        case 40:
          r = num(vals[i]);
          break;
        case 50:
          a0 = num(vals[i]);
          break;
        case 51:
          a1 = num(vals[i]);
          break;
      }
    }
    if (!(r > 0)) {
      this.warn(`${isArc ? 'ARC' : 'CIRCLE'} with zero radius skipped.`);
      return;
    }
    let start = isArc ? a0 * DEG : 0;
    let end = isArc ? a1 * DEG : TWO_PI;
    const o = this.ocs;
    if (!o) {
      const e = this.base(isArc ? 'arc' : 'circle');
      e.cx = cx;
      e.cy = cy;
      e.r = r;
      if (isArc) {
        e.start = normAngle(start);
        e.end = normAngle(end);
      }
      this.add(cont, e);
      return;
    }
    if (isArc) {
      start = normAngle(start);
      end = normAngle(end);
      if (end <= start) end += TWO_PI;
    }
    this.projectedCircle(cont, o, cx, cy, cz, r, start, end, isArc);
  }

  /** Emit a circle or arc given in an OCS: an arc when it stays circular, else an ellipse. */
  projectedCircle(cont, o, cx, cy, cz, r, start, end, isArc) {
    const m = o.m;
    ocsPt(o, cx, cy, cz);
    const px = P2[0];
    const py = P2[1];
    const el = conjugateToEllipse(px, py, r * m[0], r * m[3], r * m[1], r * m[4], start, end);
    if (!el) {
      this.warn('Circle or arc seen edge-on in plan view skipped.');
      return;
    }
    if (el.circular) {
      const rad = Math.hypot(el.mx, el.my);
      if (!isArc) {
        const e = this.base('circle');
        e.cx = px;
        e.cy = py;
        e.r = rad;
        this.add(cont, e);
        return;
      }
      const phi = Math.atan2(el.my, el.mx);
      const e = this.base('arc');
      e.cx = px;
      e.cy = py;
      e.r = rad;
      e.start = normAngle(phi + el.start);
      e.end = normAngle(phi + el.end);
      this.add(cont, e);
      return;
    }
    if (!o.planar) this.warn('Circles and arcs on tilted planes were converted to ellipses.');
    this.addEllipse(cont, el);
  }

  addEllipse(cont, el) {
    const e = this.base('ellipse');
    e.cx = el.cx;
    e.cy = el.cy;
    e.mx = el.mx;
    e.my = el.my;
    e.ratio = el.ratio;
    e.start = el.start;
    e.end = el.end;
    this.add(cont, e);
  }

  ellipse(R, cont) {
    let cx = 0,
      cy = 0,
      mx = 1,
      my = 0,
      mz = 0,
      ratio = 1,
      s = 0,
      t = TWO_PI;
    const codes = R.codes;
    const vals = R.vals;
    for (let i = 0; i < R.end; i++) {
      switch (codes[i]) {
        case 10:
          cx = num(vals[i]);
          break;
        case 20:
          cy = num(vals[i]);
          break;
        case 11:
          mx = num(vals[i]);
          break;
        case 21:
          my = num(vals[i]);
          break;
        case 31:
          mz = num(vals[i]);
          break;
        case 40:
          ratio = num(vals[i]);
          break;
        case 41:
          s = num(vals[i]);
          break;
        case 42:
          t = num(vals[i]);
          break;
      }
    }
    if (!(Math.hypot(mx, my, mz) > 0) || !(ratio > 0)) {
      this.warn('Degenerate ELLIPSE skipped.');
      return;
    }
    const full = Math.abs(t - s - TWO_PI) < 1e-9 || (s === 0 && t === 0);
    if (full) {
      s = 0;
      t = TWO_PI;
    } else {
      s = normAngle(s);
      t = normAngle(t);
      if (t <= s) t += TWO_PI;
    }
    const o = this.ocs;
    if (!o && ratio <= 1 && mz === 0) {
      this.addEllipse(cont, { cx, cy, mx, my, ratio, start: s, end: t });
      return;
    }
    const n = o ? o.n : [0, 0, 1];
    // minor axis = ratio * (N x M), projected to XY
    const vx = ratio * (n[1] * mz - n[2] * my);
    const vy = ratio * (n[2] * mx - n[0] * mz);
    const el = conjugateToEllipse(cx, cy, mx, my, vx, vy, s, t);
    if (!el) {
      this.warn('ELLIPSE seen edge-on in plan view skipped.');
      return;
    }
    this.addEllipse(cont, el);
  }

  lwpolyline(R, cont) {
    let closed = false;
    let cw = null;
    let elev = 0;
    let w0 = null;
    let uniform = true;
    const pts = [];
    const codes = R.codes;
    const vals = R.vals;
    for (let i = 0; i < R.end; i++) {
      switch (codes[i]) {
        case 70:
          closed = (int(vals[i]) & 1) !== 0;
          break;
        case 43:
          cw = num(vals[i]);
          break;
        case 38:
          elev = num(vals[i]);
          break;
        case 10:
          pts.push(num(vals[i]), 0, 0);
          break;
        case 20:
          if (pts.length) pts[pts.length - 2] = num(vals[i]);
          break;
        case 42:
          if (pts.length) pts[pts.length - 1] = num(vals[i]);
          break;
        case 40:
        case 41:
          if (pts.length) {
            const w = num(vals[i]);
            if (w0 === null) w0 = w;
            else if (w !== w0) uniform = false;
          }
          break;
      }
    }
    if (pts.length < 6) {
      this.warn('Polyline with fewer than two vertices skipped.');
      return;
    }
    if (!uniform && cw === null) this.warn('Variable-width polylines imported with a constant width.');
    this.addPolyline(cont, this.base('polyline'), pts, closed, cw ?? w0 ?? 0, this.ocs, elev);
  }

  addPolyline(cont, e, pts, closed, width, o, z) {
    if (o) {
      ocsBulgeList(o, pts, z);
      if (!o.planar) this.warn('Polylines on tilted planes were projected to plan view.');
    }
    if (!closed) pts[pts.length - 1] = 0;
    e.pts = pts;
    e.closed = closed;
    e.width = width > 0 ? width : 0;
    this.add(cont, e);
  }

  polylineStart(R, cont, ok) {
    const flags = gInt(R, 70);
    const st = {
      cont,
      skip: !ok,
      flags,
      elev: gNum(R, 30),
      ocs: this.ocs,
      w: gNum(R, 40),
      pts: [],
      ent: ok ? this.base('polyline') : null,
    };
    if (ok && flags & (16 | 64)) {
      st.skip = true;
      this.skip('POLYLINE');
      this.warn('Polyface and polygon mesh polylines are not supported and were skipped.');
    }
    this.poly = st;
  }

  vertex(R) {
    const st = this.poly;
    if (st.skip) return;
    let x = 0,
      y = 0,
      b = 0,
      f = 0;
    for (let i = 0; i < R.end; i++) {
      switch (R.codes[i]) {
        case 10:
          x = num(R.vals[i]);
          break;
        case 20:
          y = num(R.vals[i]);
          break;
        case 42:
          b = num(R.vals[i]);
          break;
        case 70:
          f = int(R.vals[i]);
          break;
      }
    }
    if (f & 16) return;
    st.pts.push(x, y, st.flags & 8 ? 0 : b);
  }

  endPoly() {
    const st = this.poly;
    if (!st) return;
    this.poly = null;
    if (st.skip) return;
    if (st.pts.length < 6) {
      this.warn('Polyline with fewer than two vertices skipped.');
      return;
    }
    const is3d = (st.flags & 8) !== 0;
    try {
      this.addPolyline(st.cont, st.ent, st.pts, (st.flags & 1) !== 0, st.w, is3d ? null : st.ocs, st.elev);
    } catch (err) {
      this.warn(`Could not read POLYLINE: ${err.message}`);
    }
  }

  spline(R, cont) {
    let flags = 0;
    let degree = 3;
    const knots = [];
    const weights = [];
    const ctrl = [];
    const fit = [];
    let st = null;
    let et = null;
    const codes = R.codes;
    const vals = R.vals;
    for (let i = 0; i < R.end; i++) {
      const v = vals[i];
      switch (codes[i]) {
        case 70:
          flags = int(v);
          break;
        case 71:
          degree = int(v);
          break;
        case 40:
          knots.push(num(v));
          break;
        case 41:
          weights.push(num(v));
          break;
        case 10:
          ctrl.push(num(v), 0);
          break;
        case 20:
          if (ctrl.length) ctrl[ctrl.length - 1] = num(v);
          break;
        case 11:
          fit.push(num(v), 0);
          break;
        case 21:
          if (fit.length) fit[fit.length - 1] = num(v);
          break;
        case 12:
          st = [num(v), 0];
          break;
        case 22:
          if (st) st[1] = num(v);
          break;
        case 13:
          et = [num(v), 0];
          break;
        case 23:
          if (et) et[1] = num(v);
          break;
      }
    }
    const closed = (flags & 1) !== 0;
    if (degree < 1) degree = 1;
    for (const w of weights) {
      if (Math.abs(w - weights[0]) > 1e-9) {
        this.warn('Rational spline weights are not supported and were ignored.');
        break;
      }
    }
    const n = ctrl.length >> 1;
    let outKnots = null;
    let outCtrl = null;
    if (n >= degree + 1) {
      const c = clampSpline(degree, knots, ctrl);
      if (c) {
        outKnots = c.knots;
        outCtrl = c.ctrl;
      } else {
        this.warn('Spline with an invalid knot vector imported with uniform knots.');
        outKnots = uniformKnots(n, degree);
        outCtrl = ctrl;
      }
    } else if (fit.length >= 4) {
      const f = fitToSpline(fit, closed, st, et);
      degree = f.degree;
      outKnots = f.knots;
      outCtrl = f.ctrl;
    } else {
      this.warn('Spline without enough control or fit points skipped.');
      return;
    }
    const e = this.base('spline');
    e.degree = degree;
    e.ctrl = outCtrl;
    e.knots = outKnots;
    e.fit = fit;
    e.closed = closed;
    this.add(cont, e);
  }

  point(R, cont) {
    const e = this.base('point');
    e.x = gNum(R, 10);
    e.y = gNum(R, 20);
    this.add(cont, e);
  }

  text(R, cont, isAttrib) {
    let x = 0,
      y = 0,
      z = 0,
      ax = 0,
      ay = 0,
      has11 = false,
      h = 0,
      val = '',
      rot = 0,
      wf = 1,
      obl = 0,
      style = '',
      hj = 0,
      vj = 0,
      af = 0;
    const codes = R.codes;
    const vals = R.vals;
    const vcode = isAttrib ? 74 : 73;
    for (let i = 0; i < R.end; i++) {
      const v = vals[i];
      switch (codes[i]) {
        case 10:
          x = num(v);
          break;
        case 20:
          y = num(v);
          break;
        case 30:
          z = num(v);
          break;
        case 11:
          ax = num(v);
          has11 = true;
          break;
        case 21:
          ay = num(v);
          break;
        case 40:
          h = num(v);
          break;
        case 1:
          val = v;
          break;
        case 50:
          rot = num(v) * DEG;
          break;
        case 41:
          wf = num(v) || 1;
          break;
        case 51:
          obl = num(v) * DEG;
          break;
        case 7:
          style = v;
          break;
        case 72:
          hj = int(v);
          break;
        case 70:
          af = int(v);
          break;
        default:
          if (codes[i] === vcode) vj = int(v);
      }
    }
    if (isAttrib && af & 1) return;
    let px = x;
    let py = y;
    let halign = 'left';
    let valign = 'baseline';
    if (hj === 3 || hj === 5) {
      if (has11 && (ax !== x || ay !== y)) {
        px = (x + ax) / 2;
        py = (y + ay) / 2;
        rot = Math.atan2(ay - y, ax - x);
      }
      halign = 'center';
    } else if (hj !== 0 || vj !== 0) {
      if (has11) {
        px = ax;
        py = ay;
      }
      halign = hj === 1 || hj === 4 ? 'center' : hj === 2 ? 'right' : 'left';
      valign = hj === 4 ? 'middle' : VALIGN[vj] ?? 'baseline';
    }
    const o = this.ocs;
    if (o) {
      ocsPt(o, px, py, z);
      px = P2[0];
      py = P2[1];
      if (o.mirror) {
        // mirrored text cannot be represented: keep it upright and readable
        rot = ocsAngle(o, rot + Math.PI / 2) - Math.PI / 2;
        if (halign === 'left') halign = 'right';
        else if (halign === 'right') halign = 'left';
      } else rot = ocsAngle(o, rot);
    }
    const styleName = this.styleName(style);
    if (!(h > 0)) h = this.styleMap.get(styleName.toLowerCase())?.height || this.drawing.header.textHeight;
    const e = this.base('text');
    e.x = px;
    e.y = py;
    e.h = h;
    e.rot = normAngle(rot);
    e.value = decodeText(val);
    e.style = styleName;
    e.halign = halign;
    e.valign = valign;
    e.widthFactor = wf;
    e.oblique = signedAngle(obl);
    this.add(cont, e);
  }

  mtext(R, cont) {
    let x = 0,
      y = 0,
      h = 0,
      w = 0,
      att = 1,
      last = '',
      chunks = '',
      style = '',
      rot = 0,
      dx = 0,
      dy = 0,
      has11 = false,
      ls = 1,
      handle = '';
    const codes = R.codes;
    const vals = R.vals;
    for (let i = 0; i < R.end; i++) {
      const v = vals[i];
      switch (codes[i]) {
        case 5:
          handle = v;
          break;
        case 10:
          x = num(v);
          break;
        case 20:
          y = num(v);
          break;
        case 40:
          h = num(v);
          break;
        case 41:
          w = num(v);
          break;
        case 71:
          att = int(v);
          break;
        case 1:
          last = v;
          break;
        case 3:
          chunks += v;
          break;
        case 7:
          style = v;
          break;
        case 50:
          rot = num(v) * DEG;
          break;
        case 11:
          dx = num(v);
          has11 = true;
          break;
        case 21:
          dy = num(v);
          break;
        case 44:
          ls = num(v) || 1;
          break;
      }
    }
    if (has11 && (dx !== 0 || dy !== 0)) rot = Math.atan2(dy, dx);
    else if (this.ocs) rot = ocsAngle(this.ocs, rot);
    const styleName = this.styleName(style);
    if (!(h > 0)) h = this.styleMap.get(styleName.toLowerCase())?.height || this.drawing.header.textHeight;
    const e = this.base('mtext');
    e.x = x;
    e.y = y;
    e.h = h;
    e.rot = normAngle(rot);
    e.value = stripMtext(chunks + last);
    e.style = styleName;
    e.width = w > 0 ? w : 0;
    e.attach = ATTACH[att - 1] ?? 'tl';
    e.lineSpacing = ls;
    this.add(cont, e);
    if (handle) this.mtextByHandle.set(handle.trim().toUpperCase(), { cont, e });
  }

  dimension(R, cont) {
    const P = new Float64Array(12); // x/y of groups 10, 11, 13, 14, 15, 16
    const slot = { 10: 0, 11: 1, 13: 2, 14: 3, 15: 4, 16: 5 };
    let flags = 0;
    let text = '';
    let style = '';
    let rot = 0;
    let z = 0;
    const codes = R.codes;
    const vals = R.vals;
    for (let i = 0; i < R.end; i++) {
      const c = codes[i];
      const v = vals[i];
      if (c >= 10 && c <= 16 && c !== 12) P[slot[c] * 2] = num(v);
      else if (c >= 20 && c <= 26 && c !== 22) P[slot[c - 10] * 2 + 1] = num(v);
      else if (c === 70) flags = int(v);
      else if (c === 1) text = v;
      else if (c === 3) style = v;
      else if (c === 50) rot = num(v) * DEG;
      else if (c === 30) z = num(v);
    }
    const o = this.ocs;
    if (o) {
      for (const k of [1, 5]) {
        ocsPt(o, P[k * 2], P[k * 2 + 1], z);
        P[k * 2] = P2[0];
        P[k * 2 + 1] = P2[1];
      }
    }
    const kind = flags & 7;
    const e = this.base('dimension');
    e.dimType = 'linear';
    e.x1 = e.y1 = e.x2 = e.y2 = e.x3 = e.y3 = e.x4 = e.y4 = 0;
    e.lx = P[0];
    e.ly = P[1];
    e.rot = 0;
    let t = stripMtext(decodeUnicode(text));
    if (t === '<>') t = '';
    e.text = t;
    e.style = this.dimStyleName(style);
    switch (kind) {
      case 0:
      case 1:
        e.dimType = kind === 0 ? 'linear' : 'aligned';
        e.x1 = P[4];
        e.y1 = P[5];
        e.x2 = P[6];
        e.y2 = P[7];
        if (kind === 0) e.rot = normAngle(rot);
        break;
      case 2: {
        // two lines: 13 -> 14 and 15 -> 10; arc location 16
        const r = angularFromLines(P[4], P[5], P[6], P[7], P[8], P[9], P[0], P[1], P[10], P[11]);
        if (!r) {
          this.warn('Angular dimension with parallel lines skipped.');
          return;
        }
        e.dimType = 'angular';
        [e.x1, e.y1, e.x2, e.y2, e.x3, e.y3] = r;
        e.lx = P[10];
        e.ly = P[11];
        break;
      }
      case 5:
        e.dimType = 'angular';
        e.x1 = P[4];
        e.y1 = P[5];
        e.x2 = P[6];
        e.y2 = P[7];
        e.x3 = P[8];
        e.y3 = P[9];
        break;
      case 3:
        e.dimType = 'diameter';
        e.x1 = (P[0] + P[8]) / 2;
        e.y1 = (P[1] + P[9]) / 2;
        e.x2 = P[8];
        e.y2 = P[9];
        e.lx = P[2];
        e.ly = P[3];
        break;
      case 4:
        e.dimType = 'radius';
        e.x1 = P[0];
        e.y1 = P[1];
        e.x2 = P[8];
        e.y2 = P[9];
        e.lx = P[2];
        e.ly = P[3];
        break;
      case 6:
        e.dimType = 'ordinate';
        e.x1 = P[4];
        e.y1 = P[5];
        e.x2 = P[6];
        e.y2 = P[7];
        e.lx = P[6];
        e.ly = P[7];
        e.ordAxis = flags & 64 ? 'x' : 'y';
        if (P[0] !== 0 || P[1] !== 0) this.warn('Ordinate dimensions with a non-zero origin are measured from 0,0.');
        break;
      default:
        this.skip('DIMENSION');
        return;
    }
    this.add(cont, e);
  }

  leader(R, cont) {
    const pts = [];
    let style = '';
    let annType = 3;
    let handle = '';
    for (let i = 0; i < R.end; i++) {
      const v = R.vals[i];
      switch (R.codes[i]) {
        case 10:
          pts.push(num(v), 0);
          break;
        case 20:
          if (pts.length) pts[pts.length - 1] = num(v);
          break;
        case 3:
          style = v;
          break;
        case 73:
          annType = int(v);
          break;
        case 340:
          handle = v.trim().toUpperCase();
          break;
      }
    }
    if (pts.length < 4) {
      this.warn('LEADER with fewer than two vertices skipped.');
      return;
    }
    const ds = this.dimStyleName(style);
    const dsObj = this.dimMap.get(ds.toLowerCase());
    const e = this.base('leader');
    e.pts = pts;
    e.text = '';
    e.h = dsObj ? dsObj.textHeight * (dsObj.scale || 1) : this.drawing.header.textHeight;
    e.style = ds;
    this.add(cont, e);
    if (handle && annType === 0) this.leaderLinks.push({ e, handle });
  }

  hatch(R, cont) {
    const codes = R.codes;
    const vals = R.vals;
    const end = R.end;
    let name = '';
    let solid = false;
    let nPaths = 0;
    let elev = 0;
    let i = 0;
    for (; i < end; i++) {
      const c = codes[i];
      if (c === 2) name = vals[i].trim();
      else if (c === 30) elev = num(vals[i]);
      else if (c === 70) solid = (int(vals[i]) & 1) !== 0;
      else if (c === 91) {
        nPaths = int(vals[i]);
        i++;
        break;
      }
    }
    const loops = [];
    for (let p = 0; p < nPaths && i < end; p++) {
      while (i < end && codes[i] !== 92) i++;
      if (i >= end) break;
      const flags = int(vals[i]);
      i++;
      const loop = [];
      if (flags & 2) i = this.hatchPolyPath(R, i, loop);
      else i = this.hatchEdgePath(R, i, loop);
      if (loop.length >= 9 || (loop.length === 6 && (loop[2] || loop[5]))) loops.push(loop);
    }
    let angle = 0;
    let scale = 1;
    let inPattern = false;
    for (; i < end; i++) {
      const c = codes[i];
      if (c === 53 || c === 98) inPattern = true;
      else if (c === 450 && int(vals[i]) !== 0) solid = true;
      else if (inPattern) continue;
      else if (c === 52) angle = num(vals[i]) * DEG;
      else if (c === 41) scale = num(vals[i]) || 1;
    }
    if (!loops.length) {
      this.warn('HATCH without usable boundary skipped.');
      return;
    }
    const o = this.ocs;
    if (o) for (const l of loops) ocsBulgeList(o, l, elev);
    const e = this.base('hatch');
    e.loops = loops;
    e.pattern = solid ? 'SOLID' : name.toUpperCase() || 'SOLID';
    e.scale = scale;
    e.angle = o ? normAngle(ocsAngle(o, angle)) : angle;
    this.add(cont, e);
  }

  hatchPolyPath(R, i, loop) {
    const codes = R.codes;
    const vals = R.vals;
    const end = R.end;
    for (; i < end; i++) {
      const c = codes[i];
      if (c === 10) loop.push(num(vals[i]), 0, 0);
      else if (c === 20) {
        if (loop.length) loop[loop.length - 2] = num(vals[i]);
      } else if (c === 42) {
        if (loop.length) loop[loop.length - 1] = num(vals[i]);
      } else if (c === 97 || c === 92 || c === 75) break;
    }
    // drop a duplicated closing vertex
    const n = loop.length;
    if (n >= 6 && loop[0] === loop[n - 3] && loop[1] === loop[n - 2]) loop.length = n - 3;
    return i;
  }

  hatchEdgePath(R, i, loop) {
    const codes = R.codes;
    const vals = R.vals;
    const end = R.end;
    let nEdges = 0;
    if (i < end && codes[i] === 93) nEdges = int(vals[i++]);
    for (let k = 0; k < nEdges && i < end; k++) {
      while (i < end && codes[i] !== 72) {
        if (codes[i] === 97 || codes[i] === 92) return i;
        i++;
      }
      if (i >= end) break;
      const type = int(vals[i++]);
      // collect the edge's groups
      let x0 = 0,
        y0 = 0,
        x1 = 0,
        y1 = 0,
        r = 0,
        a0 = 0,
        a1 = 0,
        ccw = 1,
        deg = 3;
      const knots = [];
      const ctrl = [];
      const weights = [];
      const fit = [];
      for (; i < end; i++) {
        const c = codes[i];
        if (c === 72 || c === 92 || c === 75) break;
        if (c === 97) {
          // fit data of a spline edge, or the source boundary count after the path
          const nx = i + 1 < end ? codes[i + 1] : 0;
          if (type === 4 && (nx === 11 || nx === 12 || nx === 13)) continue;
          break;
        }
        const v = vals[i];
        switch (c) {
          case 10:
            if (type === 4) ctrl.push(num(v), 0);
            else x0 = num(v);
            break;
          case 20:
            if (type === 4) {
              if (ctrl.length) ctrl[ctrl.length - 1] = num(v);
            } else y0 = num(v);
            break;
          case 11:
            if (type === 4) fit.push(num(v), 0);
            else x1 = num(v);
            break;
          case 21:
            if (type === 4) {
              if (fit.length) fit[fit.length - 1] = num(v);
            } else y1 = num(v);
            break;
          case 40:
            if (type === 4) knots.push(num(v));
            else r = num(v);
            break;
          case 42:
            weights.push(num(v));
            break;
          case 50:
            a0 = num(v);
            break;
          case 51:
            a1 = num(v);
            break;
          case 73:
            ccw = int(v);
            break;
          case 94:
            deg = int(v);
            break;
        }
      }
      if (type === 1) loop.push(x0, y0, 0);
      else if (type === 2) arcEdge(loop, x0, y0, r, a0, a1, ccw !== 0);
      else if (type === 3) ellipseEdge(loop, x0, y0, x1, y1, r, a0, a1, ccw !== 0);
      else if (type === 4) this.splineEdge(loop, deg, knots, ctrl, weights, fit);
    }
    return i;
  }

  splineEdge(loop, deg, knots, ctrl, weights, fit) {
    let pts = null;
    const n = ctrl.length >> 1;
    if (n >= deg + 1 && knots.length === n + deg + 1) {
      const w = weights.length === n ? weights : null;
      pts = tessellateSpline(deg, knots, ctrl, w, Math.min(256, Math.max(16, n * 8)));
    } else if (fit.length >= 4) {
      const f = fitToSpline(fit);
      pts = tessellateSpline(3, f.knots, f.ctrl, null, Math.min(256, Math.max(16, fit.length * 4)));
    }
    if (!pts) return;
    for (let j = 0; j < pts.length - 2; j += 2) loop.push(pts[j], pts[j + 1], 0);
  }

  insert(R, cont) {
    let name = '',
      x = 0,
      y = 0,
      z = 0,
      sx = 1,
      sy = 1,
      rot = 0,
      cols = 1,
      rows = 1,
      cs = 0,
      rs = 0;
    for (let i = 0; i < R.end; i++) {
      const v = R.vals[i];
      switch (R.codes[i]) {
        case 2:
          name = v;
          break;
        case 10:
          x = num(v);
          break;
        case 20:
          y = num(v);
          break;
        case 30:
          z = num(v);
          break;
        case 41:
          sx = num(v) || 1;
          break;
        case 42:
          sy = num(v) || 1;
          break;
        case 50:
          rot = num(v) * DEG;
          break;
        case 70:
          cols = Math.max(1, int(v));
          break;
        case 71:
          rows = Math.max(1, int(v));
          break;
        case 44:
          cs = num(v);
          break;
        case 45:
          rs = num(v);
          break;
      }
    }
    name = decodeUnicode(name.trim());
    if (!name) {
      this.warn('INSERT without block name skipped.');
      return;
    }
    if (cols * rows > MAX_MINSERT) {
      this.warn(`Block array with ${cols * rows} copies truncated to ${MAX_MINSERT}.`);
      rows = Math.max(1, Math.floor(MAX_MINSERT / cols));
      cols = Math.min(cols, MAX_MINSERT);
    }
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const o = this.ocs;
    let wrot = rot;
    let wsy = sy;
    if (o) {
      const m = o.m;
      // block X axis (c, s) and Y axis (-s, c) mapped to WCS
      const dX = c * m[0] + s * m[1];
      const dY = c * m[3] + s * m[4];
      const eX = -s * m[0] + c * m[1];
      const eY = -s * m[3] + c * m[4];
      wrot = Math.atan2(dY, dX);
      if (dX * eY - dY * eX < 0) wsy = -sy;
    }
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        let px = x + c * k * cs - s * r * rs;
        let py = y + s * k * cs + c * r * rs;
        if (o) {
          ocsPt(o, px, py, z);
          px = P2[0];
          py = P2[1];
        }
        const e = this.base('insert');
        e.name = name;
        e.x = px;
        e.y = py;
        e.sx = sx;
        e.sy = wsy;
        e.rot = normAngle(wrot);
        this.add(cont, e);
      }
    }
  }

  /** Table entity: drawn through its anonymous block. */
  tableEntity(R, cont) {
    const name = gStr(R, 2).trim();
    if (!name) {
      this.skip('ACAD_TABLE');
      return;
    }
    const e = this.base('insert');
    e.name = decodeUnicode(name);
    e.x = gNum(R, 10);
    e.y = gNum(R, 20);
    e.sx = 1;
    e.sy = 1;
    e.rot = 0;
    this.add(cont, e);
  }

  solid(R, cont) {
    const p = [0, 0, 0, 0, 0, 0, 0, 0];
    let z = 0;
    let has13 = false;
    for (let i = 0; i < R.end; i++) {
      const c = R.codes[i];
      if (c >= 10 && c <= 13) {
        p[(c - 10) * 2] = num(R.vals[i]);
        if (c === 13) has13 = true;
      } else if (c >= 20 && c <= 23) p[(c - 20) * 2 + 1] = num(R.vals[i]);
      else if (c === 30) z = num(R.vals[i]);
    }
    if (!has13) {
      p[6] = p[4];
      p[7] = p[5];
    }
    // vertex order 1, 2, 4, 3
    const loop = [p[0], p[1], 0, p[2], p[3], 0, p[6], p[7], 0];
    if (p[6] !== p[4] || p[7] !== p[5]) loop.push(p[4], p[5], 0);
    if (this.ocs) ocsBulgeList(this.ocs, loop, z);
    const e = this.base('hatch');
    e.loops = [loop];
    e.pattern = 'SOLID';
    e.scale = 1;
    e.angle = 0;
    this.add(cont, e);
  }

  mleader(R, cont) {
    const codes = R.codes;
    const vals = R.vals;
    let inCtx = false;
    let leader = null;
    let line = null;
    const leaders = [];
    let text = '';
    let tx = 0,
      ty = 0,
      th = 0,
      dirx = 1,
      diry = 0,
      hasLoc = false;
    for (let i = 0; i < R.end; i++) {
      const c = codes[i];
      const v = vals[i];
      if (c === 300) inCtx = true;
      else if (c === 301) inCtx = false;
      else if (c === 302) leader = { lines: [], cx: 0, cy: 0, dx: 0, dy: 0, dl: 0 };
      else if (c === 303) {
        if (leader) leaders.push(leader);
        leader = null;
      } else if (c === 304) {
        if (v.trim() === 'LEADER_LINE{') line = [];
        else if (inCtx && !leader) text = v;
      } else if (c === 305) {
        if (leader && line) leader.lines.push(line);
        line = null;
      } else if (line) {
        if (c === 10) line.push(num(v), 0);
        else if (c === 20 && line.length) line[line.length - 1] = num(v);
      } else if (leader) {
        if (c === 10) leader.cx = num(v);
        else if (c === 20) leader.cy = num(v);
        else if (c === 11) leader.dx = num(v);
        else if (c === 21) leader.dy = num(v);
        else if (c === 40) leader.dl = num(v);
      } else if (inCtx) {
        if (c === 41) th = num(v);
        else if (c === 12) {
          tx = num(v);
          hasLoc = true;
        } else if (c === 22) ty = num(v);
        else if (c === 13) dirx = num(v);
        else if (c === 23) diry = num(v);
      }
    }
    let made = 0;
    const h = th > 0 ? th : this.drawing.header.textHeight;
    for (const ld of leaders) {
      for (const ln of ld.lines) {
        const pts = ln.slice();
        pts.push(ld.cx, ld.cy);
        if (ld.dl > 0 && (ld.dx || ld.dy)) pts.push(ld.cx + ld.dx * ld.dl, ld.cy + ld.dy * ld.dl);
        if (pts.length < 4) continue;
        const e = this.base('leader');
        e.pts = pts;
        e.text = '';
        e.h = h;
        e.style = 'Standard';
        this.add(cont, e);
        made++;
      }
    }
    const value = stripMtext(decodeUnicode(text));
    if (value && hasLoc) {
      const e = this.base('mtext');
      e.x = tx;
      e.y = ty;
      e.h = h;
      e.rot = normAngle(Math.atan2(diry, dirx));
      e.value = value;
      e.style = 'Standard';
      e.width = 0;
      e.attach = 'tl';
      e.lineSpacing = 1;
      this.add(cont, e);
      made++;
    }
    if (!made) this.skip(R.type);
  }

  /* ---------------- post-processing ---------------- */

  finish() {
    this.endPoly();
    const d = this.drawing;
    const h = d.header;

    // linetypes, styles, layers defaults
    if (!this.ltMap.has('continuous')) {
      const lt = { name: 'Continuous', description: 'Solid line', pattern: [] };
      this.ltMap.set('continuous', lt);
      d.linetypes.unshift(lt);
    }
    if (!this.layerMap.has('0')) {
      const L = defaultLayer('0');
      this.layerMap.set('0', L);
      d.layers.unshift(L);
    }
    for (const L of d.layers) L.linetype = this.ltName(L.linetype, 'Continuous');
    if (!this.styleMap.has('standard')) {
      const st = defaultTextStyle('Standard');
      this.styleMap.set('standard', st);
      d.textStyles.unshift(st);
    }
    if (!this.dimMap.has('standard')) {
      const ds = defaultDimStyle('Standard');
      this.dimMap.set('standard', ds);
      d.dimStyles.unshift(ds);
    }

    // dimension style references by handle
    const arrowBlocks = new Set();
    for (const ref of this.dimRefs) {
      if (ref.blkHandle) {
        const bn = this.brHandles.get(ref.blkHandle);
        if (bn !== undefined) {
          ref.ds.arrowType = arrowFromName(bn);
          arrowBlocks.add(bn.toLowerCase());
        }
      }
      if (ref.txHandle) {
        const sn = this.styleHandles.get(ref.txHandle);
        if (sn) ref.ds.textStyle = sn;
      }
    }

    // leader annotations
    if (this.leaderLinks.length) {
      const drop = new Set();
      for (const link of this.leaderLinks) {
        const mt = this.mtextByHandle.get(link.handle);
        if (!mt || drop.has(mt.e)) continue;
        link.e.text = mt.e.value;
        link.e.h = mt.e.h;
        drop.add(mt.e);
      }
      if (drop.size) {
        const filt = (list) => {
          let j = 0;
          for (let i = 0; i < list.length; i++) if (!drop.has(list[i])) list[j++] = list[i];
          const removed = list.length - j;
          list.length = j;
          return removed;
        };
        this.stats.entities -= filt(d.entities);
        for (const b of d.blocks) this.stats.entities -= filt(b.entities);
      }
    }

    // block references: canonical names, unused anonymous dimension and arrow blocks
    const used = new Set();
    const fix = (list) => {
      for (const e of list) {
        if (e.type !== 'insert') continue;
        const b = this.blockMap.get(e.name.toLowerCase());
        if (b) {
          e.name = b.name;
          used.add(b.name.toLowerCase());
        } else this.warn(`Reference to undefined block '${e.name}'.`);
      }
    };
    fix(d.entities);
    for (const b of d.blocks) fix(b.entities);
    d.blocks = d.blocks.filter((b) => {
      const k = b.name.toLowerCase();
      if (used.has(k) || !(k.startsWith('*d') || arrowBlocks.has(k))) return true;
      this.stats.entities -= b.entities.length;
      return false;
    });

    // header references
    const raw = this.headerRaw;
    h.clayer = raw.clayer && this.layerMap.has(raw.clayer.toLowerCase()) ? this.layerMap.get(raw.clayer.toLowerCase()).name : '0';
    h.textStyle = this.styleName(raw.textStyle ?? '');
    h.dimStyle = this.dimStyleName(raw.dimStyle ?? '');
    if (raw.cltype) h.cltype = this.ltName(raw.cltype, 'ByLayer');
    if (h.ccolor < 0 || h.ccolor > 256) h.ccolor = COLOR_BYLAYER;
    h.nextId = this.model.nextId;
  }
}

/** Angle in (-PI, PI]. */
function signedAngle(a) {
  a = normAngle(a);
  return a > Math.PI ? a - TWO_PI : a;
}

function arrowFromName(raw) {
  let k = raw.trim().toLowerCase();
  if (k.startsWith('_')) k = k.slice(1);
  return ARROWS[k] ?? 'closed';
}

/** Hatch circular arc edge appended as a start vertex with a bulge. */
function arcEdge(loop, cx, cy, r, a0, a1, ccw) {
  let sweep = (a1 - a0) % 360;
  if (sweep <= 0) sweep += 360;
  if (Math.abs(a1 - a0) >= 360 - 1e-9) sweep = 360;
  let start = a0 * DEG;
  let sw = sweep * DEG;
  if (!ccw) {
    start = -start;
    sw = -sw;
  }
  // split sweeps over a half turn so the bulge stays finite and well conditioned
  const parts = Math.abs(sw) > Math.PI ? 2 : 1;
  const step = sw / parts;
  for (let i = 0; i < parts; i++) {
    const a = start + step * i;
    loop.push(cx + r * Math.cos(a), cy + r * Math.sin(a), Math.tan(step / 4));
  }
}

/** Hatch elliptical arc edge appended as tessellated vertices. */
function ellipseEdge(loop, cx, cy, mx, my, ratio, a0, a1, ccw) {
  const toParam = (deg) => {
    const a = deg * DEG;
    return Math.atan2(Math.sin(a) / ratio, Math.cos(a));
  };
  let t0 = toParam(a0);
  let t1 = toParam(a1);
  let sweep = t1 - t0;
  if (sweep <= 0) sweep += TWO_PI;
  if (Math.abs(a1 - a0) >= 360 - 1e-9) sweep = TWO_PI;
  if (!ccw) {
    t0 = -t0;
    sweep = -sweep;
  }
  const segs = Math.max(4, Math.ceil((Math.abs(sweep) / TWO_PI) * 64));
  const pts = ellipsePoints(cx, cy, mx, my, ratio, t0, t0 + sweep, segs);
  for (let j = 0; j < pts.length - 2; j += 2) loop.push(pts[j], pts[j + 1], 0);
}

/**
 * Angular dimension from two lines (a1 -> a2 and b1 -> b2) with arc point q.
 * Returns [x1, y1, x2, y2, vx, vy] with the rays ordered counter-clockwise.
 */
function angularFromLines(a1x, a1y, a2x, a2y, b1x, b1y, b2x, b2y, qx, qy) {
  const ux = a2x - a1x;
  const uy = a2y - a1y;
  const wx = b2x - b1x;
  const wy = b2y - b1y;
  const den = ux * wy - uy * wx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((b1x - a1x) * wy - (b1y - a1y) * wx) / den;
  const vx = a1x + ux * t;
  const vy = a1y + uy * t;
  const lu = Math.hypot(ux, uy);
  const lw = Math.hypot(wx, wy);
  const L1 = Math.max(Math.hypot(a1x - vx, a1y - vy), Math.hypot(a2x - vx, a2y - vy), lu);
  const L2 = Math.max(Math.hypot(b1x - vx, b1y - vy), Math.hypot(b2x - vx, b2y - vy), lw);
  const qdx = qx - vx;
  const qdy = qy - vy;
  const cr = (ax, ay, bx, by) => ax * by - ay * bx;
  let best = null;
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      const ax = (s1 * ux) / lu;
      const ay = (s1 * uy) / lu;
      const bx = (s2 * wx) / lw;
      const by = (s2 * wy) / lw;
      const ab = cr(ax, ay, bx, by);
      if (cr(ax, ay, qdx, qdy) * ab >= 0 && cr(bx, by, qdx, qdy) * -ab >= 0) {
        best = ab >= 0 ? [ax, ay, bx, by] : [bx, by, ax, ay];
        if (ab < 0) best.push(true);
        break;
      }
    }
    if (best) break;
  }
  if (!best) best = [ux / lu, uy / lu, wx / lw, wy / lw];
  const swapped = best[4] === true;
  const l1 = swapped ? L2 : L1;
  const l2 = swapped ? L1 : L2;
  return [vx + best[0] * l1, vy + best[1] * l1, vx + best[2] * l2, vy + best[3] * l2, vx, vy];
}

/**
 * Parse an ASCII DXF file.
 * @param {string | ArrayBuffer | Uint8Array} input file content
 * @param {object} [opts] reserved for future options
 * @returns {{ drawing: object, warnings: string[], stats: { entities: number, skipped: Object<string, number> } }}
 */
/**
 * Convert a stream of DXF-style records (see DxfParser.runRecords) into the
 * drawing model. Used by the DWG reader.
 */
export function parseRecords(records, opts = {}) {
  return new DxfParser(opts).runRecords(records);
}

export function parseDxf(input, opts = {}) {
  const text = decodeInput(input);
  return new DxfParser(opts).run(text);
}
