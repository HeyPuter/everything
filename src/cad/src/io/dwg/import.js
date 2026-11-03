/**
 * DWG import: decodes the file (database.js) and converts its objects into
 * the group-code records of an equivalent DXF file, which the DXF reader
 * turns into the drawing model. Everything the DXF importer understands
 * (layers, linetypes, styles, blocks, OCS handling, every entity type) is
 * shared that way.
 */
import { readDatabase } from './database.js';
import { RELEASE } from './container.js';
import { parseRecords } from '../dxf/reader.js';
import { R14, R2000, R2004 } from './bits.js';

const RAD = 180 / Math.PI;

/** Lineweights by the index DWG stores (29 ByLayer, 30 ByBlock, 31 Default). */
export const LW_TABLE = [0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100, 106, 120, 140, 158, 200, 211];

export function lineweightFromIndex(i) {
  if (i >= 0 && i < LW_TABLE.length) return LW_TABLE[i];
  if (i === 30) return -2;
  if (i === 31) return -3;
  return -1;
}

const hex = (h) => (h || 0).toString(16).toUpperCase();

/**
 * Text values as DXF writes them: a caret becomes '^ ' and control
 * characters ^@ .. ^_, so the DXF reader decodes them back.
 */
export function caretText(s) {
  s = s || '';
  let plain = true;
  for (let i = 0; i < s.length && plain; i++) {
    const c = s.charCodeAt(i);
    if (c < 32 || c === 94) plain = false;
  }
  if (plain) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 94) out += '^ ';
    else if (c < 32) out += '^' + String.fromCharCode(c + 64);
    else out += s[i];
  }
  return out;
}
const n = (x) => String(+x || 0);

/** One record: type and parallel code / value arrays. */
class Rec {
  constructor(type) {
    this.type = type;
    this.codes = [];
    this.vals = [];
  }
  g(code, v) {
    this.codes.push(code);
    this.vals.push(typeof v === 'string' ? v : String(v));
    return this;
  }
  num(code, v) {
    return this.g(code, n(v));
  }
  pt(code, p) {
    this.num(code, p?.[0]);
    this.num(code + 10, p?.[1]);
    if (p && p.length > 2) this.num(code + 20, p[2]);
    return this;
  }
  deg(code, rad) {
    return this.num(code, (+rad || 0) * RAD);
  }
}

class Converter {
  constructor(db) {
    this.db = db;
    this.ver = db.ver;
    this.objs = db.objects;
    this.h = db.header || {};
    this.out = [];
    this.skipped = new Map();
  }

  get(h) {
    return h ? this.objs.get(h) : undefined;
  }

  name(h, fallback = '') {
    const o = this.get(h);
    return o && typeof o.name === 'string' ? o.name : fallback;
  }

  emit(r) {
    this.out.push(r);
  }

  sec(name) {
    this.emit(new Rec('SECTION').g(2, name));
  }

  endsec() {
    this.emit(new Rec('ENDSEC'));
  }

  /** Objects of a type in handle order. */
  all(type) {
    const out = [];
    for (const o of this.objs.values()) if (o.type === type) out.push(o);
    return out;
  }

  /* ---------------- header ---------------- */

  header() {
    const h = this.h;
    const r = new Rec('SECTION').g(2, 'HEADER');
    const v = (name, code, val) => {
      if (val === undefined || val === null || (typeof val === 'number' && !Number.isFinite(val))) return;
      r.g(9, name).g(code, val);
    };
    v('$ACADVER', 1, this.db.version);
    if (this.ver >= R2000) v('$INSUNITS', 70, h.INSUNITS);
    v('$LTSCALE', 40, h.LTSCALE);
    v('$TEXTSIZE', 40, h.TEXTSIZE);
    v('$CLAYER', 8, this.name(h.CLAYER, undefined));
    v('$TEXTSTYLE', 7, this.name(h.TEXTSTYLE, undefined));
    v('$DIMSTYLE', 2, this.name(h.DIMSTYLE, undefined));
    const lt = this.name(h.CELTYPE, undefined);
    if (lt) v('$CELTYPE', 6, lt);
    if (h.CECOLOR) v('$CECOLOR', 62, h.CECOLOR.index);
    if (this.ver >= R2000 && h.FLAGS !== undefined) v('$CELWEIGHT', 370, lineweightFromIndex(h.FLAGS & 0x1f));
    v('$LUNITS', 70, h.LUNITS);
    v('$LUPREC', 70, h.LUPREC);
    v('$AUNITS', 70, h.AUNITS);
    v('$AUPREC', 70, h.AUPREC);
    v('$PDMODE', 70, h.PDMODE);
    v('$PDSIZE', 40, h.PDSIZE);
    this.emit(r);
    this.endsec();
  }

