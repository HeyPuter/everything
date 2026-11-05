/**
 * ASCII DXF writer. Produces a DXF R2000 (AC1015) file from the drawing
 * model in core/schema.js, with handles, owner pointers and subclass markers
 * on every object so that strict readers accept it.
 *
 * Options:
 *   extents            [minX, minY, maxX, maxY] or { minX, minY, maxX, maxY }:
 *                      written as $EXTMIN / $EXTMAX and used for the initial view
 *   dimensionEntities  (ent) => Entity[]: rendered geometry of a dimension
 *                      (lines, polylines, solid hatches, text) in world space
 *   dimBlocks          { [id]: Entity[] } or Map: precomputed geometry, the
 *                      alternative to dimensionEntities (for workers). Model
 *                      space dimensions use the entity id as key, dimensions
 *                      inside blocks use 'blockName/id'.
 *   explodeDimensions  true: write the dimension geometry as plain entities
 *                      instead of DIMENSION entities with anonymous blocks
 *   hatchPattern       (name) => PatternLine[] | null
 *   hatchPatterns      { [name]: PatternLine[] }, the alternative to hatchPattern
 *                      PatternLine: { angle (degrees), x, y, dx, dy, dashes: number[] }
 *                      or [angle, x, y, dx, dy, ...dashes], as in PAT definitions
 *                      (dx along the line, dy perpendicular to it)
 *   warnings           array that receives warning messages
 */
import { defaultHeader, defaultLayer, LW_DEFAULT } from '../../core/schema.js';
import { hexToRgb, nearestIndex } from '../../core/colors.js';
import { STANDARD_LINETYPES } from '../../core/linetypes.js';
import { defaultTextStyle, defaultDimStyle } from '../../core/styles.js';
import { uniformKnots, normAngle } from './geom.js';
import { splineFromFitPoints } from '../../core/geom/spline.js';

const RAD = 180 / Math.PI;
const DEG = Math.PI / 180;
const EOL = '\r\n';
const PAD = [];
for (let i = 0; i < 1072; i++) PAD.push(String(i).padStart(3) + EOL);
const FLUSH = 1 << 16;

const UNIT_CODES = { unitless: 0, in: 1, ft: 2, mm: 4, cm: 5, m: 6 };
const LUNIT_CODES = { scientific: 1, decimal: 2, engineering: 3, architectural: 4, fractional: 5 };
const AUNIT_CODES = { deg: 0, dms: 1, grad: 2, rad: 3 };
const HALIGN = { left: 0, center: 1, right: 2 };
const VALIGN = { baseline: 0, bottom: 1, middle: 2, top: 3 };
const ATTACH = { tl: 1, tc: 2, tr: 3, ml: 4, mc: 5, mr: 6, bl: 7, bc: 8, br: 9 };
const ARROW_BLOCKS = { open: '_Open', dot: '_Dot', none: '_None' };
const BAD_NAME = /[<>/\\":;?*|=`]/g;

/** Format a real number without exponent notation. */
export function fmt(n) {
  n = +n;
  if (!Number.isFinite(n)) return '0.0';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return (n === 0 ? 0 : n) + '.0';
  let s = String(n);
  if (s.indexOf('e') >= 0 && Math.abs(n) < 1) {
    s = n.toFixed(20).replace(/0+$/, '');
    if (s.endsWith('.')) s += '0';
    if (s === '-0.0') s = '0.0';
  }
  return s;
}

/** Encode a string value: non-ASCII as \U+XXXX, control characters as spaces. */
export function encodeString(s, caret = false) {
  s = s == null ? '' : String(s);
  let plain = true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c > 126 || (caret && c === 94)) {
      plain = false;
      break;
    }
  }
  if (plain) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 32) out += ' ';
    else if (c > 126) out += '\\U+' + c.toString(16).toUpperCase().padStart(4, '0');
    else if (caret && c === 94) out += '^ ';
    else out += s[i];
  }
  return out;
}

/** Encode plain text as MTEXT content ('\n' becomes \P, braces and backslashes escaped). */
export function encodeMtext(s) {
  s = s == null ? '' : String(s);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const c = s.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (ch === '\n') out += '\\P';
    else if (ch === '\t') out += '^I';
    else if (ch === '^') out += '^ ';
    else if (c < 32) continue;
    else if (c > 126) out += '\\U+' + c.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out;
}

function safeName(name, allowStar = false) {
  let s = String(name ?? '').trim();
  if (allowStar && s.startsWith('*')) return '*' + s.slice(1).replace(BAD_NAME, '_');
  return s.replace(BAD_NAME, '_');
}

function trueColorInt(c) {
  if (typeof c !== 'string' || c.length !== 7 || c[0] !== '#') return null;
  const n = parseInt(c.slice(1), 16);
  return n === n ? n : null;
}

function patternLines(def) {
  const out = [];
  for (const l of def || []) {
    if (Array.isArray(l)) {
      out.push({ angle: +l[0] || 0, x: +l[1] || 0, y: +l[2] || 0, dx: +l[3] || 0, dy: +l[4] || 0, dashes: l.slice(5).map(Number) });
    } else if (l && typeof l === 'object') {
      out.push({
        angle: +l.angle || 0,
        x: +l.x || 0,
        y: +l.y || 0,
        dx: +l.dx || 0,
        dy: +l.dy || 0,
        dashes: Array.isArray(l.dashes) ? l.dashes.map(Number) : [],
      });
    }
  }
  return out;
}

class DxfWriter {
  constructor(drawing, opts) {
    this.d = drawing || {};
    this.opts = opts || {};
    this.warnings = Array.isArray(this.opts.warnings) ? this.opts.warnings : [];
    this.warnSeen = new Set();
    this.seed = 0;
    this.chunks = [];
    this.buf = '';
  }

  warn(msg) {
    if (this.warnSeen.has(msg)) return;
    this.warnSeen.add(msg);
    this.warnings.push(msg);
  }

  h() {
    return (++this.seed).toString(16).toUpperCase();
  }

  g(code, v) {
    this.buf += PAD[code] + v + EOL;
  }

  n(code, x) {
    this.buf += PAD[code] + fmt(x) + EOL;
  }

  i(code, x) {
    this.buf += PAD[code] + String(Math.trunc(+x) || 0) + EOL;
  }

  s(code, str) {
    this.buf += PAD[code] + encodeString(str) + EOL;
  }

  pt(code, x, y) {
    this.n(code, x);
    this.n(code + 10, y);
    this.n(code + 20, 0);
  }

  flush() {
    if (this.buf) this.chunks.push(this.buf);
    this.buf = '';
  }

  /* ---------------- preparation ---------------- */

