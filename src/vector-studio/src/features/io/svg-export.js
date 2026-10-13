/**
 * SVG export: clean, standards-compliant SVG 1.1 (with SVG 2 features only
 * where there is no 1.1 equivalent, such as mix-blend-mode) for an
 * artboard, a selection or any document rectangle.
 *
 * - Coordinates are written relative to the exported rectangle, so the
 *   viewBox always starts at 0 0.
 * - Live rectangles, ellipses and lines become <rect>, <circle>/<ellipse>
 *   and <line>; everything else is a <path> with minimal path data.
 * - Gradients are userSpaceOnUse with their resolved end points, clip groups
 *   use <clipPath>, compound paths keep their fill-rule, effects become
 *   filters, inside/outside strokes use a clip path or a mask.
 * - Text is <text> with one <tspan> per line, or outlines when the type
 *   module provides them and the option is chosen.
 */
import { UserError } from '../../lib/errors.js';
import { gradientGeometry, localGradientGeometry, nodeBounds, visualBounds, rectsIntersect, selectionBounds, inflate } from '../../model/geometry.js';
import { shapeAnchors } from '../../model/shapes.js';
import { multiply, translate, isIdentity } from '../../lib/matrix.js';
import { pathDataFromSubpaths, numberFormatter } from './svg-path.js';
import { exportView } from './export-view.js';
import { svgPaintHooks, svgExportHooks, svgNodeHooks, exportWriters } from './hooks.js';
import { nodeArrowOutlines, strokedAnchors, effectiveDash, outlineSubpaths } from './outlines.js';
import { textPieces, decoRects } from './text-segments.js';
import { cssFeatureSettings } from '../type/feature-settings.js';
import { expandStops, focalPoint } from '../../model/gradients.js';
import { renderSubpaths, hasRoundCorners, isElliptical, radialFrame } from './geometry-helpers.js';

const BLEND_CSS = {
  multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', colorDodge: 'color-dodge',
  colorBurn: 'color-burn', hardLight: 'hard-light', softLight: 'soft-light', difference: 'difference', exclusion: 'exclusion',
  hue: 'hue', saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

export function escapeXml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

function shortHex(hex, minify) {
  const h = String(hex || '#000000').toLowerCase();
  if (minify && /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/.test(h)) return `#${h[1]}${h[3]}${h[5]}`;
  return h;
}

/** XML id from a layer or object name (unique within the file). */
function sanitizeId(name) {
  let s = String(name || '').trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_.-]/g, '');
  if (!s) return '';
  if (!/^[A-Za-z_]/.test(s)) s = `_${s}`;
  return s;
}

class SVGWriter {
  constructor(doc, opts) {
    this.doc = doc;
    this.o = opts;
    this.rect = opts.rect;
    this.fmt = numberFormatter(opts.precision ?? 3, opts.minify);
    this.defs = [];
    this.defKeys = new Map();
    this.counter = 0;
    this.usedIds = new Set();
    this.needsXlink = false;
    this.ox = this.rect.x;
    this.oy = this.rect.y;
    this.map = (x, y) => ({ x: x - this.ox, y: y - this.oy });
    this.cullRect = opts.cull === false ? null : inflate(this.rect, 1);
  }

  n(v) {
    return this.fmt(v);
  }

  nl(depth) {
    return this.o.minify ? '' : `\n${'  '.repeat(depth)}`;
  }

  newId(kind) {
    let id;
    do id = `${this.o.idPrefix || ''}${kind}${++this.counter}`;
    while (this.usedIds.has(id));
    this.usedIds.add(id);
    return id;
  }

  nameId(name) {
    if (this.o.minify || !this.o.writeIds) return '';
    const base = sanitizeId(name);
    if (!base) return '';
    let id = (this.o.idPrefix || '') + base;
    let i = 2;
    while (this.usedIds.has(id)) id = `${this.o.idPrefix || ''}${base}_${i++}`;
    this.usedIds.add(id);
    return ` id="${escapeXml(id)}"`;
  }

  /** Add a definition, deduplicated by content. Returns its id. */
  def(kind, build) {
    const probe = build('__ID__');
    const hit = this.defKeys.get(probe);
    if (hit) return hit;
    const id = this.newId(kind);
    this.defKeys.set(probe, id);
    this.defs.push(probe.replace('__ID__', id));
    return id;
  }

  d(subpaths, mapped = true) {
    return pathDataFromSubpaths(subpaths, { precision: this.o.precision ?? 3, minify: this.o.minify, map: mapped ? this.map : null });
  }

  matrixAttr(m) {
    const t = multiply(translate(-this.ox, -this.oy), m);
    if (isIdentity(t)) return '';
    const f = this.n.bind(this);
    if (Math.abs(t[0] - 1) < 1e-12 && Math.abs(t[1]) < 1e-12 && Math.abs(t[2]) < 1e-12 && Math.abs(t[3] - 1) < 1e-12) return ` transform="translate(${f(t[4])} ${f(t[5])})"`;
    return ` transform="matrix(${t.map((v, i) => (i < 4 ? numberFormatter(6, this.o.minify)(v) : f(v))).join(' ')})"`;
  }

  // ---- paint ----