  /* ---------------- tables ---------------- */

  /** Entries of a table in control-object order, then any others. */
  entries(type, control) {
    const seen = new Set();
    const out = [];
    const c = this.get(this.h[control]) || this.all(control)[0];
    for (const hd of c?.entries || []) {
      const o = this.get(hd);
      if (o && o.type === type && !seen.has(hd)) {
        seen.add(hd);
        out.push(o);
      }
    }
    for (const o of this.all(type)) if (!seen.has(o.handle)) out.push(o);
    return out;
  }

  tables() {
    this.sec('TABLES');
    this.emit(new Rec('TABLE').g(2, 'LTYPE'));
    for (const o of this.entries('LTYPE', 'LTYPE_CONTROL')) {
      const r = new Rec('LTYPE').g(5, hex(o.handle)).g(2, o.name || '').g(70, 0).g(3, o.description || '');
      r.g(72, 65).g(73, (o.dashes || []).length).num(40, o.patternLength);
      for (const d of o.dashes || []) r.num(49, d.length).g(74, d.shapeFlag || 0);
      this.emit(r);
    }
    this.emit(new Rec('ENDTAB'));

    this.emit(new Rec('TABLE').g(2, 'LAYER'));
    for (const o of this.entries('LAYER', 'LAYER_CONTROL')) this.emit(this.layer(o));
    this.emit(new Rec('ENDTAB'));

    this.emit(new Rec('TABLE').g(2, 'STYLE'));
    for (const o of this.entries('STYLE', 'STYLE_CONTROL')) {
      const r = new Rec('STYLE').g(5, hex(o.handle)).g(2, o.name || '');
      r.g(70, (o.shapeFile ? 1 : 0) | (o.vertical ? 4 : 0));
      r.num(40, o.fixedHeight).num(41, o.widthFactor ?? 1).deg(50, o.oblique).g(71, o.generation || 0);
      r.num(42, o.lastHeight).g(3, o.font || '').g(4, o.bigFont || '');
      this.emit(r);
    }
    this.emit(new Rec('ENDTAB'));

    this.emit(new Rec('TABLE').g(2, 'DIMSTYLE'));
    for (const o of this.entries('DIMSTYLE', 'DIMSTYLE_CONTROL')) this.emit(this.dimstyle(o));
    this.emit(new Rec('ENDTAB'));

    this.emit(new Rec('TABLE').g(2, 'BLOCK_RECORD'));
    for (const o of this.all('BLOCK_HEADER')) this.emit(new Rec('BLOCK_RECORD').g(5, hex(o.handle)).g(2, o.name || ''));
    this.emit(new Rec('ENDTAB'));
    this.endsec();
  }

  layer(o) {
    const r = new Rec('LAYER').g(5, hex(o.handle)).g(2, o.name || '');
    let frozen;
    let off;
    let locked;
    let plot = true;
    let lw = -3;
    if (this.ver <= R14) {
      frozen = !!o.frozen;
      off = !!o.off;
      locked = !!o.locked;
      if (o.rtLineweight !== undefined) lw = lineweightFromIndex(o.rtLineweight);
      if (o.rtPlot !== undefined) plot = o.rtPlot;
    } else {
      const f = o.values || 0;
      frozen = (f & 1) !== 0;
      off = (f & 2) !== 0;
      locked = (f & 8) !== 0;
      plot = (f & 16) !== 0;
      lw = lineweightFromIndex((f & 0x3e0) >> 5);
    }
    r.g(70, (frozen ? 1 : 0) | (locked ? 4 : 0));
    const c = o.color || { index: 7 };
    let idx = c.index >= 1 && c.index <= 255 ? c.index : 7;
    if (off) idx = -idx;
    r.g(62, idx);
    if (c.rgb !== null && c.rgb !== undefined) r.g(420, c.rgb);
    r.g(6, this.name(o.ltype, 'Continuous'));
    r.g(290, plot ? 1 : 0);
    r.g(370, lw);
    this.eed(r, o);
    return r;
  }