  prepare() {
    const d = this.d;
    this.hdr = { ...defaultHeader(), ...(d.header || {}) };

    this.layerOut = new Map();
    this.layers = [];
    for (const L of d.layers || []) if (L && L.name != null) this.defLayer({ ...defaultLayer(String(L.name)), ...L });
    if (!this.layerOut.has('0')) this.defLayer(defaultLayer('0'));

    this.ltOut = new Map([
      ['bylayer', 'ByLayer'],
      ['byblock', 'ByBlock'],
      ['continuous', 'Continuous'],
    ]);
    this.ltypes = [];
    for (const lt of d.linetypes || []) {
      if (!lt || lt.name == null) continue;
      const key = String(lt.name).toLowerCase();
      if (this.ltOut.has(key)) continue;
      const name = safeName(lt.name);
      this.ltOut.set(key, name);
      this.ltypes.push({ name, description: lt.description ?? '', pattern: (lt.pattern || []).map(Number) });
    }
    for (const L of this.layers) L.linetype = this.ltRef(L.linetype, 'Continuous');

    this.styleOut = new Map();
    this.styles = [];
    for (const st of d.textStyles || []) {
      if (!st || st.name == null) continue;
      const key = String(st.name).toLowerCase();
      if (this.styleOut.has(key)) continue;
      const s = { ...defaultTextStyle(safeName(st.name)), ...st, name: safeName(st.name) };
      this.styleOut.set(key, s.name);
      this.styles.push(s);
    }
    if (!this.styleOut.has('standard')) {
      this.styleOut.set('standard', 'Standard');
      this.styles.unshift(defaultTextStyle('Standard'));
    }

    this.dimOut = new Map();
    this.dims = [];
    for (const ds of d.dimStyles || []) {
      if (!ds || ds.name == null) continue;
      const key = String(ds.name).toLowerCase();
      if (this.dimOut.has(key)) continue;
      const s = { ...defaultDimStyle(safeName(ds.name)), ...ds, name: safeName(ds.name) };
      this.dimOut.set(key, s.name);
      this.dims.push(s);
    }
    if (!this.dimOut.has('standard')) {
      this.dimOut.set('standard', 'Standard');
      this.dims.unshift(defaultDimStyle('Standard'));
    }

    this.blockOut = new Map([
      ['*model_space', '*Model_Space'],
      ['*paper_space', '*Paper_Space'],
    ]);
    this.blocks = [];
    for (const b of d.blocks || []) {
      if (!b || b.name == null) continue;
      const name = safeName(b.name, true);
      const key = String(b.name).toLowerCase();
      if (!name || this.blockOut.has(key)) {
        this.warn(`Block '${b.name}' skipped (duplicate or reserved name).`);
        continue;
      }
      this.blockOut.set(key, name);
      this.blocks.push({ src: b, name, br: '' });
    }

    // arrow blocks used by dimension styles
    this.arrowBlocks = new Map();
    for (const ds of this.dims) {
      const an = ARROW_BLOCKS[ds.arrowType];
      if (!an || this.arrowBlocks.has(ds.arrowType)) continue;
      const user = this.blocks.find((b) => b.name.toLowerCase() === an.toLowerCase());
      if (user) this.arrowBlocks.set(ds.arrowType, user);
      else {
        const ab = { src: { name: an, bx: 0, by: 0, entities: arrowGeometry(ds.arrowType) }, name: an, br: '', arrow: true };
        this.blockOut.set(an.toLowerCase(), an);
        this.arrowBlocks.set(ds.arrowType, ab);
      }
    }

    // scan entities for referenced names and dimension geometry
    this.dimInfo = new Map();
    this.dimBlocks = [];
    this.dimCounter = 0;
    for (const e of d.entities || []) this.scan(e, null);
    for (const b of this.blocks) for (const e of b.src.entities || []) this.scan(e, b.src.name);

    // handles that are referenced before their objects are written
    this.hRoot = this.h();
    this.hGroup = this.h();
    this.hPsDict = this.h();
    this.hPlaceholder = this.h();
    this.brModel = this.h();
    this.brPaper = this.h();
    for (const b of this.blocks) b.br = this.h();
    for (const ab of this.arrowBlocks.values()) if (ab.arrow) ab.br = this.h();
    for (const db of this.dimBlocks) db.br = this.h();
    // draw order set with DRAWORDER: a SORTENTS table in model space's extension dictionary
    this.sortEntries = [];
    if ((d.entities || []).some((e) => e && e.orderGroup != null)) {
      this.hSortDict = this.h();
      this.hSortents = this.h();
    }
  }

  defLayer(L) {
    const key = String(L.name).toLowerCase();
    if (this.layerOut.has(key)) return;
    const name = safeName(L.name) || '0';
    this.layerOut.set(key, name);
    this.layers.push({ ...L, name });
  }

  layerRef(name) {
    const key = String(name ?? '0').toLowerCase();
    let out = this.layerOut.get(key);
    if (out === undefined) {
      this.defLayer(defaultLayer(String(name ?? '0') || '0'));
      out = this.layerOut.get(key) ?? '0';
    }
    return out;
  }

  ltRef(name, fallback = 'ByLayer') {
    if (name == null || name === '') return fallback;
    const key = String(name).toLowerCase();
    const out = this.ltOut.get(key);
    if (out !== undefined) return out;
    const std = STANDARD_LINETYPES.find((s) => s.name.toLowerCase() === key);
    if (std) {
      this.ltOut.set(key, std.name);
      this.ltypes.push({ name: std.name, description: std.description, pattern: std.pattern.slice() });
      return std.name;
    }
    this.warn(`Undefined linetype '${name}' written as ${fallback}.`);
    return fallback;
  }

  styleRef(name) {
    return this.styleOut.get(String(name ?? '').toLowerCase()) ?? 'Standard';
  }

  dimRef(name) {
    return this.dimOut.get(String(name ?? '').toLowerCase()) ?? 'Standard';
  }

  scan(e, blockName) {
    if (!e || typeof e !== 'object') return;
    this.layerRef(e.layer);
    this.ltRef(e.linetype);
    if (e.type === 'dimension') this.prepDim(e, blockName);
  }

