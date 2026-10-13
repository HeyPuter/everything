/**
 * PDF content streams to document nodes.
 *
 * Paths keep their fills, strokes (width, caps, joins, miter limit,
 * dashes) and fill rules; colors convert from any color space, with
 * separation colors linked to spot swatches; axial and radial shadings
 * become gradients; tiling patterns become pattern swatches; clipping
 * paths become clip groups and soft masks opacity masks; constant alpha
 * and blend modes carry over; images decode to embedded images; text
 * becomes editable type when its font is available (or the user asks for
 * it) and outlines otherwise; form XObjects become groups and optional
 * content groups become layers.
 *
 * All geometry is converted to document coordinates (y down) through a
 * base matrix per page.
 */
import { Lexer, Parser, EOF } from './lexer.js';
import { PDFDict, PDFStream, Name, Ref, Cmd, isCmd, textString } from './primitives.js';
import { parseColorSpace, rgbHex, DEVICE_SPACES, deviceSpace } from './colors.js';
import { compileFunction } from './functions.js';
import { loadFont, PDFFont } from './fonts.js';
import { decodeImage, inlineImageDict } from './images.js';
import { Builder, createPath, createCompound, createGroup } from './build.js';
import { createText, createImage, DEFAULT_CHAR } from '../../../model/nodes.js';
import { multiply, invert } from '../../../lib/matrix.js';
import { uid } from '../../../lib/ids.js';

const BLEND = {
  Normal: 'normal', Compatible: 'normal', Multiply: 'multiply', Screen: 'screen', Overlay: 'overlay', Darken: 'darken', Lighten: 'lighten', ColorDodge: 'colorDodge', ColorBurn: 'colorBurn',
  HardLight: 'hardLight', SoftLight: 'softLight', Difference: 'difference', Exclusion: 'exclusion', Hue: 'hue', Saturation: 'saturation', Color: 'color', Luminosity: 'luminosity',
};
const CAPS = ['butt', 'round', 'square'];
const JOINS = ['miter', 'round', 'bevel'];

const app = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
const anchorAt = (p) => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y });

class GState {
  constructor(ctm) {
    this.ctm = ctm;
    this.fill = { space: DEVICE_SPACES.gray, comps: [0], pattern: null };
    this.stroke = { space: DEVICE_SPACES.gray, comps: [0], pattern: null };
    this.lw = 1;
    this.cap = 0;
    this.join = 0;
    this.miter = 10;
    this.dash = [];
    this.dashPhase = 0;
    this.ca = 1;
    this.CA = 1;
    this.bm = 'normal';
    this.wraps = [];
    this.font = null;
    this.size = 1;
    this.tc = 0;
    this.tw = 0;
    this.th = 1;
    this.tl = 0;
    this.rise = 0;
    this.tr = 0;
    this.smaskEntry = null;
  }

  clone() {
    const g = Object.create(GState.prototype);
    Object.assign(g, this);
    g.fill = { ...this.fill };
    g.stroke = { ...this.stroke };
    return g;
  }
}

/** Font family matching against the families the app can show. */
export function familyMatcher(families = []) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = new Map();
  for (const f of families) {
    const name = typeof f === 'string' ? f : f.family;
    if (name) map.set(norm(name), name);
  }
  const SUBST = {
    sans: ['Arial', 'Helvetica', 'Helvetica Neue', 'Roboto', 'Inter', 'Open Sans'],
    serif: ['Times New Roman', 'Times', 'Source Serif 4', 'Merriweather', 'Lora'],
    mono: ['Courier New', 'Courier', 'Roboto Mono', 'Source Code Pro'],
    symbol: ['Inter', 'Roboto'],
  };
  return {
    /** The available family for a parsed font name, or null. */
    exact(info, baseFont) {
      const cands = [info.family, String(baseFont || '').replace(/^[A-Z]{6}\+/, '').split(/[-,]/)[0]];
      for (const c of cands) {
        const k = norm(c);
        if (k && map.has(k)) return map.get(k);
        // "OpenSans" vs "Open Sans", "ArialMT" vs "Arial".
        const stripped = k.replace(/(psmt|mt|ps|std|pro|lt)$/, '');
        if (stripped && map.has(stripped)) return map.get(stripped);
      }
      return null;
    },
    substitute(info) {
      for (const f of SUBST[info.category] || SUBST.sans) if (map.has(norm(f))) return map.get(norm(f));
      return families.length ? (typeof families[0] === 'string' ? families[0] : families[0].family) : 'Inter';
    },
  };
}