  dimstyle(o) {
    const r = new Rec('DIMSTYLE').g(105, hex(o.handle)).g(2, o.name || '');
    if (o.DIMPOST) r.g(3, o.DIMPOST);
    r.num(40, o.DIMSCALE ?? 1).num(41, o.DIMASZ).num(42, o.DIMEXO).num(44, o.DIMEXE);
    r.g(73, o.DIMTIH ? 1 : 0).g(77, o.DIMTAD ?? 0).g(78, o.DIMZIN ?? 0);
    r.num(140, o.DIMTXT).num(141, o.DIMCEN).num(142, o.DIMTSZ).num(147, o.DIMGAP);
    const ci = (c) => (typeof c === 'object' && c ? c.index : c) || 0;
    r.g(176, ci(o.DIMCLRD)).g(178, ci(o.DIMCLRT));
    r.g(271, o.DIMDEC ?? 2);
    if (this.ver <= R14 && o.DIMBLK) r.g(5, o.DIMBLK);
    if (o.DIMTXSTY) r.g(340, hex(o.DIMTXSTY));
    if (o.DIMBLKH) r.g(342, hex(o.DIMBLKH));
    return r;
  }

  /** Extended data as 1001 / 10xx groups after the record's own groups. */
  eed(r, o) {
    if (!o.eed) return;
    for (const blk of o.eed) {
      const app = this.name(blk.app, '');
      if (!app) continue;
      r.g(1001, app);
      for (const it of blk.items) {
        if (it.code === 1000 || it.code === 1002) r.g(it.code, it.value);
        else if (it.code === 1070 || it.code === 1071) r.g(it.code, it.value);
        else if (it.code >= 1040 && it.code <= 1042) r.num(it.code, it.value);
        else if (it.code >= 1010 && it.code <= 1013) r.pt(it.code, it.value);
        else if (it.code === 1005) r.g(1005, hex(it.value));
      }
    }
  }

  /* ---------------- entity lists ---------------- */

  /** Entities of a block header in drawing order. */
  blockEntities(bh) {
    if (this.ver >= R2004) return (bh.owned || []).map((h) => this.get(h)).filter((o) => o && o.entity);
    return this.chain(bh.firstEntity, bh.lastEntity, (o) => o.owner === bh.handle || o.entmode !== 0, bh);
  }

  /**
   * Follow the next-entity links of R13-R2000 from first to last. Falls back
   * to the owned entities in handle order when the links are broken.
   */
  chain(first, last, ok, owner) {
    const out = [];
    const seen = new Set();
    let cur = first;
    while (cur && !seen.has(cur) && out.length < 1e7) {
      seen.add(cur);
      const o = this.get(cur);
      if (!o || !o.entity) break;
      if (ok(o)) out.push(o);
      if (cur === last) return out;
      cur = o.noLinks ? cur + 1 : o.next;
    }
    if (!first || !owner) return out;
    // broken chain: everything owned by this block, in handle order
    const isModel = owner.handle === this.h.BLOCK_MODEL_SPACE;
    const isPaper = owner.handle === this.h.BLOCK_PAPER_SPACE;
    const res = [];
    for (const o of this.objs.values()) {
      if (!o.entity || SUB_ENTITIES.has(o.type)) continue;
      if (o.entmode === 0 ? o.owner === owner.handle : (o.entmode === 2 && isModel) || (o.entmode === 1 && isPaper)) res.push(o);
    }
    return res;
  }

  /** Vertices or attributes of a polyline or insert. */
  children(o, first, last) {
    if (this.ver >= R2004) return (o.owned || []).map((h) => this.get(h)).filter(Boolean);
    if (!first) return [];
    return this.chain(first, last, () => true, null);
  }

  /* ---------------- blocks and entities ---------------- */