  gradientDef(paint, node, mapped) {
    const b = nodeBounds(this.doc, node) || { x: 0, y: 0, w: 1, h: 1 };
    let g = gradientGeometry(paint, b);
    // Live type is written inside its transform (and each piece inside its own placement,
    // passed as a matrix in `mapped`), so its gradient goes into that space.
    if (node.type === 'text' && mapped !== true) g = localGradientGeometry(g, Array.isArray(mapped) ? multiply(node.transform, mapped) : node.transform);
    const p = mapped === true ? this.map : (x, y) => ({ x, y });
    const a = p(g.x1, g.y1);
    const c = p(g.x2, g.y2);
    // Midpoints become extra stops (SVG interpolates linearly between stops).
    const stops = expandStops(paint.stops);
    const nl = this.nl(2);
    const stopXml = stops
      .map((s) => {
        const op = s.opacity ?? 1;
        return `${nl}  <stop offset="${numberFormatter(4, this.o.minify)(Math.min(1, Math.max(0, s.offset)))}" stop-color="${shortHex(s.color, this.o.minify)}"${op < 1 ? ` stop-opacity="${this.n(op)}"` : ''}/>`;
      })
      .join('');
    if (paint.type === 'radial') {
      if (isElliptical(paint)) {
        // Elliptical gradient: a unit circle placed by a transform, like the canvas renderer.
        const f = radialFrame(paint, b);
        const deg = (f.angle * 180) / Math.PI;
        const tf = `translate(${this.n(a.x)} ${this.n(a.y)}) rotate(${numberFormatter(4)(deg)}) scale(1 ${numberFormatter(5)(f.aspect)})`;
        const [fu, fv] = paint.focal || [0, 0];
        const fr = (paint.focalRadius || 0) * f.r;
        const focal = `${fu || fv ? ` fx="${this.n(fu * f.r)}" fy="${this.n(fv * f.r)}"` : ''}${fr > 0 ? ` fr="${this.n(fr)}"` : ''}`;
        return this.def('g', (id) => `${nl}<radialGradient id="${id}" cx="0" cy="0" r="${this.n(f.r)}"${focal} gradientUnits="userSpaceOnUse" gradientTransform="${tf}">${stopXml}${nl}</radialGradient>`);
      }
      const r = Math.max(g.r, 1e-4);
      const fo = focalPoint(paint, g, 1);
      const fp = p(g.x1 + fo.x, g.y1 + fo.y);
      const focal = `${paint.focal ? ` fx="${this.n(fp.x)}" fy="${this.n(fp.y)}"` : ''}${fo.r > 0 ? ` fr="${this.n(fo.r)}"` : ''}`;
      return this.def('g', (id) => `${nl}<radialGradient id="${id}" cx="${this.n(a.x)}" cy="${this.n(a.y)}" r="${this.n(r)}"${focal} gradientUnits="userSpaceOnUse">${stopXml}${nl}</radialGradient>`);
    }
    return this.def('g', (id) => `${nl}<linearGradient id="${id}" x1="${this.n(a.x)}" y1="${this.n(a.y)}" x2="${this.n(c.x)}" y2="${this.n(c.y)}" gradientUnits="userSpaceOnUse">${stopXml}${nl}</linearGradient>`);
  }

  paintValue(paint, node, mapped) {
    if (!paint) return { value: 'none' };
    if (paint.type === 'solid') return { value: shortHex(paint.color, this.o.minify), opacity: paint.opacity ?? 1 };
    if (paint.type === 'linear' || paint.type === 'radial') return { value: `url(#${this.gradientDef(paint, node, mapped)})`, opacity: 1 };
    const id = svgPaintHooks[paint.type]?.(this, paint, node, mapped, exportSVG);
    if (id) return { value: `url(#${id})`, opacity: 1 };
    return { value: 'none' };
  }

  fillAttrs(node, paint, mapped = true) {
    const f = this.paintValue(paint, node, mapped);
    if (f.value === '#000' && this.o.minify && !(f.opacity < 1)) return '';
    return ` fill="${f.value}"${f.opacity < 1 ? ` fill-opacity="${this.n(f.opacity)}"` : ''}`;
  }

  strokeAttrs(node, { widthScale = 1, mapped = true } = {}) {
    if (!node.stroke || !(node.strokeWidth > 0)) return '';
    const s = this.paintValue(node.stroke, node, mapped);
    if (s.value === 'none') return '';
    let out = ` stroke="${s.value}"`;
    if (s.opacity < 1) out += ` stroke-opacity="${this.n(s.opacity)}"`;
    const w = node.strokeWidth * widthScale;
    if (Math.abs(w - 1) > 1e-9) out += ` stroke-width="${this.n(w)}"`;
    if (node.strokeCap && node.strokeCap !== 'butt') out += ` stroke-linecap="${node.strokeCap}"`;
    if (node.strokeJoin && node.strokeJoin !== 'miter') out += ` stroke-linejoin="${node.strokeJoin}"`;
    else if ((node.miterLimit ?? 10) !== 4) out += ` stroke-miterlimit="${this.n(node.miterLimit ?? 10)}"`;
    const dash = effectiveDash(node);
    if (dash) {
      out += ` stroke-dasharray="${dash.dash.map((v) => this.n(v)).join(this.o.minify ? ',' : ' ')}"`;
      if (dash.offset) out += ` stroke-dashoffset="${this.n(dash.offset)}"`;
    }
    return out;
  }