export class Interpreter {
  /**
   * doc: PDFDocument. opts: { families, textMode: 'auto'|'text'|'outlines', builder, images (list to fill) }
   */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.xref = doc;
    this.opts = opts;
    this.textMode = opts.textMode || 'auto';
    this.out = opts.builder || new Builder();
    this.fonts = new Map();
    this.fontInfo = opts.fontInfo || new Map();
    this.families = familyMatcher(opts.families);
    this.warnings = new Set();
    this.images = []; // { assetId, raster | jpeg }
    this.imageCache = new Map();
    this.spots = new Map(); // name -> swatch
    this.patterns = []; // pattern definitions for doc.root.patterns
    this.patternCache = new Map();
    this.ocLayers = new Map();
    this.formStack = [];
    this.opCount = 0;
    this.maxOps = opts.maxOps || 4_000_000;
    this.readOptionalContent();
  }

  warn(msg) {
    this.warnings.add(msg);
  }

  // ---- optional content (layers) ----

  readOptionalContent() {
    const oc = this.doc.catalog.get('OCProperties');
    this.ocOff = new Set();
    this.ocOrder = [];
    if (!(oc instanceof PDFDict)) return;
    const d = oc.get('D');
    if (d instanceof PDFDict) {
      for (const r of d.getRaw('OFF') || []) if (r instanceof Ref) this.ocOff.add(r.num);
      const order = d.get('Order');
      const flat = (arr, depth) => {
        if (!Array.isArray(arr) || depth > 8) return;
        for (const x of arr) {
          if (x instanceof Ref) this.ocOrder.push(x.num);
          else if (Array.isArray(x)) flat(x, depth + 1);
        }
      };
      flat(order, 0);
    }
  }

  /** Builder layer for an optional content group reference (or null). */
  layerForOC(ref) {
    let obj = ref instanceof Ref ? this.xref.fetch(ref) : ref;
    let key = ref instanceof Ref ? ref.num : null;
    if (obj instanceof PDFDict && obj.name('Type') === 'OCMD') {
      const ocgs = obj.getRaw('OCGs');
      const first = Array.isArray(ocgs) ? ocgs[0] : ocgs;
      key = first instanceof Ref ? first.num : null;
      obj = this.xref.fetch(first);
    }
    if (!(obj instanceof PDFDict) || key === null) return null;
    const name = textString(obj.get('Name')) || 'Layer';
    return this.out.layerFor(`oc${key}`, name, { hidden: this.ocOff.has(key) });
  }

  // ---- pages ----

  /**
   * Interpret a page into the builder. base maps the page's user space to
   * document space.
   */
  renderPage(page, base) {
    this.page = page;
    this.pageBase = base;
    const gs = new GState(base);
    this.out.setLayer(null);
    this.out.layer = null;
    this.run(page.contents(), page.resources, gs, { base });
    this.renderAnnotations(page, base);
    this.flushText();
    this.out.closeAll();
  }

  renderAnnotations(page, base) {
    const annots = page.dict.get('Annots');
    if (!Array.isArray(annots)) return;
    for (const r of annots) {
      const a = this.xref.fetch(r);
      if (!(a instanceof PDFDict)) continue;
      const flags = a.num('F', 0);
      if (flags & 2 || flags & 32) continue; // hidden, no view
      const sub = a.name('Subtype');
      if (sub === 'Link' || sub === 'Popup') continue;
      const ap = a.get('AP');
      if (!(ap instanceof PDFDict)) continue;
      let n = ap.get('N');
      if (n instanceof PDFDict && !(n instanceof PDFStream)) {
        const as = a.name('AS');
        n = as ? n.get(as) : null;
      }
      if (!(n instanceof PDFStream)) continue;
      const rect = a.array('Rect');
      if (!rect || rect.length < 4) continue;
      const bbox = n.dict.array('BBox') || [0, 0, 1, 1];
      const fm = n.dict.array('Matrix') || [1, 0, 0, 1, 0, 0];
      // Map the transformed bbox onto the annotation rectangle.
      const pts = [app(fm, bbox[0], bbox[1]), app(fm, bbox[2], bbox[1]), app(fm, bbox[2], bbox[3]), app(fm, bbox[0], bbox[3])];
      const bx0 = Math.min(...pts.map((p) => p.x));
      const by0 = Math.min(...pts.map((p) => p.y));
      const bx1 = Math.max(...pts.map((p) => p.x));
      const by1 = Math.max(...pts.map((p) => p.y));
      const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
      const sx = bx1 - bx0 ? (rx1 - rx0) / (bx1 - bx0) : 1;
      const sy = by1 - by0 ? (ry1 - ry0) / (by1 - by0) : 1;
      const am = [sx, 0, 0, sy, rx0 - bx0 * sx, ry0 - by0 * sy];
      const gs = new GState(multiply(base, am));
      this.flushText();
      this.drawForm(n, gs, page.resources, { name: sub ? `${sub} annotation` : 'Annotation' });
    }
  }

  // ---- the operator loop ----

  run(bytes, resources, gs, ctx) {
    const lexer = new Lexer(bytes);
    const parser = new Parser(lexer, this.xref, { allowStreams: false });
    const stack = [];
    let ops = [];
    const saveDepth = stack.length;
    this.path = [];
    this.cur = null;
    let pendingClip = null;
    let inText = false;
    this.tm = [1, 0, 0, 1, 0, 0];
    this.tlm = [1, 0, 0, 1, 0, 0];
    this.textClip = null;
    const mc = []; // marked content: { layer }
    for (;;) {
      let obj;
      try {
        obj = parser.getObj();
      } catch {
        break;
      }
      if (obj === EOF) break;
      if (!(obj instanceof Cmd)) {
        ops.push(obj);
        if (ops.length > 10000) ops = ops.slice(-100);
        continue;
      }
      if (++this.opCount > this.maxOps) {
        this.warn('The page has too much content; part of it was not imported.');
        break;
      }
      const a = ops;
      ops = [];
      const n = (i) => (typeof a[i] === 'number' ? a[i] : 0);
      try {
        switch (obj.cmd) {
          // ---- graphics state ----
          case 'q':
            stack.push(gs);
            gs = gs.clone();
            break;
          case 'Q':
            if (stack.length > saveDepth) gs = stack.pop();
            break;
          case 'cm':
            gs.ctm = multiply(gs.ctm, [n(0), n(1), n(2), n(3), n(4), n(5)]);
            break;
          case 'w':
            gs.lw = n(0);
            break;
          case 'J':
            gs.cap = n(0);
            break;
          case 'j':
            gs.join = n(0);
            break;
          case 'M':
            gs.miter = n(0);
            break;
          case 'd':
            gs.dash = Array.isArray(a[0]) ? a[0].filter((x) => typeof x === 'number') : [];
            gs.dashPhase = n(1);
            break;
          case 'ri':
          case 'i':
            break;
          case 'gs':
            this.extGState(a[0], resources, gs, ctx);
            break;
          // ---- path construction ----
          case 'm':
            this.moveTo(gs, n(0), n(1));
            break;
          case 'l':
            this.lineTo(gs, n(0), n(1));
            break;
          case 'c':
            this.curveTo(gs, n(0), n(1), n(2), n(3), n(4), n(5));
            break;
          case 'v': {
            const c = this.curUser || { x: n(0), y: n(1) };
            this.curveTo(gs, c.x, c.y, n(0), n(1), n(2), n(3));
            break;
          }
          case 'y':
            this.curveTo(gs, n(0), n(1), n(2), n(3), n(2), n(3));
            break;
          case 'h':
            this.closePath();
            break;
          case 're': {
            const x = n(0);
            const y = n(1);
            const w = n(2);
            const h = n(3);
            this.moveTo(gs, x, y);
            this.lineTo(gs, x + w, y);
            this.lineTo(gs, x + w, y + h);
            this.lineTo(gs, x, y + h);
            this.closePath();
            break;
          }
          // ---- painting ----
          case 'S':
          case 's':
          case 'f':
          case 'F':
          case 'f*':
          case 'B':
          case 'B*':
          case 'b':
          case 'b*':
          case 'n': {
            const op = obj.cmd;
            if (op === 's' || op === 'b' || op === 'b*') this.closePath();
            const fill = op !== 'S' && op !== 's' && op !== 'n';
            const stroke = op === 'S' || op === 's' || op === 'B' || op === 'B*' || op === 'b' || op === 'b*';
            const evenOdd = op === 'f*' || op === 'B*' || op === 'b*';
            if (fill || stroke) this.paintPath(gs, fill, stroke, evenOdd, ctx);
            if (pendingClip) {
              const subpaths = this.path.map((s) => ({ anchors: s.anchors.map((p) => ({ ...p })), closed: true }));
              gs.wraps = [...gs.wraps, { type: 'clip', subpaths, evenOdd: pendingClip === 'W*' }];
              pendingClip = null;
            }
            this.path = [];
            this.cur = null;
            break;
          }
          case 'W':
          case 'W*':
            pendingClip = obj.cmd;
            break;
          // ---- color ----
          case 'CS':
          case 'cs': {
            const space = parseColorSpace(this.xref, a[0], resources);
            const target = obj.cmd === 'CS' ? gs.stroke : gs.fill;
            target.space = space;
            target.comps = space.initial.slice();
            target.pattern = null;
            if (ctx.uncolored) break;
            break;
          }
          case 'SC':
          case 'SCN':
          case 'sc':
          case 'scn': {
            if (ctx.uncolored) break;
            const target = obj.cmd === 'SC' || obj.cmd === 'SCN' ? gs.stroke : gs.fill;
            const last = a[a.length - 1];
            if (last instanceof Name) {
              target.pattern = { name: last.name, resources, comps: a.slice(0, -1).filter((x) => typeof x === 'number'), base: ctx.base };
            } else {
              target.comps = a.filter((x) => typeof x === 'number');
              target.pattern = null;
            }
            break;
          }
          case 'G':
          case 'g':
          case 'RG':
          case 'rg':
          case 'K':
          case 'k': {
            if (ctx.uncolored) break;
            const stroke = obj.cmd === obj.cmd.toUpperCase();
            const target = stroke ? gs.stroke : gs.fill;
            const kind = { g: 'gray', rg: 'rgb', k: 'cmyk' }[obj.cmd.toLowerCase()];
            target.space = deviceSpace(this.xref, kind, resources);
            target.comps = a.filter((x) => typeof x === 'number');
            target.pattern = null;
            break;
          }
          case 'sh':
            this.flushText();
            this.shadingFill(a[0], resources, gs, ctx);
            break;
          // ---- text ----
          case 'BT':
            inText = true;
            this.tm = [1, 0, 0, 1, 0, 0];
            this.tlm = [1, 0, 0, 1, 0, 0];
            this.textClip = null;
            break;
          case 'ET':
            inText = false;
            if (this.textClip) {
              this.flushText();
              gs.wraps = [...gs.wraps, this.textClip];
              this.textClip = null;
            }
            break;
          case 'Tc':
            gs.tc = n(0);
            break;
          case 'Tw':
            gs.tw = n(0);
            break;
          case 'Tz':
            gs.th = n(0) / 100;
            break;
          case 'TL':
            gs.tl = n(0);
            break;
          case 'Tf': {
            const fonts = resources.get('Font');
            const ref = fonts instanceof PDFDict && a[0] instanceof Name ? fonts.getRaw(a[0].name) : null;
            gs.font = ref ? loadFont(this.xref, ref, this.fonts, { warn: (m) => this.warn(m) }) : null;
            gs.size = n(1);
            break;
          }
          case 'Tr':
            gs.tr = n(0);
            break;
          case 'Ts':
            gs.rise = n(0);
            break;
          case 'Td':
            this.tlm = multiply(this.tlm, [1, 0, 0, 1, n(0), n(1)]);
            this.tm = this.tlm.slice();
            break;
          case 'TD':
            gs.tl = -n(1);
            this.tlm = multiply(this.tlm, [1, 0, 0, 1, n(0), n(1)]);
            this.tm = this.tlm.slice();
            break;
          case 'Tm':
            this.tlm = [n(0), n(1), n(2), n(3), n(4), n(5)];
            this.tm = this.tlm.slice();
            break;
          case 'T*':
            this.tlm = multiply(this.tlm, [1, 0, 0, 1, 0, -gs.tl]);
            this.tm = this.tlm.slice();
            break;
          case 'Tj':
            this.showText(gs, [a[0]], resources, ctx);
            break;
          case "'":
            this.tlm = multiply(this.tlm, [1, 0, 0, 1, 0, -gs.tl]);
            this.tm = this.tlm.slice();
            this.showText(gs, [a[0]], resources, ctx);
            break;
          case '"':
            gs.tw = n(0);
            gs.tc = n(1);
            this.tlm = multiply(this.tlm, [1, 0, 0, 1, 0, -gs.tl]);
            this.tm = this.tlm.slice();
            this.showText(gs, [a[2]], resources, ctx);
            break;
          case 'TJ':
            this.showText(gs, Array.isArray(a[0]) ? a[0] : [], resources, ctx);
            break;
          case 'd0':
            break;
          case 'd1':
            ctx.uncolored = true;
            break;
          // ---- XObjects and inline images ----
          case 'Do':
            this.flushText();
            this.doXObject(a[0], resources, gs, ctx);
            break;
          case 'BI': {
            this.flushText();
            this.inlineImage(lexer, parser, resources, gs, ctx);
            break;
          }
          // ---- marked content ----
          case 'BMC':
            mc.push(null);
            break;
          case 'BDC': {
            let entry = null;
            if (a[0] instanceof Name && a[0].name === 'OC' && !ctx.inForm) {
              let props = a[1];
              let ref = null;
              if (props instanceof Name) {
                const pd = resources.get('Properties');
                ref = pd instanceof PDFDict ? pd.getRaw(props.name) : null;
              } else ref = props;
              const layer = ref ? this.layerForOC(ref) : null;
              if (layer) {
                this.flushText();
                entry = { prev: this.out.layer };
                this.out.setLayer(layer);
              }
            }
            mc.push(entry);
            break;
          }
          case 'EMC': {
            const e = mc.pop();
            if (e) {
              this.flushText();
              this.out.setLayer(e.prev);
            }
            break;
          }
          case 'MP':
          case 'DP':
          case 'BX':
          case 'EX':
            break;
          default:
            break;
        }
      } catch (err) {
        if (err?.fatal) throw err;
        this.warn('Some damaged content was skipped.');
      }
      if (!inText) {
        /* text state persists across BT/ET; nothing to do */
      }
    }
    // Restore marked-content layers left open.
    while (mc.length) {
      const e = mc.pop();
      if (e) this.out.setLayer(e.prev);
    }
    return gs;
  }

  // ---- paths ----

  moveTo(gs, x, y) {
    const p = app(gs.ctm, x, y);
    this.path.push({ anchors: [anchorAt(p)], closed: false });
    this.cur = p;
    this.curUser = { x, y };
  }

  lineTo(gs, x, y) {
    if (!this.path.length) return this.moveTo(gs, x, y);
    const sp = this.path[this.path.length - 1];
    if (sp.closed) return this.reopen(gs, x, y, () => this.lineTo(gs, x, y));
    const p = app(gs.ctm, x, y);
    sp.anchors.push(anchorAt(p));
    this.cur = p;
    this.curUser = { x, y };
  }

  curveTo(gs, x1, y1, x2, y2, x3, y3) {
    if (!this.path.length) this.moveTo(gs, x1, y1);
    const sp = this.path[this.path.length - 1];
    if (sp.closed) return this.reopen(gs, x3, y3, () => this.curveTo(gs, x1, y1, x2, y2, x3, y3));
    const c1 = app(gs.ctm, x1, y1);
    const c2 = app(gs.ctm, x2, y2);
    const p = app(gs.ctm, x3, y3);
    const last = sp.anchors[sp.anchors.length - 1];
    last.ox = c1.x;
    last.oy = c1.y;
    sp.anchors.push({ x: p.x, y: p.y, ix: c2.x, iy: c2.y, ox: p.x, oy: p.y });
    this.cur = p;
    this.curUser = { x: x3, y: y3 };
  }

  /** After h, drawing continues from the subpath's start in a new subpath. */
  reopen(gs, x, y, again) {
    const sp = this.path[this.path.length - 1];
    const s = sp.anchors[0];
    this.path.push({ anchors: [anchorAt(s)], closed: false });
    again();
  }

  closePath() {
    const sp = this.path[this.path.length - 1];
    if (!sp || sp.closed) return;
    const a = sp.anchors;
    if (a.length > 1) {
      const f = a[0];
      const l = a[a.length - 1];
      if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) {
        f.ix = l.ix;
        f.iy = l.iy;
        a.pop();
      }
    }
    sp.closed = true;
    this.cur = a[0];
  }

  // ---- paint ----

  /** Document paint for a fill or stroke color state; alpha is the constant alpha. */
  paintOf(c, alpha, gs, bboxFn) {
    // Alpha soft masks use the coverage of the art: everything paints white.
    if (gs?.forceWhite) return { type: 'solid', color: '#ffffff', ...(alpha < 1 ? { opacity: alpha } : {}) };
    if (c.pattern) return this.patternPaint(c, alpha, gs, bboxFn);
    const space = c.space;
    if (space.none) return null;
    const rgb = space.toRGB(c.comps.length ? c.comps : space.initial);
    const paint = { type: 'solid', color: rgbHex(rgb) };
    if (space.spot) {
      const sw = this.spotSwatch(space.spot);
      paint.swatchId = sw.id;
      const tint = Math.max(0, Math.min(1, c.comps[0] ?? 1));
      if (tint < 1) paint.tint = Math.round(tint * 1000) / 1000;
    }
    if (alpha < 1) paint.opacity = Math.max(0, alpha);
    return paint;
  }

  spotSwatch(spot) {
    let sw = this.spots.get(spot.name);
    if (!sw) {
      sw = { id: uid('sw'), name: spot.name, paint: { type: 'solid', color: rgbHex(spot.rgb) }, spot: true, global: true, ...(spot.cmyk ? { mode: 'cmyk' } : {}) };
      this.spots.set(spot.name, sw);
    }
    return sw;
  }

  strokeStyle(gs) {
    const s = scaleOf(gs.ctm);
    return {
      strokeWidth: Math.max(gs.lw * s, gs.lw > 0 ? 0 : 0.25),
      strokeCap: CAPS[gs.cap] || 'butt',
      strokeJoin: JOINS[gs.join] || 'miter',
      miterLimit: gs.miter || 10,
      dash: gs.dash.length && gs.dash.some((d) => d > 0) ? gs.dash.map((d) => d * s) : [],
      dashOffset: gs.dashPhase * s,
    };
  }

  paintPath(gs, fill, stroke, evenOdd, ctx) {
    const subs = this.path.filter((s) => s.anchors.length >= 2 || (stroke && gs.cap === 1 && s.anchors.length === 1));
    if (!subs.length) return;
    this.flushText();
    const bbox = () => {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const s of subs) for (const p of s.anchors) for (const [x, y] of [[p.x, p.y], [p.ix, p.iy], [p.ox, p.oy]]) {
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    const style = {
      fill: fill ? this.paintOf(gs.fill, gs.ca, gs, bbox) : null,
      stroke: stroke ? this.paintOf(gs.stroke, gs.CA, gs, bbox) : null,
      ...this.strokeStyle(gs),
      blendMode: gs.bm,
    };
    if (!stroke) style.strokeWidth = 1;
    if (!style.fill && !style.stroke) return;
    const extra = evenOdd ? { fillRule: 'evenodd' } : {};
    let node;
    if (subs.length === 1) {
      const s = subs[0];
      const anchors = s.anchors.length === 1 ? [s.anchors[0], { ...s.anchors[0] }] : s.anchors;
      node = createPath(anchors, s.closed, style, extra);
    } else {
      const kids = subs.map((s) => this.out.add(createPath(s.anchors.length === 1 ? [s.anchors[0], { ...s.anchors[0] }] : s.anchors, s.closed, { fill: null, stroke: null })));
      node = createCompound(kids, style, { fillRule: evenOdd ? 'evenodd' : 'nonzero' });
    }
    this.emit(node, gs);
  }

  emit(node, gs) {
    this.out.add(node);
    this.out.push(node.id, gs.wraps);
  }

  // ---- ExtGState ----

  extGState(name, resources, gs, ctx) {
    const dict = resources.get('ExtGState');
    const e = dict instanceof PDFDict && name instanceof Name ? dict.get(name.name) : null;
    if (!(e instanceof PDFDict)) return;
    for (const k of e.keys()) {
      const v = e.get(k);
      switch (k) {
        case 'LW':
          if (typeof v === 'number') gs.lw = v;
          break;
        case 'LC':
          if (typeof v === 'number') gs.cap = v;
          break;
        case 'LJ':
          if (typeof v === 'number') gs.join = v;
          break;
        case 'ML':
          if (typeof v === 'number') gs.miter = v;
          break;
        case 'D':
          if (Array.isArray(v)) {
            gs.dash = Array.isArray(v[0]) ? v[0].filter((x) => typeof x === 'number') : [];
            gs.dashPhase = typeof v[1] === 'number' ? v[1] : 0;
          }
          break;
        case 'CA':
          if (typeof v === 'number') gs.CA = v;
          break;
        case 'ca':
          if (typeof v === 'number') gs.ca = v;
          break;
        case 'BM': {
          const bm = Array.isArray(v) ? v[0] : v;
          gs.bm = bm instanceof Name ? BLEND[bm.name] || 'normal' : 'normal';
          break;
        }
        case 'SMask':
          this.setSoftMask(v, resources, gs, ctx);
          break;
        case 'Font':
          if (Array.isArray(v) && v.length >= 2) {
            gs.font = loadFont(this.xref, v[0], this.fonts, {});
            gs.size = typeof v[1] === 'number' ? v[1] : gs.size;
          }
          break;
        default:
          break;
      }
    }
  }

  setSoftMask(v, resources, gs, ctx) {
    // Remove the previous soft mask (it is replaced, not intersected).
    if (gs.smaskEntry) gs.wraps = gs.wraps.filter((w) => w !== gs.smaskEntry);
    gs.smaskEntry = null;
    if (!(v instanceof PDFDict)) return;
    const g = v.get('G');
    if (!(g instanceof PDFStream)) return;
    const luminosity = v.name('S', 'Luminosity') !== 'Alpha';
    // Draw the mask group into a separate builder.
    const sub = new Builder();
    sub.layer = sub.layerFor('mask', 'mask');
    const saved = this.out;
    const savedText = this.pending;
    this.pending = null;
    this.out = sub;
    try {
      const mgs = new GState(gs.ctm);
      if (!luminosity) mgs.forceWhite = true;
      const bc = v.array('BC');
      if (luminosity && bc && bc.length) {
        // A backdrop color: paint it under the mask art across the page.
        const cs = g.dict.get('Group') instanceof PDFDict ? parseColorSpace(this.xref, g.dict.get('Group').get('CS') || Name.get('DeviceGray'), resources) : DEVICE_SPACES.gray;
        const rgb = cs.toRGB(bc);
        this.backdrop(mgs, rgbHex(rgb), ctx);
      }
      this.drawForm(g, mgs, resources, { mask: true });
      this.flushText();
    } finally {
      this.out = saved;
      this.pending = savedText;
    }
    const { layers, nodes } = sub.finish();
    const ids = layers.flatMap((l) => l.ids);
    if (!ids.length) {
      // An empty luminosity mask hides everything under it.
      const entry = { type: 'clip', subpaths: [], evenOdd: false };
      gs.wraps = [...gs.wraps, entry];
      gs.smaskEntry = entry;
      return;
    }
    let root;
    const list = [];
    if (ids.length === 1) root = ids[0];
    else {
      const grp = createGroup(ids);
      nodes.set(grp.id, grp);
      for (const id of ids) nodes.set(id, { ...nodes.get(id), parent: grp.id });
      root = grp.id;
    }
    const visit = (id) => {
      const n = nodes.get(id);
      if (!n) return;
      list.push(id === root ? { ...n, parent: undefined } : n);
      for (const c of n.children || []) visit(c);
    };
    visit(root);
    const bcBlack = !(v.array('BC') || []).some((x) => x > 0);
    const entry = { type: 'smask', art: { root, nodes: list }, clip: luminosity && bcBlack, invert: false };
    gs.wraps = [...gs.wraps, entry];
    gs.smaskEntry = entry;
  }

  backdrop(gs, color, ctx) {
    const box = this.page?.mediaBox || { x: 0, y: 0, w: 612, h: 792 };
    const b = this.pageBase || gs.ctm;
    const pts = [app(b, box.x, box.y), app(b, box.x + box.w, box.y), app(b, box.x + box.w, box.y + box.h), app(b, box.x, box.y + box.h)];
    const node = createPath(pts.map(anchorAt), true, { fill: { type: 'solid', color }, stroke: null });
    this.emit(node, gs);
  }

  // ---- shadings and patterns ----

  /** Gradient paint for a shading dictionary under matrix m (shading space -> document), or a solid fallback. */
  shadingPaint(sh, m, alpha = 1) {
    return shadingToPaint(this.xref, sh, m, alpha, (msg) => this.warn(msg));
  }

  shadingFill(name, resources, gs, ctx) {
    const dict = resources.get('Shading');
    const sh = dict instanceof PDFDict && name instanceof Name ? dict.get(name.name) : null;
    if (!sh) return;
    const paint = this.shadingPaint(sh, gs.ctm, gs.ca);
    if (!paint) return;
    // Cover the clip region (or the shading's bbox, or the page).
    let rect = null;
    for (const w of gs.wraps) {
      if (w.type !== 'clip' || !w.subpaths) continue;
      let r = null;
      for (const s of w.subpaths) for (const p of s.anchors) r = growRect(r, p);
      rect = rect ? intersectRect(rect, r) : r;
    }
    if (!rect) {
      const d = sh instanceof PDFStream ? sh.dict : sh;
      const bb = d.array('BBox');
      if (bb) {
        for (const [x, y] of [[bb[0], bb[1]], [bb[2], bb[1]], [bb[2], bb[3]], [bb[0], bb[3]]]) rect = growRect(rect, app(gs.ctm, x, y));
      } else {
        const box = this.page?.cropBox || { x: 0, y: 0, w: 612, h: 792 };
        const b = this.pageBase || gs.ctm;
        for (const [x, y] of [[box.x, box.y], [box.x + box.w, box.y + box.h]]) rect = growRect(rect, app(b, x, y));
      }
    }
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return;
    const pts = [{ x: rect.x, y: rect.y }, { x: rect.x + rect.w, y: rect.y }, { x: rect.x + rect.w, y: rect.y + rect.h }, { x: rect.x, y: rect.y + rect.h }];
    const node = createPath(pts.map(anchorAt), true, { fill: paint, stroke: null, blendMode: gs.bm }, { shadingFill: true });
    this.emit(node, gs);
  }

  patternPaint(c, alpha, gs, bboxFn) {
    const pd = c.pattern.resources.get('Pattern');
    const pat = pd instanceof PDFDict ? pd.get(c.pattern.name) : null;
    const pdict = pat instanceof PDFStream ? pat.dict : pat;
    if (!(pdict instanceof PDFDict)) return null;
    const pm = pdict.array('Matrix') || [1, 0, 0, 1, 0, 0];
    const m = multiply(c.pattern.base || this.pageBase || [1, 0, 0, 1, 0, 0], pm);
    if (pdict.num('PatternType', 1) === 2) {
      const sh = pdict.get('Shading');
      return this.shadingPaint(sh, m, alpha);
    }
    if (!(pat instanceof PDFStream)) return null;
    return this.tilingPaint(pat, c, m, alpha);
  }

  /** A tiling pattern as a pattern swatch definition and paint. */
  tilingPaint(pat, c, m, alpha) {
    const d = pat.dict;
    const uncolored = d.num('PaintType', 1) === 2;
    let tint = null;
    if (uncolored) {
      const base = c.space.base || DEVICE_SPACES.gray;
      tint = rgbHex(base.toRGB(c.pattern.comps.length ? c.pattern.comps : base.initial));
    }
    const key = `${pat.dict.xref ? '' : ''}${this.patternKey(pat)}|${tint || ''}`;
    let def = this.patternCache.get(key);
    if (def === undefined) {
      def = null;
      const xs = Math.abs(d.num('XStep', 0));
      const ys = Math.abs(d.num('YStep', 0));
      const bbox = d.array('BBox') || [0, 0, xs, ys];
      const w = xs || Math.abs(bbox[2] - bbox[0]);
      const h = ys || Math.abs(bbox[3] - bbox[1]);
      if (w > 0 && h > 0 && w < 1e5 && h < 1e5) {
        const sub = new Builder();
        sub.layer = sub.layerFor('tile', 'tile');
        const saved = this.out;
        const savedText = this.pending;
        this.pending = null;
        this.out = sub;
        try {
          // Pattern space (y up) to tile units (y down, top-left at 0,0).
          const unit = [1, 0, 0, -1, -bbox[0], h + bbox[1]];
          const tgs = new GState(unit);
          if (uncolored) {
            tgs.fill = { space: DEVICE_SPACES.rgb, comps: hexRgb(tint), pattern: null };
            tgs.stroke = { ...tgs.fill };
          }
          const res = d.get('Resources');
          this.run(pat.decoded(), res instanceof PDFDict ? res : new PDFDict(this.xref), tgs, { base: unit, uncolored, inForm: true });
          this.flushText();
        } catch {
          /* empty tile */
        } finally {
          this.out = saved;
          this.pending = savedText;
        }
        const { layers, nodes } = sub.finish();
        const roots = layers.flatMap((l) => l.ids);
        if (roots.length) {
          def = { id: uid('pat'), name: `Pattern ${this.patterns.length + 1}`, tileType: 'grid', brickOffset: '1/2', width: w, height: h, hSpacing: 0, vSpacing: 0, sizeToArt: false, moveWithArt: true, overlapH: 'left', overlapV: 'top', art: { roots, nodes: [...nodes.values()] }, offset: [bbox[0], bbox[1]] };
          this.patterns.push(def);
        }
      }
      this.patternCache.set(key, def);
    }
    if (!def) return tint ? { type: 'solid', color: tint } : { type: 'solid', color: '#808080' };
    // Tile units -> pattern space -> document.
    const transform = multiply(m, [1, 0, 0, -1, def.offset[0], def.height + def.offset[1]]);
    const paint = { type: 'pattern', id: def.id, transform };
    if (alpha < 1) paint.opacity = alpha;
    return paint;
  }

  patternKey(pat) {
    if (!this.patternIds) this.patternIds = new WeakMap();
    let k = this.patternIds.get(pat);
    if (!k) this.patternIds.set(pat, (k = uid('p')));
    return k;
  }

  // ---- XObjects ----

  doXObject(name, resources, gs, ctx) {
    const xo = resources.get('XObject');
    if (!(xo instanceof PDFDict) || !(name instanceof Name)) return;
    const ref = xo.getRaw(name.name);
    const obj = this.xref.fetch(ref);
    if (!(obj instanceof PDFStream)) return;
    const sub = obj.dict.name('Subtype');
    // Optional content on the XObject itself.
    const oc = obj.dict.getRaw('OC');
    if (oc && this.ocOff.size) {
      const ocNum = oc instanceof Ref ? oc.num : null;
      if (ocNum !== null && this.ocOff.has(ocNum)) {
        /* hidden by default: still imported (its layer is hidden) */
      }
    }
    if (sub === 'Image') this.drawImage(obj, resources, gs, ref);
    else if (sub === 'Form') {
      if (this.formStack.includes(obj) || this.formStack.length > 24) return;
      const name2 = obj.dict.get('Name');
      this.drawForm(obj, gs, resources, { name: name2 instanceof Name ? '' : '', ctx });
    }
  }

  drawForm(form, gs, parentResources, { name = '', mask = false, ctx = null } = {}) {
    const d = form.dict;
    const fm = d.array('Matrix') || [1, 0, 0, 1, 0, 0];
    const fgs = gs.clone();
    fgs.ctm = multiply(gs.ctm, fm);
    const bbox = d.array('BBox');
    const group = d.get('Group');
    const transparency = group instanceof PDFDict && group.name('S') === 'Transparency';
    const extra = {};
    if (transparency && !mask) {
      if (gs.ca < 1) extra.opacity = gs.ca;
      if (gs.bm !== 'normal') extra.blendMode = gs.bm;
      if (group.get('I') === true) extra.isolate = true;
      if (group.get('K') === true) extra.knockout = true;
      fgs.ca = 1;
      fgs.CA = 1;
      fgs.bm = 'normal';
    }
    if (name) extra.name = name;
    this.out.beginGroup(gs.wraps, extra);
    if (bbox && bbox.length >= 4) {
      const pts = [[bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]]].map(([x, y]) => anchorAt(app(fgs.ctm, x, y)));
      fgs.wraps = [...fgs.wraps, { type: 'clip', subpaths: [{ anchors: pts, closed: true }], evenOdd: false }];
    }
    const res = d.get('Resources');
    this.formStack.push(form);
    const savedPath = this.path;
    const savedTm = this.tm;
    const savedTlm = this.tlm;
    try {
      let data;
      try {
        data = form.decoded();
      } catch {
        data = new Uint8Array(0);
      }
      this.run(data, res instanceof PDFDict ? res : parentResources, fgs, { base: fgs.ctm, inForm: true, uncolored: ctx?.uncolored });
      this.flushText();
    } finally {
      this.formStack.pop();
      this.path = savedPath;
      this.tm = savedTm;
      this.tlm = savedTlm;
    }
    return this.out.endGroup();
  }

  drawImage(stream, resources, gs, ref = null) {
    const fillRGB = gs.fill.space.toRGB(gs.fill.comps.length ? gs.fill.comps : gs.fill.space.initial);
    let img;
    const key = ref instanceof Ref ? ref.num : null;
    const isMask = stream.dict.get('ImageMask') === true;
    const cacheKey = key !== null ? `${key}${isMask ? rgbHex(fillRGB) : ''}` : null;
    let asset = cacheKey ? this.imageCache.get(cacheKey) : null;
    if (!asset) {
      try {
        img = decodeImage(this.xref, stream, resources, { fillRGB });
      } catch {
        img = null;
      }
      if (!img) {
        this.warn('An image could not be decoded.');
        return;
      }
      asset = this.imageAsset(img);
      if (cacheKey) this.imageCache.set(cacheKey, asset);
    }
    this.placeImage(asset, gs);
  }

  imageAsset(img) {
    if (img.kind === 'unsupported') {
      const what = { JPXDecode: 'JPEG 2000', CCITTFaxDecode: 'CCITT fax', JBIG2Decode: 'JBIG2' }[img.codec] || img.codec;
      this.warn(`Images in ${what} format cannot be shown and were replaced by gray boxes.`);
      return { placeholder: true, width: img.width, height: img.height, label: `${what} image` };
    }
    const id = uid('img');
    this.images.push({ id, img });
    let alphaId = null;
    if (img.kind === 'jpeg' && img.alpha) {
      alphaId = uid('img');
      const { width, height, gray } = img.alpha;
      const data = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < gray.length; i++) {
        data[i * 4] = data[i * 4 + 1] = data[i * 4 + 2] = gray[i];
        data[i * 4 + 3] = 255;
      }
      this.images.push({ id: alphaId, img: { kind: 'rgba', width, height, data } });
    }
    return { id, width: img.width, height: img.height, alphaId, alphaSize: img.alpha ? [img.alpha.width, img.alpha.height] : null };
  }

  placeImage(asset, gs) {
    const { width: w, height: h } = asset;
    const t = multiply(gs.ctm, [1 / w, 0, 0, -1 / h, 0, 1]);
    let node;
    if (asset.placeholder) {
      const pts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => anchorAt(app(t, x, y)));
      node = createPath(pts, true, { fill: { type: 'solid', color: '#c8c8c8' }, stroke: { type: 'solid', color: '#808080' }, strokeWidth: 0.5 }, { name: asset.label });
    } else {
      node = createImage(asset.id, w, h, t, { blendMode: gs.bm, opacity: gs.ca < 1 ? gs.ca : 1 });
      if (asset.alphaId) {
        const [aw, ah] = asset.alphaSize;
        const mt = multiply(gs.ctm, [1 / aw, 0, 0, -1 / ah, 0, 1]);
        const maskImg = createImage(asset.alphaId, aw, ah, mt);
        node.opacityMask = { art: { root: maskImg.id, nodes: [maskImg] }, transform: [1, 0, 0, 1, 0, 0], clip: true, invert: false };
      }
    }
    this.emit(node, gs);
  }

  inlineImage(lexer, parser, resources, gs, ctx) {
    const dict = new PDFDict(this.xref);
    // Key/value pairs up to ID.
    for (;;) {
      const k = parser.getObj();
      if (k === EOF) return;
      if (isCmd(k, 'ID')) break;
      if (!(k instanceof Name)) continue;
      const v = parser.getObj();
      dict.set(k.name, v);
    }
    const b = lexer.b;
    let p = lexer.pos;
    // One whitespace byte follows ID.
    if (b[p] === 32 || b[p] === 10 || b[p] === 13 || b[p] === 9) p++;
    const full = inlineImageDict(dict);
    const start = p;
    let end = -1;
    const len = full.num('Length', full.num('L', -1));
    if (len > 0 && !full.get('Filter')) end = start + len;
    if (end < 0 && !full.get('Filter')) {
      const w = full.num('Width', 0);
      const h = full.num('Height', 0);
      const bpc = full.get('ImageMask') === true ? 1 : full.num('BitsPerComponent', 8);
      let comps = 1;
      const cs = full.get('ColorSpace');
      if (cs instanceof Name) comps = cs.name === 'DeviceRGB' ? 3 : cs.name === 'DeviceCMYK' ? 4 : cs.name === 'DeviceGray' ? 1 : parseColorSpace(this.xref, cs, resources).n || 1;
      else if (cs) comps = parseColorSpace(this.xref, cs, resources).n || 1;
      end = start + Math.ceil((w * comps * bpc) / 8) * h;
    }
    // Find "EI" delimited by whitespace (at or after the computed end).
    let q = end >= 0 ? Math.min(end, b.length) : start;
    let found = -1;
    for (; q < b.length - 1; q++) {
      if (b[q] === 69 && b[q + 1] === 73 && (q === 0 || isWs(b[q - 1])) && (q + 2 >= b.length || isWs(b[q + 2]) || b[q + 2] === 81)) {
        found = q;
        break;
      }
    }
    if (found < 0) {
      lexer.pos = b.length;
      return;
    }
    const dataEnd = end >= 0 ? Math.min(end, found) : found - 1;
    const raw = b.subarray(start, Math.max(start, dataEnd));
    lexer.pos = found + 2;
    parser.buf.length = 0;
    const stream = new PDFStream(full, raw);
    const fillRGB = gs.fill.space.toRGB(gs.fill.comps.length ? gs.fill.comps : gs.fill.space.initial);
    let img = null;
    try {
      img = decodeImage(this.xref, stream, resources, { fillRGB });
    } catch {
      img = null;
    }
    if (!img) return;
    this.placeImage(this.imageAsset(img), gs);
  }

  // ---- text ----

  /** How to import a font's text: 'text' (editable) or 'outlines'. */
  textStrategy(font) {
    let info = this.fontInfo.get(font);
    if (info) return info;
    const exact = this.families.exact(font.info, font.baseFont);
    const outlines = font.type3 || font.hasOutlines;
    let mode;
    if (font.type3) mode = 'outlines';
    else if (this.textMode === 'outlines') mode = outlines ? 'outlines' : 'text';
    else if (this.textMode === 'text') mode = 'text';
    else mode = exact ? 'text' : outlines ? 'outlines' : 'text';
    const family = exact || this.families.substitute(font.info);
    info = { mode, family, exact: Boolean(exact) };
    this.fontInfo.set(font, info);
    return info;
  }

  showText(gs, items, resources, ctx) {
    const font = gs.font;
    if (!font) {
      // Text without a font: advance nothing.
      return;
    }
    const mode = gs.tr;
    const size = gs.size;
    const th = gs.th;
    const strategy = this.textStrategy(font);
    const glyphsAll = [];
    let anyText = false;
    for (const it of items) {
      if (typeof it === 'number') {
        const tx = (-it / 1000) * size * th;
        this.tm = multiply(this.tm, [1, 0, 0, 1, tx, 0]);
        continue;
      }
      if (typeof it !== 'string') continue;
      for (const g of font.decode(it)) {
        const start = this.tm;
        const tx = (g.width * size + gs.tc + (g.space ? gs.tw : 0)) * th;
        glyphsAll.push({ g, tm: start, adv: tx });
        this.tm = multiply(this.tm, [1, 0, 0, 1, tx, 0]);
        anyText = true;
      }
    }
    if (!anyText || mode === 3) return;
    const clipMode = mode >= 4;
    const fill = mode === 0 || mode === 2 || mode === 4 || mode === 6;
    const stroke = mode === 1 || mode === 2 || mode === 5 || mode === 6;
    // Type 3 glyphs are drawn by their procedures.
    if (font.type3) {
      if (mode !== 7) this.type3Glyphs(gs, font, glyphsAll, resources, ctx);
      return;
    }
    const useOutlines = strategy.mode === 'outlines' || clipMode || !PDFFont.hasText(glyphsAll.map((x) => x.g));
    if (useOutlines && !font.hasOutlines) {
      if (clipMode) {
        // Type as a clipping path without outlines: a text mask.
        this.addTextChunk(gs, font, strategy, glyphsAll, { fill: true, stroke: false, clip: true });
        return;
      }
    }
    if (useOutlines && font.hasOutlines) {
      const subpaths = [];
      const textSpace = [size * th, 0, 0, size, 0, gs.rise];
      for (const { g, tm } of glyphsAll) {
        const outline = font.glyphOutline(g);
        if (!outline || !outline.length) continue;
        const m = multiply(multiply(gs.ctm, tm), textSpace);
        appendOutline(subpaths, outline, m);
      }
      const text = glyphsAll.map((x) => x.g.unicode).join('');
      if (clipMode) {
        this.textClip = this.textClip || { type: 'clip', subpaths: [], evenOdd: false };
        this.textClip.subpaths.push(...subpaths);
      }
      if (mode === 7 || !subpaths.length || (!fill && !stroke)) return;
      if (!strategy.exact && strategy.mode === 'outlines') this.outlinedFonts = (this.outlinedFonts || new Set()).add(font.info.family || font.baseFont);
      this.flushText();
      const style = {
        fill: fill ? this.paintOf(gs.fill, gs.ca, gs) : null,
        stroke: stroke ? this.paintOf(gs.stroke, gs.CA, gs) : null,
        ...this.strokeStyle(gs),
        blendMode: gs.bm,
      };
      if (!stroke) style.strokeWidth = 1;
      const name = text.trim().slice(0, 60);
      let node;
      if (subpaths.length === 1) node = createPath(subpaths[0].anchors, true, style, { name });
      else {
        const kids = subpaths.map((s) => this.out.add(createPath(s.anchors, true, { fill: null, stroke: null })));
        node = createCompound(kids, style, { name, fillRule: 'nonzero' });
      }
      this.emit(node, gs);
      return;
    }
    if (!strategy.exact) this.substituted = (this.substituted || new Set()).add(`${font.info.family || font.baseFont} (using ${strategy.family})`);
    this.addTextChunk(gs, font, strategy, glyphsAll, { fill, stroke, clip: clipMode });
  }

  /** Collect editable text, merging runs that continue on the same line. */
  addTextChunk(gs, font, strategy, glyphs, { fill, stroke, clip }) {
    const startTm = glyphs[0].tm;
    const S = multiply(gs.ctm, startTm);
    const fillPaint = fill ? this.paintOf(gs.fill, gs.ca, gs) : null;
    const strokePaint = stroke ? this.paintOf(gs.stroke, gs.CA, gs) : null;
    const key = JSON.stringify([fillPaint, strokePaint, stroke ? gs.lw : 0, gs.size, gs.th, gs.rise, gs.tc, gs.bm, strategy.family, font.info.weight, font.info.style]);
    const entries = [];
    const inv = invert(S);
    for (const { g, tm, adv } of glyphs) {
      const o = multiply(inv, multiply(gs.ctm, tm));
      entries.push({ ch: g.unicode || '', x: o[4], adv: Math.abs(adv) });
    }
    const p = this.pending;
    if (p && !clip && !p.clip && p.key === key && p.font === font && p.wraps === gs.wraps && p.layer === this.out.layer) {
      const r = multiply(p.inv, S);
      const em = Math.abs(gs.size * gs.th) || 1;
      if (Math.abs(r[0] - 1) < 1e-3 && Math.abs(r[1]) < 1e-3 && Math.abs(r[2]) < 1e-3 && Math.abs(r[3] - 1) < 1e-3 && Math.abs(r[5]) < 0.05 * em) {
        const gap = r[4] - p.end;
        if (gap > -0.3 * em && gap < 3 * em) {
          const last = p.text[p.text.length - 1];
          const first = entries[0]?.ch;
          if (gap > 0.22 * em && last !== ' ' && first !== ' ') p.text += ' ';
          for (const e of entries) p.text += e.ch;
          const lastE = entries[entries.length - 1];
          p.end = r[4] + lastE.x + lastE.adv;
          return;
        }
      }
    }
    this.flushText();
    const lastE = entries[entries.length - 1];
    this.pending = {
      key,
      font,
      strategy,
      S,
      inv,
      wraps: gs.wraps,
      layer: this.out.layer,
      text: entries.map((e) => e.ch).join(''),
      end: lastE.x + lastE.adv,
      fill: fillPaint,
      stroke: strokePaint,
      gs: gs.clone(),
      clip,
    };
    if (clip) {
      // Type used as a clipping path without outlines: the type itself is the mask.
      const maskNode = this.textNodeOf({ ...this.pending, fill: { type: 'solid', color: '#000000' }, stroke: null });
      this.pending = null;
      if (maskNode) {
        this.textClip = this.textClip || { type: 'clip', subpaths: [], evenOdd: false };
        this.textClip.text = maskNode;
      }
      if (gs.tr !== 7 && (fill || stroke)) this.pending = this.textPendingFrom(gs, font, strategy, entries, S, inv, fillPaint, strokePaint, key);
    }
  }

  textPendingFrom(gs, font, strategy, entries, S, inv, fill, stroke, key) {
    const lastE = entries[entries.length - 1];
    return { key, font, strategy, S, inv, wraps: gs.wraps, layer: this.out.layer, text: entries.map((e) => e.ch).join(''), end: lastE.x + lastE.adv, fill, stroke, gs: gs.clone(), clip: false };
  }

  textNodeOf(p) {
    const text = p.text.replace(/\s+$/, (s) => (p.text.trim() ? '' : s));
    if (!text.trim()) return null;
    const gs = p.gs;
    // Local text space: y down, baseline at 0.
    let M = multiply(p.S, [1, 0, 0, -1, 0, 0]);
    const s = scaleOf(M);
    M = [M[0] / s, M[1] / s, M[2] / s, M[3] / s, M[4], M[5]];
    const fontSize = Math.abs(gs.size) * s;
    const flip = gs.size < 0;
    if (flip) M = [-M[0], -M[1], -M[2], -M[3], M[4], M[5]];
    const char = {
      ...DEFAULT_CHAR,
      fontFamily: p.strategy.family,
      fontWeight: p.font.info.weight,
      fontStyle: p.font.info.style,
      fontSize: round(fontSize),
      horizontalScale: round(gs.th * 100),
      tracking: gs.size ? round((gs.tc / Math.abs(gs.size)) * 1000) : 0,
      baselineShift: round(gs.rise * s),
    };
    const lw = this.strokeStyle(gs);
    return createText(text, 0, 0, {
      transform: M,
      char,
      fill: p.fill,
      stroke: p.stroke,
      strokeWidth: p.stroke ? lw.strokeWidth : 1,
      strokeJoin: lw.strokeJoin,
      strokeCap: lw.strokeCap,
      miterLimit: lw.miterLimit,
      blendMode: gs.bm,
    });
  }

  flushText() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    const node = this.textNodeOf(p);
    if (!node) return;
    this.out.add(node);
    const saved = this.out.layer;
    if (p.layer && p.layer !== saved) this.out.setLayer(p.layer);
    this.out.push(node.id, p.wraps);
    if (p.layer && p.layer !== saved) this.out.setLayer(saved);
  }

  type3Glyphs(gs, font, glyphs, resources, ctx) {
    const fm = font.matrix;
    this.out.beginGroup(gs.wraps, { name: glyphs.map((x) => x.g.unicode).join('').trim().slice(0, 60) });
    for (const { g, tm } of glyphs) {
      const proc = font.charProc(g.code);
      if (!proc) continue;
      const ggs = gs.clone();
      ggs.ctm = multiply(multiply(multiply(gs.ctm, tm), [gs.size * gs.th, 0, 0, gs.size, 0, gs.rise]), fm);
      ggs.wraps = gs.wraps;
      const savedTm = this.tm;
      const savedTlm = this.tlm;
      const savedPath = this.path;
      if (this.formStack.length > 24) break;
      this.formStack.push(proc);
      try {
        let data;
        try {
          data = proc.decoded();
        } catch {
          continue;
        }
        this.run(data, font.resources || resources, ggs, { base: ggs.ctm, inForm: true });
        this.flushText();
      } finally {
        this.formStack.pop();
        this.tm = savedTm;
        this.tlm = savedTlm;
        this.path = savedPath;
      }
    }
    this.out.endGroup();
  }
}