  blocks() {
    this.sec('BLOCKS');
    const ms = this.h.BLOCK_MODEL_SPACE;
    const ps = this.h.BLOCK_PAPER_SPACE;
    const ctl = this.get(this.h.BLOCK_CONTROL) || this.all('BLOCK_CONTROL')[0];
    const order = [];
    const seen = new Set([ms, ps]);
    for (const hd of ctl?.entries || []) if (!seen.has(hd)) {
      seen.add(hd);
      order.push(hd);
    }
    for (const o of this.all('BLOCK_HEADER')) if (!seen.has(o.handle)) {
      seen.add(o.handle);
      order.push(o.handle);
    }
    for (const hd of order) {
      const bh = this.get(hd);
      if (!bh || bh.type !== 'BLOCK_HEADER') continue;
      const name = bh.name || '';
      const lower = name.toLowerCase();
      if (lower.startsWith('*model_space') || lower.startsWith('*paper_space')) continue;
      const flags = (bh.anonymous ? 1 : 0) | (bh.hasAttribs ? 2 : 0) | (bh.isXref ? 4 : 0) | (bh.isOverlay ? 8 : 0);
      const r = new Rec('BLOCK').g(8, '0').g(2, name).g(70, flags).pt(10, bh.base || [0, 0, 0]).g(3, name);
      if (bh.description) r.g(4, bh.description);
      this.emit(r);
      if (!bh.isXref && !bh.isOverlay) for (const e of this.blockEntities(bh)) this.entity(e);
      this.emit(new Rec('ENDBLK').g(8, '0'));
    }
    this.endsec();
  }

  entities() {
    this.sec('ENTITIES');
    const ms = this.get(this.h.BLOCK_MODEL_SPACE) || this.all('BLOCK_HEADER').find((b) => (b.name || '').toLowerCase() === '*model_space');
    if (ms) for (const e of this.blockEntities(ms)) this.entity(e);
    this.endsec();
  }

  /** Common entity groups. */
  common(type, o) {
    const r = new Rec(type).g(5, hex(o.handle));
    r.g(8, this.name(o.layer, '0'));
    let lt = null;
    if (this.ver <= R14) lt = o.isByLayerLt ? null : this.name(o.ltype, null);
    else if (o.ltFlags === 1) lt = 'ByBlock';
    else if (o.ltFlags === 2) lt = 'Continuous';
    else if (o.ltFlags === 3) lt = this.name(o.ltype, null);
    if (lt) r.g(6, lt);
    const c = o.color;
    if (c) {
      if (c.rgb !== null && c.rgb !== undefined) r.g(62, c.index > 0 && c.index < 256 ? c.index : 7).g(420, c.rgb);
      else r.g(62, c.index ?? 256);
    }
    if (this.ver >= R2000 && o.lwIndex !== undefined) r.g(370, lineweightFromIndex(o.lwIndex));
    if (o.ltscale !== undefined && o.ltscale !== 1) r.num(48, o.ltscale);
    if (o.invisible & 1) r.g(60, 1);
    return r;
  }

  ext(r, e) {
    if (!e) return;
    if (e[0] === 0 && e[1] === 0 && e[2] === 1) return;
    r.num(210, e[0]).num(220, e[1]).num(230, e[2]);
  }

  done(r, o) {
    this.eed(r, o);
    this.emit(r);
  }

  skip(type) {
    this.emit(new Rec(type));
  }

  entity(o) {
    if (o.error && !TOLERANT.has(o.type)) {
      this.skipped.set(o.type, (this.skipped.get(o.type) || 0) + 1);
      return;
    }
    const fn = ENTITY_OUT[o.type];
    if (fn) {
      try {
        fn.call(this, o);
      } catch {
        this.skipped.set(o.type, (this.skipped.get(o.type) || 0) + 1);
      }
    } else this.skip(DXF_NAMES[o.type] || o.type);
  }

  text(o, type) {
    const r = this.common(type, o);
    const ins = o.ins || [0, 0];
    r.num(10, ins[0]).num(20, ins[1]).num(30, o.elevation);
    r.num(40, o.height).g(1, caretText(o.value));
    if (o.rotation) r.deg(50, o.rotation);
    if (o.widthFactor !== undefined && o.widthFactor !== 1) r.num(41, o.widthFactor);
    if (o.oblique) r.deg(51, o.oblique);
    r.g(7, this.name(o.style, 'Standard'));
    if (o.generation) r.g(71, o.generation);
    r.g(72, o.halign || 0);
    const al = o.align || ins;
    r.num(11, al[0]).num(21, al[1]).num(31, o.elevation);
    if (o.thickness) r.num(39, o.thickness);
    this.ext(r, o.extrusion);
    return r;
  }

  run() {
    this.header();
    this.tables();
    this.blocks();
    this.entities();
    this.emit(new Rec('EOF'));
    return this.out;
  }
}

const SUB_ENTITIES = new Set(['VERTEX_2D', 'VERTEX_3D', 'VERTEX_MESH', 'VERTEX_PFACE', 'VERTEX_PFACE_FACE', 'ATTRIB', 'SEQEND', 'BLOCK', 'ENDBLK']);