  /** opacity, blend mode and filter attributes. */
  commonAttrs(node, { filterUnits = 'user' } = {}) {
    let out = '';
    if ((node.opacity ?? 1) < 1) out += ` opacity="${this.n(node.opacity)}"`;
    const blend = BLEND_CSS[node.blendMode];
    // Isolate Blending keeps the group's blending inside it, like the canvas renderer.
    const css = [blend ? `mix-blend-mode:${blend}` : '', node.isolate && node.type === 'group' ? 'isolation:isolate' : ''].filter(Boolean).join(';');
    if (css) out += ` style="${css}"`;
    const fx = this.filterDef(node, filterUnits);
    if (fx) out += ` filter="url(#${fx})"`;
    for (const hook of svgExportHooks.attrs) out += hook(node) || '';
    return out;
  }

  /**
   * Live effects as one SVG filter, in the renderer's order: content effects
   * (Gaussian Blur, Feather, Inner Glow) in stacking order, then Drop Shadow
   * and Outer Glow behind the final content. Canvas shadow blur b equals a
   * Gaussian with standard deviation b / 2.
   */
  filterDef(node, units) {
    const effects = (node.effects || []).filter((e) => e && !e.hidden && ['dropShadow', 'blur', 'outerGlow', 'innerGlow', 'feather'].includes(e.type));
    if (!effects.length) return null;
    const nl = this.nl(2);
    const prims = [];
    let src = 'SourceGraphic';
    let reach = 0;
    let k = 0;
    const res = () => `r${++k}`;
    for (const e of effects) {
      if (e.type === 'blur' && e.radius > 0) {
        const r = res();
        prims.push(`<feGaussianBlur in="${src}" stdDeviation="${this.n(e.radius)}" result="${r}"/>`);
        src = r;
        reach = Math.max(reach, e.radius * 3);
      } else if (e.type === 'feather' && e.radius > 0) {
        const m = res();
        const r = res();
        prims.push(`<feGaussianBlur in="${src}" stdDeviation="${this.n(e.radius)}" result="${m}"/>`);
        prims.push(`<feComposite in="${src}" in2="${m}" operator="in" result="${r}"/>`);
        src = r;
      } else if (e.type === 'innerGlow') {
        const sd = e.blur ?? 5;
        const base = res();
        // The inverted alpha outside the shape must reach far enough for the blur to bring it inside.
        reach = Math.max(reach, sd * 3);
        if (e.source === 'center') prims.push(`<feGaussianBlur in="${src}" stdDeviation="${this.n(sd)}" result="${base}"/>`);
        else {
          const inv = res();
          prims.push(`<feComponentTransfer in="${src}" result="${inv}"><feFuncA type="table" tableValues="1 0"/></feComponentTransfer>`);
          prims.push(`<feGaussianBlur in="${inv}" stdDeviation="${this.n(sd)}" result="${base}"/>`);
        }
        const tint = res();
        const inside = res();
        const out = res();
        prims.push(`<feFlood flood-color="${shortHex(e.color || '#ffffff', this.o.minify)}" flood-opacity="${this.n(e.opacity ?? 0.75)}"/>`);
        prims.push(`<feComposite in2="${base}" operator="in" result="${tint}"/>`);
        prims.push(`<feComposite in="${tint}" in2="${src}" operator="in" result="${inside}"/>`);
        const mode = e.mode === 'normal' ? 'normal' : BLEND_CSS[e.mode || 'screen'] || 'screen';
        prims.push(`<feBlend in="${inside}" in2="${src}" mode="${mode}" result="${out}"/>`);
        src = out;
      }
    }
    const behind = [];
    const shadow = (color, opacity, sd, dx, dy) => {
      const o = res();
      const r = res();
      prims.push(`<feGaussianBlur in="${src}" stdDeviation="${this.n(sd)}"/>`);
      prims.push(dx || dy ? `<feOffset dx="${this.n(dx)}" dy="${this.n(dy)}" result="${o}"/>` : `<feOffset result="${o}"/>`);
      prims.push(`<feFlood flood-color="${shortHex(color, this.o.minify)}" flood-opacity="${this.n(opacity)}"/>`);
      prims.push(`<feComposite in2="${o}" operator="in" result="${r}"/>`);
      behind.push(r);
      reach = Math.max(reach, Math.hypot(dx, dy) + sd * 3);
    };
    // A Darkness shadow: the artwork's own colors scaled toward black.
    const darkShadow = (darkness, opacity, sd, dx, dy) => {
      const d = res();
      const o = res();
      const r = res();
      const k = this.n(1 - Math.max(0, Math.min(1, darkness)));
      prims.push(`<feComponentTransfer in="${src}" result="${d}"><feFuncR type="linear" slope="${k}"/><feFuncG type="linear" slope="${k}"/><feFuncB type="linear" slope="${k}"/></feComponentTransfer>`);
      prims.push(`<feGaussianBlur in="${d}" stdDeviation="${this.n(sd)}"/>`);
      prims.push(dx || dy ? `<feOffset dx="${this.n(dx)}" dy="${this.n(dy)}" result="${o}"/>` : `<feOffset result="${o}"/>`);
      prims.push(`<feComponentTransfer in="${o}" result="${r}"><feFuncA type="linear" slope="${this.n(opacity)}"/></feComponentTransfer>`);
      behind.push(r);
      reach = Math.max(reach, Math.hypot(dx, dy) + sd * 3);
    };
    for (const e of effects) {
      if (e.type === 'dropShadow' && e.shadowFrom === 'darkness') darkShadow(e.darkness ?? 1, e.opacity ?? 0.75, (e.blur || 0) / 2, e.x || 0, e.y || 0);
      else if (e.type === 'dropShadow') shadow(e.color || '#000000', e.opacity ?? 0.75, (e.blur || 0) / 2, e.x || 0, e.y || 0);
      else if (e.type === 'outerGlow') {
        const b = e.blur ?? 5;
        // Two passes, like the canvas renderer, for a denser core.
        shadow(e.color || '#ffff00', e.opacity ?? 0.75, b, 0, 0);
        shadow(e.color || '#ffff00', e.opacity ?? 0.75, b / 2, 0, 0);
      }
    }
    if (behind.length) prims.push(`<feMerge>${behind.map((s) => `<feMergeNode in="${s}"/>`).join('')}<feMergeNode in="${src}"/></feMerge>`);
    else if (src === 'SourceGraphic') return null;
    let region;
    if (units === 'user') {
      const vb = visualBounds(this.doc, node) || nodeBounds(this.doc, node) || { x: 0, y: 0, w: 0, h: 0 };
      const r = inflate(vb, reach + 2);
      const p = this.map(r.x, r.y);
      region = ` filterUnits="userSpaceOnUse" x="${this.n(p.x)}" y="${this.n(p.y)}" width="${this.n(r.w)}" height="${this.n(r.h)}"`;
    } else region = ' x="-50%" y="-50%" width="200%" height="200%"';
    return this.def('f', (id) => `${nl}<filter id="${id}"${region} color-interpolation-filters="sRGB">${prims.map((p) => `${nl}  ${p}`).join('')}${nl}</filter>`);
  }