  prepDim(e, blockName) {
    const opts = this.opts;
    let geom;
    if (typeof opts.dimensionEntities === 'function') {
      try {
        geom = opts.dimensionEntities(e);
      } catch (err) {
        this.warn(`Dimension geometry callback failed: ${err.message}`);
      }
    } else if (opts.dimBlocks) {
      const key = blockName == null ? e.id : `${blockName}/${e.id}`;
      geom = opts.dimBlocks instanceof Map ? opts.dimBlocks.get(key) ?? opts.dimBlocks.get(String(key)) : opts.dimBlocks[key];
    }
    if (!Array.isArray(geom)) {
      this.warn('Dimensions without supplied geometry were skipped.');
      this.dimInfo.set(e, null);
      return;
    }
    geom = geom.filter((g) => g && typeof g === 'object' && g.type !== 'dimension');
    for (const g of geom) this.scan(g, null);
    let tx = +e.lx || 0;
    let ty = +e.ly || 0;
    const t = geom.find((g) => g.type === 'text' || g.type === 'mtext');
    if (t) {
      tx = +t.x || 0;
      ty = +t.y || 0;
    }
    if (opts.explodeDimensions) {
      this.dimInfo.set(e, { explode: true, geom });
      return;
    }
    let name;
    do name = '*D' + ++this.dimCounter;
    while (this.blockOut.has(name.toLowerCase()));
    this.blockOut.set(name.toLowerCase(), name);
    const info = { name, geom, tx, ty, br: '' };
    this.dimInfo.set(e, info);
    this.dimBlocks.push(info);
  }

  /* ---------------- sections ---------------- */

  write() {
    this.prepare();
    this.g(0, 'SECTION');
    this.g(2, 'CLASSES');
    if (this.hSortents) {
      this.g(0, 'CLASS');
      this.g(1, 'SORTENTSTABLE');
      this.g(2, 'AcDbSortentsTable');
      this.g(3, 'ObjectDBX Classes');
      this.i(90, 0);
      this.i(280, 0);
      this.i(281, 0);
    }
    this.g(0, 'ENDSEC');
    this.tables();
    this.blocksSection();
    this.entitiesSection();
    this.objects();
    this.g(0, 'EOF');
    this.flush();
    const body = this.chunks.join('');
    this.chunks = [];
    this.headerSection();
    this.flush();
    return this.chunks.join('') + body;
  }

  headerSection() {
    const h = this.hdr;
    const v = (name) => this.g(9, name);
    this.g(0, 'SECTION');
    this.g(2, 'HEADER');
    v('$ACADVER');
    this.g(1, 'AC1015');
    v('$ACADMAINTVER');
    this.i(70, 6);
    v('$DWGCODEPAGE');
    this.g(3, 'ANSI_1252');
    v('$INSBASE');
    this.pt(10, 0, 0);
    const ext = this.extents();
    if (ext) {
      v('$EXTMIN');
      this.pt(10, ext[0], ext[1]);
      v('$EXTMAX');
      this.pt(10, ext[2], ext[3]);
    }
    v('$LTSCALE');
    this.n(40, +h.ltscale || 1);
    v('$TEXTSIZE');
    this.n(40, +h.textHeight || 2.5);
    v('$CLAYER');
    this.s(8, this.layerOut.get(String(h.clayer ?? '0').toLowerCase()) ?? '0');
    v('$CELTYPE');
    this.s(6, this.ltOut.get(String(h.cltype ?? 'ByLayer').toLowerCase()) ?? 'ByLayer');
    v('$CECOLOR');
    const cc = trueColorInt(h.ccolor);
    this.i(62, cc !== null ? nearestIndex(hexToRgb(h.ccolor)) : Number.isInteger(h.ccolor) ? h.ccolor : 256);
    v('$CELWEIGHT');
    this.i(370, Number.isInteger(h.clweight) ? h.clweight : -1);
    v('$TEXTSTYLE');
    this.s(7, this.styleRef(h.textStyle));
    v('$DIMSTYLE');
    this.s(2, this.dimRef(h.dimStyle));
    v('$LUNITS');
    this.i(70, LUNIT_CODES[h.linearFormat] ?? 2);
    v('$LUPREC');
    this.i(70, h.linearPrecision ?? 4);
    v('$AUNITS');
    this.i(70, AUNIT_CODES[h.angularFormat] ?? 0);
    v('$AUPREC');
    this.i(70, h.angularPrecision ?? 0);
    v('$PDMODE');
    this.i(70, h.pdmode ?? 0);
    v('$PDSIZE');
    this.n(40, h.pdsize ?? 0);
    v('$INSUNITS');
    this.i(70, UNIT_CODES[h.units] ?? 0);
    v('$MEASUREMENT');
    this.i(70, h.units === 'in' || h.units === 'ft' ? 0 : 1);
    v('$HANDSEED');
    this.g(5, (this.seed + 1).toString(16).toUpperCase());
    this.g(0, 'ENDSEC');
  }

  extents() {
    const e = this.opts.extents;
    if (!e) return null;
    const a = Array.isArray(e) ? e : [e.minX, e.minY, e.maxX, e.maxY];
    if (a.length < 4 || !a.every((x) => Number.isFinite(+x))) return null;
    return a.map(Number);
  }

  tableHead(name, handle, count) {
    this.g(0, 'TABLE');
    this.g(2, name);
    this.g(5, handle);
    this.g(330, '0');
    this.g(100, 'AcDbSymbolTable');
    this.i(70, count);
  }

  entryHead(type, owner, sub, handleCode = 5) {
    const hd = this.h();
    this.g(0, type);
    this.g(handleCode, hd);
    this.g(330, owner);
    this.g(100, 'AcDbSymbolTableRecord');
    this.g(100, sub);
    return hd;
  }