/** Entities that are still usable when trailing fields failed to decode. */
const TOLERANT = new Set(['LEADER', 'MTEXT', 'MULTILEADER', 'ATTRIB', 'ATTDEF', 'TEXT']);

const DXF_NAMES = {
  '3DFACE': '3DFACE',
  '3DSOLID': '3DSOLID',
  OLE2FRAME: 'OLE2FRAME',
};

const DIM_KIND = {
  DIMENSION_LINEAR: 0,
  DIMENSION_ALIGNED: 1,
  DIMENSION_ANG2LN: 2,
  DIMENSION_DIAMETER: 3,
  DIMENSION_RADIUS: 4,
  DIMENSION_ANG3PT: 5,
  DIMENSION_ORDINATE: 6,
};

function dimension(o) {
  const kind = DIM_KIND[o.type];
  const r = this.common('DIMENSION', o);
  r.g(2, this.name(o.block, ''));
  r.pt(10, o.p10 || [0, 0, 0]);
  const tm = o.textMid || [0, 0];
  r.num(11, tm[0]).num(21, tm[1]).num(31, o.elevation);
  let flags = kind;
  if (kind === 6 && o.flags2 & 1) flags |= 64;
  r.g(70, flags);
  if (o.userText) r.g(1, caretText(o.userText));
  if (o.textRotation) r.deg(53, o.textRotation);
  if (o.horizDir) r.deg(51, o.horizDir);
  r.g(3, this.name(o.dimstyle, 'Standard'));
  if (o.p12) r.num(12, o.p12[0]).num(22, o.p12[1]);
  if (o.p13) r.pt(13, o.p13);
  if (o.p14) r.pt(14, o.p14);
  if (o.p15) r.pt(15, o.p15);
  if (o.p16) r.num(16, o.p16[0]).num(26, o.p16[1]);
  if (o.leaderLength) r.num(40, o.leaderLength);
  if (o.dimRotation) r.deg(50, o.dimRotation);
  if (o.extRotation) r.deg(52, o.extRotation);
  this.ext(r, o.extrusion);
  this.done(r, o);
}