  // ---- nodes ----

  visible(node) {
    if (!node || node.hidden) return false;
    if (!this.cullRect) return true;
    const vb = visualBounds(this.doc, node);
    return Boolean(vb && rectsIntersect(vb, this.cullRect));
  }

  node(node, depth) {
    if (!this.visible(node)) return '';
    let out;
    for (const hook of svgExportHooks.element) if ((out = hook(node, this, depth)) !== undefined) break;
    if (out === undefined) out = this.element(node, depth);
    if (out) for (const hook of svgNodeHooks) out = hook(node, out, { nl: this.nl(depth), depth, minify: this.o.minify }) ?? out;
    return out;
  }

  element(node, depth) {
    switch (node.type) {
      case 'path':
      case 'compound':
        return this.shape(node, depth);
      case 'text':
        return this.text(node, depth);
      case 'image':
        return this.image(node, depth);
      case 'group':
      case 'layer':
        return this.group(node, depth);
      case 'instance':
        return this.instance(node, depth);
      default:
        return exportWriters.svg.get(node.type)?.(this, node, depth) || '';
    }
  }

  /**
   * A symbol instance as <use> of a shared <symbol> holding the master
   * artwork in its own coordinates (with the `symbols` option; other
   * instances arrive as plain groups from exportView).
   */
  instance(node, depth) {
    const sid = this.symbolDef(node.symbol);
    if (!sid) return '';
    this.needsXlink = true;
    return `${this.nl(depth)}<use xlink:href="#${sid}"${this.nameId(node.name)}${this.matrixAttr(node.transform)}${this.commonAttrs(node)}/>`;
  }

  symbolDef(symbolId) {
    this.symbolIds ||= new Map();
    if (this.symbolIds.has(symbolId)) return this.symbolIds.get(symbolId);
    const def = this.doc.get(symbolId);
    if (!def?.children) return null;
    const id = this.newId('symbol');
    this.symbolIds.set(symbolId, id);
    // The master is written in its own coordinates, uncropped.
    const saved = [this.ox, this.oy, this.cullRect];
    this.ox = this.oy = 0;
    this.cullRect = null;
    const body = def.children.map((c) => this.node(this.doc.get(c), 3)).join('');
    [this.ox, this.oy, this.cullRect] = saved;
    const title = def.name && !this.o.minify ? `${this.nl(3)}<title>${escapeXml(def.name)}</title>` : '';
    this.defs.push(`${this.nl(2)}<symbol id="${id}" overflow="visible">${title}${body}${this.nl(2)}</symbol>`);
    return id;
  }

  subpathsOf(node) {
    return renderSubpaths(this.doc, node);
  }

  /** <rect>/<ellipse>/<circle>/<line> when a live shape still matches its anchors, else null. */
  primitive(node) {
    const s = node.shape;
    if (!s || node.type !== 'path' || hasRoundCorners(node) || (s.angle && Math.abs(s.angle % 360) > 1e-9)) return null;
    if (!['rect', 'ellipse', 'line'].includes(s.kind)) return null;
    const expect = shapeAnchors(s);
    if (!expect || expect.length !== node.anchors.length) return null;
    for (let i = 0; i < expect.length; i++) {
      const a = expect[i];
      const b = node.anchors[i];
      if (Math.abs(a.x - b.x) > 1e-6 || Math.abs(a.y - b.y) > 1e-6 || Math.abs(a.ox - b.ox) > 1e-6 || Math.abs(a.oy - b.oy) > 1e-6 || Math.abs(a.ix - b.ix) > 1e-6 || Math.abs(a.iy - b.iy) > 1e-6) return null;
    }
    if (s.kind === 'line') {
      const p = this.map(s.x1, s.y1);
      const q = this.map(s.x2, s.y2);
      return `<line x1="${this.n(p.x)}" y1="${this.n(p.y)}" x2="${this.n(q.x)}" y2="${this.n(q.y)}"`;
    }
    const p = this.map(s.cx - s.w / 2, s.cy - s.h / 2);
    if (s.kind === 'rect') {
      const r = s.radii || [0, 0, 0, 0];
      if (r.some((v) => Math.abs(v - r[0]) > 1e-9)) return null;
      const rr = Math.min(r[0] || 0, s.w / 2, s.h / 2);
      return `<rect x="${this.n(p.x)}" y="${this.n(p.y)}" width="${this.n(s.w)}" height="${this.n(s.h)}"${rr > 0 ? ` rx="${this.n(rr)}"` : ''}`;
    }
    const c = this.map(s.cx, s.cy);
    if (Math.abs(s.w - s.h) < 1e-9) return `<circle cx="${this.n(c.x)}" cy="${this.n(c.y)}" r="${this.n(s.w / 2)}"`;
    return `<ellipse cx="${this.n(c.x)}" cy="${this.n(c.y)}" rx="${this.n(s.w / 2)}" ry="${this.n(s.h / 2)}"`;
  }