/** Gradient paint for a shading dictionary under matrix m (shading space -> document), or a solid fallback. */
export function shadingToPaint(xref, sh, m, alpha = 1, warn = () => {}) {
  const dict = sh instanceof PDFStream ? sh.dict : sh;
  if (!(dict instanceof PDFDict)) return null;
  const type = dict.num('ShadingType', 0);
  const space = parseColorSpace(xref, dict.get('ColorSpace'), null);
  const fn = compileFunction(xref, dict.get('Function'));
  const domain = dict.array('Domain') || [0, 1];
  const colorAt = (t) => {
    const comps = fn ? fn([t]) : [t];
    return rgbHex(space.toRGB(comps));
  };
  if ((type === 2 || type === 3) && fn) {
    const stops = sampleStops(colorAt, domain[0], domain[1], dict.get('Function'), xref).map((s) => ({ ...s, opacity: alpha }));
    const coords = dict.array('Coords') || [];
    if (type === 2) {
      const p0 = app(m, coords[0], coords[1]);
      const p1 = app(m, coords[2], coords[3]);
      if (Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1e-6) return { type: 'solid', color: stops[stops.length - 1].color };
      return { type: 'linear', stops, angle: (-Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI, x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y };
    }
    const [x0, y0, r0, x1, y1, r1] = coords;
    const c = app(m, x1, y1);
    const ax = { x: m[0], y: m[1] };
    const ay = { x: m[2], y: m[3] };
    const lx = Math.hypot(ax.x, ax.y) || 1;
    const ly = Math.hypot(ay.x, ay.y) || 1;
    const R = Math.max(r1, 1e-6) * lx;
    const dir = { x: ax.x / lx, y: ax.y / lx };
    const paint = { type: 'radial', stops, angle: (-Math.atan2(dir.y, dir.x) * 180) / Math.PI, x1: c.x, y1: c.y, x2: c.x + dir.x * R, y2: c.y + dir.y * R };
    const aspect = ly / lx;
    if (Math.abs(aspect - 1) > 1e-3) paint.aspect = aspect;
    if (r1 > 0 && (Math.abs(x0 - x1) > 1e-9 || Math.abs(y0 - y1) > 1e-9)) paint.focal = [(x0 - x1) / r1, (y0 - y1) / r1];
    if (r1 > 0 && r0 > 0) paint.focalRadius = Math.min(1, r0 / r1);
    return paint;
  }
  // Function-based and mesh shadings: an average color.
  warn('Mesh and function-based shadings were simplified to solid colors.');
  let color = '#808080';
  try {
    if (fn) color = colorAt((domain[0] + domain[1]) / 2);
    else if (type >= 4 && sh instanceof PDFStream) color = meshAverage(sh, space);
  } catch {
    /* keep gray */
  }
  return { type: 'solid', color, ...(alpha < 1 ? { opacity: alpha } : {}) };
}

function round(v) {
  return Math.round(v * 1000) / 1000;
}

function isWs(c) {
  return c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
}

function hexRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function growRect(r, p) {
  if (!r) return { x: p.x, y: p.y, w: 0, h: 0 };
  const x0 = Math.min(r.x, p.x);
  const y0 = Math.min(r.y, p.y);
  const x1 = Math.max(r.x + r.w, p.x);
  const y1 = Math.max(r.y + r.h, p.y);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function intersectRect(a, b) {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** Glyph path commands (text space) appended as document-space subpaths. */
function appendOutline(subpaths, cmds, m) {
  let cur = null;
  for (const c of cmds) {
    if (c[0] === 'M') {
      cur = { anchors: [anchorAt(app(m, c[1], c[2]))], closed: true };
      subpaths.push(cur);
    } else if (c[0] === 'L' && cur) cur.anchors.push(anchorAt(app(m, c[1], c[2])));
    else if (c[0] === 'C' && cur) {
      const c1 = app(m, c[1], c[2]);
      const c2 = app(m, c[3], c[4]);
      const p = app(m, c[5], c[6]);
      const last = cur.anchors[cur.anchors.length - 1];
      last.ox = c1.x;
      last.oy = c1.y;
      cur.anchors.push({ x: p.x, y: p.y, ix: c2.x, iy: c2.y, ox: p.x, oy: p.y });
    } else if (c[0] === 'Z' && cur) {
      const a = cur.anchors;
      if (a.length > 1) {
        const f = a[0];
        const l = a[a.length - 1];
        if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) {
          f.ix = l.ix;
          f.iy = l.iy;
          a.pop();
        }
      }
      cur = null;
    }
  }
  // Drop degenerate contours.
  for (let i = subpaths.length - 1; i >= 0; i--) if (subpaths[i].anchors.length < 2) subpaths.splice(i, 1);
}

/**
 * Stops for a shading function: exact for linear (type 2, N = 1) and
 * stitched linear functions, sampled otherwise.
 */
function sampleStops(colorAt, t0, t1, fnObj, xref) {
  const span = t1 - t0 || 1;
  let ts = null;
  const f = fnObj instanceof Ref ? xref.fetch(fnObj) : fnObj;
  const fd = f instanceof PDFStream ? f.dict : f;
  if (fd instanceof PDFDict) {
    const type = fd.num('FunctionType', -1);
    if (type === 2 && fd.num('N', 1) === 1) ts = [t0, t1];
    else if (type === 3) {
      const subs = fd.array('Functions') || [];
      const linear = subs.every((s) => s instanceof PDFDict && s.num('FunctionType', -1) === 2 && s.num('N', 1) === 1);
      if (linear) ts = [t0, ...(fd.array('Bounds') || []), t1];
    }
  }
  if (!ts) {
    ts = [];
    for (let i = 0; i <= 24; i++) ts.push(t0 + (span * i) / 24);
  }
  const stops = [];
  for (const t of ts) {
    const offset = Math.max(0, Math.min(1, (t - t0) / span));
    const color = colorAt(Math.min(t, t1 - 1e-9 * span));
    stops.push({ offset, color: offset >= 1 ? colorAt(t1) : color, opacity: 1 });
  }
  // Remove samples a straight interpolation already reproduces.
  if (stops.length > 2) {
    const keep = [stops[0]];
    for (let i = 1; i < stops.length - 1; i++) {
      const a = keep[keep.length - 1];
      const b = stops[i];
      const c = stops[i + 1];
      const t = (b.offset - a.offset) / (c.offset - a.offset || 1);
      const ca = hexRgb(a.color);
      const cb = hexRgb(b.color);
      const cc = hexRgb(c.color);
      const err = Math.max(...[0, 1, 2].map((k) => Math.abs(ca[k] + (cc[k] - ca[k]) * t - cb[k])));
      if (err > 1.5 / 255) keep.push(b);
    }
    keep.push(stops[stops.length - 1]);
    return keep;
  }
  return stops;
}

/** Average color of a mesh shading's vertex colors (types 4-7). */
function meshAverage(sh, space) {
  const d = sh.dict;
  const bpc = d.num('BitsPerCoordinate', 16);
  const bpcomp = d.num('BitsPerComponent', 8);
  const bpf = d.num('BitsPerFlag', 8);
  const decode = d.array('Decode') || [];
  const fn = compileFunction(sh.dict.xref, d.get('Function'));
  const data = sh.decoded();
  const ncomp = fn ? 1 : space.n;
  const type = d.num('ShadingType', 4);
  let bit = 0;
  const total = data.length * 8;
  const read = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = v * 2 + ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  const align = () => (bit = Math.ceil(bit / 8) * 8);
  const sums = [0, 0, 0];
  let count = 0;
  const color = () => {
    const comps = [];
    for (let k = 0; k < ncomp; k++) {
      const v = read(bpcomp) / (2 ** bpcomp - 1);
      const lo = decode[4 + 2 * k] ?? 0;
      const hi = decode[5 + 2 * k] ?? 1;
      comps.push(lo + v * (hi - lo));
    }
    const rgb = space.toRGB(fn ? fn(comps) : comps);
    sums[0] += rgb[0];
    sums[1] += rgb[1];
    sums[2] += rgb[2];
    count++;
  };
  for (let guard = 0; guard < 5000; guard++) {
    if (type === 4 || type === 5) {
      const need = (type === 4 ? bpf : 0) + 2 * bpc + ncomp * bpcomp;
      if (bit + need > total) break;
      if (type === 4) read(bpf);
      read(bpc);
      read(bpc);
      color();
      if (type === 4) align();
    } else {
      if (bit + bpf > total) break;
      const flag = read(bpf);
      const pts = flag === 0 ? (type === 6 ? 12 : 16) : type === 6 ? 8 : 12;
      const cols = flag === 0 ? 4 : 2;
      if (bit + pts * 2 * bpc + cols * ncomp * bpcomp > total) break;
      bit += pts * 2 * bpc;
      for (let k = 0; k < cols; k++) color();
      align();
    }
  }
  if (!count) return '#808080';
  return rgbHex(sums.map((s) => s / count));
}