const ENTITY_OUT = {
  LINE(o) {
    const r = this.common('LINE', o);
    if (this.ver <= R14) r.pt(10, o.p1).pt(11, o.p2);
    else r.pt(10, [o.x1, o.y1, o.z1 || 0]).pt(11, [o.x2, o.y2, o.z2 || 0]);
    if (o.thickness) r.num(39, o.thickness);
    this.ext(r, o.extrusion);
    this.done(r, o);
  },
  CIRCLE(o) {
    const r = this.common('CIRCLE', o).pt(10, o.center).num(40, o.radius);
    if (o.thickness) r.num(39, o.thickness);
    this.ext(r, o.extrusion);
    this.done(r, o);
  },
  ARC(o) {
    const r = this.common('ARC', o).pt(10, o.center).num(40, o.radius).deg(50, o.start).deg(51, o.end);
    if (o.thickness) r.num(39, o.thickness);
    this.ext(r, o.extrusion);
    this.done(r, o);
  },
  ELLIPSE(o) {
    const r = this.common('ELLIPSE', o).pt(10, o.center).pt(11, o.major);
    r.num(210, o.extrusion?.[0]).num(220, o.extrusion?.[1]).num(230, o.extrusion?.[2] ?? 1);
    r.num(40, o.ratio).num(41, o.start).num(42, o.end);
    this.done(r, o);
  },
  POINT(o) {
    const r = this.common('POINT', o).pt(10, o.pt);
    if (o.thickness) r.num(39, o.thickness);
    this.ext(r, o.extrusion);
    if (o.xAngle) r.deg(50, o.xAngle);
    this.done(r, o);
  },
  XLINE(o) {
    this.done(this.common('XLINE', o).pt(10, o.pt).pt(11, o.dir), o);
  },
  RAY(o) {
    this.done(this.common('RAY', o).pt(10, o.pt).pt(11, o.dir), o);
  },
  LWPOLYLINE(o) {
    const f = o.flags || 0;
    const r = this.common('LWPOLYLINE', o);
    const pts = o.pts || [];
    r.g(90, pts.length).g(70, (f & 512 ? 1 : 0) | (f & 256 ? 128 : 0));
    if (f & 4) r.num(43, o.constWidth);
    if (f & 8) r.num(38, o.elevation);
    if (f & 2) r.num(39, o.thickness);
    this.ext(r, o.extrusion);
    const b = o.bulges || [];
    const w = o.widths || [];
    for (let i = 0; i < pts.length; i++) {
      r.num(10, pts[i][0]).num(20, pts[i][1]);
      if (w[i]) r.num(40, w[i][0]).num(41, w[i][1]);
      if (b[i]) r.num(42, b[i]);
    }
    this.done(r, o);
  },
  POLYLINE_2D(o) {
    const r = this.common('POLYLINE', o).g(66, 1).num(10, 0).num(20, 0).num(30, o.elevation);
    r.g(70, o.flags || 0).num(40, o.startWidth).num(41, o.endWidth);
    if (o.curveType) r.g(75, o.curveType);
    if (o.thickness) r.num(39, o.thickness);
    this.ext(r, o.extrusion);
    this.done(r, o);
    for (const v of this.children(o, o.firstVertex, o.lastVertex)) {
      if (v.type !== 'VERTEX_2D') continue;
      const vr = this.common('VERTEX', v).pt(10, v.pt || [0, 0, 0]);
      vr.num(40, v.startWidth).num(41, v.endWidth).num(42, v.bulge).g(70, v.flags || 0);
      if (v.tangent) vr.deg(50, v.tangent);
      this.emit(vr);
    }
    this.emit(this.common('SEQEND', o));
  },
  POLYLINE_3D(o) {
    this.polyline(o, 8 | (o.flags & 1) | (o.curveFlags & 6 ? 4 : 0), 'VERTEX_3D', 32);
  },
  POLYLINE_MESH(o) {
    this.polyline(o, 16 | (o.flags & ~16), 'VERTEX_MESH', 64, (r) => r.g(71, o.mCount || 0).g(72, o.nCount || 0));
  },
  POLYLINE_PFACE(o) {
    this.polyline(o, 64, 'VERTEX_PFACE', 192, (r) => r.g(71, o.numVerts || 0).g(72, o.numFaces || 0));
  },
  SPLINE(o) {
    const r = this.common('SPLINE', o);
    const fit = o.scenario === 2;
    const knots = fit ? [] : (o.knots || []).map((k) => (typeof k === 'number' ? k : k.v));
    const ctrl = fit ? [] : o.ctrl || [];
    const fitPts = fit ? (o.fit || []).map((p) => (Array.isArray(p) ? p : p.v)) : [];
    const flags = (o.closed ? 1 : 0) | (o.periodic ? 2 : 0) | (o.rational ? 4 : 0) | 8;
    r.g(70, flags).g(71, o.degree || 3).g(72, knots.length).g(73, ctrl.length).g(74, fitPts.length);
    for (const k of knots) r.num(40, k);
    for (const c of ctrl) {
      r.pt(10, c.pt);
      if (o.weighted) r.num(41, c.w ?? 1);
    }
    for (const p of fitPts) r.pt(11, p);
    if (fit && o.startTan && (o.startTan[0] || o.startTan[1])) r.pt(12, o.startTan);
    if (fit && o.endTan && (o.endTan[0] || o.endTan[1])) r.pt(13, o.endTan);
    this.done(r, o);
  },
  TEXT(o) {
    const r = this.text(o, 'TEXT');
    r.g(73, o.valign || 0);
    this.done(r, o);
  },
  ATTDEF(o) {
    this.skip('ATTDEF');
    void o;
  },
  MTEXT(o) {
    this.done(this.mtextRec(o), o);
  },
  LEADER(o) {
    const r = this.common('LEADER', o).g(3, this.name(o.dimstyle, 'Standard'));
    r.g(71, o.arrowOn ? 1 : 0).g(72, o.pathType || 0).g(73, o.annotType ?? 3);
    const pts = o.pts || [];
    r.g(76, pts.length);
    for (const p of pts) r.pt(10, p);
    if (o.annotation) r.g(340, hex(o.annotation));
    this.ext(r, o.extrusion);
    if (o.xdir) r.pt(211, o.xdir);
    this.done(r, o);
  },
  HATCH(o) {
    this.done(hatchRec.call(this, o), o);
  },
  SOLID(o) {
    this.solid(o, 'SOLID');
  },
  TRACE(o) {
    this.solid(o, 'TRACE');
  },
  INSERT(o) {
    this.insert(o, false);
  },
  MINSERT(o) {
    this.insert(o, true);
  },
  ACAD_TABLE(o) {
    const r = this.common('ACAD_TABLE', o).g(2, this.name(o.block, '')).pt(10, o.ins);
    this.done(r, o);
  },
  MULTILEADER(o) {
    const r = this.common('MULTILEADER', o).g(300, 'CONTEXT_DATA{');
    r.num(41, o.textHeight);
    if (o.hasText) {
      r.pt(12, o.location || [0, 0, 0]).pt(13, o.dir || [1, 0, 0]);
      r.g(304, caretText(o.label));
    }
    for (const root of o.roots || []) {
      r.g(302, 'LEADER{').pt(10, root.connection).pt(11, root.direction).num(40, root.landingDistance);
      for (const ln of root.lines || []) {
        r.g(304, 'LEADER_LINE{');
        for (const p of ln.pts || []) r.pt(10, Array.isArray(p) ? p : p.v);
        r.g(305, '}');
      }
      r.g(303, '}');
    }
    r.g(301, '}');
    this.done(r, o);
  },
  DIMENSION_LINEAR: dimension,
  DIMENSION_ALIGNED: dimension,
  DIMENSION_ANG2LN: dimension,
  DIMENSION_ANG3PT: dimension,
  DIMENSION_RADIUS: dimension,
  DIMENSION_DIAMETER: dimension,
  DIMENSION_ORDINATE: dimension,
};