  geometryOpen(node) {
    const prim = this.primitive(node);
    if (prim) return prim;
    const rule = node.fillRule === 'evenodd' ? ' fill-rule="evenodd"' : '';
    return `<path d="${this.d(this.subpathsOf(node))}"${rule}`;
  }

  shape(node, depth) {
    const subs = this.subpathsOf(node);
    if (!subs.length || !subs.some((s) => s.anchors.length > 1)) return '';
    const nl = this.nl(depth);
    const open = this.geometryOpen(node);
    const id = this.nameId(node.name);
    const align = node.strokeAlign || 'center';
    const closedShape = node.type === 'compound' || node.closed;
    const hasStroke = node.stroke && node.strokeWidth > 0;
    const arrows = hasStroke ? nodeArrowOutlines(node) : [];
    const trimmed = hasStroke ? strokedAnchors(node) : null;
    if ((!hasStroke || align === 'center' || !closedShape) && !arrows.length && !trimmed) {
      return `${nl}${open}${id}${this.fillAttrs(node, node.fill)}${this.strokeAttrs(node)}${this.commonAttrs(node)}/>`;
    }
    // Several elements share the object's opacity, blend and effects through a group.
    const inner = [];
    if (trimmed) {
      // The stroke stops short of the arrowheads; the fill keeps the full path.
      if (node.fill) inner.push(`${this.nl(depth + 1)}${open}${this.fillAttrs(node, node.fill)}/>`);
      inner.push(`${this.nl(depth + 1)}<path d="${this.d([{ anchors: trimmed, closed: false }])}" fill="none"${this.strokeAttrs(node)}/>`);
    } else if (!hasStroke || align === 'center' || !closedShape) {
      inner.push(`${this.nl(depth + 1)}${open}${this.fillAttrs(node, node.fill)}${this.strokeAttrs(node)}/>`);
    } else {
      inner.push(`${this.nl(depth + 1)}${open}${this.fillAttrs(node, node.fill)}/>`);
      const rule = node.fillRule === 'evenodd' ? 'evenodd' : 'nonzero';
      const d = this.d(subs);
      if (align === 'inside') {
        const cp = this.def('c', (cid) => `${this.nl(2)}<clipPath id="${cid}"><path d="${d}"${rule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
        inner.push(`${this.nl(depth + 1)}<g clip-path="url(#${cp})">${this.nl(depth + 2)}${open} fill="none"${this.strokeAttrs(node, { widthScale: 2 })}/>${this.nl(depth + 1)}</g>`);
      } else {
        const vb = inflate(nodeBounds(this.doc, node), node.strokeWidth * 4 + 2);
        const p = this.map(vb.x, vb.y);
        const mk = this.def('m', (mid) => `${this.nl(2)}<mask id="${mid}" maskUnits="userSpaceOnUse" x="${this.n(p.x)}" y="${this.n(p.y)}" width="${this.n(vb.w)}" height="${this.n(vb.h)}"><rect x="${this.n(p.x)}" y="${this.n(p.y)}" width="${this.n(vb.w)}" height="${this.n(vb.h)}" fill="#fff"/><path d="${d}" fill="#000"${rule === 'evenodd' ? ' fill-rule="evenodd"' : ''}/></mask>`);
        inner.push(`${this.nl(depth + 1)}<g mask="url(#${mk})">${this.nl(depth + 2)}${open} fill="none"${this.strokeAttrs(node, { widthScale: 2 })}/>${this.nl(depth + 1)}</g>`);
      }
    }
    if (arrows.length) {
      const f = this.paintValue(node.stroke, node, true);
      inner.push(`${this.nl(depth + 1)}<path d="${this.d(arrows)}" fill="${f.value}"${f.opacity < 1 ? ` fill-opacity="${this.n(f.opacity)}"` : ''}/>`);
    }
    return `${nl}<g${id}${this.commonAttrs(node)}>${inner.join('')}${nl}</g>`;
  }

  fontFamily(f) {
    const fam = String(f || 'sans-serif');
    const generic = ['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui'];
    if (generic.includes(fam)) return fam;
    return `${/[\s,]/.test(fam) ? `'${fam.replace(/'/g, '')}'` : fam}, ${/mono/i.test(fam) ? 'monospace' : /serif/i.test(fam) && !/sans/i.test(fam) ? 'serif' : 'sans-serif'}`;
  }

  /** Font attributes for a text style. */
  fontAttrs(st, size) {
    let a = ` font-family="${escapeXml(this.fontFamily(st.fontFamily))}" font-size="${this.n(size ?? st.fontSize)}"`;
    if ((st.fontWeight || 400) !== 400) a += ` font-weight="${st.fontWeight}"`;
    if (st.fontStyle === 'italic') a += ' font-style="italic"';
    // OpenType features: a class with font-feature-settings (no presentation attribute exists for it).
    const ff = cssFeatureSettings(st);
    if (ff) {
      this.featureClasses = this.featureClasses || new Map();
      let cls = this.featureClasses.get(ff);
      if (!cls) {
        cls = `vs-ff${this.featureClasses.size + 1}`;
        this.featureClasses.set(ff, cls);
        this.defs.push(`<style>.${cls}{font-feature-settings:${escapeXml(ff)}}</style>`);
      }
      a += ` class="${cls}"`;
    }
    return a;
  }

  /** Fill/stroke attributes for a text style (gradients in the text's local space, like the canvas). */
  /** Fill and stroke of a text piece; `seg` is the piece's placement inside the text (null for none). */
  textPaintAttrs(node, st, seg = null) {
    const fill = st.fill === undefined ? node.fill : st.fill;
    const stroke = st.stroke === undefined ? node.stroke : st.stroke;
    const strokeWidth = st.strokeWidth ?? node.strokeWidth;
    const space = seg || false;
    return `${this.fillAttrs(node, fill, space)}${this.strokeAttrs({ ...node, stroke, strokeWidth, dash: node.dash }, { mapped: space })}`;
  }

  text(node, depth) {
    const nl = this.nl(depth);
    const id = this.nameId(node.name);
    const runs = this.o.textMode === 'outlines' ? this.o.outlines?.get(node.id) : null;
    if (runs?.length) {
      const paths = runs.map((r) => `<path d="${this.d(r.subpaths)}"${this.fillAttrs(node, r.fill)}${this.strokeAttrs({ ...node, stroke: r.stroke, strokeWidth: r.strokeWidth })}`);
      if (paths.length === 1) return `${nl}${paths[0]}${id}${this.commonAttrs(node)}/>`;
      return `${nl}<g${id}${this.commonAttrs(node)}>${paths.map((p) => `${this.nl(depth + 1)}${p}/>`).join('')}${nl}</g>`;
    }
    const { mode, items } = textPieces(node);
    if (!items.length) return '';
    const tf = this.matrixAttr(node.transform);
    const kids = [];
    const d1 = this.nl(depth + 1);
    const common = this.commonAttrs(node, { filterUnits: 'box' });
    if (mode === 'segments') {
      // Unscaled pieces share ONE <text> as <tspan>s positioned from the
      // layout (baseline shifts as dy from the line's baseline), so SVG
      // importers, ours included, read back a single text object with style
      // runs. Scaled pieces need a transform, which a tspan cannot carry.
      const spans = [];
      let preserve = false;
      for (const it of items) {
        const st = it.style;
        const fill = st.fill === undefined ? node.fill : st.fill;
        const scaled = it.hs !== 1 || it.vs !== 1;
        const ls = it.track ? ` letter-spacing="${this.n(scaled ? it.track / it.hs : it.track)}"` : '';
        if (it.str && !scaled) {
          if (/^\s|\s$|\s{2}/.test(it.str)) preserve = true;
          const dy = Math.abs(it.y - it.base) > 1e-9 ? ` dy="${this.n(it.y - it.base)}"` : '';
          const deco = [st.underline && 'underline', st.strike && 'line-through'].filter(Boolean).join(' ');
          spans.push({ it, dy, attrs: `${this.fontAttrs(st, it.size)}${ls}${this.textPaintAttrs(node, st, null)}${deco ? ` text-decoration="${deco}"` : ''}`, deco, str: escapeXml(it.str) });
          continue;
        }
        if (it.str) {
          const pre = /^\s|\s$|\s{2}/.test(it.str) ? ' xml:space="preserve"' : '';
          kids.push(`${d1}<text transform="translate(${this.n(it.x)} ${this.n(it.y)}) scale(${this.n(it.hs)} ${this.n(it.vs)})"${this.fontAttrs(st, it.size)}${ls}${this.textPaintAttrs(node, st, [it.hs, 0, 0, it.vs, it.x, it.y])}${pre}>${escapeXml(it.str)}</text>`);
        }
        for (const [x, y, w, h] of decoRects(st, it.size, it.deco)) kids.push(`${d1}<rect x="${this.n(x)}" y="${this.n(y)}" width="${this.n(w)}" height="${this.n(h)}"${this.fillAttrs(node, fill, false)}/>`);
      }
      const pre = preserve ? ' xml:space="preserve"' : '';
      if (!spans.length && !kids.length) return '';
      // A single unshifted piece without decorations stays a plain <text x y>.
      const one = spans.length === 1 && !kids.length && !spans[0].dy && !spans[0].deco ? spans[0] : null;
      const text = one
        ? `<text${id}${tf}${common} x="${this.n(one.it.x)}" y="${this.n(one.it.y)}"${one.attrs}${pre}>${one.str}</text>`
        : spans.length
          ? `<text${kids.length ? '' : `${id}${tf}${common}`}${pre}>${spans.map((sp) => `<tspan x="${this.n(sp.it.x)}" y="${this.n(sp.it.base)}"${sp.dy}${sp.attrs}>${sp.str}</tspan>`).join('')}</text>`
          : '';
      if (!kids.length) return `${nl}${text}`;
      return `${nl}<g${id}${tf}${common}>${text ? `${d1}${text}` : ''}${kids.join('')}${nl}</g>`;
    }
    for (const it of items) {
      const st = it.style;
      const m = it.m.map((v, i) => (i < 4 ? numberFormatter(6, this.o.minify)(v) : this.n(v))).join(' ');
      const deco = decoRects(st, it.size, it.deco).map(([x, y, w, h]) => `<rect x="${this.n(x)}" y="${this.n(y)}" width="${this.n(w)}" height="${this.n(h)}"${this.fillAttrs(node, st.fill === undefined ? node.fill : st.fill, it.m)}/>`).join('');
      kids.push(`${d1}<g transform="matrix(${m})"><text${this.fontAttrs(st, it.size)}${this.textPaintAttrs(node, st, it.m)}>${escapeXml(it.str)}</text>${deco}</g>`);
    }
    if (!kids.length) return '';
    return `${nl}<g${id}${tf}${common}>${kids.join('')}${nl}</g>`;
  }

  image(node, depth) {
    const asset = this.doc.assets.get(node.asset);
    if (!asset?.data) return '';
    this.needsXlink = true;
    const tf = this.matrixAttr(node.transform);
    return `${this.nl(depth)}<image${this.nameId(node.name)} width="${this.n(node.width)}" height="${this.n(node.height)}"${tf} preserveAspectRatio="none" xlink:href="${escapeXml(asset.data)}"${this.commonAttrs(node, { filterUnits: 'box' })}/>`;
  }

  clipDef(mask) {
    const parts = [];
    const add = (n) => {
      if (!n) return;
      if (n.type === 'path' || n.type === 'compound') {
        const subs = this.subpathsOf(n);
        if (subs.length) parts.push(`<path d="${this.d(subs)}"${n.fillRule === 'evenodd' ? ' clip-rule="evenodd"' : ''}/>`);
      } else if (n.type === 'group') for (const c of n.children) add(this.doc.get(c));
      else if (n.type === 'text') {
        const o = outlineSubpaths(this.o.outlines?.get(n.id));
        if (o.length) parts.push(`<path d="${this.d(o)}"/>`);
        else {
          // Live type clips by its glyphs: <text> elements (each with its full placement, since a clip path cannot hold groups).
          const { mode, items } = textPieces(n);
          for (const it of items) {
            if (!it.str || !it.str.trim()) continue;
            const st = it.style;
            if (mode === 'segments') {
              const scaled = it.hs !== 1 || it.vs !== 1;
              const ls = it.track ? ` letter-spacing="${this.n(scaled ? it.track / it.hs : it.track)}"` : '';
              const tf = this.matrixAttr(scaled ? multiply(n.transform, [it.hs, 0, 0, it.vs, it.x, it.y]) : n.transform);
              const xy = scaled ? '' : ` x="${this.n(it.x)}" y="${this.n(it.y)}"`;
              parts.push(`<text${tf}${xy}${this.fontAttrs(st, it.size)}${ls}>${escapeXml(it.str)}</text>`);
            } else parts.push(`<text${this.matrixAttr(multiply(n.transform, it.m))}${this.fontAttrs(st, it.size)}>${escapeXml(it.str)}</text>`);
          }
        }
      } else if (n.type === 'image') {
        const b = nodeBounds(this.doc, n);
        if (b) {
          const p = this.map(b.x, b.y);
          parts.push(`<rect x="${this.n(p.x)}" y="${this.n(p.y)}" width="${this.n(b.w)}" height="${this.n(b.h)}"/>`);
        }
      }
    };
    add(mask);
    if (!parts.length) return null;
    const nl = this.nl(2);
    return this.def('c', (id) => `${nl}<clipPath id="${id}">${parts.map((p) => `${nl}  ${p}`).join('')}${nl}</clipPath>`);
  }

  group(node, depth) {
    const kids = node.children.map((c) => this.doc.get(c)).filter(Boolean);
    const nl = this.nl(depth);
    const isLayer = node.type === 'layer';
    const id = isLayer ? this.nameId(node.name || 'Layer') : this.nameId(node.name);
    const dataName = isLayer && !this.o.minify && node.name && sanitizeId(node.name) !== node.name ? ` data-name="${escapeXml(node.name)}"` : '';
    if (node.type === 'group' && node.clip && kids.length) {
      const mask = kids[kids.length - 1];
      const cp = this.clipDef(mask);
      if (!cp) return '';
      const stroked = mask.stroke && mask.strokeWidth > 0 && (mask.type === 'path' || mask.type === 'compound') && !mask.hidden;
      const fx = (node.effects || []).some((e) => !e.hidden);
      if (!stroked && !fx) {
        const body = kids.slice(0, -1).map((k) => this.node(k, depth + 1)).join('');
        return body ? `${nl}<g${id} clip-path="url(#${cp})"${this.commonAttrs(node)}>${body}${nl}</g>` : '';
      }
      // A stroked clipping path draws its stroke above the clipped content, and
      // effects apply after clipping, so both need the clip on an inner group.
      const body = kids.slice(0, -1).map((k) => this.node(k, depth + 2)).join('');
      let out = body ? `${this.nl(depth + 1)}<g clip-path="url(#${cp})">${body}${this.nl(depth + 1)}</g>` : '';
      if (stroked) out += `${this.nl(depth + 1)}${this.geometryOpen(mask)} fill="none"${this.strokeAttrs(mask)}/>`;
      if (!out) return '';
      return `${nl}<g${id}${this.commonAttrs(node)}>${out}${nl}</g>`;
    }
    const body = kids.map((k) => this.node(k, depth + 1)).join('');
    if (!body) return '';
    const common = this.commonAttrs(node);
    if (!isLayer && !id && !common && kids.length === 1 && this.o.minify) return body;
    return `${nl}<g${id}${dataName}${common}>${body}${nl}</g>`;
  }
}

/** An instance that draws exactly as its master under its matrix (no part colors or 9-slice scaling). */
function plainInstance(doc, n) {
  if (n.type !== 'instance' || n.overrides || n.tint || n.style) return false;
  const def = doc.get(n.symbol);
  return Boolean(def?.symbolDef && !def.symbolDef.slice9);
}

/**
 * Export document content as SVG text.
 *   rect        document rect that becomes the viewBox (required)
 *   ids         root node ids to export (default: every visible layer)
 *   precision   decimal places (default 3)
 *   minify      compact output
 *   responsive  omit width/height so the SVG scales to its container
 *   textMode    'text' | 'outlines' (needs `outlines`: Map id -> subpaths)
 *   background  optional color for a full-size background rectangle
 *   symbols     write symbol instances as <use> of shared <symbol> definitions
 *   title, idPrefix, writeIds (object names as ids, default true), cull
 */
export function exportSVG(source, opts) {
  const o = { precision: 3, minify: false, responsive: false, textMode: 'text', writeIds: true, ...opts };
  const doc = exportView(source, { keep: o.symbols ? (n) => plainInstance(source, n) : null, native: Object.keys(svgPaintHooks) });
  const rect = o.rect;
  const w = new SVGWriter(doc, o);
  let body = '';
  if (o.ids) for (const id of o.ids) body += w.node(doc.get(id), 1);
  else {
    for (const id of doc.root.children) {
      const layer = doc.get(id);
      if (!layer || layer.hidden || layer.template) continue;
      body += w.node(layer, 1);
    }
  }
  const f = w.n.bind(w);
  const nl = o.minify ? '' : '\n';
  const size = o.responsive ? '' : ` width="${f(rect.w)}" height="${f(rect.h)}"`;
  const xlink = w.needsXlink ? ' xmlns:xlink="http://www.w3.org/1999/xlink"' : '';
  let head = o.minify ? '' : '<?xml version="1.0" encoding="UTF-8"?>\n';
  if (o.comment) head += `<!-- ${String(o.comment).replace(/--/g, '-')} -->${nl}`;
  let out = `${head}<svg xmlns="http://www.w3.org/2000/svg"${xlink} version="1.1"${size} viewBox="0 0 ${f(rect.w)} ${f(rect.h)}">`;
  const info = doc.root?.info;
  const title = info?.title || o.title;
  if (title) out += `${nl}${o.minify ? '' : '  '}<title>${escapeXml(title)}</title>`;
  if (info && !o.minify) out += metadataXml(info, title);
  for (const hook of svgExportHooks.head) {
    const extra = hook(doc);
    if (extra) out += `${nl}${o.minify ? '' : '  '}${extra}`;
  }
  if (w.defs.length) out += `${nl}${o.minify ? '' : '  '}<defs>${w.defs.join('')}${nl}${o.minify ? '' : '  '}</defs>`;
  if (o.background) out += `${nl}${o.minify ? '' : '  '}<rect width="100%" height="100%" fill="${shortHex(o.background, o.minify)}"/>`;
  out += `${body}${nl}</svg>${nl}`;
  return out;
}

/** File Info as <desc> and Dublin Core <metadata>. */
function metadataXml(info, title) {
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  let out = info.description ? `\n  <desc>${escapeXml(info.description)}</desc>` : '';
  const dc = [];
  if (title) dc.push(`<dc:title>${escapeXml(title)}</dc:title>`);
  for (const a of list(info.author)) dc.push(`<dc:creator>${escapeXml(a)}</dc:creator>`);
  if (info.description) dc.push(`<dc:description>${escapeXml(info.description)}</dc:description>`);
  for (const k of list(info.keywords)) dc.push(`<dc:subject>${escapeXml(k)}</dc:subject>`);
  if (info.copyright) dc.push(`<dc:rights>${escapeXml(info.copyright)}</dc:rights>`);
  if (info.copyrightUrl) dc.push(`<dc:source>${escapeXml(info.copyrightUrl)}</dc:source>`);
  if (!dc.length) return out;
  out += `\n  <metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><rdf:Description>${dc.join('')}</rdf:Description></rdf:RDF></metadata>`;
  return out;
}

/**
 * Editor-level SVG export (the `app.exporters.svg` interface).
 *   artboard   artboard index (default: the active one)
 *   selection  true to export the selection's visual bounds
 *   rect       explicit document rect
 * plus every exportSVG() option.
 */
export function editorSVG(editor, opts = {}) {
  const doc = editor.doc;
  let rect = opts.rect;
  let ids = opts.ids || null;
  if (opts.selection) {
    ids = editor.topSelection();
    rect = selectionBounds(doc, ids, true);
    if (!rect) throw new UserError('Select artwork to export.');
  } else if (!rect) {
    const a = editor.artboard(opts.artboard ?? editor.activeArtboard);
    rect = a ? { x: a.x, y: a.y, w: a.w, h: a.h } : selectionBounds(doc, doc.root.children, true);
  }
  if (!rect || !(rect.w > 0) || !(rect.h > 0)) throw new UserError('Nothing to export.');
  return exportSVG(doc, { title: opts.title, ...opts, rect, ids });
}