  tables() {
    this.g(0, 'SECTION');
    this.g(2, 'TABLES');

    // VPORT
    let th = this.h();
    this.tableHead('VPORT', th, 1);
    this.entryHead('VPORT', th, 'AcDbViewportTableRecord');
    this.g(2, '*Active');
    this.i(70, 0);
    const ext = this.extents();
    let cx = 0,
      cy = 0,
      vh = 100,
      ar = 1.5;
    if (ext) {
      cx = (ext[0] + ext[2]) / 2;
      cy = (ext[1] + ext[3]) / 2;
      const w = Math.max(ext[2] - ext[0], 1e-9);
      vh = Math.max(ext[3] - ext[1], w / ar, 1e-6) * 1.1;
    }
    this.n(10, 0);
    this.n(20, 0);
    this.n(11, 1);
    this.n(21, 1);
    this.n(12, cx);
    this.n(22, cy);
    this.n(13, 0);
    this.n(23, 0);
    this.n(14, 1);
    this.n(24, 1);
    this.n(15, 10);
    this.n(25, 10);
    this.n(16, 0);
    this.n(26, 0);
    this.n(36, 1);
    this.n(17, 0);
    this.n(27, 0);
    this.n(37, 0);
    this.n(40, vh);
    this.n(41, ar);
    this.n(42, 50);
    this.n(43, 0);
    this.n(44, 0);
    this.n(50, 0);
    this.n(51, 0);
    this.i(71, 0);
    this.i(72, 100);
    this.i(73, 1);
    this.i(74, 3);
    this.i(75, 0);
    this.i(76, 0);
    this.i(77, 0);
    this.i(78, 0);
    this.i(281, 0);
    this.i(65, 1);
    this.pt(110, 0, 0);
    this.n(111, 1);
    this.n(121, 0);
    this.n(131, 0);
    this.n(112, 0);
    this.n(122, 1);
    this.n(132, 0);
    this.i(79, 0);
    this.n(146, 0);
    this.g(0, 'ENDTAB');

    // LTYPE
    th = this.h();
    this.tableHead('LTYPE', th, 3 + this.ltypes.length);
    this.ltypeEntry(th, 'ByBlock', '', []);
    this.ltypeEntry(th, 'ByLayer', '', []);
    this.ltypeEntry(th, 'Continuous', 'Solid line', []);
    for (const lt of this.ltypes) this.ltypeEntry(th, lt.name, lt.description, lt.pattern);
    this.g(0, 'ENDTAB');

    // LAYER
    th = this.h();
    this.tableHead('LAYER', th, this.layers.length);
    for (const L of this.layers) this.layerEntry(th, L);
    this.g(0, 'ENDTAB');

    // STYLE
    th = this.h();
    this.tableHead('STYLE', th, this.styles.length);
    this.styleHandles = new Map();
    for (const st of this.styles) {
      const hd = this.entryHead('STYLE', th, 'AcDbTextStyleTableRecord');
      this.styleHandles.set(st.name.toLowerCase(), hd);
      this.s(2, st.name);
      this.i(70, 0);
      this.n(40, +st.height > 0 ? +st.height : 0);
      this.n(41, +st.widthFactor || 1);
      this.n(50, (+st.oblique || 0) * RAD);
      this.i(71, 0);
      this.n(42, +this.hdr.textHeight || 2.5);
      this.g(3, st.font === 'mono' ? 'monotxt' : 'txt');
      this.g(4, '');
    }
    this.g(0, 'ENDTAB');

    // VIEW, UCS
    for (const name of ['VIEW', 'UCS']) {
      this.tableHead(name, this.h(), 0);
      this.g(0, 'ENDTAB');
    }

    // APPID
    const apps = ['ACAD'];
    if (this.layers.some((L) => +L.transparency > 0)) apps.push('AcCmTransparency');
    if (this.layers.some((L) => L.description)) apps.push('AcAecLayerStandard');
    th = this.h();
    this.tableHead('APPID', th, apps.length);
    for (const a of apps) {
      this.entryHead('APPID', th, 'AcDbRegAppTableRecord');
      this.g(2, a);
      this.i(70, 0);
    }
    this.g(0, 'ENDTAB');

    // DIMSTYLE (entry handles use group 105)
    th = this.h();
    this.tableHead('DIMSTYLE', th, this.dims.length);
    const dimHandles = this.dims.map(() => this.h());
    this.g(100, 'AcDbDimStyleTable');
    this.i(71, this.dims.length);
    for (const hd of dimHandles) this.g(340, hd);
    this.dims.forEach((ds, k) => this.dimStyleEntry(th, ds, dimHandles[k]));
    this.g(0, 'ENDTAB');

    // BLOCK_RECORD
    th = this.h();
    const recs = [
      ['*Model_Space', this.brModel],
      ['*Paper_Space', this.brPaper],
      ...this.blocks.map((b) => [b.name, b.br]),
      ...[...this.arrowBlocks.values()].filter((b) => b.arrow).map((b) => [b.name, b.br]),
      ...this.dimBlocks.map((b) => [b.name, b.br]),
    ];
    this.tableHead('BLOCK_RECORD', th, recs.length);
    for (const [name, hd] of recs) {
      this.g(0, 'BLOCK_RECORD');
      this.g(5, hd);
      if (hd === this.brModel && this.hSortents) {
        this.g(102, '{ACAD_XDICTIONARY');
        this.g(360, this.hSortDict);
        this.g(102, '}');
      }
      this.g(330, th);
      this.g(100, 'AcDbSymbolTableRecord');
      this.g(100, 'AcDbBlockTableRecord');
      this.s(2, name);
    }
    this.g(0, 'ENDTAB');

    this.g(0, 'ENDSEC');
  }

  ltypeEntry(owner, name, desc, pattern) {
    this.entryHead('LTYPE', owner, 'AcDbLinetypeTableRecord');
    this.s(2, name);
    this.i(70, 0);
    this.s(3, desc ?? '');
    this.i(72, 65);
    this.i(73, pattern.length);
    let total = 0;
    for (const p of pattern) total += Math.abs(p);
    this.n(40, total);
    for (const p of pattern) {
      this.n(49, p);
      this.i(74, 0);
    }
  }

  layerEntry(owner, L) {
    this.entryHead('LAYER', owner, 'AcDbLayerTableRecord');
    this.s(2, L.name);
    this.i(70, (L.frozen ? 1 : 0) | (L.locked ? 4 : 0));
    const tc = trueColorInt(L.color);
    let idx = tc !== null ? nearestIndex(hexToRgb(L.color)) : Number.isInteger(L.color) && L.color >= 1 && L.color <= 255 ? L.color : 7;
    if (L.on === false) idx = -idx;
    this.i(62, idx);
    if (tc !== null) this.i(420, tc);
    this.s(6, this.ltRef(L.linetype, 'Continuous').replace(/^By(Layer|Block)$/, 'Continuous'));
    this.i(290, L.plot === false ? 0 : 1);
    this.i(370, Number.isInteger(L.lineweight) && L.lineweight >= 0 ? L.lineweight : LW_DEFAULT);
    this.g(390, this.hPlaceholder);
    if (L.description) {
      this.g(1001, 'AcAecLayerStandard');
      this.g(1000, '');
      this.s(1000, L.description);
    }
    const t = +L.transparency;
    if (t > 0) {
      const alpha = Math.round(255 * (1 - Math.min(90, t) / 100));
      this.g(1001, 'AcCmTransparency');
      this.i(1071, 0x02000000 | alpha);
    }
  }