Converter.prototype.polyline = function (o, flags, vtype, vflags, extra) {
  const r = this.common('POLYLINE', o).g(66, 1).num(10, 0).num(20, 0).num(30, 0).g(70, flags);
  if (extra) extra(r);
  this.done(r, o);
  for (const v of this.children(o, o.firstVertex, o.lastVertex)) {
    if (v.type === vtype || (vtype === 'VERTEX_PFACE' && v.type === 'VERTEX_PFACE_FACE')) {
      const vr = this.common('VERTEX', v);
      if (v.type === 'VERTEX_PFACE_FACE') vr.num(10, 0).num(20, 0).num(30, 0).g(70, 128).g(71, v.i1).g(72, v.i2).g(73, v.i3).g(74, v.i4);
      else vr.pt(10, v.pt || [0, 0, 0]).g(70, vflags | (v.flags || 0));
      this.emit(vr);
    }
  }
  this.emit(this.common('SEQEND', o));
};

Converter.prototype.mtextRec = function (o) {
  const r = this.common('MTEXT', o).pt(10, o.ins).num(40, o.height).num(41, o.rectWidth);
  r.g(71, o.attach || 1).g(72, o.drawDir || 1);
  r.g(1, caretText(o.text));
  r.g(7, this.name(o.style, 'Standard'));
  this.ext(r, o.extrusion);
  r.pt(11, o.xdir || [1, 0, 0]);
  if (o.lsStyle) r.g(73, o.lsStyle);
  if (o.lsFactor) r.num(44, o.lsFactor);
  return r;
};

Converter.prototype.solid = function (o, type) {
  const r = this.common(type, o);
  const z = o.elevation || 0;
  for (let i = 0; i < 4; i++) {
    const c = o['c' + (i + 1)] || [0, 0];
    r.num(10 + i, c[0]).num(20 + i, c[1]).num(30 + i, z);
  }
  if (o.thickness) r.num(39, o.thickness);
  this.ext(r, o.extrusion);
  this.done(r, o);
};

Converter.prototype.insert = function (o, multi) {
  const r = this.common('INSERT', o);
  const kids = o.hasAttribs ? this.children(o, o.firstAttrib, o.lastAttrib).filter((a) => a.type === 'ATTRIB') : [];
  if (kids.length) r.g(66, 1);
  r.g(2, this.name(o.block, ''));
  r.pt(10, o.ins || [0, 0, 0]);
  r.num(41, o.sx ?? 1).num(42, o.sy ?? 1).num(43, o.sz ?? 1);
  if (o.rotation) r.deg(50, o.rotation);
  if (multi) r.g(70, o.cols || 1).g(71, o.rows || 1).num(44, o.colSpacing).num(45, o.rowSpacing);
  this.ext(r, o.extrusion);
  this.done(r, o);
  if (!kids.length) return;
  for (const a of kids) {
    const ar = this.text(a, 'ATTRIB');
    ar.g(2, a.tag || '').g(70, a.flags || 0).g(74, a.valign || 0);
    this.done(ar, a);
  }
  this.emit(this.common('SEQEND', o));
};