  dimStyleEntry(owner, ds, hd) {
    this.g(0, 'DIMSTYLE');
    this.g(105, hd);
    this.g(330, owner);
    this.g(100, 'AcDbSymbolTableRecord');
    this.g(100, 'AcDbDimStyleTableRecord');
    this.s(2, ds.name);
    this.i(70, 0);
    if (ds.prefix || ds.suffix) this.s(3, `${ds.prefix ?? ''}<>${ds.suffix ?? ''}`);
    this.n(40, +ds.scale > 0 ? +ds.scale : 1);
    this.n(41, +ds.arrowSize || 0);
    this.n(42, +ds.extOffset || 0);
    this.n(44, +ds.extExtend || 0);
    const horiz = ds.textAlign === 'horizontal' ? 1 : 0;
    this.i(73, horiz);
    this.i(74, horiz);
    this.i(77, ds.textPlacement === 'centered' ? 0 : 1);
    this.i(78, ds.trailingZeros ? 0 : 8);
    this.n(140, +ds.textHeight || 2.5);
    this.n(141, +ds.centerMark || 0);
    this.n(142, ds.arrowType === 'tick' ? +ds.arrowSize || 0 : 0);
    this.n(147, +ds.textGap || 0);
    this.i(173, 0);
    this.i(176, dimColor(ds.lineColor));
    this.i(177, dimColor(ds.lineColor));
    this.i(178, dimColor(ds.textColor));
    this.i(271, ds.precision ?? 2);
    const sh = this.styleHandles.get(this.styleRef(ds.textStyle).toLowerCase());
    if (sh) this.g(340, sh);
    const ab = this.arrowBlocks.get(ds.arrowType);
    if (ab) this.g(342, ab.br);
  }

  blocksSection() {
    this.g(0, 'SECTION');
    this.g(2, 'BLOCKS');
    this.blockDef('*Model_Space', this.brModel, 0, 0, 0, false, null);
    this.blockDef('*Paper_Space', this.brPaper, 0, 0, 0, true, null);
    for (const b of this.blocks) {
      this.blockDef(b.name, b.br, b.name.startsWith('*') ? 1 : 0, +b.src.bx || 0, +b.src.by || 0, false, b.src.entities, b.src.name);
    }
    for (const ab of this.arrowBlocks.values()) {
      if (ab.arrow) this.blockDef(ab.name, ab.br, 0, 0, 0, false, ab.src.entities, ab.name);
    }
    for (const db of this.dimBlocks) this.blockDef(db.name, db.br, 1, 0, 0, false, db.geom, null, true);
    this.g(0, 'ENDSEC');
  }

  blockDef(name, br, flags, bx, by, paper, entities, srcName = null, isDim = false) {
    this.g(0, 'BLOCK');
    this.g(5, this.h());
    this.g(330, br);
    this.g(100, 'AcDbEntity');
    if (paper) this.i(67, 1);
    this.g(8, '0');
    this.g(100, 'AcDbBlockBegin');
    this.s(2, name);
    this.i(70, flags);
    this.pt(10, bx, by);
    this.s(3, name);
    this.g(1, '');
    if (entities) for (const e of entities) this.entity(e, br, isDim ? null : srcName);
    this.g(0, 'ENDBLK');
    this.g(5, this.h());
    this.g(330, br);
    this.g(100, 'AcDbEntity');
    if (paper) this.i(67, 1);
    this.g(8, '0');
    this.g(100, 'AcDbBlockEnd');
  }

  entitiesSection() {
    this.g(0, 'SECTION');
    this.g(2, 'ENTITIES');
    // Draw-order bands become runs of objects sharing a sort handle: the
    // handle of the run's first object, so the order stays the file order.
    let group = null;
    let key = '';
    for (const e of this.d.entities || []) {
      this.first = '';
      this.entity(e, this.brModel, null);
      if (!this.hSortents || !this.first) continue;
      const g = e.orderGroup ?? null;
      if (g !== null && g !== group) key = this.first;
      if (g !== null) this.sortEntries.push(this.first, key);
      group = g;
    }
    this.first = null;
    this.g(0, 'ENDSEC');
  }

  objects() {
    this.g(0, 'SECTION');
    this.g(2, 'OBJECTS');
    this.g(0, 'DICTIONARY');
    this.g(5, this.hRoot);
    this.g(330, '0');
    this.g(100, 'AcDbDictionary');
    this.i(281, 1);
    this.g(3, 'ACAD_GROUP');
    this.g(350, this.hGroup);
    this.g(3, 'ACAD_PLOTSTYLENAME');
    this.g(350, this.hPsDict);
    this.g(0, 'DICTIONARY');
    this.g(5, this.hGroup);
    this.g(102, '{ACAD_REACTORS');
    this.g(330, this.hRoot);
    this.g(102, '}');
    this.g(330, this.hRoot);
    this.g(100, 'AcDbDictionary');
    this.i(281, 1);
    this.g(0, 'ACDBDICTIONARYWDFLT');
    this.g(5, this.hPsDict);
    this.g(102, '{ACAD_REACTORS');
    this.g(330, this.hRoot);
    this.g(102, '}');
    this.g(330, this.hRoot);
    this.g(100, 'AcDbDictionary');
    this.i(281, 1);
    this.g(3, 'Normal');
    this.g(350, this.hPlaceholder);
    this.g(100, 'AcDbDictionaryWithDefault');
    this.g(340, this.hPlaceholder);
    this.g(0, 'ACDBPLACEHOLDER');
    this.g(5, this.hPlaceholder);
    this.g(102, '{ACAD_REACTORS');
    this.g(330, this.hPsDict);
    this.g(102, '}');
    this.g(330, this.hPsDict);
    if (this.hSortents) {
      this.g(0, 'DICTIONARY');
      this.g(5, this.hSortDict);
      this.g(102, '{ACAD_REACTORS');
      this.g(330, this.brModel);
      this.g(102, '}');
      this.g(330, this.brModel);
      this.g(100, 'AcDbDictionary');
      this.i(280, 1);
      this.i(281, 1);
      this.g(3, 'ACAD_SORTENTS');
      this.g(360, this.hSortents);
      this.g(0, 'SORTENTSTABLE');
      this.g(5, this.hSortents);
      this.g(102, '{ACAD_REACTORS');
      this.g(330, this.hSortDict);
      this.g(102, '}');
      this.g(330, this.hSortDict);
      this.g(100, 'AcDbSortentsTable');
      this.g(330, this.brModel);
      const se = this.sortEntries;
      for (let i = 0; i < se.length; i += 2) {
        this.g(331, se[i]);
        this.g(5, se[i + 1]);
      }
    }
    this.g(0, 'ENDSEC');
  }

  /* ---------------- entities ---------------- */

  /** Write one entity; on failure the partial output is discarded. */
  entity(e, owner, blockName) {
    if (!e || typeof e !== 'object') return;
    if (this.buf.length > FLUSH) this.flush();
    const mark = this.buf.length;
    try {
      this.entityBody(e, owner, blockName);
    } catch (err) {
      this.buf = this.buf.slice(0, mark);
      if (this.first) this.first = '';
      this.warn(`Could not write ${e.type} entity: ${err.message}`);
    }
  }