function hatchRec(o) {
  const r = this.common('HATCH', o).num(10, 0).num(20, 0).num(30, o.elevation);
  const e = o.extrusion || [0, 0, 1];
  r.num(210, e[0]).num(220, e[1]).num(230, e[2]);
  r.g(2, o.name || 'SOLID').g(70, o.solid ? 1 : 0).g(71, o.associative ? 1 : 0);
  const paths = o.paths || [];
  r.g(91, paths.length);
  for (const p of paths) {
    r.g(92, p.flags || 0);
    if (p.flags & 2) {
      const verts = p.verts || [];
      r.g(72, p.hasBulges ? 1 : 0).g(73, p.closed ? 1 : 0).g(93, verts.length);
      for (const v of verts) {
        r.num(10, v.pt[0]).num(20, v.pt[1]);
        if (p.hasBulges) r.num(42, v.bulge);
      }
    } else {
      const segs = p.segs || [];
      r.g(93, segs.length);
      for (const s of segs) {
        r.g(72, s.type);
        if (s.type === 1) r.num(10, s.p0[0]).num(20, s.p0[1]).num(11, s.p1[0]).num(21, s.p1[1]);
        else if (s.type === 2) r.num(10, s.center[0]).num(20, s.center[1]).num(40, s.radius).deg(50, s.start).deg(51, s.end).g(73, s.ccw ? 1 : 0);
        else if (s.type === 3) {
          r.num(10, s.center[0]).num(20, s.center[1]).num(11, s.major[0]).num(21, s.major[1]).num(40, s.ratio);
          r.deg(50, s.start).deg(51, s.end).g(73, s.ccw ? 1 : 0);
        } else if (s.type === 4) {
          const knots = (s.knots || []).map((k) => (typeof k === 'number' ? k : k.v));
          const ctrl = s.ctrl || [];
          r.g(94, s.degree || 3).g(73, s.rational ? 1 : 0).g(74, s.periodic ? 1 : 0).g(95, knots.length).g(96, ctrl.length);
          for (const k of knots) r.num(40, k);
          for (const c of ctrl) {
            r.num(10, c.pt[0]).num(20, c.pt[1]);
            if (s.rational) r.num(42, c.w ?? 1);
          }
          const fit = (s.fit || []).map((q) => (Array.isArray(q) ? q : q.v));
          if (fit.length) {
            r.g(97, fit.length);
            for (const q of fit) r.num(11, q[0]).num(21, q[1]);
            if (s.startTan) r.num(12, s.startTan[0]).num(22, s.startTan[1]);
            if (s.endTan) r.num(13, s.endTan[0]).num(23, s.endTan[1]);
          }
        }
      }
    }
    r.g(97, 0);
  }
  r.g(75, o.style || 0).g(76, o.patternType ?? 1);
  if (!o.solid) {
    r.deg(52, o.angle).num(41, o.scale ?? 1).g(77, o.double ? 1 : 0);
    const lines = o.lines || [];
    r.g(78, lines.length);
    for (const l of lines) {
      r.deg(53, l.angle).num(43, l.base[0]).num(44, l.base[1]).num(45, l.offset[0]).num(46, l.offset[1]);
      const d = (l.dashes || []).map((x) => (typeof x === 'number' ? x : x.v));
      r.g(79, d.length);
      for (const x of d) r.num(49, x);
    }
  }
  r.g(98, 0);
  if (o.gradient) r.g(450, 1);
  return r;
}

/**
 * Parse a DWG file into the drawing model.
 * @param {ArrayBuffer|Uint8Array} input
 * @returns {{ drawing, warnings: string[], stats, version: string, release: string }}
 */
export function parseDwg(input, opts = {}) {
  const u8 = input instanceof Uint8Array ? input : ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
  const db = readDatabase(u8);
  const conv = new Converter(db);
  const records = conv.run();
  const res = parseRecords(records, opts);
  const warnings = [...db.warnings];
  for (const [type, count] of conv.skipped) warnings.push(`${count} ${type} entit${count === 1 ? 'y' : 'ies'} could not be read and ${count === 1 ? 'was' : 'were'} skipped.`);
  warnings.push(...res.warnings);
  return { ...res, warnings, version: db.version, release: RELEASE[db.version] || db.version };
}