  common(type, e, owner, handle = this.h()) {
    if (this.first === '') this.first = handle;
    this.g(0, type);
    this.g(5, handle);
    this.g(330, owner);
    this.g(100, 'AcDbEntity');
    this.s(8, this.layerRef(e.layer));
    const lt = this.ltRef(e.linetype);
    if (lt !== 'ByLayer') this.s(6, lt);
    const c = e.color;
    const tc = trueColorInt(c);
    if (tc !== null) {
      this.i(62, nearestIndex(hexToRgb(c)));
      this.i(420, tc);
    } else if (Number.isInteger(c) && c >= 0 && c <= 255) this.i(62, c);
    const lw = e.lineweight;
    if (Number.isInteger(lw) && lw !== -1) this.i(370, lw);
    const lts = +e.ltscale;
    if (lts > 0 && lts !== 1) this.n(48, lts);
  }

  entityBody(e, owner, blockName) {
    switch (e.type) {
      case 'line':
        this.common('LINE', e, owner);
        this.g(100, 'AcDbLine');
        this.pt(10, e.x1, e.y1);
        this.pt(11, e.x2, e.y2);
        return;
      case 'xline':
      case 'ray': {
        const l = Math.hypot(+e.dx, +e.dy);
        if (!(l > 0)) throw new Error('zero direction');
        this.common(e.type === 'ray' ? 'RAY' : 'XLINE', e, owner);
        this.g(100, e.type === 'ray' ? 'AcDbRay' : 'AcDbXline');
        this.pt(10, e.x, e.y);
        this.pt(11, e.dx / l, e.dy / l);
        return;
      }
      case 'circle':
        if (!(+e.r > 0)) throw new Error('zero radius');
        this.common('CIRCLE', e, owner);
        this.g(100, 'AcDbCircle');
        this.pt(10, e.cx, e.cy);
        this.n(40, e.r);
        return;
      case 'arc':
        if (!(+e.r > 0)) throw new Error('zero radius');
        this.common('ARC', e, owner);
        this.g(100, 'AcDbCircle');
        this.pt(10, e.cx, e.cy);
        this.n(40, e.r);
        this.g(100, 'AcDbArc');
        this.n(50, normAngle(+e.start || 0) * RAD);
        this.n(51, normAngle(+e.end || 0) * RAD);
        return;
      case 'ellipse':
        return this.ellipse(e, owner);
      case 'polyline':
        return this.lwpolyline(e, owner);
      case 'spline':
        return this.spline(e, owner);
      case 'point':
        this.common('POINT', e, owner);
        this.g(100, 'AcDbPoint');
        this.pt(10, e.x, e.y);
        return;
      case 'text':
        return this.text(e, owner);
      case 'mtext':
        return this.mtext(e, owner);
      case 'leader':
        return this.leader(e, owner);
      case 'hatch':
        return this.hatch(e, owner);
      case 'insert':
        return this.insert(e, owner);
      case 'dimension':
        return this.dimension(e, owner);
      default:
        throw new Error('unsupported entity type');
    }
  }

  ellipse(e, owner) {
    let mx = +e.mx || 0;
    let my = +e.my || 0;
    let ratio = +e.ratio || 1;
    let s = +e.start || 0;
    let t = e.end == null ? 2 * Math.PI : +e.end;
    if (!(Math.hypot(mx, my) > 0) || !(ratio > 0)) throw new Error('degenerate ellipse');
    if (ratio > 1) {
      const nx = -my * ratio;
      const ny = mx * ratio;
      mx = nx;
      my = ny;
      ratio = 1 / ratio;
      s -= Math.PI / 2;
      t -= Math.PI / 2;
    }
    const full = Math.abs(t - s - 2 * Math.PI) < 1e-9;
    this.common('ELLIPSE', e, owner);
    this.g(100, 'AcDbEllipse');
    this.pt(10, e.cx, e.cy);
    this.pt(11, mx, my);
    this.n(210, 0);
    this.n(220, 0);
    this.n(230, 1);
    this.n(40, Math.max(1e-6, ratio));
    this.n(41, full ? 0 : normAngle(s));
    this.n(42, full ? 2 * Math.PI : normAngle(s) + (t - s));
  }

  lwpolyline(e, owner) {
    const p = e.pts || [];
    const n = Math.floor(p.length / 3);
    if (n < 2) throw new Error('fewer than two vertices');
    this.common('LWPOLYLINE', e, owner);
    this.g(100, 'AcDbPolyline');
    this.i(90, n);
    this.i(70, e.closed ? 1 : 0);
    this.n(43, +e.width > 0 ? +e.width : 0);
    for (let k = 0; k < n; k++) {
      this.n(10, p[k * 3]);
      this.n(20, p[k * 3 + 1]);
      const b = +p[k * 3 + 2] || 0;
      if (b && (e.closed || k < n - 1)) this.n(42, b);
    }
  }

  spline(e, owner) {
    let deg = Math.trunc(+e.degree) || 3;
    let ctrl = e.ctrl || [];
    let knots = e.knots || [];
    const fit = (e.fit || []).slice();
    // closed fit-point splines list their first point again at the end
    const nf0 = fit.length;
    if (e.closed && nf0 >= 6 && (fit[0] !== fit[nf0 - 2] || fit[1] !== fit[nf0 - 1])) fit.push(fit[0], fit[1]);
    if (ctrl.length < (deg + 1) * 2) {
      const f = fit.length >= 4 ? splineFromFitPoints(fit, !!e.closed) : null;
      if (!f) throw new Error('not enough control points');
      deg = f.degree;
      ctrl = f.ctrl;
      knots = f.knots;
    }
    const nc = ctrl.length >> 1;
    if (knots.length !== nc + deg + 1) {
      this.warn('Spline knot vectors of the wrong length were replaced with uniform knots.');
      knots = uniformKnots(nc, deg);
    }
    const nf = fit.length >> 1;
    this.common('SPLINE', e, owner);
    this.g(100, 'AcDbSpline');
    this.n(210, 0);
    this.n(220, 0);
    this.n(230, 1);
    this.i(70, 8 | (e.closed ? 1 : 0));
    this.i(71, deg);
    this.i(72, knots.length);
    this.i(73, nc);
    this.i(74, nf);
    this.n(42, 1e-10);
    this.n(43, 1e-10);
    if (nf) this.n(44, 1e-10);
    // Readers rebuild fit-point splines from the fit points; the end derivatives
    // (per unit of chord length) make them rebuild this exact curve.
    const tan = nf >= 2 && deg === 3 ? endTangents(ctrl, knots, fit) : null;
    if (tan) {
      this.pt(12, tan[0], tan[1]);
      this.pt(13, tan[2], tan[3]);
    }
    for (const k of knots) this.n(40, k);
    for (let k = 0; k < nc; k++) this.pt(10, ctrl[k * 2], ctrl[k * 2 + 1]);
    for (let k = 0; k < nf; k++) this.pt(11, fit[k * 2], fit[k * 2 + 1]);
  }

  text(e, owner) {
    const hj = HALIGN[e.halign] ?? 0;
    const vj = VALIGN[e.valign] ?? 0;
    const value = String(e.value ?? '').replace(/\r?\n/g, ' ');
    this.common('TEXT', e, owner);
    this.g(100, 'AcDbText');
    this.pt(10, e.x, e.y);
    this.n(40, +e.h > 0 ? +e.h : +this.hdr.textHeight || 2.5);
    this.g(1, encodeString(value, true));
    if (+e.rot) this.n(50, normAngle(+e.rot) * RAD);
    if (+e.widthFactor && +e.widthFactor !== 1) this.n(41, +e.widthFactor);
    if (+e.oblique) this.n(51, +e.oblique * RAD);
    this.s(7, this.styleRef(e.style));
    if (hj || vj) {
      this.i(72, hj);
      this.pt(11, e.x, e.y);
    }
    this.g(100, 'AcDbText');
    if (vj) this.i(73, vj);
  }

  mtext(e, owner, handle) {
    this.common('MTEXT', e, owner, handle);
    this.mtextBody(e.x, e.y, e.h, e.width, ATTACH[e.attach] ?? 1, e.value, e.style, e.rot, e.lineSpacing);
  }

  mtextBody(x, y, h, width, attach, value, style, rot, spacing) {
    this.g(100, 'AcDbMText');
    this.pt(10, x, y);
    this.n(40, +h > 0 ? +h : +this.hdr.textHeight || 2.5);
    this.n(41, +width > 0 ? +width : 0);
    this.i(71, attach);
    this.i(72, 1);
    let v = encodeMtext(value);
    while (v.length > 250) {
      this.g(3, v.slice(0, 250));
      v = v.slice(250);
    }
    this.g(1, v);
    this.s(7, this.styleRef(style));
    const a = +rot || 0;
    this.pt(11, Math.cos(a), Math.sin(a));
    this.i(73, 1);
    this.n(44, +spacing > 0 ? +spacing : 1);
  }

  leader(e, owner) {
    const p = e.pts || [];
    const n = p.length >> 1;
    if (n < 2) throw new Error('fewer than two vertices');
    const hasText = e.text != null && String(e.text) !== '';
    const mh = hasText ? this.h() : null;
    const style = this.dimRef(e.style);
    const h = +e.h > 0 ? +e.h : +this.hdr.textHeight || 2.5;
    const dx = p[n * 2 - 2] - p[n * 2 - 4];
    const right = dx >= 0;
    this.common('LEADER', e, owner);
    this.g(100, 'AcDbLeader');
    this.s(3, style);
    this.i(71, 1);
    this.i(72, 0);
    this.i(73, hasText ? 0 : 3);
    this.i(74, 0);
    this.i(75, 0);
    this.n(40, hasText ? h : 0);
    this.n(41, 0);
    this.i(76, n);
    for (let k = 0; k < n; k++) this.pt(10, p[k * 2], p[k * 2 + 1]);
    if (hasText) this.g(340, mh);
    this.n(210, 0);
    this.n(220, 0);
    this.n(230, 1);
    this.n(211, right ? 1 : -1);
    this.n(221, 0);
    this.n(231, 0);
    if (!hasText) return;
    const ds = this.dims.find((d) => d.name === style);
    const gap = ds ? (+ds.textGap || 0) * (+ds.scale || 1) : h / 4;
    const lx = p[n * 2 - 2] + (right ? gap : -gap);
    const ly = p[n * 2 - 1];
    this.common('MTEXT', e, owner, mh);
    this.mtextBody(lx, ly, h, 0, right ? 4 : 6, e.text, ds ? ds.textStyle : 'Standard', 0, 1);
  }

  hatch(e, owner) {
    const loops = (e.loops || []).filter((l) => Array.isArray(l) && (l.length >= 9 || (l.length >= 6 && (+l[2] || +l[5]))));
    if (!loops.length) throw new Error('no boundary loops');
    const pattern = String(e.pattern || 'SOLID');
    const solid = pattern.toUpperCase() === 'SOLID';
    // A mirrored pattern is written as AutoCAD writes mirrored hatches: in the
    // OCS of extrusion (0, 0, -1), whose X axis is world -X.
    const flip = !solid && !!e.mirror;
    const fx = flip ? -1 : 1;
    this.common('HATCH', e, owner);
    this.g(100, 'AcDbHatch');
    this.pt(10, 0, 0);
    this.n(210, 0);
    this.n(220, 0);
    this.n(230, fx);
    this.s(2, solid ? 'SOLID' : pattern);
    this.i(70, solid ? 1 : 0);
    this.i(71, 0);
    this.i(91, loops.length);
    loops.forEach((l, k) => {
      const nv = Math.floor(l.length / 3);
      let bulges = false;
      for (let j = 0; j < nv; j++) if (+l[j * 3 + 2]) bulges = true;
      this.i(92, k === 0 ? 3 : 2);
      this.i(72, bulges ? 1 : 0);
      this.i(73, 1);
      this.i(93, nv);
      for (let j = 0; j < nv; j++) {
        this.n(10, fx * l[j * 3]);
        this.n(20, l[j * 3 + 1]);
        if (bulges) this.n(42, fx * (+l[j * 3 + 2] || 0));
      }
      this.i(97, 0);
    });
    this.i(75, 0);
    this.i(76, 1);
    if (!solid) {
      const angle = flip ? normAngle(Math.PI - (+e.angle || 0)) : +e.angle || 0;
      const scale = +e.scale || 1;
      this.n(52, angle * RAD);
      this.n(41, scale);
      this.i(77, 0);
      const lines = this.patternFor(pattern);
      this.i(78, lines.length);
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      for (const ln of lines) {
        const a = ln.angle * DEG + angle;
        this.n(53, normAngle(a) * RAD);
        this.n(43, (ln.x * ca - ln.y * sa) * scale);
        this.n(44, (ln.x * sa + ln.y * ca) * scale);
        this.n(45, (ln.dx * Math.cos(a) - ln.dy * Math.sin(a)) * scale);
        this.n(46, (ln.dx * Math.sin(a) + ln.dy * Math.cos(a)) * scale);
        this.i(79, ln.dashes.length);
        for (const dsh of ln.dashes) this.n(49, dsh * scale);
      }
    }
    this.i(98, 0);
  }

  patternFor(name) {
    const o = this.opts;
    let def = null;
    if (typeof o.hatchPattern === 'function') {
      try {
        def = o.hatchPattern(name);
      } catch {
        def = null;
      }
    } else if (o.hatchPatterns) def = o.hatchPatterns[name] ?? o.hatchPatterns[name.toUpperCase()];
    const lines = patternLines(def);
    if (!lines.length) this.warn(`No definition for hatch pattern '${name}'; readers must supply it.`);
    return lines;
  }

  insert(e, owner) {
    const name = this.blockOut.get(String(e.name ?? '').toLowerCase());
    if (!name || name.startsWith('*Model') || name.startsWith('*Paper')) throw new Error(`undefined block '${e.name}'`);
    this.common('INSERT', e, owner);
    this.g(100, 'AcDbBlockReference');
    this.s(2, name);
    this.pt(10, e.x, e.y);
    this.n(41, e.sx ?? 1);
    this.n(42, e.sy ?? 1);
    this.n(43, 1);
    if (+e.rot) this.n(50, normAngle(+e.rot) * RAD);
  }

  dimension(e, owner) {
    const info = this.dimInfo.get(e);
    if (info === undefined) throw new Error('dimension was not prepared');
    if (info === null) return;
    if (info.explode) {
      for (const g of info.geom) this.entityBody(g, owner, null);
      return;
    }
    const x1 = +e.x1 || 0,
      y1 = +e.y1 || 0,
      x2 = +e.x2 || 0,
      y2 = +e.y2 || 0,
      lx = +e.lx || 0,
      ly = +e.ly || 0;
    let flags = 0;
    let def = [lx, ly];
    let sub = null;
    switch (e.dimType) {
      case 'linear': {
        flags = 0;
        const r = +e.rot || 0;
        const ux = Math.cos(r);
        const uy = Math.sin(r);
        const t = (x2 - lx) * ux + (y2 - ly) * uy;
        def = [lx + ux * t, ly + uy * t];
        sub = () => {
          this.g(100, 'AcDbAlignedDimension');
          this.pt(13, x1, y1);
          this.pt(14, x2, y2);
          this.n(50, normAngle(r) * RAD);
          this.g(100, 'AcDbRotatedDimension');
        };
        break;
      }
      case 'aligned': {
        flags = 1;
        const l = Math.hypot(x2 - x1, y2 - y1) || 1;
        const nx = -(y2 - y1) / l;
        const ny = (x2 - x1) / l;
        const t = (lx - x2) * nx + (ly - y2) * ny;
        def = [x2 + nx * t, y2 + ny * t];
        sub = () => {
          this.g(100, 'AcDbAlignedDimension');
          this.pt(13, x1, y1);
          this.pt(14, x2, y2);
        };
        break;
      }
      case 'angular':
        flags = 5;
        sub = () => {
          this.g(100, 'AcDb3PointAngularDimension');
          this.pt(13, x1, y1);
          this.pt(14, x2, y2);
          this.pt(15, +e.x3 || 0, +e.y3 || 0);
        };
        break;
      case 'diameter':
        flags = 3;
        def = [2 * x1 - x2, 2 * y1 - y2];
        sub = () => {
          this.g(100, 'AcDbDiametricDimension');
          this.pt(15, x2, y2);
          this.n(40, 0);
        };
        break;
      case 'radius':
        flags = 4;
        def = [x1, y1];
        sub = () => {
          this.g(100, 'AcDbRadialDimension');
          this.pt(15, x2, y2);
          this.n(40, 0);
        };
        break;
      case 'ordinate':
        flags = 6 | (e.ordAxis === 'x' ? 64 : 0);
        def = [0, 0];
        sub = () => {
          this.g(100, 'AcDbOrdinateDimension');
          this.pt(13, x1, y1);
          this.pt(14, x2, y2);
        };
        break;
      default:
        throw new Error(`unknown dimension type '${e.dimType}'`);
    }
    this.common('DIMENSION', e, owner);
    this.g(100, 'AcDbDimension');
    this.s(2, info.name);
    this.pt(10, def[0], def[1]);
    this.pt(11, info.tx, info.ty);
    this.i(70, flags | 32);
    if (e.text) this.g(1, encodeMtext(e.text));
    this.s(3, this.dimRef(e.style));
    sub();
  }
}

function dimColor(c) {
  const tc = trueColorInt(c);
  if (tc !== null) return nearestIndex(hexToRgb(c));
  return Number.isInteger(c) && c >= 0 && c <= 256 ? c : 0;
}

/** Unit-size arrowhead block geometry: tip at the origin, tail towards -X. */
function arrowGeometry(type) {
  const base = { id: 0, layer: '0', color: 0, linetype: 'ByBlock', lineweight: -2, ltscale: 1 };
  if (type === 'open') {
    return [{ ...base, id: 1, type: 'polyline', pts: [-1, 1 / 6, 0, 0, 0, 0, -1, -1 / 6, 0], closed: false, width: 0 }];
  }
  if (type === 'dot') {
    return [{ ...base, id: 1, type: 'polyline', pts: [-0.25, 0, 1, 0.25, 0, 1], closed: true, width: 0.5 }];
  }
  return [];
}

/**
 * Start and end derivatives [x0, y0, x1, y1] of a cubic spline with respect to
 * the chord length of its fit points, or null when they cannot be measured.
 */
function endTangents(ctrl, knots, fit) {
  const n = ctrl.length >> 1;
  const L = knots.length;
  let chord = 0;
  for (let i = 2; i < fit.length - 1; i += 2) chord += Math.hypot(fit[i] - fit[i - 2], fit[i + 1] - fit[i - 1]);
  const span = knots[L - 1] - knots[0];
  const a = knots[4] - knots[3];
  const b = knots[L - 4] - knots[L - 5];
  if (n < 4 || !(chord > 0) || !(span > 0) || !(a > 0) || !(b > 0)) return null;
  const f = span / chord;
  return [
    ((3 * (ctrl[2] - ctrl[0])) / a) * f,
    ((3 * (ctrl[3] - ctrl[1])) / a) * f,
    ((3 * (ctrl[2 * n - 2] - ctrl[2 * n - 4])) / b) * f,
    ((3 * (ctrl[2 * n - 1] - ctrl[2 * n - 3])) / b) * f,
  ];
}

/**
 * Write a drawing as an ASCII DXF R2000 file.
 * @param {object} drawing drawing in the core/schema.js model
 * @param {object} [opts] see the module comment
 * @returns {string} DXF text with CRLF line endings
 */
export function writeDxf(drawing, opts = {}) {
  return new DxfWriter(drawing, opts).write();
}
